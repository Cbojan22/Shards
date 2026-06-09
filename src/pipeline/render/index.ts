import path from 'path';
import { mkdir, unlink, writeFile } from 'fs/promises';
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
  IdentityClusterResult,
  TrackingDebugEntry,
  TrackingDebugRecord,
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
  // Area of the target face's bbox at this keyframe, when hasFace=true.
  // Used by `smoothKeyframes` to detect cuts that change shot scale (e.g.
  // cut to close-up of the same speaker) without moving the face's
  // horizontal position much — position-only cut detection misses those.
  // Undefined for gap-filled keyframes so the smoother ignores them when
  // comparing areas.
  faceArea?: number;
}

interface EntityData {
  appearances: FaceAppearance[];
  centroidEmbedding?: number[];
}

// Padding applied AFTER snapping to segment boundaries, so we both capture
// the full sentence and leave a little breath/lead-in around it.
const START_PADDING_SECONDS = 0.3;
const END_PADDING_SECONDS = 1.0;

function snapClipToSegments(
  clipStart: number,
  clipEnd: number,
  transcript: TranscriptResult,
): { start: number; end: number } {
  let snappedStart = clipStart;
  let snappedEnd = clipEnd;

  for (const seg of transcript.segments) {
    if (seg.start < clipStart && seg.end > clipStart) {
      snappedStart = Math.min(snappedStart, seg.start);
    }
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
  const {
    clip, inputPath, outputPath, exportOptions, speakerFaceMap, faceData,
    transcript, personData, debugTracking,
  } = job;

  onProgress?.(`Rendering clip: ${clip.title}`);

  const sourceW = faceData.width || 1920;
  const sourceH = faceData.height || 1080;
  const sourceDuration = faceData.duration || transcript.duration || clip.end + END_PADDING_SECONDS;

  const snapped = snapClipToSegments(clip.start, clip.end, transcript);
  const startTime = Math.max(0, snapped.start - START_PADDING_SECONDS);
  const endTime = Math.min(sourceDuration, snapped.end + END_PADDING_SECONDS);

  const { keyframes, debugRecord } = generateCropKeyframes(
    { ...clip, start: startTime, end: endTime },
    transcript, faceData, speakerFaceMap, sourceW, sourceH,
    {
      videoFormat: exportOptions.videoFormat,
      personData,
      debugTracking,
    },
  );

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

  // Debug-tracking sidecar — light version of the JSON writer that was
  // reverted on 2026-05-18. No .ass sidecar, no _nocap.mp4, just the JSON.
  if (debugRecord) {
    const sidecarPath = outputPath.replace(/\.(mp4|mov|webm)$/i, '_tracking.json');
    await writeFile(sidecarPath, JSON.stringify(debugRecord, null, 2));
    onProgress?.(`  Debug tracking: ${path.basename(sidecarPath)}`);
  }

  onProgress?.(`  Rendered: ${path.basename(outputPath)}`);
  return outputPath;
}

interface CropKeyframesOptions {
  videoFormat: 'fullscreen' | 'centered';
  personData?: IdentityClusterResult;
  debugTracking?: boolean;
}

export function generateCropKeyframes(
  clip: ViralClip,
  transcript: TranscriptResult,
  faceData: FaceDetectionResult,
  speakerFaceMap: SpeakerFaceMapping,
  sourceWidth: number,
  sourceHeight: number,
  options: CropKeyframesOptions = { videoFormat: 'fullscreen' },
): { keyframes: CropKeyframe[]; debugRecord?: TrackingDebugRecord } {
  const { videoFormat, personData, debugTracking } = options;
  const cropHeight = sourceHeight;
  const cropAspect = videoFormat === 'centered' ? 9 / 8 : 9 / 16;
  const cropWidth = Math.min(Math.round(sourceHeight * cropAspect), sourceWidth);
  const defaultX = Math.round((sourceWidth - cropWidth) / 2);

  // Identity mode: tracking entities are persons (stable identities across
  // the whole video). Legacy mode: tracking entities are per-frame face tracks.
  // Same iteration shape, different identity granularity.
  const entities: Record<string, EntityData> = personData
    ? Object.fromEntries(Object.entries(personData.persons).map(([id, p]) => [id, {
        appearances: p.appearances,
        centroidEmbedding: p.centroid_embedding,
      }]))
    : Object.fromEntries(Object.entries(faceData.faces).map(([id, f]) => [id, {
        appearances: f.appearances,
      }]));

  const keyframes: CropKeyframe[] = [];
  const debugEntries: TrackingDebugEntry[] = [];
  const interval = 0.5;
  const clipDuration = clip.end - clip.start;

  // The diarization in transcribe.py just flips SPEAKER_0/SPEAKER_1 on every
  // >1.5s silence gap — labels don't correspond to real speaker identities.
  // We gate on its self-reported confidence: above this floor we trust the
  // mapping; below it, we now fall through to the dominant-screen-time
  // entity in the clip window (used to be "biggest face near source center",
  // which was the path that locked onto ads / posters / non-speakers).
  const SPEAKER_MAP_MIN_CONFIDENCE = 0.4;

  const dominantSpeaker = findDominantSpeaker(clip.start, clip.end, transcript.segments);
  const mappedDominant =
    dominantSpeaker &&
    (speakerFaceMap.confidence[dominantSpeaker] ?? 0) >= SPEAKER_MAP_MIN_CONFIDENCE
      ? speakerFaceMap.mapping[dominantSpeaker] ?? null
      : null;
  // New fallback: the entity that's actually on screen the most during this
  // clip's window. Stable across keyframes and avoids the per-frame
  // biggest-near-center thrash that was the visible bug.
  const dominantEntityInWindow = findDominantEntityInRange(
    clip.start, clip.end, entities,
  );
  const finalFallbackEntity = mappedDominant ?? dominantEntityInWindow;

  for (let t = 0; t <= clipDuration; t += interval) {
    const absTime = clip.start + t;
    const speaker = getActiveSpeaker(absTime, transcript.segments);
    const speakerConfidence = speaker ? (speakerFaceMap.confidence[speaker] ?? 0) : 0;

    let targetEntityId: string | null = null;
    if (speaker && speakerConfidence >= SPEAKER_MAP_MIN_CONFIDENCE) {
      targetEntityId = speakerFaceMap.mapping[speaker] ?? null;
    } else if (finalFallbackEntity) {
      targetEntityId = finalFallbackEntity;
    }

    const pick = findBestVisibleEntity(absTime, entities, sourceWidth, targetEntityId);

    let x = defaultX;
    let hasFace = false;
    let faceArea: number | undefined;
    // Only commit to a face position when (a) we have no target — early in
    // the pipeline before any mapping/fallback decision — or (b) the picker
    // landed on the target we actually wanted. Non-target picks would make
    // the camera jump to whoever happens to be on screen; instead we leave
    // hasFace=false so fillKeyframeGaps interpolates from the target's last
    // known position. This was the visible regression from the identity-
    // tracking revamp: target loses the 5× score bonus to a closer/larger
    // non-speaker face and the crop wanders off the speaker.
    if (pick && (!targetEntityId || pick.entityId === targetEntityId)) {
      hasFace = true;
      const faceCenterX = pick.rect.x + pick.rect.w / 2;
      x = Math.round(faceCenterX - cropWidth / 2);
      x = Math.max(0, Math.min(x, sourceWidth - cropWidth));
      faceArea = pick.rect.w * pick.rect.h;
    }

    keyframes.push({
      time: t,
      x,
      y: 0,
      width: cropWidth,
      height: cropHeight,
      speaker: speaker || 'unknown',
      hasFace,
      faceArea,
    });

    if (debugTracking) {
      const pickedAppearance = pick
        ? findAppearanceAtOrBefore(entities[pick.entityId].appearances, absTime)
        : null;
      const speakerMappedId = speaker ? speakerFaceMap.mapping[speaker] ?? null : null;
      const embeddingDistance = personData && speakerMappedId && pick
        ? cosineDistanceBetween(
            personData.persons[pick.entityId]?.centroid_embedding,
            personData.persons[speakerMappedId]?.centroid_embedding,
          )
        : null;
      debugEntries.push({
        time: Number(absTime.toFixed(3)),
        speaker,
        mappedTargetId: targetEntityId,
        pickedId: pick?.entityId ?? null,
        pickedScore: pick ? Number(pick.score.toFixed(4)) : 0,
        runnerUpId: pick?.runnerUp?.entityId ?? null,
        runnerUpScore: pick?.runnerUp ? Number(pick.runnerUp.score.toFixed(4)) : 0,
        speakerConfidence: Number(speakerConfidence.toFixed(3)),
        lipMovement: pickedAppearance ? pickedAppearance.lip_movement : 0,
        embeddingDistance,
        bbox: pick ? [
          Math.round(pick.rect.x), Math.round(pick.rect.y),
          Math.round(pick.rect.w), Math.round(pick.rect.h),
        ] : null,
      });
    }
  }

  fillKeyframeGaps(keyframes);
  const smoothed = smoothKeyframes(keyframes, 7, sourceWidth);

  const debugRecord: TrackingDebugRecord | undefined = debugTracking ? {
    clipId: clip.id,
    clipTitle: clip.title,
    videoFormat,
    useIdentityTracking: Boolean(personData),
    entries: debugEntries,
  } : undefined;

  return { keyframes: smoothed, debugRecord };
}

function fillKeyframeGaps(keyframes: CropKeyframe[]): void {
  const firstValid = keyframes.findIndex((k) => k.hasFace);
  if (firstValid === -1) return;

  const firstX = keyframes[firstValid].x;
  for (let i = 0; i < firstValid; i++) keyframes[i].x = firstX;

  let lastValid = keyframes.length - 1;
  while (lastValid >= 0 && !keyframes[lastValid].hasFace) lastValid--;
  const lastX = keyframes[lastValid].x;
  for (let i = lastValid + 1; i < keyframes.length; i++) keyframes[i].x = lastX;

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

  const CUT_THRESHOLD_PX = sourceWidth * 0.25;
  // A face that doubles or halves in apparent size within 1s of sampling is
  // essentially always a hard cut to a different shot scale (close-up ↔
  // wide). Natural face motion (lean-in, walk-toward-camera) is far slower
  // than this. Verified across the 7-clip baseline: 9 of 10 area jumps
  // ≥ this ratio co-occur with a position cut, and the 10th is the missed
  // close-up cut that motivated this check — zero false positives.
  const AREA_CUT_RATIO = 2.0;

  const smoothed: CropKeyframe[] = [];
  const half = Math.floor(windowSize / 2);

  const isAreaCut = (a: number | undefined, b: number | undefined): boolean => {
    if (!a || !b) return false;
    return a / b > AREA_CUT_RATIO || b / a > AREA_CUT_RATIO;
  };

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
      // Per-step (0.5s) jumps catch hard cuts that complete in one sample.
      // 2-step (1s) jumps catch cuts whose face-position change ramps across
      // a couple of samples — e.g. a cut to a wider shot where each
      // individual step is below threshold but the total motion isn't. Same
      // threshold for both, so this isn't a tuned parameter, just a wider
      // measurement window applied to the existing one.
      // Area discontinuities catch cuts where the speaker stays at roughly
      // the same horizontal position but the shot scale changes (close-up
      // of the same person), which position-only detection cannot see.
      for (let j = start + 1; j <= end; j++) {
        if (Math.abs(keyframes[j].x - keyframes[j - 1].x) > CUT_THRESHOLD_PX) {
          hasBoundary = true;
          break;
        }
        if (isAreaCut(keyframes[j].faceArea, keyframes[j - 1].faceArea)) {
          hasBoundary = true;
          break;
        }
        if (j >= start + 2) {
          if (Math.abs(keyframes[j].x - keyframes[j - 2].x) > CUT_THRESHOLD_PX) {
            hasBoundary = true;
            break;
          }
          if (isAreaCut(keyframes[j].faceArea, keyframes[j - 2].faceArea)) {
            hasBoundary = true;
            break;
          }
        }
      }
    }

    if (hasBoundary) {
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

// Entity with the most appearances inside the clip window. Used as the
// fallback when the speaker→entity mapping is too low-confidence to trust.
// Replaces the old biggest-face-near-center fallback that locked onto ad
// faces / non-speakers.
function findDominantEntityInRange(
  clipStart: number,
  clipEnd: number,
  entities: Record<string, EntityData>,
): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, data] of Object.entries(entities)) {
    let count = 0;
    for (const app of data.appearances) {
      if (app.time >= clipStart && app.time <= clipEnd) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = id;
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

function findAppearanceAtOrBefore(
  apps: FaceAppearance[],
  time: number,
): FaceAppearance | null {
  let best: FaceAppearance | null = null;
  for (const a of apps) {
    if (a.time <= time && (!best || a.time > best.time)) best = a;
  }
  return best;
}

interface EntityPick {
  entityId: string;
  rect: { x: number; y: number; w: number; h: number };
  score: number;
  runnerUp?: { entityId: string; score: number };
}

/**
 * Find the best-scoring visible entity (face track or person identity) at a
 * given time. Generic over the entity collection — same scoring works for
 * both because both expose an `appearances` list of FaceAppearance.
 *
 * Returns the winner with its rect/score AND the runner-up's id/score so the
 * debug-tracking sidecar can show what was nearly picked.
 */
function findBestVisibleEntity(
  time: number,
  entities: Record<string, EntityData>,
  frameWidth: number,
  targetEntityId: string | null = null,
): EntityPick | null {
  const FRESHNESS_LIMIT_SECONDS = 2;
  const TARGET_ENTITY_BONUS = 5;

  let best: EntityPick | null = null;
  let runnerScore = -Infinity;
  let runnerId: string | null = null;

  for (const [entityId, data] of Object.entries(entities)) {
    const apps = data.appearances;
    if (apps.length < 5) continue;

    let before: FaceAppearance | null = null;
    let after: FaceAppearance | null = null;

    for (const app of apps) {
      if (app.time <= time && (!before || app.time > before.time)) before = app;
      if (app.time >= time && (!after || app.time < after.time)) after = app;
    }

    if (!before) continue;

    const beforeAge = time - before.time;
    if (beforeAge > FRESHNESS_LIMIT_SECONDS) continue;

    const usableAfter = after && after.time - time <= FRESHNESS_LIMIT_SECONDS ? after : null;

    let pos: { x: number; y: number; w: number; h: number };
    if (usableAfter && usableAfter !== before) {
      const tt = (time - before.time) / (usableAfter.time - before.time);
      pos = {
        x: before.bbox[0] + (usableAfter.bbox[0] - before.bbox[0]) * tt,
        y: before.bbox[1] + (usableAfter.bbox[1] - before.bbox[1]) * tt,
        w: before.bbox[2] + (usableAfter.bbox[2] - before.bbox[2]) * tt,
        h: before.bbox[3] + (usableAfter.bbox[3] - before.bbox[3]) * tt,
      };
    } else {
      pos = bboxToRect(before);
    }
    const nearestDist = usableAfter
      ? Math.min(beforeAge, usableAfter.time - time)
      : beforeAge;

    const faceCenterX = pos.x + pos.w / 2;
    const distFromCenter = Math.abs(faceCenterX - frameWidth / 2) / (frameWidth / 2);
    const centerBonus = 1 - distFromCenter * 0.5;
    const targetBonus = targetEntityId && entityId === targetEntityId ? TARGET_ENTITY_BONUS : 1;
    const score = pos.w * pos.h * centerBonus * targetBonus / (1 + nearestDist * 0.5);

    if (best === null || score > best.score) {
      if (best) {
        if (best.score > runnerScore) {
          runnerScore = best.score;
          runnerId = best.entityId;
        }
      }
      best = { entityId, rect: pos, score };
    } else if (score > runnerScore) {
      runnerScore = score;
      runnerId = entityId;
    }
  }

  if (best && runnerId !== null) {
    best.runnerUp = { entityId: runnerId, score: runnerScore };
  }
  return best;
}

function cosineDistanceBetween(
  a: number[] | undefined,
  b: number[] | undefined,
): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  const sim = Math.max(-1, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
  return Number((1 - sim).toFixed(4));
}

export async function renderAllClips(
  clips: ViralClip[],
  inputPath: string,
  transcript: TranscriptResult,
  faceData: FaceDetectionResult,
  speakerFaceMap: SpeakerFaceMapping,
  exportOptions: ExportOptions,
  onProgress?: (msg: string) => void,
  personData?: IdentityClusterResult,
  debugTracking: boolean = false,
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
      personData,
      debugTracking,
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
