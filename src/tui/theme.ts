// Single colour palette for the SHARDS TUI. Picked once so every screen
// looks like part of the same retro/hacker shell.

export const TUI = {
  primary: '#00FF41',  // matrix green — borders, headings, accents
  accent: '#00D4FF',   // cyan — interactive highlights, "press X" cues
  warn: '#FFD700',     // amber — warnings + secondary highlights
  error: '#FF3860',    // red — errors and destructive actions
  dim: '#5C5C5C',      // gray — hints, captions, low-priority info
  fg: '#E6E6E6',       // off-white — body text
  muted: '#9CA3AF',    // muted gray — placeholder text
} as const;
