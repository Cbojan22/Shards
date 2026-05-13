import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import type { CaptionOnlyOptions } from '../../types/index.js';
import { transcribeVideo } from '../transcribe/index.js';
import { generateCaptions } from '../captions/index.js';
import { burnCaptions, getVideoMetadata } from '../../utils/ffmpeg.js';

export interface CaptionOnlyResult {
  outputPath: string;
  /** False when libass was missing and we fell back to soft mov_text subs. */
  usedAssFilter: boolean;
  durationSec: number;
}

/**
 * Burn Shards-styled captions onto an existing short-form clip.
 *
 * - Transcribes the input locally with faster-whisper (no API call).
 * - Generates an ASS subtitle file for the full clip duration.
 * - Burns it back over the source video with FFmpeg (`ass` filter where
 *   available, soft `mov_text` track as a fallback).
 *
 * No Anthropic API key required.
 */
export async function captionExistingClip(
  opts: CaptionOnlyOptions,
  onProgress?: (stage: string, message: string) => void,
): Promise<CaptionOnlyResult> {
  const progress = (s: string, m: string) => onProgress?.(s, m);

  progress('init', `Analyzing ${path.basename(opts.inputPath)}…`);
  const meta = await getVideoMetadata(opts.inputPath);
  progress('init', `Source: ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}s`);

  progress('transcribe', 'Transcribing with local Whisper…');
  const transcript = await transcribeVideo(
    opts.inputPath,
    { model: opts.whisperModel, language: opts.language },
    (msg) => progress('transcribe', msg),
  );

  progress('captions', 'Generating subtitle file…');
  const assPath = path.join(
    tmpdir(),
    `shards_captions_${randomUUID()}.ass`,
  );
  await generateCaptions(
    transcript,
    0,
    meta.duration,
    opts.captionStyle,
    assPath,
  );

  progress('render', 'Burning captions with FFmpeg…');
  let usedAssFilter: boolean;
  try {
    ({ usedAssFilter } = await burnCaptions({
      inputPath: opts.inputPath,
      subtitlePath: assPath,
      outputPath: opts.outputPath,
      quality: opts.quality,
    }));
  } finally {
    // ASS files live in the OS temp dir; clean up so repeated runs don't
    // accumulate cleartext transcripts there.
    await unlink(assPath).catch(() => {});
  }

  if (!usedAssFilter) {
    progress('render', 'WARNING: libass not available — embedded soft subs instead of burning. Most social uploads will strip these.');
  }

  progress('complete', `Done → ${opts.outputPath}`);

  return {
    outputPath: opts.outputPath,
    usedAssFilter,
    durationSec: meta.duration,
  };
}
