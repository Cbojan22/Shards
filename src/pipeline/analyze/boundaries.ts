import { TranscriptSegment } from '../../types/index.js';

export interface SnapOptions {
  searchSec: number;
  minPauseSec: number;
}

interface FlatWord {
  word: string;
  start: number;
  end: number;
  speaker: string;
}

function flattenWords(segments: TranscriptSegment[]): FlatWord[] {
  const out: FlatWord[] = [];
  for (const s of segments) {
    for (const w of s.words) {
      out.push({ word: w.word, start: w.start, end: w.end, speaker: s.speaker });
    }
  }
  return out;
}

// True if the word's last non-quote / non-bracket character is . ! or ?
function endsWithTerminator(word: string): boolean {
  const stripped = word.replace(/[\s"'\)\]\}]+$/, '');
  if (!stripped) return false;
  const last = stripped[stripped.length - 1];
  return last === '.' || last === '!' || last === '?';
}

/**
 * Walk forward from `proposedEnd` and snap to the first natural ending boundary
 * within `searchSec`. A boundary is:
 *   - a word ending in . ! or ? followed by a pause >= minPauseSec, OR
 *   - a word ending in . ! or ? at end-of-transcript, OR
 *   - any word followed by a speaker change AND a pause >= minPauseSec.
 * If none found, returns `proposedEnd` unchanged.
 */
export function snapEndForward(
  segments: TranscriptSegment[],
  proposedEnd: number,
  options: SnapOptions
): number {
  const { searchSec, minPauseSec } = options;
  const limit = proposedEnd + searchSec;
  const words = flattenWords(segments);

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end < proposedEnd) continue;
    if (w.end > limit) break;

    const next = words[i + 1];

    if (!next) {
      if (endsWithTerminator(w.word)) return w.end;
      continue;
    }

    const pauseAfter = next.start - w.end;
    const speakerChange = next.speaker !== w.speaker;

    if (speakerChange && pauseAfter >= minPauseSec) return w.end;
    if (endsWithTerminator(w.word) && pauseAfter >= minPauseSec) return w.end;
  }

  return proposedEnd;
}

/**
 * Walk backward from `proposedStart` and snap to the first natural sentence
 * start within `searchSec`. A boundary is a word whose start is preceded by
 * either a pause >= minPauseSec, or a speaker change. If none found, returns
 * `proposedStart` unchanged.
 */
export function snapStartBackward(
  segments: TranscriptSegment[],
  proposedStart: number,
  options: SnapOptions
): number {
  const { searchSec, minPauseSec } = options;
  const limit = proposedStart - searchSec;
  const words = flattenWords(segments);

  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w.start > proposedStart) continue;
    if (w.start < limit) break;

    const prev = words[i - 1];
    if (!prev) continue; // first word of transcript isn't itself a snap signal

    const pauseBefore = w.start - prev.end;
    const speakerChange = prev.speaker !== w.speaker;

    if (pauseBefore >= minPauseSec || speakerChange) return w.start;
  }

  return proposedStart;
}

/**
 * Clamp `end` so the clip never exceeds `start + maxDuration * softCapRatio`.
 * Acts as a safety ceiling for the soft-cap rule (Claude may flag overrun for
 * completeness, but we never let a single clip blow past this multiple).
 */
export function clampSoftCap(
  start: number,
  end: number,
  maxDuration: number,
  softCapRatio: number
): number {
  const ceiling = start + maxDuration * softCapRatio;
  return Math.min(end, ceiling);
}

/**
 * Add tail padding to give the punchline / reaction beat room to breathe.
 * Optional `totalDuration` caps the result at the source video's length so we
 * never request frames past EOF.
 */
export function applyTailPadding(
  end: number,
  paddingSec: number,
  totalDuration?: number
): number {
  const padded = end + paddingSec;
  if (totalDuration !== undefined) return Math.min(padded, totalDuration);
  return padded;
}
