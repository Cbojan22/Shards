#!/usr/bin/env python3
"""Map speakers (from transcription) to faces (from face detection) using temporal lip movement correlation."""

import argparse
import json
import sys
import os

def log(msg):
    print(msg, file=sys.stderr, flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--transcript', required=True, help='Path to transcript JSON')
    parser.add_argument('--faces', required=True, help='Path to faces JSON')
    args = parser.parse_args()

    try:
        with open(args.transcript, 'r') as f:
            transcript = json.load(f)
        with open(args.faces, 'r') as f:
            faces = json.load(f)
    except Exception as e:
        print(json.dumps({"error": f"Failed to load input files: {e}"}))
        sys.exit(1)

    try:
        segments = transcript.get("segments", [])
        face_data = faces.get("faces", {})
        speakers = list(set(s["speaker"] for s in segments))
        face_ids = list(face_data.keys())

        log(f"Mapping {len(speakers)} speakers to {len(face_ids)} faces")

        if not speakers or not face_ids:
            # No mapping possible
            output = {
                "mapping": {s: face_ids[0] if face_ids else "FACE_0" for s in speakers},
                "confidence": {s: 0.0 for s in speakers},
            }
            print(json.dumps(output))
            return

        # For each speaker, compute average lip movement of each face during their speaking segments
        speaker_face_scores = {}  # speaker -> {face_id -> avg_lip_movement}

        for speaker in speakers:
            speaker_face_scores[speaker] = {}
            # Get all time ranges where this speaker talks
            speaker_ranges = [
                (seg["start"], seg["end"])
                for seg in segments
                if seg["speaker"] == speaker
            ]

            for face_id in face_ids:
                appearances = face_data[face_id].get("appearances", [])
                if not appearances:
                    speaker_face_scores[speaker][face_id] = 0.0
                    continue

                # Find lip movement values during speaker's active ranges
                lip_values = []
                for app in appearances:
                    t = app["time"]
                    for start, end in speaker_ranges:
                        if start <= t <= end:
                            lip_values.append(app["lip_movement"])
                            break

                avg_lip = sum(lip_values) / len(lip_values) if lip_values else 0.0
                speaker_face_scores[speaker][face_id] = avg_lip

        # Assign faces to speakers greedily (highest correlation first)
        mapping = {}
        confidence = {}
        used_faces = set()

        # Sort speakers by total speaking time (most talkative first for better assignment)
        speaker_times = {}
        for speaker in speakers:
            total = sum(seg["end"] - seg["start"] for seg in segments if seg["speaker"] == speaker)
            speaker_times[speaker] = total

        sorted_speakers = sorted(speakers, key=lambda s: speaker_times.get(s, 0), reverse=True)

        for speaker in sorted_speakers:
            scores = speaker_face_scores.get(speaker, {})
            best_face = None
            best_score = -1

            for face_id, score in scores.items():
                if face_id not in used_faces and score > best_score:
                    best_score = score
                    best_face = face_id

            if best_face is None:
                # All faces used, assign the one with highest score anyway
                for face_id, score in scores.items():
                    if score > best_score:
                        best_score = score
                        best_face = face_id

            if best_face is None:
                best_face = face_ids[0]
                best_score = 0.0

            mapping[speaker] = best_face
            used_faces.add(best_face)

            # Confidence: how much higher is the best score vs second best
            sorted_scores = sorted(scores.values(), reverse=True)
            if len(sorted_scores) >= 2 and sorted_scores[0] > 0:
                confidence[speaker] = min(1.0, sorted_scores[0] / (sorted_scores[0] + sorted_scores[1] + 1e-8))
            elif best_score > 0:
                confidence[speaker] = min(1.0, best_score * 2)
            else:
                confidence[speaker] = 0.0

            confidence[speaker] = round(confidence[speaker], 3)
            log(f"  {speaker} -> {best_face} (confidence: {confidence[speaker]:.1%})")

        output = {
            "mapping": mapping,
            "confidence": confidence,
        }

        log("Speaker-face mapping complete")
        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
