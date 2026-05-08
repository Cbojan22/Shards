import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  WordTimestamp,
  TranscriptResult,
  CaptionStyle,
} from '../../types/index.js';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

export interface WordGroup {
  words: WordTimestamp[];
  text: string;
  start: number; // absolute time
  end: number;   // absolute time
  emphasisIndices: Set<number>; // which words are emphasized
}

export interface ASSEvent {
  start: number; // relative to clip start
  end: number;
  text: string;  // with ASS override tags
  style: string; // "Default"
}

// ---------------------------------------------------------------------------
// Default caption style
// ---------------------------------------------------------------------------

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Arial Black',
  fontSize: 104,
  primaryColor: '#FFFFFF',
  highlightColor: '#FFD700',
  accentColor: '#00D4FF',
  outlineColor: '#000000',
  outlineWidth: 5,
  shadowColor: '#000000',
  position: 'bottom',
  // Soft target: grouping respects phrase cohesion and width, so groups
  // can grow past this when a phrase fits and shrink when punctuation
  // suggests a clean break.
  wordsPerGroup: 3,
  bold: true,
};

// Caption frame width matches the rendered ASS PlayResX (see buildASSHeader).
const CAPTION_VIDEO_WIDTH = 1080;
// Keep text inside ~82% of the frame so libass never wraps or clips on
// narrower devices (status bars, rounded corners, share sheets).
const SAFE_WIDTH_RATIO = 0.82;

// ---------------------------------------------------------------------------
// Emphasis detection
// ---------------------------------------------------------------------------

const EMPHASIS_WORDS = new Set([
  'never', 'always', 'amazing', 'incredible', 'literally', 'absolutely',
  'exactly', 'insane', 'crazy', 'million', 'billion', 'trillion',
  'thousand', 'hundred', 'impossible', 'unbelievable', 'seriously',
  'definitely', 'actually', 'basically', 'obviously', 'honestly',
  'everything', 'nothing', 'forever', 'massive', 'enormous', 'huge',
  'terrible', 'fantastic', 'perfect', 'worst', 'best', 'biggest',
  'smallest', 'fastest', 'strongest', 'greatest', 'money', 'secret',
  'guaranteed', 'powerful', 'dangerous', 'critical', 'urgent',
  'important', 'essential', 'ultimate', 'extraordinary', 'revolutionary',
]);

/**
 * Identify which words in a group should be highlighted/emphasized.
 * Returns a set of indices (0-based) within the provided array.
 */
