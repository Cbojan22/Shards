import type { CaptionStyle } from '../../types/index.js';

export type CaptionThemeId =
  | 'golden'
  | 'matrix'
  | 'cyberpunk'
  | 'vhs'
  | 'mono'
  | 'sunset';

export interface CaptionTheme {
  id: CaptionThemeId;
  name: string;
  tagline: string;
  // libass picks fonts up from the system; these are macOS-installed names.
  fontFamily: string;
  primaryColor: string;
  highlightColor: string;
  accentColor: string;
  outlineColor: string;
  shadowColor: string;
  outlineWidth: number;
  bold: boolean;
  // Used by the TUI to render a colour swatch / preview line.
  swatchFg: string;
  swatchBg: string;
}

export const CAPTION_THEMES: Record<CaptionThemeId, CaptionTheme> = {
  golden: {
    id: 'golden',
    name: 'Golden',
    tagline: 'White text with gold emphasis — the classic look.',
    fontFamily: 'Arial Black',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: true,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
  },
  matrix: {
    id: 'matrix',
    name: 'Matrix',
    tagline: 'Phosphor green monospace — wake up, Neo.',
    fontFamily: 'Menlo',
    primaryColor: '#00FF41',
    highlightColor: '#7CFFB2',
    accentColor: '#00FFD1',
    outlineColor: '#001100',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: true,
    swatchFg: '#00FF41',
    swatchBg: '#000000',
  },
  cyberpunk: {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    tagline: 'Magenta and cyan neon, slick sans.',
    fontFamily: 'Helvetica Neue',
    primaryColor: '#FF00FF',
    highlightColor: '#00FFFF',
    accentColor: '#FFFF00',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 6,
    bold: true,
    swatchFg: '#FF00FF',
    swatchBg: '#0F0F23',
  },
  vhs: {
    id: 'vhs',
    name: 'VHS',
    tagline: 'Bold Impact in blood red — late-night cable.',
    fontFamily: 'Impact',
    primaryColor: '#FFFFFF',
    highlightColor: '#FF1F1F',
    accentColor: '#FFD700',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 6,
    bold: true,
    swatchFg: '#FF1F1F',
    swatchBg: '#000000',
  },
  mono: {
    id: 'mono',
    name: 'Mono',
    tagline: 'Plain white, no colour emphasis — distraction-free.',
    fontFamily: 'Helvetica Neue',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    accentColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 4,
    bold: true,
    swatchFg: '#FFFFFF',
    swatchBg: '#000000',
  },
  sunset: {
    id: 'sunset',
    name: 'Sunset',
    tagline: 'Warm orange and coral on dusk plum.',
    fontFamily: 'Futura',
    primaryColor: '#FFB347',
    highlightColor: '#FF6F61',
    accentColor: '#FFD2D7',
    outlineColor: '#3E1F47',
    shadowColor: '#1A0E22',
    outlineWidth: 5,
    bold: true,
    swatchFg: '#FF6F61',
    swatchBg: '#3E1F47',
  },
};

export const CAPTION_THEME_IDS = Object.keys(CAPTION_THEMES) as CaptionThemeId[];

// Overlay a theme's visual fields onto an existing CaptionStyle without
// touching layout fields (position, fontSize, wordsPerGroup) the user might
// have customised separately.
export function applyTheme(style: CaptionStyle, themeId: CaptionThemeId): CaptionStyle {
  const theme = CAPTION_THEMES[themeId];
  return {
    ...style,
    fontFamily: theme.fontFamily,
    primaryColor: theme.primaryColor,
    highlightColor: theme.highlightColor,
    accentColor: theme.accentColor,
    outlineColor: theme.outlineColor,
    shadowColor: theme.shadowColor,
    outlineWidth: theme.outlineWidth,
    bold: theme.bold,
  };
}
