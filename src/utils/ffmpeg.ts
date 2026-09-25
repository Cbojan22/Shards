import ffmpeg from 'fluent-ffmpeg';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Bundled caption fonts live at <repo>/assets/fonts. This file compiles to
// dist/utils/ffmpeg.js, so ../../assets/fonts resolves to the repo root under
// both the src and dist layouts (same trick utils/python.ts uses for scripts/).
const BUNDLED_FONTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');

/** The bundled-fonts dir, or undefined if it isn't present at runtime. */
function bundledFontsDir(): string | undefined {
  return existsSync(BUNDLED_FONTS_DIR) ? BUNDLED_FONTS_DIR : undefined;
}

/**
 * Escape a path for use as a filter option value inside a filtergraph (both
 * -vf and -filter_script). FFmpeg unescapes twice: once for the option value
 * (`\ ' :`) and once for the graph (`\ ' [ ] , ;`). Escaping only colons let
 * a quote or comma in the repo path silently drop the bundled fonts.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\':]/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&');
}

/**
 * Build the `:fontsdir=…` suffix for the libass `ass` filter so it can resolve
 * our bundled .ttf faces. Empty when no dir is given so we never hand ffmpeg a
 * bogus fontsdir.
 */
function fontsDirArg(fontsDir?: string): string {
  return fontsDir ? `:fontsdir=${escapeFilterValue(fontsDir)}` : '';
}

/**
 * `:fontsdir=…` suffix for the bundled caption fonts, ready to append after an
 * `ass=<path>` filter so libass can resolve them. Empty when the dir is absent.
 * Exported for other burn sites (e.g. the themes preview) to stay consistent.
 */
export function bundledFontsFilterSuffix(): string {
  return fontsDirArg(bundledFontsDir());
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number;
  audioCodec: string;
  audioSampleRate: number;
}

function parseFraction(fraction: string): number {
  const parts = fraction.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den !== 0) return num / den;
  }
  return parseFloat(fraction) || 30;
}

export function getVideoMetadata(inputPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) {
        reject(new Error(`ffprobe failed: ${err.message}`));
        return;
      }

      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      const audioStream = data.streams.find((s) => s.codec_type === 'audio');

      if (!videoStream) {
        reject(new Error('No video stream found'));
        return;
      }

      const fps = videoStream.r_frame_rate
        ? parseFraction(videoStream.r_frame_rate)
        : 30;

      resolve({
        duration: parseFloat(String(data.format.duration ?? '0')) || 0,
        width: videoStream.width || 1920,
        height: videoStream.height || 1080,
        fps: Math.round(fps),
        codec: videoStream.codec_name || 'unknown',
        bitrate: parseInt(String(data.format.bit_rate ?? '0')) || 0,
        audioCodec: audioStream?.codec_name || 'unknown',
        audioSampleRate: audioStream?.sample_rate
          ? parseInt(String(audioStream.sample_rate))
          : 44100,
      });
    });
  });
}

export function getQualityPreset(quality: 'high' | 'medium' | 'low'): {
  crf: number;
  preset: string;
  // Target H.264 bitrate for VideoToolbox at 1080×1920 short-form. Bitrate
  // mode is far more reliable than `-q:v` on h264_videotoolbox — the latter
  // fails with EINVAL on several common FFmpeg builds.
  vtBitrate: string;
} {
  switch (quality) {
    case 'high':
      return { crf: 18, preset: 'slow',   vtBitrate: '8M' };
    case 'medium':
      return { crf: 23, preset: 'medium', vtBitrate: '5M' };
    case 'low':
      return { crf: 28, preset: 'fast',   vtBitrate: '3M' };
  }
}

// macOS Apple Silicon / Intel both expose VideoToolbox H.264 hardware encoding
// via `h264_videotoolbox`. On Mac it offloads encoding to the Media Engine and
// drops the render stage's CPU spend close to zero; on other platforms we fall
// back to libx264.
function videoEncoderArgs(quality: 'high' | 'medium' | 'low'): string[] {
  const { crf, preset, vtBitrate } = getQualityPreset(quality);
  if (process.platform === 'darwin') {
    return ['-c:v', 'h264_videotoolbox', '-b:v', vtBitrate];
  }
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)];
}

