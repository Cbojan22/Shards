import { describe, it, expect } from 'vitest';
import {
  snapEndForward,
  snapStartBackward,
  clampSoftCap,
  applyTailPadding,
} from '../src/pipeline/analyze/boundaries.js';
import { TranscriptSegment, WordTimestamp } from '../src/types/index.js';

// Test helper: builds a TranscriptSegment from a compact tuple list.
function seg(
  words: Array<[string, number, number]>,
  speaker = 'SPEAKER_A'
): TranscriptSegment {
  const wordObjs: WordTimestamp[] = words.map(([w, s, e]) => ({
    word: w,
    start: s,
    end: e,
  }));
  return {
    start: wordObjs[0].start,
    end: wordObjs[wordObjs.length - 1].end,
    text: words.map(([w]) => w).join(' '),
    speaker,
    words: wordObjs,
  };
}

describe('snapEndForward', () => {
  it('snaps to a word ending in punctuation followed by a real pause', () => {
    // proposedEnd=10. Within 5s window, "yeah." ends at 12.5 with a 0.5s pause to next word.
    const segments = [
      seg([
        ['hello', 0, 0.5],
        ['fine,', 9, 10],
        ['and', 10.1, 10.4],
        ['yeah.', 12, 12.5],
        ['but', 13.0, 13.3],
        ['no', 14, 14.3],
      ]),
    ];
    expect(snapEndForward(segments, 10, { searchSec: 5, minPauseSec: 0.4 })).toBe(12.5);
  });

  it('does NOT snap to punctuation if the following pause is too short', () => {
    // "fine," has only 0.1s pause after — not a real ending beat.
    const segments = [
      seg([
        ['fine,', 9, 10],
        ['and', 10.1, 10.4],
        ['continuing', 10.5, 11.2],
      ]),
    ];
    expect(snapEndForward(segments, 9.5, { searchSec: 5, minPauseSec: 0.4 })).toBe(9.5);
  });

  it('returns proposedEnd when no qualifying boundary is found in the window', () => {
    const segments = [
      seg([
        ['this', 0, 0.5],
        ['has', 0.6, 0.8],
        ['no', 0.9, 1.1],
        ['endings', 1.2, 1.6],
      ]),
    ];
    expect(snapEndForward(segments, 0.5, { searchSec: 2, minPauseSec: 0.4 })).toBe(0.5);
  });

  it('snaps to a punctuated word at end-of-transcript (no next word at all)', () => {
    const segments = [
      seg([
        ['it', 0, 0.3],
        ['is', 0.4, 0.6],
        ['done.', 1.0, 1.5],
      ]),
    ];
    expect(snapEndForward(segments, 0.7, { searchSec: 5, minPauseSec: 0.4 })).toBe(1.5);
  });

  it('snaps on speaker change even without punctuation, when the gap is real', () => {
    const segments = [
      seg(
        [
          ['my', 0, 0.5],
          ['answer', 0.6, 1.0],
        ],
        'SPEAKER_A'
      ),
      seg(
        [
          ['what', 2.0, 2.3], // 1.0s gap before this — real pause
        ],
        'SPEAKER_B'
      ),
    ];
    expect(snapEndForward(segments, 0.7, { searchSec: 3, minPauseSec: 0.4 })).toBe(1.0);
  });

  it('respects searchSec — does not snap to a far-away punctuation', () => {
    const segments = [
      seg([
        ['near', 0, 0.5],
        ['far.', 100, 100.5],
        ['away', 102, 102.5],
      ]),
    ];
    expect(snapEndForward(segments, 10, { searchSec: 5, minPauseSec: 0.4 })).toBe(10);
  });

  it('handles ! and ? as ending punctuation', () => {
    const segments = [
      seg([
        ['wait', 0, 0.5],
        ['really?', 1.0, 1.5],
        ['yes', 2.5, 2.9],
      ]),
    ];
    expect(snapEndForward(segments, 0.6, { searchSec: 3, minPauseSec: 0.4 })).toBe(1.5);
  });

  it('strips trailing whitespace/quotes when checking punctuation', () => {
    // Whisper sometimes emits words like 'done."' or 'yes!"'
    const segments = [
      seg([
        ['"done."', 0, 0.5],
        ['then', 1.5, 1.8],
      ]),
    ];
    expect(snapEndForward(segments, 0.2, { searchSec: 3, minPauseSec: 0.4 })).toBe(0.5);
  });
});

describe('snapStartBackward', () => {
  it('snaps backward to a word that starts right after a real pause', () => {
    const segments = [
      seg([
        ['lead-in.', 0, 0.5],
        ['So', 1.5, 1.8], // 1.0s pause before — qualifies
        ['anyway', 1.9, 2.3],
        ['the', 2.4, 2.5],
        ['thing', 2.6, 2.9],
      ]),
    ];
    expect(snapStartBackward(segments, 2.5, { searchSec: 2, minPauseSec: 0.4 })).toBe(1.5);
  });

  it('returns proposedStart when no qualifying boundary is found', () => {
    const segments = [
      seg([
        ['nonstop', 0, 0.5],
        ['speech', 0.51, 0.8],
        ['continues', 0.81, 1.2],
      ]),
    ];
    expect(snapStartBackward(segments, 1.0, { searchSec: 2, minPauseSec: 0.4 })).toBe(1.0);
  });

  it('snaps backward across multiple words to reach a real pause', () => {
    const segments = [
      seg([
        ['outro.', 0, 0.5],
        ['So', 2.0, 2.3], // 1.5s pause before — qualifies
        ['the', 2.4, 2.5],
        ['point', 2.6, 2.9],
      ]),
    ];
    expect(snapStartBackward(segments, 2.7, { searchSec: 3, minPauseSec: 0.4 })).toBe(2.0);
  });

  it('snaps backward on speaker change', () => {
    const segments = [
      seg(
        [
          ['intro', 0, 0.4],
          ['line', 0.5, 0.8],
        ],
        'SPEAKER_A'
      ),
      seg(
        [
          ['response', 0.85, 1.2], // small pause but speaker changed
          ['continues', 1.3, 1.7],
        ],
        'SPEAKER_B'
      ),
    ];
    expect(snapStartBackward(segments, 1.5, { searchSec: 2, minPauseSec: 0.4 })).toBe(0.85);
  });
});

describe('clampSoftCap', () => {
  it('returns end unchanged when duration is within softCap window', () => {
    expect(clampSoftCap(0, 50, 60, 1.5)).toBe(50);
  });

  it('clamps to start + maxDuration*softCapRatio when overshooting', () => {
    expect(clampSoftCap(0, 200, 60, 1.5)).toBe(90);
  });

  it('respects a non-zero start offset', () => {
    expect(clampSoftCap(100, 250, 60, 1.5)).toBe(190);
  });

  it('softCapRatio of 1.0 acts as a hard cap', () => {
    expect(clampSoftCap(0, 200, 60, 1.0)).toBe(60);
  });
});

describe('applyTailPadding', () => {
  it('adds padding to the end', () => {
    expect(applyTailPadding(10, 0.6)).toBe(10.6);
  });

  it('caps at totalDuration when given', () => {
    expect(applyTailPadding(10, 5, 12)).toBe(12);
  });

  it('returns end unchanged when padding is zero', () => {
    expect(applyTailPadding(10, 0)).toBe(10);
  });

  it('does not exceed totalDuration even with large padding', () => {
    expect(applyTailPadding(99.5, 5, 100)).toBe(100);
  });
});
