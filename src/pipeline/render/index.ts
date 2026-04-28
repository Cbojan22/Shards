import path from 'path';
import { mkdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  ViralClip,
  TranscriptResult,
  TranscriptSegment,
  FaceDetectionResult,
  FaceAppearance,
  SpeakerFaceMapping,
  ExportOptions,
  ClipRenderJob,
} from '../../types/index.js';
import { renderClipWithReframe } from '../../utils/ffmpeg.js';
import { generateCaptions } from '../captions/index.js';

interface CropKeyframe {
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
  speaker: string;
  // True when `x` came from an actual face detection at this timestep. False
  // means the value is a placeholder that the gap-fill pass should replace by
  // interpolating between surrounding real detections — important so the
  // smoother never averages real positions with a "no face → defaultX" value
  // and drifts the camera toward the middle of the room.
  hasFace: boolean;
}

// Padding applied AFTER snapping to segment boundaries, so we both capture
// the full sentence and leave a little breath/lead-in around it.
const START_PADDING_SECONDS = 0.3;
const END_PADDING_SECONDS = 1.0;

// Snap a clip to the surrounding transcript segments: extend the start back to
// the beginning of the first sentence the AI's selection landed inside, and
// the end forward to the end of the last sentence. Anthropic occasionally
// picks boundaries mid-word; this guarantees we don't cut off context.
function snapClipToSegments(
  clipStart: number,
  clipEnd: number,
  transcript: TranscriptResult,
): { start: number; end: number } {
  let snappedStart = clipStart;
  let snappedEnd = clipEnd;

  for (const seg of transcript.segments) {
    // Segment that contains (or starts just after) the requested start →
    // pull back to the segment's start so we begin at the sentence boundary.
    if (seg.start < clipStart && seg.end > clipStart) {
      snappedStart = Math.min(snappedStart, seg.start);
    }
    // Segment that contains (or ends just before) the requested end → push
    // forward to the segment's end so we capture the full thought.
    if (seg.start < clipEnd && seg.end > clipEnd) {
      snappedEnd = Math.max(snappedEnd, seg.end);
    }
  }

  return { start: snappedStart, end: snappedEnd };
}

