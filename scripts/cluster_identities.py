#!/usr/bin/env python3
"""Cluster per-frame face appearances into persistent person identities.

Input: faces JSON produced by detect_faces.py (with embeddings, mtcnn detector).
Output: persons JSON keyed by personId. Each person has appearances, screen-time
totals, and a centroid embedding. Persons with total screen time below
--min-screen-time are dropped (kills transient ads / posters / B-roll).

Cosine threshold default of 0.6 is FaceNet's canonical decision boundary.
Adjustable via CLI so it can be picked from real data per
[[shards-no-heuristic-fixes-without-data]].
"""

import argparse
import json
import sys
import math


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--faces', required=True, help='Path to faces JSON (from detect_faces.py)')
    parser.add_argument('--cosine-threshold', type=float, default=0.6,
                        help='Max cosine distance to merge an appearance into an existing cluster')
    parser.add_argument('--min-screen-time', type=float, default=2.0,
                        help='Drop persons whose total screen time falls below this (seconds)')
    args = parser.parse_args()

    try:
        with open(args.faces, 'r') as f:
            face_data = json.load(f)
    except Exception as e:
        print(json.dumps({"error": f"Failed to load faces JSON: {e}"}))
        sys.exit(1)

    try:
        sample_rate = float(face_data.get("sample_rate", 2.0)) or 2.0
        frame_period = 1.0 / sample_rate

        # Flatten all appearances into a single list, sorted by time so the
        # online clustering keeps consecutive same-person frames in one cluster.
        flat = []
        for track_id, track in face_data.get("faces", {}).items():
            for app in track.get("appearances", []):
                if "embedding" not in app or not app["embedding"]:
                    continue
                flat.append((app["time"], track_id, app))
        flat.sort(key=lambda x: x[0])

        if not flat:
            log("No embeddings in faces JSON — was detect_faces.py run with --detector mtcnn?")
            print(json.dumps({
                "persons": {}, "cosine_threshold": args.cosine_threshold,
                "min_screen_time_seconds": args.min_screen_time,
                "filtered_short_lived": 0,
            }))
            return

        log(f"Clustering {len(flat)} appearances with cosine threshold {args.cosine_threshold}")

        # Online clustering with running-mean centroids. We use distance =
        # 1 - cosine_similarity, so threshold 0.6 ≈ "different person".
        clusters = []  # list of dict(centroid, count, appearances)

        for time_, _track_id, app in flat:
            emb = app["embedding"]
            best_idx = -1
            best_dist = args.cosine_threshold
            for i, c in enumerate(clusters):
                d = cosine_distance(emb, c["centroid"])
                if d < best_dist:
                    best_dist = d
                    best_idx = i

            if best_idx == -1:
                clusters.append({
                    "centroid": list(emb),
                    "count": 1,
                    "appearances": [strip_embedding(app)],
                })
            else:
                c = clusters[best_idx]
                # Running mean centroid (numerically stable for what we need).
                n = c["count"]
                c["centroid"] = [(c["centroid"][k] * n + emb[k]) / (n + 1) for k in range(len(emb))]
                c["count"] = n + 1
                c["appearances"].append(strip_embedding(app))

        log(f"Formed {len(clusters)} raw clusters")

        # Compute per-cluster screen time and filter.
        persons = {}
        filtered = 0
        for i, c in enumerate(clusters):
            apps = c["appearances"]
            # Screen time is count × sample period — appearances are uniformly
            # spaced because detect_faces.py samples at fixed intervals.
            total_screen_time = len(apps) * frame_period
            if total_screen_time < args.min_screen_time:
                filtered += 1
                continue
            apps.sort(key=lambda a: a["time"])
            person_id = f"PERSON_{i}"
            persons[person_id] = {
                "personId": person_id,
                "appearances": apps,
                "total_screen_time": round(total_screen_time, 3),
                "first_seen": apps[0]["time"],
                "last_seen": apps[-1]["time"],
                "centroid_embedding": [round(v, 5) for v in c["centroid"]],
            }

        log(f"Kept {len(persons)} persons (dropped {filtered} short-lived clusters)")
        for pid, p in persons.items():
            log(f"  {pid}: {p['total_screen_time']:.1f}s, "
                f"{p['first_seen']:.1f}s -> {p['last_seen']:.1f}s, "
                f"{len(p['appearances'])} frames")

        output = {
            "persons": persons,
            "cosine_threshold": args.cosine_threshold,
            "min_screen_time_seconds": args.min_screen_time,
            "filtered_short_lived": filtered,
        }
        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def strip_embedding(app):
    """Return a copy of an appearance without its embedding field — saves space
    in the persons JSON (per-frame embeddings live in the faces JSON if needed)."""
    return {k: v for k, v in app.items() if k != "embedding"}


def cosine_distance(a, b):
    """1 - cosine_similarity. 0 = identical direction, 1 = orthogonal, 2 = opposite."""
    dot = 0.0
    na = 0.0
    nb = 0.0
    for i in range(len(a)):
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    if na == 0 or nb == 0:
        return 1.0
    sim = dot / (math.sqrt(na) * math.sqrt(nb))
    # Clamp because float drift can push sim slightly outside [-1, 1].
    sim = max(-1.0, min(1.0, sim))
    return 1.0 - sim


if __name__ == '__main__':
    main()
