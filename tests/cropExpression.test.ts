import { describe, it, expect } from 'vitest';
import { buildCropExpression } from '../src/utils/ffmpeg.js';

type KF = { time: number; x: number; y: number; w: number; h: number };

// FFmpeg 8.x's av_expr_parse rejects crop expressions past ~3600 chars
// (3580 parses, 3618 fails at config time). buildCropExpression must keep the
// output comfortably under that cliff regardless of how much the subject moves.
const HARD_LIMIT = 3580;

function motionKeyframes(count: number, cropW = 1215): KF[] {
  // Jittery, never-repeating x so almost no constant runs collapse — the exact
  // shape that produced the 4345-char expression that broke the JRE render.
  return Array.from({ length: count }, (_, i) => ({
    time: i * 0.5,
    x: 200 + Math.round(60 * Math.sin(i / 3) + (i % 7) * 4),
    y: 0,
    w: cropW,
    h: 1080,
  }));
}

describe('buildCropExpression length budget', () => {
  it('stays under the FFmpeg parse limit for a 2-minute continuously-moving clip', () => {
    // 240 keyframes @ 0.5s = 120s, all with real motion (the regression case).
    const expr = buildCropExpression(motionKeyframes(240), 'x');
    expect(expr.length).toBeLessThan(HARD_LIMIT);
  });

  it('stays under the limit even for a pathologically long, jittery clip', () => {
    // 1200 keyframes @ 0.5s = 10 minutes of nonstop motion.
    const expr = buildCropExpression(motionKeyframes(1200), 'x');
    expect(expr.length).toBeLessThan(HARD_LIMIT);
  });

  it('produces an evaluable flat-sum expression (no nested if(), no stray commas)', () => {
    const expr = buildCropExpression(motionKeyframes(240), 'x');
    expect(expr).not.toContain('if(');
    // Every comma inside the expression must be escaped for FFmpeg (\,).
    expect(/(?<!\\),/.test(expr)).toBe(false);
  });

  it('returns a bare constant for a single keyframe', () => {
    expect(buildCropExpression([{ time: 0, x: 321, y: 0, w: 1215, h: 1080 }], 'x')).toBe('321');
  });

  it('returns "0" when given no keyframes', () => {
    expect(buildCropExpression([], 'x')).toBe('0');
  });
});