export async function renderClip(
  job: ClipRenderJob,
  onProgress?: (msg: string) => void
): Promise<string> {
  const { clip, inputPath, outputPath, exportOptions, speakerFaceMap, faceData, transcript } = job;

  onProgress?.(`Rendering clip: ${clip.title}`);

  const sourceW = faceData.width || 1920;
  const sourceH = faceData.height || 1080;
  const sourceDuration = faceData.duration || transcript.duration || clip.end + END_PADDING_SECONDS;

  // 1. Snap to sentence boundaries so we never cut mid-thought.
  // 2. Add a small breath at the start and the existing trailing buffer.
  // 3. Clamp to the source's actual duration.
  const snapped = snapClipToSegments(clip.start, clip.end, transcript);
  const startTime = Math.max(0, snapped.start - START_PADDING_SECONDS);
  const endTime = Math.min(sourceDuration, snapped.end + END_PADDING_SECONDS);

  // Generate crop keyframes following active speaker's face. The video format
  // determines how wide the source crop is — fullscreen = 9:16 close-up,
  // centered = wider 9:8 region that will later be padded with black bars.
  const keyframes = generateCropKeyframes(
    { ...clip, start: startTime, end: endTime }, transcript, faceData, speakerFaceMap, sourceW, sourceH,
    exportOptions.videoFormat
  );


  // Generate captions if enabled. The ASS file lives in tmpdir for the
  // duration of the burn-in pass — we only need it as a libass input, and
  // the user wants the output folder to contain finished mp4s only, no
  // working files.
  let subtitlePath: string | undefined;
  if (exportOptions.withCaptions) {
    subtitlePath = path.join(tmpdir(), `shards_caption_${clip.id}_${randomUUID()}.ass`);
    await generateCaptions(
      transcript, startTime, endTime, exportOptions.captionStyle, subtitlePath
    );
    onProgress?.('  Captions generated');
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  try {
    await renderClipWithReframe({
      inputPath,
      outputPath,
      start: startTime,
      end: endTime,
      cropKeyframes: keyframes.map((kf) => ({
        time: kf.time,
        x: kf.x,
        y: kf.y,
        w: kf.width,
        h: kf.height,
      })),
      resolution: exportOptions.resolution,
      quality: exportOptions.quality,
      subtitlePath,
      videoFormat: exportOptions.videoFormat,
    });
  } finally {
    if (subtitlePath) await unlink(subtitlePath).catch(() => {});
  }

  onProgress?.(`  Rendered: ${path.basename(outputPath)}`);
  return outputPath;
}

export function generateCropKeyframes(
  clip: ViralClip,
  transcript: TranscriptResult,
  faceData: FaceDetectionResult,
  speakerFaceMap: SpeakerFaceMapping,
  sourceWidth: number,
  sourceHeight: number,
  videoFormat: 'fullscreen' | 'centered' = 'fullscreen'
): CropKeyframe[] {
  const cropHeight = sourceHeight;
  // Fullscreen: 9:16 crop fills the output frame top-to-bottom.
  // Centered: 9:8 crop (twice as wide) will later be scaled into the middle
  // half of the 9:16 output, with equal black bars above and below.
  const cropAspect = videoFormat === 'centered' ? 9 / 8 : 9 / 16;
  const cropWidth = Math.min(Math.round(sourceHeight * cropAspect), sourceWidth);
  const defaultX = Math.round((sourceWidth - cropWidth) / 2);

  const keyframes: CropKeyframe[] = [];
  const interval = 0.5; // sample every 0.5s (was 0.25)
  const clipDuration = clip.end - clip.start;

  // The diarization in transcribe.py just flips SPEAKER_0/SPEAKER_1 on every
  // >1.5s silence gap — labels don't correspond to real speaker identities.
  // That makes the speaker→face mapping noisy. We gate on its self-reported
  // confidence: above this floor we trust the mapping; below it, we fall
  // through to whichever face the size+center scoring picks (largest face,
  // which is reliably the active speaker in a close-up).
  const SPEAKER_MAP_MIN_CONFIDENCE = 0.4;

  // Dominant speaker = whoever talks the most in this clip. Used as a
  // tie-breaker when the active speaker can't be determined for an individual
  // keyframe (silence, sub-second pause). Only resolved to a face when the
  // mapping confidence clears the floor — otherwise the fallback would lock
  // onto whichever wrong face the noisy mapping pointed at for the whole clip.
  const dominantSpeaker = findDominantSpeaker(clip.start, clip.end, transcript.segments);
  const dominantFaceId =
    dominantSpeaker &&
    (speakerFaceMap.confidence[dominantSpeaker] ?? 0) >= SPEAKER_MAP_MIN_CONFIDENCE
      ? speakerFaceMap.mapping[dominantSpeaker] ?? null
      : null;

  for (let t = 0; t <= clipDuration; t += interval) {
    const absTime = clip.start + t;
    const speaker = getActiveSpeaker(absTime, transcript.segments);

    let targetFaceId: string | null = null;
    if (speaker && (speakerFaceMap.confidence[speaker] ?? 0) >= SPEAKER_MAP_MIN_CONFIDENCE) {
      targetFaceId = speakerFaceMap.mapping[speaker] ?? null;
    } else if (dominantFaceId) {
      targetFaceId = dominantFaceId;
    }
    const facePos = findBestVisibleFace(absTime, faceData, targetFaceId);

    let x = defaultX;
    let hasFace = false;
    if (facePos) {
      hasFace = true;
      // Center the speaker's face in the output crop. Earlier code blended
      // the crop center with the source's geometric center — that's what was
      // pushing speakers off to one side of the output frame.
      const faceCenterX = facePos.x + facePos.w / 2;
      x = Math.round(faceCenterX - cropWidth / 2);
      x = Math.max(0, Math.min(x, sourceWidth - cropWidth));
    }

    keyframes.push({
      time: t,
      x,
      y: 0,
      width: cropWidth,
      height: cropHeight,
      speaker: speaker || 'unknown',
      hasFace,
    });
  }

  // Replace every "no face" keyframe with an interpolated value drawn from the
  // surrounding real detections — leading/trailing gaps carry the nearest
  // valid x; middle gaps are linearly interpolated between bookends. This
  // matters because the smoother below averages a window of keyframes; if any
  // window member still held the defaultX placeholder, the average would drift
  // the crop toward the center of the source frame.
  fillKeyframeGaps(keyframes);

  // Smooth keyframes to reduce jitter (larger window for smoother motion)
  return smoothKeyframes(keyframes, 7, sourceWidth);
}

function fillKeyframeGaps(keyframes: CropKeyframe[]): void {
  const firstValid = keyframes.findIndex((k) => k.hasFace);
  if (firstValid === -1) {
    // No face was ever detected in this clip — leave the placeholder centers.
    // This degrades to a simple center-crop, which is the least bad option.
    return;
  }

  // Forward-fill leading gap with the first valid x.
  const firstX = keyframes[firstValid].x;
  for (let i = 0; i < firstValid; i++) {
    keyframes[i].x = firstX;
  }

  // Backward-fill trailing gap with the last valid x.
  let lastValid = keyframes.length - 1;
  while (lastValid >= 0 && !keyframes[lastValid].hasFace) lastValid--;
  const lastX = keyframes[lastValid].x;
  for (let i = lastValid + 1; i < keyframes.length; i++) {
    keyframes[i].x = lastX;
  }

  // Linearly interpolate middle gaps between the bookend valid keyframes.
  let i = firstValid + 1;
  while (i <= lastValid) {
    if (keyframes[i].hasFace) {
      i++;
      continue;
    }
    const runStart = i;
    while (i <= lastValid && !keyframes[i].hasFace) i++;
    const startX = keyframes[runStart - 1].x;
    const endX = keyframes[i].x;
    const span = i - (runStart - 1);
    for (let j = runStart; j < i; j++) {
      const t = (j - (runStart - 1)) / span;
      keyframes[j].x = Math.round(startX + (endX - startX) * t);
    }
  }
}

function smoothKeyframes(
  keyframes: CropKeyframe[],
  windowSize: number,
  sourceWidth: number,
): CropKeyframe[] {
  if (keyframes.length <= windowSize) return keyframes;

  // A keyframe-to-keyframe x jump larger than this is a hard camera cut, not
  // an actual head movement. We refuse to smooth across cuts because the
  // average between two unrelated angles lands in the empty middle of the
  // source frame — exactly the "neither speaker visible" symptom. The
  // speaker-label check below catches changes when diarization is reliable;
  // this catches them when it isn't.
  const CUT_THRESHOLD_PX = sourceWidth * 0.25;

  const smoothed: CropKeyframe[] = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < keyframes.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(keyframes.length - 1, i + half);

    const currentSpeaker = keyframes[i].speaker;
    let hasBoundary = false;
    for (let j = start; j <= end; j++) {
      if (keyframes[j].speaker !== currentSpeaker) {
        hasBoundary = true;
        break;
      }
    }
    if (!hasBoundary) {
      for (let j = start + 1; j <= end; j++) {
        if (Math.abs(keyframes[j].x - keyframes[j - 1].x) > CUT_THRESHOLD_PX) {
          hasBoundary = true;
          break;
        }
      }
    }

    if (hasBoundary) {
      // Preserve the cut — don't average across it.
      smoothed.push({ ...keyframes[i] });
    } else {
      let sumX = 0;
      let count = 0;
      for (let j = start; j <= end; j++) {
        sumX += keyframes[j].x;
        count++;
      }
      smoothed.push({
        ...keyframes[i],
        x: Math.round(sumX / count),
      });
    }
  }

  return smoothed;
}

