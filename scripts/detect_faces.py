#!/usr/bin/env python3
"""Detect and track faces in video.

Two detector backends:
- `mtcnn` (default): facenet-pytorch MTCNN + InceptionResnetV1 embeddings + 5-point landmarks.
  Mouth-region lip_movement is anchored to the actual mouth landmarks.
- `haar`: legacy OpenCV Haar cascade. No embeddings, lip_movement uses the
  lower-40% bbox slice. Kept for the useIdentityTracking=false fallback.
"""

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
    parser.add_argument('--detector', choices=['mtcnn', 'haar'], default='mtcnn',
                        help='Detector backend (mtcnn produces embeddings)')
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
        log(f"Detector: {args.detector}")

        if args.detector == 'mtcnn':
            faces_output = detect_mtcnn(cap, fps, width, height, args.sample_rate, np, cv2)
        else:
            faces_output = detect_haar(cap, fps, width, height, args.sample_rate, np, cv2)

        cap.release()

        output = {
            "fps": round(fps, 2),
            "width": width,
            "height": height,
            "sample_rate": args.sample_rate,
            "detector": args.detector,
            "faces": faces_output,
            "frame_count": total_frames,
            "duration": round(duration, 3),
        }

        log(f"Done: {len(faces_output)} face track(s) tracked")
        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


# ---------------------------------------------------------------------------
# MTCNN backend
# ---------------------------------------------------------------------------

