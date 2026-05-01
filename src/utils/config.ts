import { homedir } from 'os';
import path from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import type { CaptionStyle } from '../types/index.js';
import { DEFAULT_CAPTION_STYLE } from '../pipeline/captions/index.js';
import type { CaptionThemeId } from '../pipeline/captions/themes.js';

// Single source of truth for user-facing settings, shared between the
// scripted CLI (`shards-cli`) and the TUI (`shards`). Stored in the user's
// home directory so the same defaults follow them across projects.

export interface UserConfig {
  whisperModel: string;
  language: string;
  minClipDuration: number;
  maxClipDuration: number;
  maxClips: number;
  faceSampleRate: number;
  anthropicApiKey: string;
  format: 'mp4' | 'mov' | 'webm';
  quality: 'high' | 'medium' | 'low';
  videoFormat: 'fullscreen' | 'centered';
  withCaptions: boolean;
  captionTheme: CaptionThemeId;
  captionStyle: CaptionStyle;
  /** Seconds of tail padding added after each clip's snapped ending. */
  endPaddingSec: number;
  /** Hard ceiling = maxClipDuration * softCapRatio. */
  softCapRatio: number;
  /** Drop clips Claude flagged as incomplete (completeness_score<70 or ending_type "trail_off"). */
  strictCompleteness: boolean;
}

export const DEFAULT_CONFIG: UserConfig = {
  whisperModel: 'small',
  language: 'en',
  minClipDuration: 15,
  maxClipDuration: 180,
  maxClips: 20,
  faceSampleRate: 2,
  anthropicApiKey: '',
  format: 'mp4',
  quality: 'high',
  videoFormat: 'fullscreen',
  withCaptions: true,
  captionTheme: 'golden',
  captionStyle: DEFAULT_CAPTION_STYLE,
  endPaddingSec: 0.6,
  softCapRatio: 1.5,
  strictCompleteness: true,
};

const CONFIG_DIR = process.env.SHARDS_CONFIG_DIR || path.join(homedir(), '.shards');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
// Pre-shards builds wrote to <cwd>/config/clipper.json. We pick that up once
// so users don't lose their saved API key when they first run shards.
const LEGACY_PATH = path.join(process.cwd(), 'config', 'clipper.json');

export function configPath(): string {
  return CONFIG_PATH;
}

export async function loadConfig(): Promise<UserConfig> {
  const direct = await tryReadJson(CONFIG_PATH);
  if (direct) return mergeWithDefaults(direct);

  const legacy = await tryReadJson(LEGACY_PATH);
  if (legacy) return mergeWithDefaults(legacy);

  return cloneDefaults();
}

export async function saveConfig(config: UserConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function cloneDefaults(): UserConfig {
  return {
    ...DEFAULT_CONFIG,
    captionStyle: { ...DEFAULT_CAPTION_STYLE },
  };
}

async function tryReadJson(filePath: string): Promise<Partial<UserConfig> | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as Partial<UserConfig>;
  } catch {
    return null;
  }
}

function mergeWithDefaults(partial: Partial<UserConfig>): UserConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    captionStyle: {
      ...DEFAULT_CAPTION_STYLE,
      ...(partial.captionStyle || {}),
    },
  };
}
