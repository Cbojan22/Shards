import ffmpeg from 'fluent-ffmpeg';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

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

export function extractClip(
  inputPath: string,
  outputPath: string,
  start: number,
  end: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(end - start)
      .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
      .output(outputPath)
      .on('error', (err) => reject(new Error(`Extract clip failed: ${err.message}`)))
      .on('end', () => resolve())
      .run();
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

  // Sample max 20 keyframes to keep expression manageable
  const maxKf = 20;
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

  try {
    await runFFmpeg(args);
  } finally {
    await unlink(filterScriptPath).catch(() => {});
  }

  // Step 2: If subtitles, try to burn them in; fall back to soft subtitles
  if (job.subtitlePath) {
    const hasAssFilter = await checkFFmpegFilter('ass');

    if (hasAssFilter) {
      // Burn in with ASS filter
      const subFilterPath = join(tmpdir(), `shards_sub_${randomUUID()}.txt`);
      await writeFile(subFilterPath, `ass=${job.subtitlePath.replace(/:/g, '\\:')}`);
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
        const errLines = stderr.split('\n').filter(l => l.trim()).slice(-5).join('\n');
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
    // libass: colons inside the filter graph must be escaped with `\:`
    const escapedSub = p.subtitlePath.replace(/:/g, '\\:');
    return [
      '-y',
      '-i', p.inputPath,
      '-vf', `ass=${escapedSub}`,
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
  });
  await runFFmpeg(args);
  return { usedAssFilter: hasAss };
}

function buildCropExpression(
  keyframes: Array<{ time: number; x: number; y: number; w: number; h: number }>,
  axis: 'x' | 'y'
): string {
  if (keyframes.length === 0) return '0';
  if (keyframes.length === 1) return String(Math.round(keyframes[0][axis]));

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  // Limit keyframes
  const step = sorted.length > 20 ? Math.ceil(sorted.length / 20) : 1;
  const sampled = sorted.filter((_, i) => i % step === 0 || i === sorted.length - 1);

  // Build a nested if/else chain using FFmpeg's if(cond\,then\,else) syntax.
  // Even in filter_script files, commas must be escaped with backslash.
  // This ensures there are NO gaps — every time value maps to a valid position.

  const C = '\\,'; // escaped comma for FFmpeg expressions

  const lastVal = Math.round(sampled[sampled.length - 1][axis]);
  let expr = String(lastVal);

  for (let i = sampled.length - 2; i >= 0; i--) {
    const kf = sampled[i];
    const next = sampled[i + 1];
    const v0 = Math.round(kf[axis]);
    const v1 = Math.round(next[axis]);
    const t1 = next.time.toFixed(2);

    let segment: string;
    if (v0 === v1) {
      segment = String(v0);
    } else {
      const t0 = kf.time.toFixed(2);
      const dt = (next.time - kf.time).toFixed(4);
      // Linear interpolation: v0 + (v1-v0) * (t-t0) / dt
      segment = `${v0}+${v1 - v0}*(t-${t0})/${dt}`;
    }

    expr = `if(lt(t${C}${t1})${C}${segment}${C}${expr})`;
  }

  return expr;
}