def detect_mtcnn(cap, fps, width, height, sample_rate, np, cv2):
    try:
        import torch
    except Exception as e:
        raise RuntimeError(f"Failed to import torch: {e!r}") from e
    try:
        from facenet_pytorch import MTCNN, InceptionResnetV1
    except Exception as e:
        raise RuntimeError(f"Failed to import facenet_pytorch: {e!r}") from e

    device = torch.device('cpu')
    # keep_all=True so the detector returns every face, not just the most
    # confident — we need all of them for crowd shots / interviews.
    # min_face_size scaled to source height so tiny background faces don't
    # bait the detector (these are the ad/poster faces the old Haar path
    # locked onto).
    min_face_px = max(40, int(height * 0.06))
    mtcnn = MTCNN(
        image_size=160, margin=14, keep_all=True, post_process=False,
        device=device, min_face_size=min_face_px, thresholds=[0.6, 0.7, 0.7],
    )
    # vggface2 weights are the canonical face-recognition embeddings used in
    # most FaceNet benchmarks. ~110 MB one-time download on first run.
    resnet = InceptionResnetV1(pretrained='vggface2').to(device)
    resnet.train(False)  # equivalent to .eval(), turns off dropout/batchnorm

    frame_interval = int(fps / sample_rate) if sample_rate > 0 else int(fps)
    frame_interval = max(1, frame_interval)

    face_tracks = {}
    next_face_id = 0
    prev_mouth_rois = {}

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
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        try:
            with torch.no_grad():
                boxes, probs, landmarks = mtcnn.detect(rgb, landmarks=True)
        except Exception as e:
            # Most often a single-frame decode glitch; skip and continue.
            log(f"  WARN frame {frame_idx}: {e}")
            frame_idx += 1
            continue

        if boxes is None or len(boxes) == 0:
            frame_idx += 1
            continue

        # Compute embeddings in a single batched pass for all faces in the frame.
        face_crops = []
        valid_indices = []
        for i, box in enumerate(boxes):
            crop = crop_and_align(rgb, box, np, cv2, size=160)
            if crop is not None:
                face_crops.append(crop)
                valid_indices.append(i)

        embeddings = []
        if face_crops:
            with torch.no_grad():
                batch = torch.from_numpy(np.stack(face_crops)).permute(0, 3, 1, 2).float()
                batch = (batch - 127.5) / 128.0  # facenet-pytorch standard norm
                emb_tensor = resnet(batch.to(device))
                embeddings = emb_tensor.detach().cpu().numpy().tolist()

        # Build per-detection bundle (box, landmarks, embedding) for matching.
        detections = []
        for k, i in enumerate(valid_indices):
            x1, y1, x2, y2 = boxes[i]
            x, y, w, h = int(x1), int(y1), int(x2 - x1), int(y2 - y1)
            lms = landmarks[i] if landmarks is not None else None
            detections.append({
                "rect": (x, y, w, h),
                "landmarks": lms,
                "embedding": embeddings[k] if k < len(embeddings) else None,
                "prob": float(probs[i]) if probs is not None else 0.0,
            })

        # Match to existing tracks by position (same heuristic as Haar). The
        # real cross-frame identity is recovered later in cluster_identities.py
        # by clustering embeddings — these short-lived tracks just give us a
        # stable handle for computing lip_movement frame-to-frame.
        matched = match_detections_to_tracks(detections, face_tracks, width)

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        for det, track_id in matched:
            x, y, w, h = det["rect"]
            if track_id is None:
                track_id = f"FACE_{next_face_id}"
                next_face_id += 1
                face_tracks[track_id] = []

            center_x = x + w / 2
            if center_x < width * 0.35:
                position = "left"
            elif center_x > width * 0.65:
                position = "right"
            else:
                position = "center"

            # Lip movement from the mouth landmark ROI (anchored to the actual
            # mouth, not a fixed slice of the bbox — head turns / smiles /
            # blinks won't trigger it the way the old slice did).
            lip_movement = 0.0
            mouth_roi = extract_mouth_roi(gray, det["landmarks"], width, height, np)
            if mouth_roi is not None and mouth_roi.size > 0:
                prev_roi = prev_mouth_rois.get(track_id)
                if prev_roi is not None and prev_roi.shape == mouth_roi.shape:
                    diff = cv2.absdiff(prev_roi, mouth_roi)
                    lip_movement = float(np.mean(diff)) / 255.0
                    # Same 5x sensitivity as the Haar path, so downstream
                    # thresholds calibrated against Haar data still read.
                    lip_movement = min(1.0, lip_movement * 5)
                prev_mouth_rois[track_id] = mouth_roi.copy()

            appearance = {
                "time": round(time_sec, 3),
                "bbox": [x, y, w, h],
                "lip_movement": round(lip_movement, 3),
                "position": position,
            }
            lms = det["landmarks"]
            if lms is not None:
                appearance["landmarks"] = {
                    "leftEye":   [float(lms[0][0]), float(lms[0][1])],
                    "rightEye":  [float(lms[1][0]), float(lms[1][1])],
                    "nose":      [float(lms[2][0]), float(lms[2][1])],
                    "mouthLeft": [float(lms[3][0]), float(lms[3][1])],
                    "mouthRight":[float(lms[4][0]), float(lms[4][1])],
                }
            if det["embedding"] is not None:
                # Round to 5 decimals to keep the JSON ~5x smaller without
                # measurably degrading cosine-distance clustering.
                appearance["embedding"] = [round(v, 5) for v in det["embedding"]]

            face_tracks[track_id].append(appearance)

        sampled += 1
        if sampled % 50 == 0:
            log(f"  Processed {sampled} sampled frames ({time_sec:.1f}s)")

        frame_idx += 1

    # Filter very short tracks (noise). cluster_identities.py runs a second,
    # stricter screen-time filter after embedding clusters are formed.
    min_appearances = max(3, sampled * 0.01)
    filtered = {
        fid: {"appearances": apps}
        for fid, apps in face_tracks.items()
        if len(apps) >= min_appearances
    }
    return filtered


def crop_and_align(rgb, box, np, cv2, size=160):
    """Crop bbox out of rgb, resize to (size, size). Returns uint8 HWC or None."""
    h_img, w_img = rgb.shape[:2]
    x1, y1, x2, y2 = box
    x1 = max(0, int(x1))
    y1 = max(0, int(y1))
    x2 = min(w_img, int(x2))
    y2 = min(h_img, int(y2))
    if x2 <= x1 + 4 or y2 <= y1 + 4:
        return None
    crop = rgb[y1:y2, x1:x2]
    try:
        return cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    except Exception:
        return None


