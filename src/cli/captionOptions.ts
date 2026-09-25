import chalk from 'chalk';
import { CAPTION_THEMES, CAPTION_THEME_IDS, type CaptionThemeId } from '../pipeline/captions/themes.js';
import type { CaptionStyle } from '../types/index.js';

// Caption flag handling shared by `process`, `caption` and `config`, so a
// value is accepted or rejected the same way everywhere.

export const THEME_COUNT = CAPTION_THEME_IDS.length;

export const FONT_SIZE_RANGE = { min: 24, max: 240 } as const;
export const WORDS_PER_GROUP_RANGE = { min: 1, max: 5 } as const;

export interface CaptionOverrides {
  theme?: string;
  position?: string;
  fontSize?: string;
  wordsPerGroup?: string;
}

export class CaptionOptionError extends Error {}

/**
 * Validate caption flags and layer them over the saved style. Returns the
 * un-themed style (what gets persisted) plus the chosen theme; callers run
 * `applyTheme` to get the render style. Throws CaptionOptionError on bad input.
 */
export function applyCaptionOverrides(
  base: CaptionStyle,
  savedTheme: CaptionThemeId,
  o: CaptionOverrides,
): { captionTheme: CaptionThemeId; captionStyle: CaptionStyle } {
  if (o.theme !== undefined && !CAPTION_THEME_IDS.includes(o.theme as CaptionThemeId)) {
    throw new CaptionOptionError(
      `Unknown caption theme "${o.theme}". Run \`shards-cli themes\` to list all ${THEME_COUNT}.`,
    );
  }
  const style = { ...base };
  if (o.position !== undefined) {
    if (o.position !== 'top' && o.position !== 'center' && o.position !== 'bottom') {
      throw new CaptionOptionError(`Invalid caption position: ${o.position}. Expected top|center|bottom.`);
    }
    style.position = o.position;
  }
  if (o.fontSize !== undefined) {
    style.fontSize = parseInRange(o.fontSize, FONT_SIZE_RANGE, 'font size');
  }
  if (o.wordsPerGroup !== undefined) {
    style.wordsPerGroup = parseInRange(o.wordsPerGroup, WORDS_PER_GROUP_RANGE, 'words per group');
  }
  return { captionTheme: (o.theme as CaptionThemeId | undefined) ?? savedTheme, captionStyle: style };
}

function parseInRange(raw: string, range: { min: number; max: number }, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    throw new CaptionOptionError(`Invalid ${label}: ${raw}. Expected ${range.min}–${range.max}.`);
  }
  return n;
}

// Validate caption flags, printing the problem and exiting on bad input.
export function captionOverridesOrExit(...args: Parameters<typeof applyCaptionOverrides>) {
  try {
    return applyCaptionOverrides(...args);
  } catch (err) {
    if (!(err instanceof CaptionOptionError)) throw err;
    console.error(chalk.red(err.message));
    process.exit(1);
  }
}

/** Lines for `shards-cli themes`: id, font and tagline, with the saved default marked. */
export function formatThemeList(savedTheme: CaptionThemeId): string[] {
  const idWidth = Math.max(...CAPTION_THEME_IDS.map((id) => id.length));
  const fontWidth = Math.max(...CAPTION_THEME_IDS.map((id) => CAPTION_THEMES[id].fontFamily.length));
  return [
    '',
    chalk.bold(`  Caption themes (${THEME_COUNT})`),
    '',
    ...CAPTION_THEME_IDS.map((id) => {
      const t = CAPTION_THEMES[id];
      const marker = id === savedTheme ? chalk.green('●') : ' ';
      return `  ${marker} ${chalk.cyan(id.padEnd(idWidth))}  ${chalk.white(t.fontFamily.padEnd(fontWidth))} ${chalk.gray(t.tagline)}`;
    }),
    '',
    chalk.gray('  ● saved default · render samples of all themes with `shards-cli preview`'),
    '',
  ];
}
