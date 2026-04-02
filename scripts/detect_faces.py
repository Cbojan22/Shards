#!/usr/bin/env python3
"""Detect and track faces in video using OpenCV with lip movement analysis."""

import argparse
import json
import sys
import os

def log(msg):
    print(msg, file=sys.stderr, flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, help='Path to video file')
    parser.add_argument('--sample-rate', type=float, default=2.0,
                        help='Frames to sample per second')
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(json.dumps({"error": f"Input file not found: {args.input}"}))
        sys.exit(1)

    try:
        import cv2
        import numpy as np
    except ImportError:
        print(json.dumps({"error": "opencv-python not installed. Run: pip install opencv-python-headless"}))
        sys.exit(1)

    try:
        cap = cv2.VideoCapture(args.input)
        if not cap.isOpened():
            print(json.dumps({"error": f"Cannot open video: {args.input}"}))
            sys.exit(1)

        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_frames / fps

        log(f"Video: {width}x{height} @ {fps:.1f}fps, {duration:.1f}s, {total_frames} frames")

        # Load Haar cascade for face detection
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        face_cascade = cv2.CascadeClassifier(cascade_path)

        if face_cascade.empty():
            print(json.dumps({"error": "Failed to load face cascade classifier"}))
            sys.exit(1)

        # Sample frames
        frame_interval = int(fps / args.sample_rate) if args.sample_rate > 0 else int(fps)
        frame_interval = max(1, frame_interval)

        # Track faces across frames
        face_tracks = {}  # face_id -> list of appearances
        next_face_id = 0
        prev_gray_faces = {}  # face_id -> previous grayscale face region

        frame_idx = 0
        sampled = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % frame_interval != 0:
                frame_idx += 1
                continue

            time_sec = frame_idx / fps
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            # Detect faces
            faces = face_cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=5,
                minSize=(int(width * 0.05), int(height * 0.05))
            )

            # Match detected faces to existing tracks
            matched = match_faces_to_tracks(faces, face_tracks, width)

            for face_rect, track_id in matched:
                x, y, w, h = face_rect

                if track_id is None:
                    track_id = f"FACE_{next_face_id}"
                    next_face_id += 1
                    face_tracks[track_id] = []

                # Determine position in frame
                center_x = x + w / 2
                if center_x < width * 0.35:
                    position = "left"
                elif center_x > width * 0.65:
                    position = "right"
                else:
                    position = "center"

                # Estimate lip movement by comparing mouth region with previous frame
                lip_movement = 0.0
                mouth_region = gray[y + int(h * 0.6):y + h, x + int(w * 0.2):x + int(w * 0.8)]

                if track_id in prev_gray_faces and mouth_region.size > 0:
                    prev_mouth = prev_gray_faces[track_id]
                    if prev_mouth.shape == mouth_region.shape and mouth_region.size > 0:
                        diff = cv2.absdiff(prev_mouth, mouth_region)
                        lip_movement = float(np.mean(diff)) / 255.0
                        lip_movement = min(1.0, lip_movement * 5)  # Scale up for sensitivity

                if mouth_region.size > 0:
                    prev_gray_faces[track_id] = mouth_region.copy()

                face_tracks[track_id].append({
                    "time": round(time_sec, 3),
                    "bbox": [int(x), int(y), int(w), int(h)],
                    "lip_movement": round(lip_movement, 3),
                    "position": position,
                })

            sampled += 1
            if sampled % 100 == 0:
                log(f"  Processed {sampled} frames ({time_sec:.1f}s / {duration:.1f}s)")

            frame_idx += 1

        cap.release()

        # Filter out very short tracks (noise)
        min_appearances = max(3, sampled * 0.01)
        filtered_faces = {
            fid: {"appearances": apps}
            for fid, apps in face_tracks.items()
            if len(apps) >= min_appearances
        }

        output = {
            "fps": round(fps, 2),
            "width": width,
            "height": height,
            "sample_rate": args.sample_rate,
            "faces": filtered_faces,
            "frame_count": total_frames,
            "duration": round(duration, 3),
        }

        log(f"Done: {len(filtered_faces)} faces tracked across {sampled} sampled frames")
        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def match_faces_to_tracks(detected_faces, existing_tracks, frame_width):
    """Match detected face rectangles to existing face tracks by position proximity."""
    results = []

    if len(detected_faces) == 0:
        return results

    # Get last known position for each track
    track_positions = {}
    for track_id, appearances in existing_tracks.items():
        if appearances:
            last = appearances[-1]
            cx = last["bbox"][0] + last["bbox"][2] / 2
            track_positions[track_id] = cx

    used_tracks = set()

    for face in detected_faces:
        x, y, w, h = face
        center_x = x + w / 2
        best_track = None
        best_dist = frame_width * 0.15  # Max matching distance: 15% of frame width

        for track_id, track_cx in track_positions.items():
            if track_id in used_tracks:
                continue
            dist = abs(center_x - track_cx)
            if dist < best_dist:
                best_dist = dist
                best_track = track_id

        if best_track:
            used_tracks.add(best_track)

        results.append(((int(x), int(y), int(w), int(h)), best_track))

    return results


if __name__ == '__main__':
    main()