export async function renderClipWithReframe(job: {
  inputPath: string;
  outputPath: string;
  start: number;
  end: number;
  cropKeyframes: Array<{ time: number; x: number; y: number; w: number; h: number }>;
  resolution: { width: number; height: number };
  quality: 'high' | 'medium' | 'low';
  subtitlePath?: string;
  videoFormat?: 'fullscreen' | 'centered';
}): Promise<void> {
  const encoderArgs = videoEncoderArgs(job.quality);
  const duration = job.end - job.start;

  const cropW = job.cropKeyframes[0]?.w || 608;
  const cropH = job.cropKeyframes[0]?.h || 1080;

  // FFmpeg 8.x silently rejects crop-x expressions past ~3600 chars (the parse
  // fails at config time with "Failed to configure input pad"). Cap the
  // keyframe density here for a sane starting point; buildCropExpression then
  // enforces a hard character budget, thinning further when continuous motion
  // would otherwise overflow it.
  const maxKf = 120;
  let kfs = job.cropKeyframes;
  if (kfs.length > maxKf) {
    const step = Math.ceil(kfs.length / maxKf);
    kfs = kfs.filter((_, i) => i % step === 0 || i === kfs.length - 1);
  }

  const xExpr = buildCropExpression(kfs, 'x');

  const { writeFile, unlink } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  // In 'centered' mode the video occupies exactly half the output height,
  // perfectly centered, so the combined black bar area equals the video area.
  // We enforce even pixel counts because yuv420p chroma subsampling rejects
  // odd dimensions.
  const isCentered = job.videoFormat === 'centered';
  const scaledHeight = isCentered
    ? Math.round(job.resolution.height / 4) * 2
    : job.resolution.height;
  const padY = isCentered
    ? Math.round((job.resolution.height - scaledHeight) / 4) * 2
    : 0;
  const padStep = isCentered
    ? `,pad=${job.resolution.width}:${job.resolution.height}:0:${padY}:black`
    : '';

  // Write the crop+scale filter to a temp script file to avoid comma parsing issues
  // FFmpeg's -vf parser treats commas in if() expressions as filter separators
  const cropScale = `crop=${cropW}:${cropH}:${xExpr}:0,scale=${job.resolution.width}:${scaledHeight}:flags=lanczos${padStep}`;

  const filterScriptPath = join(tmpdir(), `shards_filter_${randomUUID()}.txt`);
  await writeFile(filterScriptPath, cropScale);

  // Step 1: Render with crop + scale
  // IMPORTANT: -ss AFTER -i for frame-accurate seeking (avoids keyframe glitches)
  const step1Output = job.subtitlePath
    ? job.outputPath.replace(/(\.\w+)$/, '_nosub$1')
    : job.outputPath;

  const args = [
    '-y',
    '-i', job.inputPath,
    '-ss', String(job.start),
    '-t', String(duration),
    '-filter_script:v', filterScriptPath,
    ...encoderArgs,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    step1Output,
  ];

  // Preserve the filter script on failure so the user can inspect the
  // expression that broke FFmpeg. On success it's cleaned up.
  let renderSucceeded = false;
  try {
    await runFFmpeg(args);
    renderSucceeded = true;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    e.message = `${e.message}\n\nFilter script preserved at: ${filterScriptPath}`;
    throw e;
  } finally {
    if (renderSucceeded) {
      await unlink(filterScriptPath).catch(() => {});
    }
  }

  // Step 2: If subtitles, try to burn them in; fall back to soft subtitles
  if (job.subtitlePath) {
    const hasAssFilter = await checkFFmpegFilter('ass');

    if (hasAssFilter) {
      // Burn in with ASS filter
      const subFilterPath = join(tmpdir(), `shards_sub_${randomUUID()}.txt`);
      await writeFile(
        subFilterPath,
        `ass=${escapeFilterValue(job.subtitlePath)}${fontsDirArg(bundledFontsDir())}`,
      );
      const subArgs = [
        '-y', '-i', step1Output,
        '-filter_script:v', subFilterPath,
        ...encoderArgs,
        '-c:a', 'copy', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
        job.outputPath,
      ];
      try {
        await runFFmpeg(subArgs);
      } finally {
        await unlink(subFilterPath).catch(() => {});
        await unlink(step1Output).catch(() => {});
      }
    } else {
      // No ASS filter: embed as soft subtitle track
      const subArgs = [
        '-y', '-i', step1Output, '-i', job.subtitlePath,
        '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
        '-movflags', '+faststart',
        job.outputPath,
      ];
      try {
        await runFFmpeg(subArgs);
      } catch {
        // If soft subs also fail, just rename the no-sub version
        const { rename } = await import('fs/promises');
        await rename(step1Output, job.outputPath);
        return;
      }
      await unlink(step1Output).catch(() => {});
    }
  }
}

const _filterCache = new Map<string, boolean>();

async function checkFFmpegFilter(name: string): Promise<boolean> {
  if (_filterCache.has(name)) return _filterCache.get(name)!;
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-filters'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', () => {
      const regex = new RegExp(`\\b${name}\\b`);
      const available = regex.test(output);
      _filterCache.set(name, available);
      resolve(available);
    });
    proc.on('error', () => resolve(false));
  });
}

