#!/usr/bin/env python3
"""Map speakers (from transcription) to either face tracks or person identities
using temporal lip-movement correlation.

Two input modes:
- --faces PATH: legacy mode. Maps speaker -> faceId (per-track).
- --persons PATH: identity mode. Maps speaker -> personId. Lip-movement is
  aggregated across each person's full appearance set across the whole video,
  which is far more robust than the per-track aggregation.
"""

import argparse
import json
import sys


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--transcript', required=True, help='Path to transcript JSON')
    parser.add_argument('--faces', help='Path to faces JSON (legacy mode)')
    parser.add_argument('--persons', help='Path to persons JSON (from cluster_identities.py)')
    args = parser.parse_args()

    if not args.faces and not args.persons:
        print(json.dumps({"error": "Either --faces or --persons must be provided"}))
        sys.exit(1)

    try:
        with open(args.transcript, 'r') as f:
            transcript = json.load(f)
        if args.persons:
            with open(args.persons, 'r') as f:
                persons_data = json.load(f)
            entities = persons_data.get("persons", {})
            mode = "person"
        else:
            with open(args.faces, 'r') as f:
                faces_data = json.load(f)
            entities = faces_data.get("faces", {})
            mode = "face"
    except Exception as e:
        print(json.dumps({"error": f"Failed to load input files: {e}"}))
        sys.exit(1)

    try:
        segments = transcript.get("segments", [])
        speakers = list(set(s["speaker"] for s in segments))
        entity_ids = list(entities.keys())

        log(f"Mapping {len(speakers)} speakers to {len(entity_ids)} {mode}(s)")

        if not speakers or not entity_ids:
            output = {
                "mapping": {s: entity_ids[0] if entity_ids else f"{mode.upper()}_0" for s in speakers},
                "confidence": {s: 0.0 for s in speakers},
            }
            print(json.dumps(output))
            return

        # For each speaker, accumulate total lip movement of each entity during
        # that speaker's speaking segments. We sum rather than average because
        # average rewards ghost clusters: a person with 10 frames that all
        # happen during speech gets a near-perfect average and beats a real
        # speaker with 600 mostly-speech frames whose average is diluted by
        # listening pauses. Summing penalises sparse clusters proportionally
        # to how rarely they're on screen, which is the correct prior.
        speaker_entity_scores = {}

        for speaker in speakers:
            speaker_entity_scores[speaker] = {}
            speaker_ranges = [
                (seg["start"], seg["end"])
                for seg in segments
                if seg["speaker"] == speaker
            ]

            for entity_id in entity_ids:
                appearances = entities[entity_id].get("appearances", [])
                if not appearances:
                    speaker_entity_scores[speaker][entity_id] = 0.0
                    continue

                total_lip = 0.0
                for app in appearances:
                    t = app["time"]
                    for start, end in speaker_ranges:
                        if start <= t <= end:
                            total_lip += app["lip_movement"]
                            break

                speaker_entity_scores[speaker][entity_id] = total_lip

        mapping = {}
        confidence = {}
        used_entities = set()

        speaker_times = {}
        for speaker in speakers:
            total = sum(seg["end"] - seg["start"] for seg in segments if seg["speaker"] == speaker)
            speaker_times[speaker] = total

        sorted_speakers = sorted(speakers, key=lambda s: speaker_times.get(s, 0), reverse=True)

        for speaker in sorted_speakers:
            scores = speaker_entity_scores.get(speaker, {})
            best_entity = None
            best_score = -1

            for entity_id, score in scores.items():
                if entity_id not in used_entities and score > best_score:
                    best_score = score
                    best_entity = entity_id

            if best_entity is None:
                for entity_id, score in scores.items():
                    if score > best_score:
                        best_score = score
                        best_entity = entity_id

            if best_entity is None:
                best_entity = entity_ids[0]
                best_score = 0.0

            mapping[speaker] = best_entity
            used_entities.add(best_entity)

            sorted_scores = sorted(scores.values(), reverse=True)
            if len(sorted_scores) >= 2 and sorted_scores[0] > 0:
                confidence[speaker] = min(1.0, sorted_scores[0] / (sorted_scores[0] + sorted_scores[1] + 1e-8))
            elif best_score > 0:
                confidence[speaker] = min(1.0, best_score * 2)
            else:
                confidence[speaker] = 0.0

            confidence[speaker] = round(confidence[speaker], 3)
            log(f"  {speaker} -> {best_entity} (confidence: {confidence[speaker]:.1%})")

        output = {
            "mapping": mapping,
            "confidence": confidence,
        }

        log("Speaker mapping complete")
        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
