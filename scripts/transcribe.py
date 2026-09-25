#!/usr/bin/env python3
"""Transcribe video audio using faster-whisper with word-level timestamps and basic speaker diarization."""

import argparse
import json
import sys
import os
import numpy as np

def log(msg):
    print(msg, file=sys.stderr, flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, help='Path to video/audio file')
    parser.add_argument('--model', default='base', help='Whisper model size')
    parser.add_argument('--language', default='en', help='Language code')
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(json.dumps({"error": f"Input file not found: {args.input}"}))
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}))
        sys.exit(1)

    try:
        log(f"Loading Whisper model '{args.model}'...")
        model = WhisperModel(args.model, device="cpu", compute_type="int8")

        log(f"Transcribing: {args.input}")
        whisper_segments, info = model.transcribe(
            args.input,
            language=args.language,
            word_timestamps=True,
            vad_filter=True,
        )

        # `info.duration` is the total audio length faster-whisper computed
        # after VAD. Use it as the denominator for live progress so the GUI
        # has something to show while the generator is decoding.
        total_duration = float(getattr(info, "duration", 0) or 0)

        log("Processing segments and detecting speakers...")
        segments = []
        last_progress_emit = -1.0  # last segment-end we logged progress for

        for seg in whisper_segments:
            words = []
            if seg.words:
                for w in seg.words:
                    words.append({
                        "word": w.word.strip(),
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                    })

            segments.append({
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
                "speaker": "SPEAKER_0",
                "words": words,
            })

            # Emit progress at most every ~3s of decoded audio so the GUI's
            # progress bar moves smoothly without flooding the stream.
            if total_duration > 0 and seg.end - last_progress_emit >= 3.0:
                log(f"  Transcribed {seg.end:.1f}s / {total_duration:.1f}s")
                last_progress_emit = seg.end

        duration = segments[-1]["end"] if segments else 0

        # Basic speaker diarization using silence gaps and energy analysis
        assign_speakers(segments, args.input)

        unique_speakers = list(set(s["speaker"] for s in segments))

        output = {
            "segments": segments,
            "speakers": unique_speakers,
            "language": info.language if info else args.language,
            "duration": round(duration, 3),
        }

        log(f"Done: {len(segments)} segments, {len(unique_speakers)} speakers, {duration:.1f}s")
        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def assign_speakers(segments, input_path):
    """Assign speaker labels based on audio energy analysis and silence gaps."""
    if len(segments) <= 1:
        return

    try:
        import subprocess
        import tempfile

        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            tmp_path = tmp.name

        import wave
        try:
            subprocess.run(
                ['ffmpeg', '-y', '-i', input_path, '-ac', '1', '-ar', '16000',
                 '-t', '7200', tmp_path],
                capture_output=True, timeout=300
            )
            with wave.open(tmp_path, 'rb') as wf:
                frames = wf.readframes(wf.getnframes())
                audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                sample_rate = wf.getframerate()
        finally:
            os.unlink(tmp_path)

        current_speaker = 0
        speaker_change_threshold = 1.5

        for i, seg in enumerate(segments):
            if i == 0:
                seg["speaker"] = f"SPEAKER_{current_speaker}"
                continue

            prev_seg = segments[i - 1]
            gap = seg["start"] - prev_seg["end"]

            if gap > speaker_change_threshold:
                current_speaker = 1 - current_speaker

            seg_start_sample = int(seg["start"] * sample_rate)
            seg_end_sample = min(int(seg["end"] * sample_rate), len(audio))
            prev_start_sample = int(prev_seg["start"] * sample_rate)
            prev_end_sample = min(int(prev_seg["end"] * sample_rate), len(audio))

            if seg_end_sample > seg_start_sample and prev_end_sample > prev_start_sample:
                seg_energy = np.mean(np.abs(audio[seg_start_sample:seg_end_sample]))
                prev_energy = np.mean(np.abs(audio[prev_start_sample:prev_end_sample]))

                energy_ratio = seg_energy / (prev_energy + 1e-8)
                if gap > 0.5 and (energy_ratio > 2.0 or energy_ratio < 0.5):
                    current_speaker = 1 - current_speaker

            seg["speaker"] = f"SPEAKER_{current_speaker}"

    except Exception as e:
        log(f"Warning: Speaker diarization fallback - {e}")
        current_speaker = 0
        for i, seg in enumerate(segments):
            if i > 0:
                gap = seg["start"] - segments[i - 1]["end"]
                if gap > 2.0:
                    current_speaker = 1 - current_speaker
            seg["speaker"] = f"SPEAKER_{current_speaker}"


if __name__ == '__main__':
    main()