// Total speaking time per speaker across the clip's range — whoever leads
// is the "primary subject" we should default to when frame-level speaker
// detection is ambiguous.
function findDominantSpeaker(
  clipStart: number,
  clipEnd: number,
  segments: TranscriptSegment[],
): string | null {
  const time: Record<string, number> = {};
  for (const seg of segments) {
    if (seg.end <= clipStart || seg.start >= clipEnd) continue;
    const overlap = Math.min(seg.end, clipEnd) - Math.max(seg.start, clipStart);
    if (overlap > 0) {
      time[seg.speaker] = (time[seg.speaker] ?? 0) + overlap;
    }
  }
  let best: string | null = null;
  let bestT = 0;
  for (const [spk, t] of Object.entries(time)) {
    if (t > bestT) {
      bestT = t;
      best = spk;
    }
  }
  return best;
}

export function getActiveSpeaker(
  time: number,
  segments: TranscriptSegment[]
): string | null {
  for (const seg of segments) {
    if (time >= seg.start && time <= seg.end) {
      return seg.speaker;
    }
  }

  // Find nearest segment if we're in a gap
  let closest: TranscriptSegment | null = null;
  let closestDist = Infinity;

  for (const seg of segments) {
    const dist = Math.min(Math.abs(seg.start - time), Math.abs(seg.end - time));
    if (dist < closestDist && dist < 2.0) {
      closestDist = dist;
      closest = seg;
    }
  }

  return closest?.speaker || null;
}


function bboxToRect(app: FaceAppearance): { x: number; y: number; w: number; h: number } {
  return { x: app.bbox[0], y: app.bbox[1], w: app.bbox[2], h: app.bbox[3] };
}

/**
 * Find the best visible face at a given time across all tracked faces.
 * If `targetFaceId` is provided, that face gets a strong scoring bonus so the
 * crop locks onto the active speaker even when another face is larger on
 * screen — but the bonus is multiplicative, so a missing/tiny target face will
 * still cleanly fall through to the next-best candidate.
 */
