import type { CaptionStyle } from '../../types/index.js';

export type CaptionThemeId =
  | 'golden'
  | 'matrix'
  | 'cyberpunk'
  | 'vhs'
  | 'mono'
  | 'sunset'
  | 'newsprint'
  | 'frost'
  | 'inferno'
  | 'brutalist'
  | 'pastel'
  | 'y2k'
  | 'amber'
  | 'magazine'
  | 'notebook'
  | 'vapor'
  // Bundled Opus-Clip fonts (ship as .ttf in assets/fonts, burned via libass
  // fontsdir). White + gold on black — the classic look, one per typeface.
  | 'anton'
  | 'bebas'
  | 'montserrat'
  | 'poppins'
  | 'archivo'
  | 'league'
  | 'roboto'
  | 'inter';

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
  newsprint: {
    id: 'newsprint',
    name: 'Newsprint',
    tagline: 'Editorial serif with newspaper-red emphasis.',
    fontFamily: 'Times New Roman',
    primaryColor: '#1A1A1A',
    highlightColor: '#C8102E',
    accentColor: '#4A5568',
    // Light themes get a white outline so the dark text reads as a
    // "newspaper cutout" against varied video backgrounds.
    outlineColor: '#FFFFFF',
    shadowColor: '#888888',
    outlineWidth: 7,
    bold: true,
    swatchFg: '#C8102E',
    swatchBg: '#FFFFFF',
  },
  frost: {
    id: 'frost',
    name: 'Frost',
    tagline: 'Cool tech minimal — Apple Keynote energy.',
    fontFamily: 'Helvetica Neue',
    primaryColor: '#FFFFFF',
    highlightColor: '#00B4D8',
    accentColor: '#90E0EF',
    outlineColor: '#03045E',
    shadowColor: '#001D3D',
    outlineWidth: 5,
    bold: true,
    swatchFg: '#00B4D8',
    swatchBg: '#03045E',
  },
  inferno: {
    id: 'inferno',
    name: 'Inferno',
    tagline: 'Heavy condensed orange — sports hype + breaking news.',
    fontFamily: 'Impact',
    primaryColor: '#FF4500',
    highlightColor: '#FFD700',
    accentColor: '#FF1B1B',
    outlineColor: '#1A0000',
    shadowColor: '#000000',
    outlineWidth: 6,
    bold: true,
    swatchFg: '#FFD700',
    swatchBg: '#1A0000',
  },
  brutalist: {
    id: 'brutalist',
    name: 'Brutalist',
    tagline: 'Stark white with thick black borders, single signal-red accent.',
    fontFamily: 'Helvetica Neue',
    primaryColor: '#FFFFFF',
    highlightColor: '#FF0033',
    accentColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 8,
    bold: true,
    swatchFg: '#FFFFFF',
    swatchBg: '#000000',
  },
  pastel: {
    id: 'pastel',
    name: 'Pastel Pop',
    tagline: 'Soft femme dreamy — wellness and lifestyle vibes.',
    fontFamily: 'Avenir Next',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFB6C1',
    accentColor: '#B19CD9',
    outlineColor: '#6B4E71',
    shadowColor: '#2D1B3D',
    outlineWidth: 5,
    bold: true,
    swatchFg: '#FFB6C1',
    swatchBg: '#2D1B3D',
  },
  y2k: {
    id: 'y2k',
    name: 'Y2K',
    tagline: 'Early-internet maximalist — chatroom nostalgia.',
    fontFamily: 'Trebuchet MS',
    primaryColor: '#00FFFF',
    highlightColor: '#C2FF00',
    accentColor: '#FF00C8',
    outlineColor: '#000080',
    shadowColor: '#000000',
    outlineWidth: 6,
    bold: true,
    swatchFg: '#00FFFF',
    swatchBg: '#000080',
  },
  amber: {
    id: 'amber',
    name: 'Terminal Amber',
    tagline: 'Warm CRT amber — the analog cousin of Matrix.',
    fontFamily: 'Courier New',
    primaryColor: '#FFB000',
    highlightColor: '#FFE600',
    accentColor: '#FF8C00',
    outlineColor: '#1F0F00',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: true,
    swatchFg: '#FFB000',
    swatchBg: '#1F0F00',
  },
  magazine: {
    id: 'magazine',
    name: 'Magazine',
    tagline: 'Didot serif with champagne gold — Vogue cover energy.',
    fontFamily: 'Didot',
    primaryColor: '#1A1A1A',
    highlightColor: '#D4AF37',
    accentColor: '#C0C0C0',
    outlineColor: '#FFFFFF',
    shadowColor: '#888888',
    outlineWidth: 6,
    bold: true,
    swatchFg: '#D4AF37',
    swatchBg: '#FFFFFF',
  },
  notebook: {
    id: 'notebook',
    name: 'Notebook',
    tagline: 'Marker Felt navy ink — handwritten margin notes.',
    fontFamily: 'Marker Felt',
    primaryColor: '#1E3A5F',
    highlightColor: '#E63946',
    accentColor: '#FFB627',
    outlineColor: '#FFFFFF',
    shadowColor: '#888888',
    outlineWidth: 7,
    // Marker Felt has its own weight; bolding it makes it muddy.
    bold: false,
    swatchFg: '#1E3A5F',
    swatchBg: '#FFFFFF',
  },
  vapor: {
    id: 'vapor',
    name: 'Vapor',
    tagline: '80s vaporwave — pink + cyan + purple aesthetic.',
    fontFamily: 'Futura',
    primaryColor: '#FF71CE',
    highlightColor: '#01CDFE',
    accentColor: '#B967FF',
    outlineColor: '#050546',
    shadowColor: '#B967FF',
    outlineWidth: 6,
    bold: true,
    swatchFg: '#FF71CE',
    swatchBg: '#050546',
  },

  // ── Bundled font options (Opus-Clip fonts) ──────────────────────────────
  // Each is the classic white + gold-emphasis look on a different bundled
  // typeface. `bold` is false because the .ttf files are baked at their heavy
  // display weight — ASS bold would fake-embolden and muddy them.
  anton: {
    id: 'anton',
    name: 'Anton',
    tagline: 'Heavy condensed — the viral / Hormozi caption look.',
    fontFamily: 'Anton',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: false,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
  },
  bebas: {
    id: 'bebas',
    name: 'Bebas Neue',
    tagline: 'Tall condensed all-caps — sports & fitness energy.',
    fontFamily: 'Bebas Neue',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: false,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
  },
  montserrat: {
    id: 'montserrat',
    name: 'Montserrat',
    tagline: 'Bold geometric sans — clean, modern, versatile.',
    fontFamily: 'Montserrat Black',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: false,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
  },
  poppins: {
    id: 'poppins',
    name: 'Poppins',
    tagline: 'Rounded geometric — friendly, lifestyle & beauty.',
    fontFamily: 'Poppins ExtraBold',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: false,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
  },
  archivo: {
    id: 'archivo',
    name: 'Archivo Black',
    tagline: 'Chunky grotesque — loud, bold statements.',
    fontFamily: 'Archivo Black',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: false,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
  },
  league: {
    id: 'league',
    name: 'League Spartan',
    tagline: 'Modern geometric — tech & finance clean.',
    fontFamily: 'League Spartan Black',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: false,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
  },
  roboto: {
    id: 'roboto',
    name: 'Roboto',
    tagline: 'Neutral grotesque — news & explainer clean.',
    fontFamily: 'Roboto Black',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: false,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
  },
  inter: {
    id: 'inter',
    name: 'Inter',
    tagline: 'Minimal UI-grade sans — design & premium.',
    fontFamily: 'Inter Black',
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD700',
    accentColor: '#00D4FF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    bold: false,
    swatchFg: '#FFD700',
    swatchBg: '#000000',
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