export function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`FFmpeg spawn failed: ${err.message}`));
    });

    proc.on('close', (code: number) => {
      if (code !== 0) {
        // Filter eval errors print the full broken expression in stderr,
        // which can easily span 50+ lines on long clips. 100 covers it.
        const errLines = stderr.split('\n').filter(l => l.trim()).slice(-100).join('\n');
        reject(new Error(`FFmpeg exited with code ${code}:\n${errLines}`));
      } else {
        resolve();
      }
    });
  });
}

export interface BuildBurnCaptionsArgsParams {
  inputPath: string;
  subtitlePath: string;
  outputPath: string;
  quality: 'high' | 'medium' | 'low';
  platform: NodeJS.Platform;
  useAssFilter: boolean;
  /** Extra font directory for libass (bundled caption fonts). */
  fontsDir?: string;
}

/**
 * Build the ffmpeg argv that burns (or embeds) captions onto an existing clip
 * without cropping, scaling, or otherwise touching the picture geometry. Pure
 * function so we can unit-test platform + filter branching without spawning
 * ffmpeg.
 */
export function buildBurnCaptionsArgs(p: BuildBurnCaptionsArgsParams): string[] {
  const { crf, preset, vtBitrate } = getQualityPreset(p.quality);
  const encoder = p.platform === 'darwin'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', vtBitrate]
    : ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)];

  if (p.useAssFilter) {
    return [
      '-y',
      '-i', p.inputPath,
      '-vf', `ass=${escapeFilterValue(p.subtitlePath)}${fontsDirArg(p.fontsDir)}`,
      ...encoder,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      p.outputPath,
    ];
  }

  // Fallback: embed as a soft subtitle track. Player must support mov_text
  // for it to render; most social platforms strip it on upload, so we warn
  // upstream when we take this branch.
  return [
    '-y',
    '-i', p.inputPath,
    '-i', p.subtitlePath,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-c:s', 'mov_text',
    '-movflags', '+faststart',
    p.outputPath,
  ];
}

/**
 * Burn an ASS subtitle file onto an existing video. Tries the libass `ass`
 * filter first; if unavailable, falls back to embedding `mov_text`. Returns
 * a flag indicating which branch was taken so callers can warn the user.
 */
export async function burnCaptions(opts: {
  inputPath: string;
  subtitlePath: string;
  outputPath: string;
  quality: 'high' | 'medium' | 'low';
}): Promise<{ usedAssFilter: boolean }> {
  const hasAss = await checkFFmpegFilter('ass');
  const args = buildBurnCaptionsArgs({
    inputPath: opts.inputPath,
    subtitlePath: opts.subtitlePath,
    outputPath: opts.outputPath,
    quality: opts.quality,
    platform: process.platform,
    useAssFilter: hasAss,
    fontsDir: bundledFontsDir(),
  });
  await runFFmpeg(args);
  return { usedAssFilter: hasAss };
}

// FFmpeg 8.x's av_expr_parse rejects crop expressions past ~3600 chars:
// empirically a 3580-char crop-x parses but 3618 fails at config time with
// "Failed to configure input pad" (AVERROR(EINVAL) / -22), aborting the render
// before a single frame is written. Keyframe count alone does NOT bound the
// length — a clip whose subject moves on nearly every keyframe collapses almost
// no constant runs, so even the 120-keyframe cap can yield a 4300+ char
// expression. We enforce a hard character budget with generous headroom below
// the cliff and decimate further until the expression fits.
const MAX_CROP_EXPR_CHARS = 3000;

export function buildCropExpression(
  keyframes: Array<{ time: number; x: number; y: number; w: number; h: number }>,
  axis: 'x' | 'y'
): string {
  if (keyframes.length === 0) return '0';
  if (keyframes.length === 1) return String(Math.round(keyframes[0][axis]));

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  // Start at the 120-keyframe density, then keep thinning (larger stride =>
  // fewer terms => shorter expression) until we clear FFmpeg's parse limit.
  // Halting is guaranteed: once stride >= length the expression collapses to
  // first+last, which is trivially short.
  let stride = sorted.length > 120 ? Math.ceil(sorted.length / 120) : 1;
  let expr = buildFlatSum(sorted, axis, stride);
  while (expr.length > MAX_CROP_EXPR_CHARS && stride < sorted.length) {
    stride++;
    expr = buildFlatSum(sorted, axis, stride);
  }
  return expr;
}