function findBestVisibleFace(
  time: number,
  faceData: FaceDetectionResult,
  targetFaceId: string | null = null,
): { x: number; y: number; w: number; h: number } | null {
  // A face track is only eligible at `time` if it has an appearance within
  // this window in either direction. Beyond it, the camera has almost
  // certainly cut to a different angle and the stale position doesn't match
  // what's on screen any more.
  const FRESHNESS_LIMIT_SECONDS = 2;
  // The target face gets a strong-but-not-absolute scoring bonus. Soft
  // preference: when the speaker→face mapping is correct it picks the right
  // face even if a larger phantom is on screen, but if the target track has
  // no nearby appearance the next-best real face still wins.
  const TARGET_FACE_BONUS = 5;

  let bestFace: { x: number; y: number; w: number; h: number } | null = null;
  let bestScore = -Infinity;

  for (const [faceId, data] of Object.entries(faceData.faces)) {
    const apps = data.appearances;
    if (apps.length < 5) continue;

    // Find nearest appearances for interpolation
    let before: FaceAppearance | null = null;
    let after: FaceAppearance | null = null;

    for (const app of apps) {
      if (app.time <= time && (!before || app.time > before.time)) before = app;
      if (app.time >= time && (!after || app.time < after.time)) after = app;
    }

    // Reject backward extrapolation: a face track whose first sighting is in
    // the future hasn't been seen yet. Using that first-sighting position for
    // earlier frames leaks a close-up's coordinates into the preceding wide
    // shot, putting the crop in the empty middle of the room.
    if (!before) continue;

    const beforeAge = time - before.time;
    // Apply the freshness limit to `before` UNCONDITIONALLY — not just when
    // `after` is null. Previously this guard only fired without an `after`,
    // which let stale tracks (e.g. an interviewer's close-up that reappears
    // 30s later) project their position into intervening wide-shot frames
    // because the long-distance `after` made the function think it had
    // valid interpolation data.
    if (beforeAge > FRESHNESS_LIMIT_SECONDS) continue;

    // `after` is only a useful interpolation bookend when it's also within
    // the freshness window. A far-future appearance means there's a multi-
    // second gap that almost always spans camera cuts — interpolating across
    // it produces phantom mid-cut positions. Drop it and use `before` alone.
    const usableAfter = after && after.time - time <= FRESHNESS_LIMIT_SECONDS ? after : null;

    let pos: { x: number; y: number; w: number; h: number };
    if (usableAfter && usableAfter !== before) {
      const t = (time - before.time) / (usableAfter.time - before.time);
      pos = {
        x: before.bbox[0] + (usableAfter.bbox[0] - before.bbox[0]) * t,
        y: before.bbox[1] + (usableAfter.bbox[1] - before.bbox[1]) * t,
        w: before.bbox[2] + (usableAfter.bbox[2] - before.bbox[2]) * t,
        h: before.bbox[3] + (usableAfter.bbox[3] - before.bbox[3]) * t,
      };
    } else {
      pos = bboxToRect(before);
    }
    const nearestDist = usableAfter
      ? Math.min(beforeAge, usableAfter.time - time)
      : beforeAge;

    // Score by face size (larger = better), time proximity, and center preference.
    const faceCenterX = pos.x + pos.w / 2;
    const frameW = faceData.width || 1920;
    const distFromCenter = Math.abs(faceCenterX - frameW / 2) / (frameW / 2);
    const centerBonus = 1 - distFromCenter * 0.5;
    const speakerBonus = targetFaceId && faceId === targetFaceId ? TARGET_FACE_BONUS : 1;
    const score = pos.w * pos.h * centerBonus * speakerBonus / (1 + nearestDist * 0.5);
    if (score > bestScore) {
      bestScore = score;
      bestFace = pos;
    }
  }

  return bestFace;
}

export async function renderAllClips(
  clips: ViralClip[],
  inputPath: string,
  transcript: TranscriptResult,
  faceData: FaceDetectionResult,
  speakerFaceMap: SpeakerFaceMapping,
  exportOptions: ExportOptions,
  onProgress?: (msg: string) => void
): Promise<string[]> {
  const outputPaths: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const ext = exportOptions.format === 'webm' ? 'webm' : exportOptions.format === 'mov' ? 'mov' : 'mp4';
    const filename = `${clip.id}_${sanitizeFilename(clip.title)}.${ext}`;
    const outputPath = path.join(exportOptions.outputDir, filename);

    onProgress?.(`[${i + 1}/${clips.length}] Rendering: ${clip.title}`);

    const job: ClipRenderJob = {
      clip,
      inputPath,
      outputPath,
      exportOptions,
      speakerFaceMap,
      faceData,
      transcript,
    };

    await renderClip(job, onProgress);
    outputPaths.push(outputPath);
  }

  return outputPaths;
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}
