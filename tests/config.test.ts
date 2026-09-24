import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

describe('saveConfig', () => {
  let dir: string;

  beforeAll(async () => {
    dir = path.join(await mkdtemp(path.join(tmpdir(), 'shards-cfg-')), 'cfg');
    // CONFIG_DIR is read at module load, so set the override before importing.
    process.env.SHARDS_CONFIG_DIR = dir;
  });

  afterAll(async () => {
    delete process.env.SHARDS_CONFIG_DIR;
    await rm(path.dirname(dir), { recursive: true, force: true });
  });

  it('writes the config (which may hold an API key) owner-only, even over an existing world-readable file', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'config.json'), '{}', { mode: 0o644 });

    const { saveConfig, cloneDefaults } = await import('../src/utils/config.js');
    await saveConfig({ ...cloneDefaults(), anthropicApiKey: 'test-key' });

    const { mode } = await stat(path.join(dir, 'config.json'));
    expect(mode & 0o777).toBe(0o600);
  });
});

describe('defaultClipOutputDir', () => {
  it('writes <name>_clips next to the input when no base folder is saved', async () => {
    const { defaultClipOutputDir } = await import('../src/utils/config.js');
    expect(defaultClipOutputDir('/videos/talk.mp4', '')).toBe('/videos/talk_clips');
  });

  it('writes <base>/<name> when a base folder is saved, expanding ~/', async () => {
    const { defaultClipOutputDir } = await import('../src/utils/config.js');
    const { homedir } = await import('os');
    expect(defaultClipOutputDir('/videos/talk.mp4', '/out')).toBe('/out/talk');
    expect(defaultClipOutputDir('/videos/talk.mp4', '~/Clips')).toBe(path.join(homedir(), 'Clips', 'talk'));
  });
});