// Build the flat sum-of-masked-segments crop expression for one axis, keeping
// every `stride`-th keyframe (plus the last). Factored out of buildCropExpression
// so the caller can retry with a larger stride when the result overflows
// FFmpeg's expression-length limit.
function buildFlatSum(
  sorted: Array<{ time: number; x: number; y: number; w: number; h: number }>,
  axis: 'x' | 'y',
  stride: number
): string {
  const downsampled = stride > 1
    ? sorted.filter((_, i) => i % stride === 0 || i === sorted.length - 1)
    : sorted;

  // Collapse interior keyframes whose axis value matches both neighbours.
  // A clip that pans off a face for the second half ends with dozens of
  // identical `K*gte(t,N)*lt(t,N+.5)` terms; without this, the expression
  // wastes its budget encoding motion that's trivially a single constant.
  const sampled: typeof downsampled = [];
  for (let i = 0; i < downsampled.length; i++) {
    const v = Math.round(downsampled[i][axis]);
    const prev = i > 0 ? Math.round(downsampled[i - 1][axis]) : null;
    const next = i < downsampled.length - 1 ? Math.round(downsampled[i + 1][axis]) : null;
    if (prev !== null && next !== null && v === prev && v === next) continue;
    sampled.push(downsampled[i]);
  }

  if (sampled.length === 1) return String(Math.round(sampled[0][axis]));

  // The old implementation built a right-nested if(lt(t,t1),seg,if(lt(t,t2),...))
  // chain. FFmpeg's expression evaluator hard-fails ("Missing ')' or too many
  // args") past ~50–60 levels of nested if(), which we hit immediately with
  // any clip longer than ~30s at 0.5s keyframe spacing.
  //
  // New form: a FLAT sum of (segment_value * mask) terms, where mask is
  //   gte(t,t0)*lt(t,t1)   — 1 inside the half-open interval [t0,t1), else 0
  // so exactly one mask is 1 at any t and the sum equals the active segment.
  // Zero nesting, evaluator-safe at any keyframe count.

  const C = '\\,'; // escaped comma for FFmpeg expressions

  // A keyframe-to-keyframe jump larger than this almost certainly corresponds
  // to a real camera cut. Snap at midpoint of the interval rather than ramp.
  const cropW = Math.max(...sampled.map((kf) => kf.w)) || 608;
  const CUT_THRESHOLD_PX = cropW * 0.25;

  const terms: string[] = [];

  for (let i = 0; i < sampled.length - 1; i++) {
    const kf = sampled[i];
    const next = sampled[i + 1];
    const v0 = Math.round(kf[axis]);
    const v1 = Math.round(next[axis]);
    const dv = v1 - v0;
    const t0 = fmtNum(kf.time);
    const t1 = fmtNum(next.time);

    let segValue: string;
    if (v0 === v1) {
      segValue = String(v0);
    } else if (Math.abs(dv) > CUT_THRESHOLD_PX) {
      // Camera cut: gte(t,tmid) is 0 before midpoint, 1 after — so the
      // crop snaps at the midpoint of the keyframe interval (best estimate
      // of the actual cut moment given fixed-interval sampling).
      const tmid = fmtNum((kf.time + next.time) / 2);
      segValue = `(${v0}${stepTerm(dv, `gte(t${C}${tmid})`)})`;
    } else {
      const dt = fmtNum(next.time - kf.time, 4);
      // Linear interpolation: v0 + (v1-v0) * (t-t0) / dt
      segValue = `(${v0}${stepTerm(dv, `(t-${t0})/${dt}`)})`;
    }

    // First segment also covers t < t0 (extrapolate backward) — match the
    // old behavior. Middle/last middle segments use the half-open mask.
    const mask = i === 0
      ? `lt(t${C}${t1})`
      : `gte(t${C}${t0})*lt(t${C}${t1})`;

    terms.push(`${segValue}*${mask}`);
  }

  // After the last keyframe time, hold at the final value.
  const lastVal = Math.round(sampled[sampled.length - 1][axis]);
  const lastTime = fmtNum(sampled[sampled.length - 1].time);
  terms.push(`${lastVal}*gte(t${C}${lastTime})`);

  return terms.join('+');
}

// Compact "+ N * expr" / "- expr" / "+ expr" formatting based on coefficient
// sign and magnitude. Saves ~3-6 chars per segment vs the naive form.
function stepTerm(coef: number, expr: string): string {
  if (coef === 1) return `+${expr}`;
  if (coef === -1) return `-${expr}`;
  if (coef >= 0) return `+${coef}*${expr}`;
  return `${coef}*${expr}`; // negative coef already carries the sign
}

// Compact number formatter for FFmpeg expressions:
// 0.500 -> .5, 1.000 -> 1, 12.345 -> 12.345
function fmtNum(n: number, decimals: number = 3): string {
  let s = n.toFixed(decimals);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    s = s.replace(/\.$/, '');
  }
  if (s.startsWith('0.')) s = s.slice(1);
  if (s.startsWith('-0.')) s = '-' + s.slice(2);
  if (s === '' || s === '-') s = '0';
  return s;
}
