import path from 'path';
import { mkdir } from 'fs/promises';
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
}

export async function renderClip(
  job: ClipRenderJob,
  onProgress?: (msg: string) => void
): Promise<string> {
  const { clip, inputPath, outputPath, exportOptions, speakerFaceMap, faceData, transcript } = job;

  onProgress?.(`Rendering clip: ${clip.title}`);

  const sourceW = faceData.width || 1920;
  const sourceH = faceData.height || 1080;

  // Generate crop keyframes following active speaker's face
  const keyframes = generateCropKeyframes(
    clip, transcript, faceData, speakerFaceMap, sourceW, sourceH
  );


  // Generate captions if enabled
  let subtitlePath: string | undefined;
  if (exportOptions.withCaptions) {
    const captionDir = path.dirname(outputPath);
    subtitlePath = path.join(captionDir, `${clip.id}_captions.ass`);
    await generateCaptions(
      transcript, clip.start, clip.end, exportOptions.captionStyle, subtitlePath
    );
    onProgress?.('  Captions generated');
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  // Render with FFmpeg
  await renderClipWithReframe({
    inputPath,
    outputPath,
    start: clip.start,
    end: clip.end,
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
  });

  onProgress?.(`  Rendered: ${path.basename(outputPath)}`);
  return outputPath;
}

export function generateCropKeyframes(
  clip: ViralClip,
  transcript: TranscriptResult,
  faceData: FaceDetectionResult,
  speakerFaceMap: SpeakerFaceMapping,
  sourceWidth: number,
  sourceHeight: number
): CropKeyframe[] {
  const cropHeight = sourceHeight;
  const cropWidth = Math.min(Math.round(sourceHeight * 9 / 16), sourceWidth);
  const defaultX = Math.round((sourceWidth - cropWidth) / 2);

  const keyframes: CropKeyframe[] = [];
  const interval = 0.5; // sample every 0.5s (was 0.25)
  const clipDuration = clip.end - clip.start;
  const frameCenter = sourceWidth / 2;

  for (let t = 0; t <= clipDuration; t += interval) {
    const absTime = clip.start + t;
    const speaker = getActiveSpeaker(absTime, transcript.segments);

    // Always use the largest visible face at this time — most reliable for podcasts.
    // The largest face is typically the active speaker (close-up shot) or the
    // primary subject in a two-person wide shot.
    const facePos = findBestVisibleFace(absTime, faceData);

    let x = defaultX;
    if (facePos) {
      const faceCenterX = facePos.x + facePos.w / 2;

      // Blend face position with frame center to keep the person naturally framed
      // (not just their face, but their upper body too)
      const distFromCenter = Math.abs(faceCenterX - frameCenter);
      const isCentered = distFromCenter < sourceWidth * 0.3;

      if (isCentered) {
        // Face near center: blend toward center to keep full framing
        const blendedCenter = faceCenterX * 0.5 + frameCenter * 0.5;
        x = Math.round(blendedCenter - cropWidth / 2);
      } else {
        // Face off-center (e.g., two-person shot): follow face more closely
        x = Math.round(faceCenterX - cropWidth / 2);
      }

      x = Math.max(0, Math.min(x, sourceWidth - cropWidth));
    }

    keyframes.push({
      time: t,
      x,
      y: 0,
      width: cropWidth,
      height: cropHeight,
      speaker: speaker || 'unknown',
    });
  }

  // Backfill: if early keyframes fell back to defaultX (no face found),
  // replace them with the first keyframe that has a valid face position.
  // This ensures the clip starts on the speaker's face immediately.
  let firstFaceIdx = -1;
  for (let i = 0; i < keyframes.length; i++) {
    if (keyframes[i].x !== defaultX) {
      firstFaceIdx = i;
      break;
    }
  }
  if (firstFaceIdx > 0) {
    const firstFaceX = keyframes[firstFaceIdx].x;
    for (let i = 0; i < firstFaceIdx; i++) {
      keyframes[i].x = firstFaceX;
    }
  }

  // Smooth keyframes to reduce jitter (larger window for smoother motion)
  return smoothKeyframes(keyframes, 7);
}

function smoothKeyframes(keyframes: CropKeyframe[], windowSize: number): CropKeyframe[] {
  if (keyframes.length <= windowSize) return keyframes;

  const smoothed: CropKeyframe[] = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < keyframes.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(keyframes.length - 1, i + half);
    let sumX = 0;
    let count = 0;

    // Check if there's a speaker change in this window
    const currentSpeaker = keyframes[i].speaker;
    let hasSpeakerChange = false;
    for (let j = start; j <= end; j++) {
      if (keyframes[j].speaker !== currentSpeaker) {
        hasSpeakerChange = true;
        break;
      }
    }

    if (hasSpeakerChange) {
      // Don't smooth across speaker changes — allow quick transition
      smoothed.push({ ...keyframes[i] });
    } else {
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
 * Prefers the largest face (closest to camera) with the nearest appearance time.
 * Uses interpolation for smooth position tracking.
 */
function findBestVisibleFace(
  time: number,
  faceData: FaceDetectionResult
): { x: number; y: number; w: number; h: number } | null {
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

    // Must have data within 5 seconds
    const nearest = before && after
      ? (time - before.time < after.time - time ? before : after)
      : (before || after);
    if (!nearest) continue;
    const nearestDist = Math.abs(nearest.time - time);
    if (nearestDist > 5) continue;

    // Interpolate position if we have both sides
    let pos: { x: number; y: number; w: number; h: number };
    if (before && after && before !== after) {
      const t = (time - before.time) / (after.time - before.time);
      pos = {
        x: before.bbox[0] + (after.bbox[0] - before.bbox[0]) * t,
        y: before.bbox[1] + (after.bbox[1] - before.bbox[1]) * t,
        w: before.bbox[2] + (after.bbox[2] - before.bbox[2]) * t,
        h: before.bbox[3] + (after.bbox[3] - before.bbox[3]) * t,
      };
    } else {
      pos = bboxToRect(nearest);
    }

    // Score by face size (larger = better), time proximity, and center preference.
    // Faces closer to the horizontal center of the frame are more likely the main subject.
    const faceCenterX = pos.x + pos.w / 2;
    const frameW = faceData.width || 1920;
    const distFromCenter = Math.abs(faceCenterX - frameW / 2) / (frameW / 2); // 0-1
    const centerBonus = 1 - distFromCenter * 0.5; // 0.5 to 1.0

    const score = pos.w * pos.h * centerBonus / (1 + nearestDist * 0.5);
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
