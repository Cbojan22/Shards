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
} {
  switch (quality) {
    case 'high':
      return { crf: 18, preset: 'slow' };
    case 'medium':
      return { crf: 23, preset: 'medium' };
    case 'low':
      return { crf: 28, preset: 'fast' };
  }
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
}): Promise<void> {
  const { crf, preset } = getQualityPreset(job.quality);
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

  // Write the crop+scale filter to a temp script file to avoid comma parsing issues
  // FFmpeg's -vf parser treats commas in if() expressions as filter separators
  const cropScale = `crop=${cropW}:${cropH}:${xExpr}:0,scale=${job.resolution.width}:${job.resolution.height}:flags=lanczos`;

  const filterScriptPath = join(tmpdir(), `clipper_filter_${randomUUID()}.txt`);
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
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
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
      const subFilterPath = join(tmpdir(), `clipper_sub_${randomUUID()}.txt`);
      await writeFile(subFilterPath, `ass=${job.subtitlePath.replace(/:/g, '\\:')}`);
      const subArgs = [
        '-y', '-i', step1Output,
        '-filter_script:v', subFilterPath,
        '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
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

function runFFmpeg(args: string[]): Promise<void> {
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
