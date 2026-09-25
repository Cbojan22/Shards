#!/usr/bin/env node
import path from 'path';
import { readFile } from 'fs/promises';
import { render } from 'ink';
import { App } from './App.js';

// Walk up from the launch directory looking for a `.env` so users can run
// `shards` from anywhere and still pick up the API key they've stashed in
// their project directory. Falls through to the shell env if nothing is
// found, which is the recommended setup anyway.
async function loadDotEnvUpwards(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) return;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const text = await readFile(path.join(dir, '.env'), 'utf-8');
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        // Only import the API key — other vars would leak into spawned
        // python/ffmpeg processes.
        const key = line.slice(0, eq).trim();
        if (key !== 'ANTHROPIC_API_KEY') continue;
        process.env[key] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      }
      return;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
  }
}

async function main() {
  await loadDotEnvUpwards();
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const { waitUntilExit } = render(<App initialApiKey={apiKey} />);
  await waitUntilExit();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