export function identifyEmphasisWords(words: string[]): Set<number> {
  const indices = new Set<number>();

  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    // Strip punctuation for matching
    const cleaned = raw.replace(/[.,!?;:'")\]]+$/g, '').replace(/^[(['"]+/g, '');

    // ALL CAPS words (at least 2 chars to avoid "I", "A")
    if (cleaned.length >= 2 && cleaned === cleaned.toUpperCase() && /[A-Z]/.test(cleaned)) {
      indices.add(i);
      continue;
    }

    // Words longer than 6 characters
    if (cleaned.length > 6) {
      indices.add(i);
      continue;
    }

    // Known emphasis words
    if (EMPHASIS_WORDS.has(cleaned.toLowerCase())) {
      indices.add(i);
      continue;
    }

    // Numbers (pure digits or contains digits like "$100k")
    if (/\d/.test(cleaned)) {
      indices.add(i);
      continue;
    }
  }

  return indices;
}

// ---------------------------------------------------------------------------
// Word grouping
// ---------------------------------------------------------------------------

const PAUSE_THRESHOLD = 0.35; // seconds -- start new group if gap exceeds this

const NUMBER_MAGNITUDE = new Set([
  'thousand', 'thousands', 'million', 'millions', 'billion', 'billions',
  'trillion', 'trillions', 'hundred', 'hundreds', 'dozen', 'dozens',
  'k', 'm', 'b', 'mil', 'bil',
]);

function strip(word: string): string {
  return word.replace(/[.,!?;:'"()\[\]]+/g, '').toLowerCase();
}

function hasDigit(word: string): boolean {
  return /\d/.test(word);
}

function isMagnitudeWord(word: string): boolean {
  return NUMBER_MAGNITUDE.has(strip(word));
}

/**
 * True when `next` continues a numeric phrase started by `prev` and the
 * pair must never be split across caption groups (e.g. "50" + ",000",
 * "$5" + "million", "1" + "point" + "5").
 */
function isUnbreakablePair(prev: string, next: string): boolean {
  // "50" + ",000" or "12" + ".5"
  if (hasDigit(prev) && /^[,.]\d/.test(next)) return true;
  // "50" + "thousand", "$5" + "million"
  if ((hasDigit(prev) || /[$€£¥]$/.test(prev)) && isMagnitudeWord(next)) return true;
  // "$" + "5"
  if (/[$€£¥]$/.test(prev) && hasDigit(next)) return true;
  // "five" + "hundred" + "thousand"
  if (isMagnitudeWord(prev) && isMagnitudeWord(next)) return true;
  // "1" + "point" + "5"
  if (hasDigit(prev) && strip(next) === 'point') return true;
  if (strip(prev) === 'point' && hasDigit(next)) return true;
  return false;
}

/**
 * Approximate rendered width of `text` in pixels for bold uppercase
 * captions at the given font size. Tuned for Arial Black / Impact-class
 * faces; conservative for narrower fonts. Used to decide how many words
 * fit on one line without libass wrapping or clipping.
 */
function estimateTextWidth(text: string, fontSize: number): number {
  const upper = text.toUpperCase();
  let width = 0;
  for (const ch of upper) {
    if (ch === ' ') width += fontSize * 0.32;
    else if (/[ILJ1!.,'":;|]/.test(ch)) width += fontSize * 0.32;
    else if (/[MW]/.test(ch)) width += fontSize * 0.88;
    else width += fontSize * 0.62;
  }
  return width;
}

// Words may carry an optional `speaker` tag attached upstream by
// extractClipWords. Grouping breaks on speaker change when present and
// silently ignores it when absent (preserving the public API).
type MaybeSpeakerWord = WordTimestamp & { speaker?: string };

interface AtomicChunk {
  words: MaybeSpeakerWord[];
  start: number;
  end: number;
  text: string;
  speaker?: string;
  endsSentence: boolean; // last word ends with .?! → hard break after
  endsClause: boolean;   // last word ends with ,;:  → soft break after
}

/**
 * Pre-pass that fuses runs of words which must be displayed together
 * (numeric phrases, currency, decimals). Subsequent grouping treats each
 * chunk as atomic.
 */
function buildAtomicChunks(words: MaybeSpeakerWord[]): AtomicChunk[] {
  const chunks: AtomicChunk[] = [];
  let cur: MaybeSpeakerWord[] = [];

  for (const w of words) {
    if (cur.length === 0) {
      cur.push(w);
      continue;
    }
    const prev = cur[cur.length - 1];
    if (isUnbreakablePair(prev.word, w.word)) {
      cur.push(w);
    } else {
      chunks.push(makeChunk(cur));
      cur = [w];
    }
  }
  if (cur.length > 0) chunks.push(makeChunk(cur));
  return chunks;
}

function makeChunk(words: MaybeSpeakerWord[]): AtomicChunk {
  const last = words[words.length - 1].word;
  return {
    words: [...words],
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.word).join(' '),
    speaker: words[0].speaker,
    endsSentence: /[.?!]$/.test(last),
    endsClause: /[,;:]$/.test(last),
  };
}

export interface GroupOptions {
  /** Reserved soft hint; the new algorithm prioritises sentence cohesion
   *  over a fixed word count, so this only nudges the soft clause-break
   *  threshold. */
  targetWordsPerGroup: number;
  /** Font size used to estimate rendered text width. */
  fontSize: number;
  /** Frame width in pixels (matches ASS PlayResX). */
  videoWidth?: number;
  /** Override pause-break threshold in seconds. */
  pauseThreshold?: number;
}

// Soft break point: when the current group's rendered width crosses this
// fraction of the safe max AND the previous word ended a clause (,;:),
// flush there so long sentences split on natural clause boundaries
// instead of mid-phrase when width finally runs out.
const SOFT_CLAUSE_WIDTH_RATIO = 0.7;

/**
 * Group consecutive words for display so each group reads as a complete
 * thought. Breaks on, in priority order:
 *  - sentence-ending punctuation (. ? !) — strongest signal
 *  - speaker change (when speaker tags are present on the words)
 *  - natural pause longer than `pauseThreshold`
 *  - rendered width exceeding the safe frame width
 *  - clause-ending punctuation (, ; :) once width is past ~70% of the cap
 *
 * Numeric phrases are pre-fused into atomic chunks so they're never
 * split (see `buildAtomicChunks`). The `targetWordsPerGroup` field is
 * kept for config compatibility but no longer caps group size.
 */
export function groupWords(
  words: WordTimestamp[] | MaybeSpeakerWord[],
  options: GroupOptions | number,
): WordGroup[] {
  if (words.length === 0) return [];

  // Backward-compat: callers used to pass a plain number.
  const opts: GroupOptions =
    typeof options === 'number'
      ? { targetWordsPerGroup: options, fontSize: DEFAULT_CAPTION_STYLE.fontSize }
      : options;

  const pauseGap = opts.pauseThreshold ?? PAUSE_THRESHOLD;
  const videoWidth = opts.videoWidth ?? CAPTION_VIDEO_WIDTH;
  const maxWidth = videoWidth * SAFE_WIDTH_RATIO;

  const chunks = buildAtomicChunks(words as MaybeSpeakerWord[]);
  const groups: WordGroup[] = [];

  let curChunks: AtomicChunk[] = [];
  let curText = '';
  let curSpeaker: string | undefined;

  const flush = () => {
    if (curChunks.length === 0) return;
    const flat = curChunks.flatMap((c) => c.words);
    groups.push(buildGroup(flat));
    curChunks = [];
    curText = '';
    curSpeaker = undefined;
  };

  for (const chunk of chunks) {
    if (curChunks.length === 0) {
      curChunks.push(chunk);
      curText = chunk.text;
      curSpeaker = chunk.speaker;
      continue;
    }

    const prevChunk = curChunks[curChunks.length - 1];
    const gap = chunk.start - prevChunk.end;
    const tentativeText = `${curText} ${chunk.text}`;
    const tentativeWidth = estimateTextWidth(tentativeText, opts.fontSize);

    // Strong reasons to start a new caption right here.
    const sentenceEnded = prevChunk.endsSentence;
    const speakerChanged =
      curSpeaker !== undefined &&
      chunk.speaker !== undefined &&
      chunk.speaker !== curSpeaker;
    const longPause = gap > pauseGap;
    const widthOverflow = tentativeWidth > maxWidth;

    // Soft fallback: if the previous chunk ended a clause and we're
    // close to width cap, break here rather than waiting to overflow
    // mid-phrase.
    const softClauseBreak =
      prevChunk.endsClause && tentativeWidth > maxWidth * SOFT_CLAUSE_WIDTH_RATIO;

    const shouldFlush =
      sentenceEnded ||
      speakerChanged ||
      longPause ||
      widthOverflow ||
      softClauseBreak;

    if (shouldFlush) {
      flush();
      curChunks.push(chunk);
      curText = chunk.text;
      curSpeaker = chunk.speaker;
    } else {
      curChunks.push(chunk);
      curText = tentativeText;
    }
  }

  flush();
  return groups;
}

function buildGroup(words: WordTimestamp[]): WordGroup {
  const textParts = words.map((w) => w.word);
  const emphasisIndices = identifyEmphasisWords(textParts);
  return {
    words: [...words],
    text: textParts.join(' '),
    start: words[0].start,
    end: words[words.length - 1].end,
    emphasisIndices,
  };
}

// ---------------------------------------------------------------------------
// Color conversion
// ---------------------------------------------------------------------------

/**
 * Convert "#RRGGBB" hex color to ASS "&HBBGGRR&" format.
 * Also accepts "#RGB" shorthand.
 */
export function hexToASS(hex: string): string {
  let h = hex.replace('#', '');

  // Expand shorthand
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }

  const r = h.substring(0, 2);
  const g = h.substring(2, 4);
  const b = h.substring(4, 6);

  return `&H00${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}&`;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/**
 * Convert seconds to ASS time format "H:MM:SS.CC" (centiseconds).
 */
export function formatASSTime(seconds: number): string {
  if (seconds < 0) seconds = 0;

  const totalCs = Math.round(seconds * 100);
  const h = Math.floor(totalCs / 360000);
  const remaining = totalCs % 360000;
  const m = Math.floor(remaining / 6000);
  const remaining2 = remaining % 6000;
  const s = Math.floor(remaining2 / 100);
  const cs = remaining2 % 100;

  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const cc = String(cs).padStart(2, '0');

  return `${h}:${mm}:${ss}.${cc}`;
}

// ---------------------------------------------------------------------------
// ASS header
// ---------------------------------------------------------------------------

/**
 * Build the ASS file header including [Script Info] and [V4+ Styles].
 */
export function buildASSHeader(
  style: CaptionStyle,
  videoWidth = 1080,
  videoHeight = 1920,
): string {
  const primaryBGR = hexToASS(style.primaryColor);
  const highlightBGR = hexToASS(style.highlightColor);
  const accentBGR = hexToASS(style.accentColor);
  const outlineBGR = hexToASS(style.outlineColor);
  const shadowBGR = hexToASS(style.shadowColor);

  const boldFlag = style.bold ? -1 : 0;

  // Position -> alignment & marginV
  let alignment: number;
  let marginV: number;
  switch (style.position) {
    case 'top':
      alignment = 8;
      marginV = 100;
      break;
    case 'center':
      alignment = 5;
      marginV = 0;
      break;
    case 'bottom':
    default:
      alignment = 2;
      marginV = 350;
      break;
  }

  // ASS Style format:
  // Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,
  // OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,
  // ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,
  // Alignment, MarginL, MarginR, MarginV, Encoding

  const defaultStyle = [
    'Default',
    style.fontFamily,
    style.fontSize,
    primaryBGR,
    primaryBGR,
    outlineBGR,
    shadowBGR,
    boldFlag,
    0, // Italic
    0, // Underline
    0, // StrikeOut
    100, // ScaleX
    100, // ScaleY
    0, // Spacing
    0, // Angle
    1, // BorderStyle (outline + shadow)
    style.outlineWidth,
    1, // Shadow depth
    alignment,
    10, // MarginL
    10, // MarginR
    marginV,
    1, // Encoding
  ].join(',');

  const highlightStyle = [
    'Highlight',
    style.fontFamily,
    style.fontSize + 4,
    highlightBGR,
    highlightBGR,
    outlineBGR,
    shadowBGR,
    boldFlag,
    0, 0, 0,
    100, 100, 0, 0,
    1,
    style.outlineWidth,
    1,
    alignment,
    10, 10,
    marginV,
    1,
  ].join(',');

  const accentStyle = [
    'Accent',
    style.fontFamily,
    style.fontSize + 2,
    accentBGR,
    accentBGR,
    outlineBGR,
    shadowBGR,
    boldFlag,
    0, 0, 0,
    100, 100, 0, 0,
    1,
    style.outlineWidth,
    1,
    alignment,
    10, 10,
    marginV,
    1,
  ].join(',');

  return `[Script Info]
Title: Shards Captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${defaultStyle}
Style: ${highlightStyle}
Style: ${accentStyle}

`;
}

// ---------------------------------------------------------------------------
// ASS event text with inline override tags
// ---------------------------------------------------------------------------

function buildEventText(group: WordGroup, style: CaptionStyle): string {
  const highlightASSColor = hexToASS(style.highlightColor);
  const parts: string[] = [];

  for (let i = 0; i < group.words.length; i++) {
    const word = group.words[i].word.toUpperCase();
    if (group.emphasisIndices.has(i)) {
      // Emphasised word: change colour and scale up slightly
      parts.push(
        `{\\c${highlightASSColor}\\fscx110\\fscy110}${word}{\\r}`,
      );
    } else {
      parts.push(word);
    }
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// ASS file composition
// ---------------------------------------------------------------------------

/**
 * Compose the full ASS file from a header string and an array of events.
 */
export function generateASSFile(header: string, events: ASSEvent[]): string {
  const lines: string[] = [header];
  lines.push('[Events]');
  lines.push(
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  );

  for (const evt of events) {
    const start = formatASSTime(evt.start);
    const end = formatASSTime(evt.end);
    lines.push(
      `Dialogue: 0,${start},${end},${evt.style},,0,0,0,,${evt.text}`,
    );
  }

  lines.push(''); // trailing newline
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Extract words within clip range
// ---------------------------------------------------------------------------

function extractClipWords(
  transcript: TranscriptResult,
  clipStart: number,
  clipEnd: number,
): MaybeSpeakerWord[] {
  const result: MaybeSpeakerWord[] = [];

  for (const segment of transcript.segments) {
    // Skip segments entirely outside the clip range
    if (segment.end <= clipStart || segment.start >= clipEnd) continue;

    for (const w of segment.words) {
      // Word must overlap with the clip window
      if (w.end > clipStart && w.start < clipEnd) {
        // Tag with segment speaker so groupWords can break on
        // speaker change between consecutive utterances.
        result.push({ ...w, speaker: segment.speaker });
      }
    }
  }

  // Sort by start time to ensure correct ordering
  result.sort((a, b) => a.start - b.start);
  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const MIN_DISPLAY_TIME = 0.3;
const GROUP_GAP = 0.05;

/**
 * Generate an ASS subtitle file for a clip from the given transcript.
 *
 * @returns The output file path.
 */
export async function generateCaptions(
  transcript: TranscriptResult,
  clipStart: number,
  clipEnd: number,
  style: CaptionStyle,
  outputPath: string,
): Promise<string> {
  // 1. Extract words within clip range
  const words = extractClipWords(transcript, clipStart, clipEnd);

  if (words.length === 0) {
    // Still produce a valid but empty ASS file
    const header = buildASSHeader(style);
    const content = generateASSFile(header, []);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, 'utf-8');
    return outputPath;
  }

  // 2. Group words
  const groups = groupWords(words, {
    targetWordsPerGroup: style.wordsPerGroup,
    fontSize: style.fontSize,
  });

  // 3. Build ASS events with timing relative to clip start
  const events: ASSEvent[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];

    // Times relative to clip start
    let relStart = group.start - clipStart;
    let relEnd = group.end - clipStart;

    // Enforce minimum display time
    if (relEnd - relStart < MIN_DISPLAY_TIME) {
      relEnd = relStart + MIN_DISPLAY_TIME;
    }

    // Ensure a small gap from the previous event for readability
    if (events.length > 0) {
      const prevEnd = events[events.length - 1].end;
      if (relStart < prevEnd + GROUP_GAP) {
        relStart = prevEnd + GROUP_GAP;
        if (relEnd <= relStart) {
          relEnd = relStart + MIN_DISPLAY_TIME;
        }
      }
    }

    // Clamp to clip duration
    const clipDuration = clipEnd - clipStart;
    if (relStart >= clipDuration) break;
    if (relEnd > clipDuration) relEnd = clipDuration;

    const text = buildEventText(group, style);

    events.push({
      start: relStart,
      end: relEnd,
      text,
      style: 'Default',
    });
  }

  // 4. Generate full ASS content
  const header = buildASSHeader(style);
  const content = generateASSFile(header, events);

  // 5. Write to disk
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf-8');

  return outputPath;
}
