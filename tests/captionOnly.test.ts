import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { tmpdir } from 'os';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { buildBurnCaptionsArgs } from '../src/utils/ffmpeg.js';
import { DEFAULT_CAPTION_STYLE } from '../src/pipeline/captions/index.js';

// Mock the two side-effectful dependencies. We're testing orchestration —
// did the function call transcribe with the right model, did it pass
// transcript timings into generateCaptions, did it call burnCaptions with
// the produced ASS path. Real ffmpeg and Whisper runs are out of scope.
vi.mock('../src/pipeline/transcribe/index.js', () => ({
  transcribeVideo: vi.fn(async () => ({
    segments: [{
      start: 0, end: 1.5, text: 'hello world', speaker: 'SPEAKER_A',
      words: [
        { word: 'hello', start: 0.0, end: 0.5 },
        { word: 'world', start: 0.7, end: 1.5 },
      ],
    }],
    speakers: ['SPEAKER_A'],
    language: 'en',
    duration: 1.5,
  })),
}));

vi.mock('../src/utils/ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ffmpeg.js')>();
  return {
    ...actual,
    getVideoMetadata: vi.fn(async () => ({
      duration: 1.5, width: 1080, height: 1920, fps: 30,
      codec: 'h264', bitrate: 2_000_000, audioCodec: 'aac', audioSampleRate: 48000,
    })),
    burnCaptions: vi.fn(async () => ({ usedAssFilter: true })),
  };
});

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

describe('captionExistingClip', () => {
  it('transcribes, generates an ASS, and calls burnCaptions with the right paths', async () => {
    const { captionExistingClip } = await import('../src/pipeline/captionOnly/index.js');
    const { transcribeVideo } = await import('../src/pipeline/transcribe/index.js');
    const { burnCaptions } = await import('../src/utils/ffmpeg.js');

    const dir = await mkdtemp(path.join(tmpdir(), 'shards-cap-'));
    try {
      const result = await captionExistingClip({
        inputPath: '/tmp/fake-clip.mp4',
        outputPath: path.join(dir, 'clip_captioned.mp4'),
        whisperModel: 'small',
        language: 'en',
        quality: 'high',
        captionStyle: DEFAULT_CAPTION_STYLE,
      });

      expect(transcribeVideo).toHaveBeenCalledWith(
        '/tmp/fake-clip.mp4',
        { model: 'small', language: 'en' },
        expect.any(Function),
      );
      expect(burnCaptions).toHaveBeenCalledOnce();
      const burnArgs = (burnCaptions as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(burnArgs.inputPath).toBe('/tmp/fake-clip.mp4');
      expect(burnArgs.outputPath).toBe(path.join(dir, 'clip_captioned.mp4'));
      expect(burnArgs.subtitlePath.endsWith('.ass')).toBe(true);

      // The generated ASS file should actually exist and contain our words.
      const ass = await readFile(burnArgs.subtitlePath, 'utf-8');
      expect(ass).toContain('HELLO WORLD');

      expect(result.outputPath).toBe(path.join(dir, 'clip_captioned.mp4'));
      expect(result.usedAssFilter).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
