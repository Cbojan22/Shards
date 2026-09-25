import { describe, it, expect } from 'vitest';
import { applyCaptionOverrides, CaptionOptionError } from '../src/cli/captionOptions.js';
import { escapeFilterValue } from '../src/utils/ffmpeg.js';
import { whisperModelItems } from '../src/tui/components/WhisperModelStep.js';
import { DEFAULT_CAPTION_STYLE } from '../src/pipeline/captions/index.js';

const base = { ...DEFAULT_CAPTION_STYLE };

describe('applyCaptionOverrides', () => {
  it('keeps the saved theme and style when no flags are given', () => {
    const r = applyCaptionOverrides(base, 'golden', {});
    expect(r.captionTheme).toBe('golden');
    expect(r.captionStyle).toEqual(base);
  });

  it('layers valid flags over the saved style without mutating it', () => {
    const r = applyCaptionOverrides(base, 'golden', {
      theme: 'bebas', position: 'top', fontSize: '96', wordsPerGroup: '2',
    });
    expect(r.captionTheme).toBe('bebas');
    expect(r.captionStyle).toMatchObject({ position: 'top', fontSize: 96, wordsPerGroup: 2 });
    expect(base.position).toBe(DEFAULT_CAPTION_STYLE.position);
  });

  it('accepts the range boundaries', () => {
    expect(applyCaptionOverrides(base, 'golden', { fontSize: '24', wordsPerGroup: '1' }).captionStyle)
      .toMatchObject({ fontSize: 24, wordsPerGroup: 1 });
    expect(applyCaptionOverrides(base, 'golden', { fontSize: '240', wordsPerGroup: '5' }).captionStyle)
      .toMatchObject({ fontSize: 240, wordsPerGroup: 5 });
  });

  it.each([
    [{ theme: 'nope' }, /Unknown caption theme/],
    [{ position: 'middle' }, /Invalid caption position/],
    [{ fontSize: '23' }, /Invalid font size/],
    [{ fontSize: '241' }, /Invalid font size/],
    [{ fontSize: '96px' }, /Invalid font size/],
    [{ wordsPerGroup: '0' }, /Invalid words per group/],
    [{ wordsPerGroup: '6' }, /Invalid words per group/],
    [{ wordsPerGroup: '2.5' }, /Invalid words per group/],
  ])('rejects %o', (flags, message) => {
    expect(() => applyCaptionOverrides(base, 'golden', flags)).toThrow(CaptionOptionError);
    expect(() => applyCaptionOverrides(base, 'golden', flags)).toThrow(message);
  });
});

describe('escapeFilterValue', () => {
  it('leaves ordinary paths alone', () => {
    expect(escapeFilterValue('/tmp/My Videos/clip.ass')).toBe('/tmp/My Videos/clip.ass');
  });

  it('escapes both FFmpeg levels so quotes, commas and brackets survive', () => {
    expect(escapeFilterValue("a:b")).toBe('a\\\\:b');
    expect(escapeFilterValue("it's")).toBe("it\\\\\\'s");
    expect(escapeFilterValue('a,b;c[d]')).toBe('a\\,b\\;c\\[d\\]');
    expect(escapeFilterValue('a\\b')).toBe('a\\\\\\\\b');
  });
});

describe('whisperModelItems', () => {
  it('lists the stock sizes', () => {
    expect(whisperModelItems('small').map((i) => i.value)).toEqual(['tiny', 'base', 'small', 'medium', 'large']);
  });

  it('keeps a custom saved model selectable instead of dropping it', () => {
    expect(whisperModelItems('large-v3')[0].value).toBe('large-v3');
  });
});
