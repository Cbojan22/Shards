import { describe, it, expect } from 'vitest';
import { buildBurnCaptionsArgs } from '../src/utils/ffmpeg.js';

describe('buildBurnCaptionsArgs', () => {
  it('builds an ffmpeg argv that burns ASS subtitles via the ass filter on macOS', () => {
    const args = buildBurnCaptionsArgs({
      inputPath: '/tmp/clip.mp4',
      subtitlePath: '/tmp/clip.ass',
      outputPath: '/tmp/clip_captioned.mp4',
      quality: 'high',
      platform: 'darwin',
      useAssFilter: true,
    });

    expect(args[0]).toBe('-y');
    expect(args).toContain('-i');
    expect(args).toContain('/tmp/clip.mp4');
    expect(args).toContain('-vf');
    expect(args.find((a) => a.startsWith('ass=/tmp/clip.ass'))).toBeTruthy();
    expect(args).toContain('h264_videotoolbox');
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
    expect(args[args.length - 1]).toBe('/tmp/clip_captioned.mp4');
  });

  it('escapes colons in the subtitle path so libass parses it as one arg', () => {
    const args = buildBurnCaptionsArgs({
      inputPath: '/tmp/in.mp4',
      subtitlePath: '/Users/carter/Library/Mobile Documents/foo:bar/clip.ass',
      outputPath: '/tmp/out.mp4',
      quality: 'high',
      platform: 'darwin',
      useAssFilter: true,
    });

    const vf = args[args.indexOf('-vf') + 1];
    // libass requires \: for literal colons inside the filter string
    expect(vf).toContain('foo\\:bar');
  });

  it('falls back to mov_text soft subtitles when libass is unavailable', () => {
    const args = buildBurnCaptionsArgs({
      inputPath: '/tmp/in.mp4',
      subtitlePath: '/tmp/in.ass',
      outputPath: '/tmp/out.mp4',
      quality: 'high',
      platform: 'darwin',
      useAssFilter: false,
    });

    expect(args).toContain('-c:s');
    expect(args).toContain('mov_text');
    // soft subs: must add the ASS as a second input
    const inputCount = args.filter((a) => a === '-i').length;
    expect(inputCount).toBe(2);
    expect(args).not.toContain('-vf');
  });

  it('uses libx264 on linux', () => {
    const args = buildBurnCaptionsArgs({
      inputPath: '/tmp/in.mp4',
      subtitlePath: '/tmp/in.ass',
      outputPath: '/tmp/out.mp4',
      quality: 'medium',
      platform: 'linux',
      useAssFilter: true,
    });
    expect(args).toContain('libx264');
    expect(args).toContain('-preset');
    expect(args).toContain('medium');
    expect(args).toContain('-crf');
    expect(args).toContain('23');
  });
});
