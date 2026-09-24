import { homedir } from 'os';
import path from 'path';
import { readFile, writeFile, mkdir, chmod } from 'fs/promises';
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
  /** Use MTCNN + identity-embedding face tracking. Default true. */
  useIdentityTracking: boolean;
  /** Write per-clip _tracking.json sidecars (off by default). */
  debugTracking: boolean;
  /** Base folder for clip runs (<outputDir>/<video name>). '' = next to the input. */
  outputDir: string;
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
  useIdentityTracking: true,
  debugTracking: false,
  outputDir: '',
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
  // The config can hold an API key, so keep it owner-only. writeFile's mode
  // only applies on create — chmod covers files written by older builds.
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
}

/**
 * Default output folder for a clip run: `<outputDir>/<video name>` when the
 * user saved a base folder, else `<video name>_clips` next to the input.
 */
export function defaultClipOutputDir(inputPath: string, outputDir: string): string {
  const name = path.basename(inputPath, path.extname(inputPath));
  if (!outputDir) return path.join(path.dirname(inputPath), `${name}_clips`);
  const base = outputDir.startsWith('~/') ? path.join(homedir(), outputDir.slice(2)) : outputDir;
  return path.join(base, name);
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
