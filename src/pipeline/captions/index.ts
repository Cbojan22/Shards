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
  wordsPerGroup: 2,
  bold: true,
};

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

const PAUSE_THRESHOLD = 0.3; // seconds -- start new group if gap exceeds this

/**
 * Group consecutive words for display. Respects natural pauses and
 * the configured wordsPerGroup limit.
 */
export function groupWords(
  words: WordTimestamp[],
  wordsPerGroup: number,
): WordGroup[] {
  if (words.length === 0) return [];

  const groups: WordGroup[] = [];
  let currentWords: WordTimestamp[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    // Check for pause gap between previous word and this one
    if (currentWords.length > 0) {
      const prev = currentWords[currentWords.length - 1];
      const gap = word.start - prev.end;
      if (gap > PAUSE_THRESHOLD) {
        // Flush current group because of a natural pause
        groups.push(buildGroup(currentWords));
        currentWords = [];
      }
    }

    currentWords.push(word);

    // Flush when we hit the group size limit
    if (currentWords.length >= wordsPerGroup) {
      groups.push(buildGroup(currentWords));
      currentWords = [];
    }
  }

  // Flush remaining words
  if (currentWords.length > 0) {
    groups.push(buildGroup(currentWords));
  }

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
Title: Video Clipper Captions
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
): WordTimestamp[] {
  const result: WordTimestamp[] = [];

  for (const segment of transcript.segments) {
    // Skip segments entirely outside the clip range
    if (segment.end <= clipStart || segment.start >= clipEnd) continue;

    for (const w of segment.words) {
      // Word must overlap with the clip window
      if (w.end > clipStart && w.start < clipEnd) {
        result.push(w);
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
  const groups = groupWords(words, style.wordsPerGroup);

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