def extract_mouth_roi(gray, landmarks, frame_w, frame_h, np):
    """Cut a small rectangle centered on the mouth landmarks for lip-movement."""
    if landmarks is None:
        return None
    mouth_left = landmarks[3]
    mouth_right = landmarks[4]
    cx = (mouth_left[0] + mouth_right[0]) / 2
    cy = (mouth_left[1] + mouth_right[1]) / 2
    mouth_w = float(np.hypot(mouth_right[0] - mouth_left[0], mouth_right[1] - mouth_left[1]))
    if mouth_w < 4:
        return None
    # Slightly larger than the corner-to-corner span so the upper lip / chin
    # ridge are inside the ROI (lip-movement needs both sides of the mouth).
    half_w = mouth_w * 0.9
    half_h = mouth_w * 0.55

    x1 = int(max(0, cx - half_w))
    x2 = int(min(frame_w, cx + half_w))
    y1 = int(max(0, cy - half_h))
    y2 = int(min(frame_h, cy + half_h))
    if x2 <= x1 + 2 or y2 <= y1 + 2:
        return None
    return gray[y1:y2, x1:x2]


# ---------------------------------------------------------------------------
# Haar backend (legacy fallback)
# ---------------------------------------------------------------------------

def detect_haar(cap, fps, width, height, sample_rate, np, cv2):
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(cascade_path)

    if face_cascade.empty():
        raise RuntimeError("Failed to load face cascade classifier")

    frame_interval = int(fps / sample_rate) if sample_rate > 0 else int(fps)
    frame_interval = max(1, frame_interval)

    face_tracks = {}
    next_face_id = 0
    prev_gray_faces = {}

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

        faces = face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5,
            minSize=(int(width * 0.05), int(height * 0.05))
        )

        detections = [
            {"rect": (int(f[0]), int(f[1]), int(f[2]), int(f[3])),
             "landmarks": None, "embedding": None, "prob": 0.0}
            for f in faces
        ]
        matched = match_detections_to_tracks(detections, face_tracks, width)

        for det, track_id in matched:
            x, y, w, h = det["rect"]
            if track_id is None:
                track_id = f"FACE_{next_face_id}"
                next_face_id += 1
                face_tracks[track_id] = []

            center_x = x + w / 2
            if center_x < width * 0.35:
                position = "left"
            elif center_x > width * 0.65:
                position = "right"
            else:
                position = "center"

            lip_movement = 0.0
            mouth_region = gray[y + int(h * 0.6):y + h, x + int(w * 0.2):x + int(w * 0.8)]
            if track_id in prev_gray_faces and mouth_region.size > 0:
                prev_mouth = prev_gray_faces[track_id]
                if prev_mouth.shape == mouth_region.shape:
                    diff = cv2.absdiff(prev_mouth, mouth_region)
                    lip_movement = float(np.mean(diff)) / 255.0
                    lip_movement = min(1.0, lip_movement * 5)
            if mouth_region.size > 0:
                prev_gray_faces[track_id] = mouth_region.copy()

            face_tracks[track_id].append({
                "time": round(time_sec, 3),
                "bbox": [x, y, w, h],
                "lip_movement": round(lip_movement, 3),
                "position": position,
            })

        sampled += 1
        if sampled % 100 == 0:
            log(f"  Processed {sampled} frames ({time_sec:.1f}s)")

        frame_idx += 1

    min_appearances = max(3, sampled * 0.01)
    return {
        fid: {"appearances": apps}
        for fid, apps in face_tracks.items()
        if len(apps) >= min_appearances
    }


# ---------------------------------------------------------------------------
# Shared per-frame face -> track matcher
# ---------------------------------------------------------------------------

def match_detections_to_tracks(detections, existing_tracks, frame_width):
    """Match each detection to the nearest existing track by horizontal center.

    Intentionally shallow — it only stabilises per-frame matching enough to
    compute lip_movement. The real cross-frame identity (which is what fixes
    the ad-face / non-speaker problem) comes from clustering embeddings in
    cluster_identities.py.
    """
    results = []
    if not detections:
        return results

    track_positions = {}
    for track_id, appearances in existing_tracks.items():
        if appearances:
            last = appearances[-1]
            cx = last["bbox"][0] + last["bbox"][2] / 2
            track_positions[track_id] = cx

    used_tracks = set()

    for det in detections:
        x, y, w, h = det["rect"]
        center_x = x + w / 2
        best_track = None
        best_dist = frame_width * 0.15

        for track_id, track_cx in track_positions.items():
            if track_id in used_tracks:
                continue
            dist = abs(center_x - track_cx)
            if dist < best_dist:
                best_dist = dist
                best_track = track_id

        if best_track:
            used_tracks.add(best_track)
        results.append((det, best_track))

    return results


if __name__ == '__main__':
    main()
