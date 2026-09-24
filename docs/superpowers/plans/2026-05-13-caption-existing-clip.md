# Caption-an-Existing-Clip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a feature that burns Shards-styled captions onto an existing short-form MP4 — no Anthropic API, no face detection, no reframing — using only local Whisper + FFmpeg.

**Architecture:** A new thin pipeline module (`src/pipeline/captionOnly/index.ts`) reuses the existing `transcribeVideo()` + `generateCaptions()` + caption themes, then calls a new no-reframe `burnCaptions()` FFmpeg helper. A new `shards-cli caption <input>` subcommand and a TUI menu entry + mini-wizard expose it. Settings (theme, position, font size, model, quality) come from `~/.shards/config.json` with per-run overrides.

**Tech Stack:** TypeScript 5.7 (ESM), Node ≥18, faster-whisper (via existing Python venv), FFmpeg + libass, Commander (CLI), Ink/React (TUI), Vitest (tests).

**Free?** Yes — the only API key in Shards is `ANTHROPIC_API_KEY`, used purely for viral-clip selection in `analyze/index.ts`. This feature does not call that module. Cost is local CPU time only.

---

## File Structure

**New files:**
- `src/pipeline/captionOnly/index.ts` — orchestrator: transcribe → ASS → burn
- `src/tui/screens/CaptionWizard.tsx` — 3-step mini-wizard (input, theme, position)
- `src/tui/screens/CaptionRun.tsx` — live run screen for caption-only mode
- `tests/captionOnly.test.ts` — unit tests for the orchestrator + arg builder

**Modified files:**
- `src/types/index.ts` — add `CaptionOnlyOptions` interface
- `src/utils/ffmpeg.ts` — add `burnCaptions()` + extracted `buildBurnCaptionsArgs()` pure helper
- `src/cli/index.ts` — add `caption` subcommand
- `src/tui/App.tsx` — wire `captionWizard` + `captionRun` screen states
- `src/tui/screens/Menu.tsx` — add `caption` menu item
- `README.md` — short usage note for both entry points
- `package.json` — version bump to `1.5.0`

---

## Task 1: Define `CaptionOnlyOptions` type

**Files:**
- Modify: `src/types/index.ts` (append at the end of the file)

- [ ] **Step 1: Add the new interface**

Append this block to `src/types/index.ts`:

```ts
/**
 * Inputs for the caption-only flow. Used by both the CLI subcommand and the
 * TUI's caption-only run screen. Captures everything needed to transcribe an
 * already-finished short-form clip and burn captions onto it — no Anthropic
 * API, no face detection, no reframing.
 */
export interface CaptionOnlyOptions {
  inputPath: string;
  outputPath: string;
  whisperModel: string;
  language: string;
  quality: 'high' | 'medium' | 'low';
  captionStyle: CaptionStyle;
}
```

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `npm run build`
Expected: no errors. (Nothing references the new interface yet.)

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(captions): add CaptionOnlyOptions type for caption-only pipeline"
```

---

## Task 2: Add `burnCaptions()` FFmpeg helper

**Files:**
- Modify: `src/utils/ffmpeg.ts` (append below the existing exports)
- Test: `tests/captionOnly.test.ts` (new file)

- [ ] **Step 1: Write the failing test for the pure arg builder**

Create `tests/captionOnly.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildBurnCaptionsArgs } from '../src/utils/ffmpeg.js';

describe('buildBurnCaptionsArgs', () => {
  it('builds an ffmpeg argv that burns ASS subtitles via the ass filter on macOS', () => {
    const args = buildBurnCaptionsArgs({
      inputPath: '/tmp/clip.mp4',
      subtitlePath: '/tmp/clip.ass',
      outputPath: '/tmp/clip_captioned.mp4',
      quality: 'high',
      platform: 'darwin',
      useAssFilter: true,
    });

    expect(args[0]).toBe('-y');
    expect(args).toContain('-i');
    expect(args).toContain('/tmp/clip.mp4');
    expect(args).toContain('-vf');
    expect(args.find((a) => a.startsWith('ass=/tmp/clip.ass'))).toBeTruthy();
    expect(args).toContain('h264_videotoolbox');
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
    expect(args[args.length - 1]).toBe('/tmp/clip_captioned.mp4');
  });

  it('escapes colons in the subtitle path so libass parses it as one arg', () => {
    const args = buildBurnCaptionsArgs({
      inputPath: '/tmp/in.mp4',
      subtitlePath: '/Users/someone/My Videos/foo:bar/clip.ass',
      outputPath: '/tmp/out.mp4',
      quality: 'high',
      platform: 'darwin',
      useAssFilter: true,
    });

    const vf = args[args.indexOf('-vf') + 1];
    // libass requires \: for literal colons inside the filter string
    expect(vf).toContain('foo\\:bar');
  });

  it('falls back to mov_text soft subtitles when libass is unavailable', () => {
    const args = buildBurnCaptionsArgs({
      inputPath: '/tmp/in.mp4',
      subtitlePath: '/tmp/in.ass',
      outputPath: '/tmp/out.mp4',
      quality: 'high',
      platform: 'darwin',
      useAssFilter: false,
    });

    expect(args).toContain('-c:s');
    expect(args).toContain('mov_text');
    // soft subs: must add the ASS as a second input
    const inputCount = args.filter((a) => a === '-i').length;
    expect(inputCount).toBe(2);
    expect(args).not.toContain('-vf');
  });

  it('uses libx264 on linux', () => {
    const args = buildBurnCaptionsArgs({
      inputPath: '/tmp/in.mp4',
      subtitlePath: '/tmp/in.ass',
      outputPath: '/tmp/out.mp4',
      quality: 'medium',
      platform: 'linux',
      useAssFilter: true,
    });
    expect(args).toContain('libx264');
    expect(args).toContain('-preset');
    expect(args).toContain('medium');
    expect(args).toContain('-crf');
    expect(args).toContain('23');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/captionOnly.test.ts`
Expected: FAIL — `buildBurnCaptionsArgs is not a function` (the symbol doesn't exist yet).

- [ ] **Step 3: Add the pure arg builder + the helper to `src/utils/ffmpeg.ts`**

Append to `src/utils/ffmpeg.ts` (after `runFFmpeg`, before `buildCropExpression`):

```ts
export interface BuildBurnCaptionsArgsParams {
  inputPath: string;
  subtitlePath: string;
  outputPath: string;
  quality: 'high' | 'medium' | 'low';
  platform: NodeJS.Platform;
  useAssFilter: boolean;
}

/**
 * Build the ffmpeg argv that burns (or embeds) captions onto an existing clip
 * without cropping, scaling, or otherwise touching the picture geometry. Pure
 * function so we can unit-test platform + filter branching without spawning
 * ffmpeg.
 */
export function buildBurnCaptionsArgs(p: BuildBurnCaptionsArgsParams): string[] {
  const { crf, preset, vtBitrate } = getQualityPreset(p.quality);
  const encoder = p.platform === 'darwin'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', vtBitrate]
    : ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)];

  if (p.useAssFilter) {
    // libass: colons inside the filter graph must be escaped with `\:`
    const escapedSub = p.subtitlePath.replace(/:/g, '\\:');
    return [
      '-y',
      '-i', p.inputPath,
      '-vf', `ass=${escapedSub}`,
      ...encoder,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      p.outputPath,
    ];
  }

  // Fallback: embed as a soft subtitle track. Player must support mov_text
  // for it to render; most social platforms strip it on upload, so we warn
  // upstream when we take this branch.
  return [
    '-y',
    '-i', p.inputPath,
    '-i', p.subtitlePath,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-c:s', 'mov_text',
    '-movflags', '+faststart',
    p.outputPath,
  ];
}

/**
 * Burn an ASS subtitle file onto an existing video. Tries the libass `ass`
 * filter first; if unavailable, falls back to embedding `mov_text`. Returns
 * a flag indicating which branch was taken so callers can warn the user.
 */
export async function burnCaptions(opts: {
  inputPath: string;
  subtitlePath: string;
  outputPath: string;
  quality: 'high' | 'medium' | 'low';
}): Promise<{ usedAssFilter: boolean }> {
  const hasAss = await checkFFmpegFilter('ass');
  const args = buildBurnCaptionsArgs({
    inputPath: opts.inputPath,
    subtitlePath: opts.subtitlePath,
    outputPath: opts.outputPath,
    quality: opts.quality,
    platform: process.platform,
    useAssFilter: hasAss,
  });
  await runFFmpeg(args);
  return { usedAssFilter: hasAss };
}
```

Also: `checkFFmpegFilter` is currently `function` (not exported). It's already used internally — leave it as-is; `burnCaptions` in the same file can call it directly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/captionOnly.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Build to confirm TS still compiles**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/ffmpeg.ts tests/captionOnly.test.ts
git commit -m "feat(ffmpeg): add burnCaptions helper for caption-only renders"
```

---

## Task 3: Implement `captionExistingClip()` orchestrator

**Files:**
- Create: `src/pipeline/captionOnly/index.ts`
- Test: `tests/captionOnly.test.ts` (append more tests)

- [ ] **Step 1: Write the failing orchestrator test**

Append to `tests/captionOnly.test.ts`:

```ts
import { vi } from 'vitest';
import path from 'path';
import { tmpdir } from 'os';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { DEFAULT_CAPTION_STYLE } from '../src/pipeline/captions/index.js';

// Mock the two side-effectful dependencies. We're testing orchestration —
// did the function call transcribe with the right model, did it pass
// transcript timings into generateCaptions, did it call burnCaptions with
// the produced ASS path. Real ffmpeg and Whisper runs are out of scope.
vi.mock('../src/pipeline/transcribe/index.js', () => ({
  transcribeVideo: vi.fn(async () => ({
    segments: [{
      start: 0, end: 1.5, text: 'hello world', speaker: 'SPEAKER_A',
      words: [
        { word: 'hello', start: 0.0, end: 0.5 },
        { word: 'world', start: 0.7, end: 1.5 },
      ],
    }],
    speakers: ['SPEAKER_A'],
    language: 'en',
    duration: 1.5,
  })),
}));

vi.mock('../src/utils/ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ffmpeg.js')>();
  return {
    ...actual,
    getVideoMetadata: vi.fn(async () => ({
      duration: 1.5, width: 1080, height: 1920, fps: 30,
      codec: 'h264', bitrate: 2_000_000, audioCodec: 'aac', audioSampleRate: 48000,
    })),
    burnCaptions: vi.fn(async () => ({ usedAssFilter: true })),
  };
});

describe('captionExistingClip', () => {
  it('transcribes, generates an ASS, and calls burnCaptions with the right paths', async () => {
    const { captionExistingClip } = await import('../src/pipeline/captionOnly/index.js');
    const { transcribeVideo } = await import('../src/pipeline/transcribe/index.js');
    const { burnCaptions } = await import('../src/utils/ffmpeg.js');

    const dir = await mkdtemp(path.join(tmpdir(), 'shards-cap-'));
    try {
      const result = await captionExistingClip({
        inputPath: '/tmp/fake-clip.mp4',
        outputPath: path.join(dir, 'clip_captioned.mp4'),
        whisperModel: 'small',
        language: 'en',
        quality: 'high',
        captionStyle: DEFAULT_CAPTION_STYLE,
      });

      expect(transcribeVideo).toHaveBeenCalledWith(
        '/tmp/fake-clip.mp4',
        { model: 'small', language: 'en' },
        expect.any(Function),
      );
      expect(burnCaptions).toHaveBeenCalledOnce();
      const burnArgs = (burnCaptions as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(burnArgs.inputPath).toBe('/tmp/fake-clip.mp4');
      expect(burnArgs.outputPath).toBe(path.join(dir, 'clip_captioned.mp4'));
      expect(burnArgs.subtitlePath.endsWith('.ass')).toBe(true);

      // The generated ASS file should actually exist and contain our words.
      const ass = await readFile(burnArgs.subtitlePath, 'utf-8');
      expect(ass).toContain('HELLO WORLD');

      expect(result.outputPath).toBe(path.join(dir, 'clip_captioned.mp4'));
      expect(result.usedAssFilter).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/captionOnly.test.ts`
Expected: FAIL — `Cannot find module '../src/pipeline/captionOnly/index.js'`.

- [ ] **Step 3: Create the orchestrator**

Create `src/pipeline/captionOnly/index.ts`:

```ts
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { CaptionOnlyOptions } from '../../types/index.js';
import { transcribeVideo } from '../transcribe/index.js';
import { generateCaptions } from '../captions/index.js';
import { burnCaptions, getVideoMetadata } from '../../utils/ffmpeg.js';

export interface CaptionOnlyResult {
  outputPath: string;
  /** False when libass was missing and we fell back to soft mov_text subs. */
  usedAssFilter: boolean;
  durationSec: number;
}

/**
 * Burn Shards-styled captions onto an existing short-form clip.
 *
 * - Transcribes the input locally with faster-whisper (no API call).
 * - Generates an ASS subtitle file for the full clip duration.
 * - Burns it back over the source video with FFmpeg (`ass` filter where
 *   available, soft `mov_text` track as a fallback).
 *
 * No Anthropic API key required.
 */
export async function captionExistingClip(
  opts: CaptionOnlyOptions,
  onProgress?: (stage: string, message: string) => void,
): Promise<CaptionOnlyResult> {
  const progress = (s: string, m: string) => onProgress?.(s, m);

  progress('init', `Analyzing ${path.basename(opts.inputPath)}…`);
  const meta = await getVideoMetadata(opts.inputPath);
  progress('init', `Source: ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}s`);

  progress('transcribe', 'Transcribing with local Whisper…');
  const transcript = await transcribeVideo(
    opts.inputPath,
    { model: opts.whisperModel, language: opts.language },
    (msg) => progress('transcribe', msg),
  );

  progress('captions', 'Generating subtitle file…');
  const assPath = path.join(
    tmpdir(),
    `shards_captions_${randomUUID()}.ass`,
  );
  await generateCaptions(
    transcript,
    0,
    meta.duration,
    opts.captionStyle,
    assPath,
  );

  progress('render', 'Burning captions with FFmpeg…');
  const { usedAssFilter } = await burnCaptions({
    inputPath: opts.inputPath,
    subtitlePath: assPath,
    outputPath: opts.outputPath,
    quality: opts.quality,
  });

  if (!usedAssFilter) {
    progress('render', 'WARNING: libass not available — embedded soft subs instead of burning. Most social uploads will strip these.');
  }

  progress('complete', `Done → ${opts.outputPath}`);

  return {
    outputPath: opts.outputPath,
    usedAssFilter,
    durationSec: meta.duration,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/captionOnly.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Build to confirm TS compiles**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/captionOnly/index.ts tests/captionOnly.test.ts
git commit -m "feat(pipeline): add captionExistingClip orchestrator (free, no API)"
```

---

## Task 4: Add `shards-cli caption` subcommand

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Add the subcommand**

Insert this block in `src/cli/index.ts` directly above the `// === PREVIEW COMMAND ===` section (around line 376 in the current file). Most imports needed (`path`, `chalk`, `ora`, `access`, `loadConfig`, `saveConfig`, `applyTheme`, `CAPTION_THEME_IDS`, `CaptionThemeId`, `isPythonSetup`, `setupPython`) are already imported at the top of the file.

First, add two new imports next to the existing import block at the top of the file:

```ts
import { captionExistingClip } from '../pipeline/captionOnly/index.js';
import type { CaptionOnlyOptions } from '../types/index.js';
```

Note: `PipelineConfig` is already imported via `import type { PipelineConfig } from '../types/index.js';` — change that line to:

```ts
import type { PipelineConfig, CaptionOnlyOptions } from '../types/index.js';
```

…instead of adding a second `from '../types/index.js'` import.

Then add the command itself:

```ts
// === CAPTION COMMAND ===
program
  .command('caption')
  .description('Burn captions onto an existing short-form clip (no Anthropic API, free)')
  .argument('<input>', 'Path to an MP4 clip you already have')
  .option('-o, --output <path>', 'Output file path (default: <input>_captioned.mp4 next to source)')
  .option('-m, --model <size>', 'Whisper model (tiny, base, small, medium, large)', '')
  .option('-l, --language <code>', 'Language code', '')
  .option('-q, --quality <level>', 'Render quality (high, medium, low)', '')
  .option('--theme <id>', 'Caption theme (see `shards-cli config --show`)')
  .option('--position <pos>', 'Caption position (top, center, bottom)')
  .option('--font-size <px>', 'Caption font size override')
  .action(async (input: string, opts: Record<string, string>) => {
    const spinner = ora();
    try {
      const inputPath = path.resolve(input);
      try {
        await access(inputPath);
      } catch {
        console.error(chalk.red(`Error: Input file not found: ${inputPath}`));
        process.exit(1);
      }

      const config = await loadConfig();

      // Default output: <inputDir>/<basename>_captioned.mp4
      const inputDir = path.dirname(inputPath);
      const inputBase = path.basename(inputPath, path.extname(inputPath));
      const outputPath = opts.output
        ? path.resolve(opts.output)
        : path.join(inputDir, `${inputBase}_captioned.mp4`);

      // Resolve theme
      const themeArg = opts.theme as CaptionThemeId | undefined;
      const captionTheme: CaptionThemeId = themeArg && CAPTION_THEME_IDS.includes(themeArg)
        ? themeArg
        : config.captionTheme;
      if (themeArg && !CAPTION_THEME_IDS.includes(themeArg)) {
        console.warn(chalk.yellow(`Unknown theme "${themeArg}", falling back to "${config.captionTheme}".`));
      }

      // Build base caption style with per-run overrides on position + font size
      const baseStyle = { ...config.captionStyle };
      if (opts.position) {
        const p = opts.position as 'top' | 'center' | 'bottom';
        if (p !== 'top' && p !== 'center' && p !== 'bottom') {
          console.error(chalk.red(`Invalid --position: ${p}. Expected top|center|bottom.`));
          process.exit(1);
        }
        baseStyle.position = p;
      }
      if (opts.fontSize) {
        const n = parseInt(opts.fontSize, 10);
        if (Number.isNaN(n) || n < 24 || n > 240) {
          console.error(chalk.red(`Invalid --font-size: ${opts.fontSize}. Expected 24–240.`));
          process.exit(1);
        }
        baseStyle.fontSize = n;
      }
      const captionStyle = applyTheme(baseStyle, captionTheme);

      // Ensure the Python venv is ready (Whisper needs it).
      spinner.start('Checking Python environment…');
      if (!(await isPythonSetup())) {
        spinner.text = 'Setting up Python venv (first run, ~1 min)…';
        await setupPython();
      }
      spinner.succeed('Python environment ready');

      // Persist the theme choice (consistent with `process`).
      await saveConfig({ ...config, captionTheme });

      const options: CaptionOnlyOptions = {
        inputPath,
        outputPath,
        whisperModel: (opts.model as string) || config.whisperModel,
        language: (opts.language as string) || config.language,
        quality: ((opts.quality as string) || config.quality) as 'high' | 'medium' | 'low',
        captionStyle,
      };

      console.log('');
      console.log(chalk.bold.green('  SHARDS // caption'));
      console.log(chalk.white(`  Input:    ${options.inputPath}`));
      console.log(chalk.white(`  Output:   ${options.outputPath}`));
      console.log(chalk.white(`  Model:    Whisper ${options.whisperModel}`));
      console.log(chalk.white(`  Theme:    ${captionTheme} @ ${captionStyle.position}`));
      console.log('');

      const start = Date.now();
      const result = await captionExistingClip(options, (stage, message) => {
        const colorFn = stage === 'complete' ? chalk.bold.green : chalk.cyan;
        console.log(`  ${chalk.gray(`[${stage}]`)} ${colorFn(message)}`);
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      console.log('');
      console.log(chalk.bold.green('  Captioning complete!'));
      console.log(chalk.white(`  Time: ${elapsed}s`));
      console.log(chalk.white(`  Wrote: ${result.outputPath}`));
      if (!result.usedAssFilter) {
        console.log(chalk.yellow('  Note: libass missing — soft mov_text track instead of burned-in. Social uploads usually strip these.'));
      }
      console.log('');
    } catch (err) {
      spinner.fail('Captioning failed');
      console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Smoke-test the CLI shape (no real video needed)**

Run: `node dist/cli/index.js caption --help`
Expected: prints usage with `<input>` and the option list above.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): add `shards-cli caption` subcommand for free caption-only runs"
```

---

## Task 5: TUI — add menu entry

**Files:**
- Modify: `src/tui/screens/Menu.tsx`

- [ ] **Step 1: Add the new menu choice**

Edit `src/tui/screens/Menu.tsx`. Replace the `MenuChoice` type, `ITEMS` list, and `HINTS` map so they include the new `caption` action:

Find:
```ts
export type MenuChoice = 'run' | 'guide' | 'defaults' | 'preview' | 'quit';
```

Replace with:
```ts
export type MenuChoice = 'run' | 'caption' | 'guide' | 'defaults' | 'preview' | 'quit';
```

Find the `ITEMS` array and replace with:
```ts
const ITEMS: MenuItem[] = [
  { label: '> New clip run',          value: 'run' },
  { label: '> Caption existing clip', value: 'caption' },
  { label: '> Edit defaults',         value: 'defaults' },
  { label: '> Preview themes',        value: 'preview' },
  { label: '> View quick guide',      value: 'guide' },
  { label: '> Quit',                  value: 'quit' },
];
```

Find the `HINTS` map and replace with:
```ts
const HINTS: Record<MenuChoice, string> = {
  run:      'Pick a video, configure, and process',
  caption:  'Burn captions onto a clip you already have (free, no API)',
  defaults: 'Adjust saved settings without running',
  preview:  'Render an MP4 showing every caption theme burned in',
  guide:    'How SHARDS works, what you need',
  quit:     'Leave SHARDS',
};
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: TS error in `App.tsx` because `handleMenu` doesn't handle `caption`. This is expected — Task 7 wires it up. Leave the error for now.

- [ ] **Step 3: Commit**

```bash
git add src/tui/screens/Menu.tsx
git commit -m "feat(tui): add 'Caption existing clip' menu entry"
```

---

## Task 6: TUI — CaptionWizard screen

**Files:**
- Create: `src/tui/screens/CaptionWizard.tsx`

- [ ] **Step 1: Create the wizard screen**

Create `src/tui/screens/CaptionWizard.tsx`:

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import path from 'path';
import { access } from 'fs/promises';
import { Box, Text, useInput } from 'ink';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-text-input ships its own loose types
import TextInput from 'ink-text-input';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-select-input ships its own loose types
import SelectInput from 'ink-select-input';
import { Frame } from '../components/Frame.js';
import { TUI } from '../theme.js';
import {
  CAPTION_THEMES,
  CAPTION_THEME_IDS,
  type CaptionThemeId,
} from '../../pipeline/captions/themes.js';

export interface CaptionWizardAnswers {
  inputPath: string;
  outputPath: string;       // '' means: derive at run time
  captionTheme: CaptionThemeId;
  captionPosition: 'top' | 'center' | 'bottom';
}

interface CaptionWizardProps {
  initial: CaptionWizardAnswers;
  onCancel: () => void;
  onSubmit: (answers: CaptionWizardAnswers) => void;
}

type StepKey = 'inputPath' | 'theme' | 'position' | 'confirm';
const STEPS: StepKey[] = ['inputPath', 'theme', 'position', 'confirm'];

export function CaptionWizard({ initial, onCancel, onSubmit }: CaptionWizardProps): React.ReactElement {
  const [answers, setAnswers] = useState<CaptionWizardAnswers>(initial);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (key.escape) {
      setError(null);
      if (step === 0) onCancel();
      else setStep((s) => Math.max(0, s - 1));
    }
  });

  const advance = () => {
    setError(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  const update = <K extends keyof CaptionWizardAnswers>(k: K, v: CaptionWizardAnswers[K]) => {
    setAnswers((prev) => ({ ...prev, [k]: v }));
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color={TUI.primary} bold>SHARDS // caption existing clip</Text>
        <Text color={TUI.dim}>step {step + 1}/{STEPS.length}</Text>
      </Box>

      {STEPS[step] === 'inputPath' && <PathStep answers={answers} update={update} advance={advance} error={error} setError={setError} />}
      {STEPS[step] === 'theme' && <ThemeStep answers={answers} update={update} advance={advance} />}
      {STEPS[step] === 'position' && <PositionStep answers={answers} update={update} advance={advance} />}
      {STEPS[step] === 'confirm' && <ConfirmStep answers={answers} onSubmit={onSubmit} advance={advance} />}

      <Box marginTop={1}>
        <Text color={TUI.dim}>
          enter to continue · esc to {step === 0 ? 'cancel' : 'go back'}
        </Text>
      </Box>
    </Box>
  );
}

interface StepProps {
  answers: CaptionWizardAnswers;
  update: <K extends keyof CaptionWizardAnswers>(k: K, v: CaptionWizardAnswers[K]) => void;
  advance: () => void;
  error?: string | null;
  setError?: (s: string | null) => void;
}

function PathStep({ answers, update, advance, error, setError }: StepProps) {
  const [value, setValue] = useState(answers.inputPath);
  const onSubmit = async (raw: string) => {
    const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!trimmed) { setError?.('Path is required.'); return; }
    const resolved = path.resolve(trimmed.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    try { await access(resolved); } catch { setError?.(`File not found: ${resolved}`); return; }
    update('inputPath', resolved);
    advance();
  };
  return (
    <Frame title="input clip" subtitle="absolute or ~ path to the .mp4 you want captioned">
      <Box>
        <Text color={TUI.primary}>{'> '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} placeholder="/path/to/clip.mp4" />
      </Box>
      {error && (
        <Box marginTop={1}><Text color={TUI.error}>{error}</Text></Box>
      )}
    </Frame>
  );
}

function ThemeStep({ answers, update, advance }: StepProps) {
  const items = CAPTION_THEME_IDS.map((id) => ({
    label: `${CAPTION_THEMES[id].name.padEnd(10)} ${CAPTION_THEMES[id].tagline}`,
    value: id,
  }));
  const initial = items.findIndex((i) => i.value === answers.captionTheme);
  const [highlighted, setHighlighted] = useState<CaptionThemeId>(answers.captionTheme);
  return (
    <Frame title="caption theme" subtitle="font + colour preset">
      <SelectInput
        items={items}
        initialIndex={initial >= 0 ? initial : 0}
        onHighlight={(item: { value: CaptionThemeId }) => setHighlighted(item.value)}
        onSelect={(item: { value: CaptionThemeId }) => {
          update('captionTheme', item.value);
          advance();
        }}
      />
      <Box marginTop={1}>
        <ThemeSwatch themeId={highlighted} />
      </Box>
    </Frame>
  );
}

function ThemeSwatch({ themeId }: { themeId: CaptionThemeId }) {
  const t = CAPTION_THEMES[themeId];
  return (
    <Box flexDirection="column">
      <Text color={t.swatchFg} backgroundColor={t.swatchBg} bold>
        {' THIS IS YOUR '}
        <Text color={t.highlightColor} backgroundColor={t.swatchBg} bold>VIRAL</Text>
        {' '}
        <Text color={t.highlightColor} backgroundColor={t.swatchBg} bold>MOMENT</Text>
        {' '}
      </Text>
      <Text color={TUI.dim}>{t.fontFamily} · {t.tagline}</Text>
    </Box>
  );
}

function PositionStep({ answers, update, advance }: StepProps) {
  const items = [
    { label: 'bottom — most readable on phones',  value: 'bottom' },
    { label: 'center — TikTok-style centerpiece', value: 'center' },
    { label: 'top    — keep the speaker visible', value: 'top' },
  ];
  const initial = items.findIndex((i) => i.value === answers.captionPosition);
  return (
    <Frame title="caption position" subtitle="where captions sit inside the frame">
      <SelectInput
        items={items}
        initialIndex={initial >= 0 ? initial : 0}
        onSelect={(item: { value: string }) => {
          update('captionPosition', item.value as CaptionWizardAnswers['captionPosition']);
          advance();
        }}
      />
    </Frame>
  );
}

function ConfirmStep({ answers, onSubmit, advance }: { answers: CaptionWizardAnswers; onSubmit: (a: CaptionWizardAnswers) => void; advance: () => void; }) {
  const defaultOut = useMemo(() => deriveDefaultOutput(answers.inputPath), [answers.inputPath]);
  const rows: Array<[string, string]> = [
    ['input',    answers.inputPath],
    ['output',   answers.outputPath || defaultOut],
    ['theme',    answers.captionTheme],
    ['position', answers.captionPosition],
  ];
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  return (
    <Frame title="review" subtitle="press enter on the highlighted action">
      <Box flexDirection="column">
        {rows.map(([k, v]) => (
          <Text key={k} color={TUI.fg}>
            <Text color={TUI.accent}>{k.padEnd(labelWidth)}</Text>{'  '}{v}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: 'start captioning — begin now',  value: 'go' },
            { label: 'cancel — back to menu',         value: 'cancel' },
          ]}
          onSelect={(item: { value: string }) => {
            if (item.value === 'go') onSubmit({ ...answers, outputPath: answers.outputPath || defaultOut });
            else advance();
          }}
        />
      </Box>
    </Frame>
  );
}

function deriveDefaultOutput(inputPath: string): string {
  if (!inputPath) return '<input dir>/<name>_captioned.mp4';
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}_captioned.mp4`);
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: TS errors only in `App.tsx` (not yet wired up). The wizard file itself should compile clean.

- [ ] **Step 3: Commit**

```bash
git add src/tui/screens/CaptionWizard.tsx
git commit -m "feat(tui): add CaptionWizard screen for caption-only flow"
```

---

## Task 7: TUI — CaptionRun screen + wire up App router

**Files:**
- Create: `src/tui/screens/CaptionRun.tsx`
- Modify: `src/tui/App.tsx`

- [ ] **Step 1: Create the run screen**

Create `src/tui/screens/CaptionRun.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useInput } from 'ink';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-spinner ships its own loose types
import Spinner from 'ink-spinner';
import { Frame } from '../components/Frame.js';
import { TUI } from '../theme.js';
import { isPythonSetup, setupPython } from '../../utils/python.js';
import { applyTheme } from '../../pipeline/captions/themes.js';
import { captionExistingClip, type CaptionOnlyResult } from '../../pipeline/captionOnly/index.js';
import type { CaptionWizardAnswers } from './CaptionWizard.js';
import type { UserConfig } from '../../utils/config.js';

interface CaptionRunProps {
  answers: CaptionWizardAnswers;
  baseConfig: UserConfig;
  onDone: () => void;
}

interface LogLine {
  id: number;
  stage: string;
  message: string;
  timestamp: string;
}

const STAGE_COLORS: Record<string, string> = {
  init: '#7DD3FC',
  transcribe: '#C084FC',
  captions: '#22D3EE',
  render: '#60A5FA',
  complete: '#22C55E',
  setup: '#A1A1AA',
  ready: '#22C55E',
  error: '#EF4444',
};

export function CaptionRun({ answers, baseConfig, onDone }: CaptionRunProps): React.ReactElement {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [stage, setStage] = useState('init');
  const [message, setMessage] = useState('starting up…');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptionOnlyResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);
  const startTimeRef = useRef(Date.now());

  useInput((_input, key) => {
    if (done && (key.return || key.escape)) onDone();
  });

  useEffect(() => {
    if (done) return;
    const t = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [done]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const append = (s: string, m: string) => {
      setStage(s);
      setMessage(m);
      setLogs((prev) => [
        ...prev,
        { id: prev.length, stage: s, message: m, timestamp: new Date().toLocaleTimeString([], { hour12: false }) },
      ]);
    };

    (async () => {
      try {
        append('setup', 'Checking Python environment…');
        if (!(await isPythonSetup())) {
          append('setup', 'Setting up Python venv (first run, ~1 min)…');
          await setupPython();
        }
        append('ready', 'Python ready, starting caption pass');

        const captionStyle = applyTheme(
          { ...baseConfig.captionStyle, position: answers.captionPosition },
          answers.captionTheme,
        );

        const res = await captionExistingClip(
          {
            inputPath: answers.inputPath,
            outputPath: answers.outputPath,
            whisperModel: baseConfig.whisperModel,
            language: baseConfig.language,
            quality: baseConfig.quality,
            captionStyle,
          },
          append,
        );
        setResult(res);
        setDone(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        append('error', msg);
        setError(msg);
        setDone(true);
      }
    })();
  }, [answers, baseConfig]);

  return (
    <Box flexDirection="column">
      <Static items={logs}>
        {(line) => (
          <Box key={line.id}>
            <Text color={TUI.dim}>{line.timestamp} </Text>
            <Text color={STAGE_COLORS[line.stage] ?? TUI.fg}>[{line.stage.padEnd(10)}]</Text>
            <Text color={TUI.fg}> {line.message}</Text>
          </Box>
        )}
      </Static>

      {!done && (
        <Frame title="SHARDS // captioning" subtitle={`elapsed ${formatElapsed(elapsed)} — ctrl+c aborts`} borderColor={TUI.accent}>
          <Text color={STAGE_COLORS[stage] ?? TUI.fg}>
            <Spinner type="dots" />{'  '}[{stage}] {message}
          </Text>
        </Frame>
      )}

      {done && error && (
        <Frame title="SHARDS // failed" subtitle="press enter to return to the menu" borderColor={TUI.error}>
          <Text color={TUI.error}>{error}</Text>
        </Frame>
      )}

      {done && !error && result && (
        <Frame title="SHARDS // complete" subtitle="press enter to return to the menu" borderColor={TUI.primary}>
          <Text color={TUI.fg}>captioned in <Text color={TUI.accent} bold>{formatElapsed(elapsed)}</Text></Text>
          <Text color={TUI.dim}>output: <Text color={TUI.fg}>{result.outputPath}</Text></Text>
          {!result.usedAssFilter && (
            <Text color={TUI.warn}>note: libass missing, used soft mov_text track instead</Text>
          )}
        </Frame>
      )}
    </Box>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

Edit `src/tui/App.tsx`:

1. Add the imports near the top (after the existing screen imports):

```ts
import { CaptionWizard, type CaptionWizardAnswers } from './screens/CaptionWizard.js';
import { CaptionRun } from './screens/CaptionRun.js';
```

2. Extend the `Screen` union:

Find:
```ts
type Screen =
  | { kind: 'splash' }
  | { kind: 'menu' }
  | { kind: 'guide' }
  | { kind: 'preview' }
  | { kind: 'wizard'; mode: WizardMode }
  | { kind: 'run'; answers: WizardAnswers };
```

Replace with:
```ts
type Screen =
  | { kind: 'splash' }
  | { kind: 'menu' }
  | { kind: 'guide' }
  | { kind: 'preview' }
  | { kind: 'wizard'; mode: WizardMode }
  | { kind: 'run'; answers: WizardAnswers }
  | { kind: 'captionWizard' }
  | { kind: 'captionRun'; answers: CaptionWizardAnswers };
```

3. Extend `handleMenu`:

Find:
```ts
  const handleMenu = (choice: MenuChoice) => {
    switch (choice) {
      case 'run':      return setScreen({ kind: 'wizard', mode: 'run' });
      case 'defaults': return setScreen({ kind: 'wizard', mode: 'defaults' });
      case 'preview':  return setScreen({ kind: 'preview' });
      case 'guide':    return setScreen({ kind: 'guide' });
      case 'quit':     return exit();
    }
  };
```

Replace with:
```ts
  const handleMenu = (choice: MenuChoice) => {
    switch (choice) {
      case 'run':      return setScreen({ kind: 'wizard', mode: 'run' });
      case 'caption':  return setScreen({ kind: 'captionWizard' });
      case 'defaults': return setScreen({ kind: 'wizard', mode: 'defaults' });
      case 'preview':  return setScreen({ kind: 'preview' });
      case 'guide':    return setScreen({ kind: 'guide' });
      case 'quit':     return exit();
    }
  };
```

4. Add the new screen branches in the final `switch (screen.kind)` block, right after the existing `case 'run':`:

```tsx
    case 'captionWizard': {
      const initial: CaptionWizardAnswers = {
        inputPath: '',
        outputPath: '',
        captionTheme: config.captionTheme,
        captionPosition: config.captionStyle.position,
      };
      return (
        <CaptionWizard
          initial={initial}
          onCancel={() => setScreen({ kind: 'menu' })}
          onSubmit={async (answers) => {
            // Persist theme + position so subsequent runs default to them.
            const merged: UserConfig = {
              ...config,
              captionTheme: answers.captionTheme,
              captionStyle: { ...config.captionStyle, position: answers.captionPosition },
            };
            await persist(merged);
            setScreen({ kind: 'captionRun', answers });
          }}
        />
      );
    }

    case 'captionRun':
      return (
        <CaptionRun
          answers={screen.answers}
          baseConfig={config}
          onDone={() => setScreen({ kind: 'menu' })}
        />
      );
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all tests pass (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/tui/App.tsx src/tui/screens/CaptionRun.tsx
git commit -m "feat(tui): wire caption-existing-clip flow into menu router"
```

---

## Task 8: Manual smoke test on a real clip

**Files:** (none modified — verification step)

- [ ] **Step 1: Run the CLI against a real existing short clip**

Pick any short MP4 you already have (e.g. one Shards produced earlier). Run:

```bash
npm run build
node dist/cli/index.js caption path/to/clip_001_<slug>.mp4 --theme matrix --position bottom
```

Expected:
- Progress lines appear for `[init]`, `[transcribe]`, `[captions]`, `[render]`, `[complete]`.
- Output file `<input>_captioned.mp4` is created next to the source.
- Open it in QuickTime — captions are burned in with the matrix theme at the bottom.

If `libass` is missing on this machine you'll see the soft-subs warning instead — the file will still play but captions won't show on a phone upload. (Acceptable on this branch; mostly relevant for Linux users.)

- [ ] **Step 2: Run the TUI flow**

```bash
npm run dev
```

In the TUI: arrow down to `Caption existing clip` → enter → paste the same clip path → pick a theme → bottom → start. Confirm the produced file plays with captions.

- [ ] **Step 3: Stop the dev TUI**

Ctrl+C.

---

## Task 9: README note + version bump

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `src/cli/index.ts` (version string in the Command declaration)

- [ ] **Step 1: Bump `package.json` to 1.5.0**

Edit `package.json`, change:
```json
"version": "1.4.0",
```
to:
```json
"version": "1.5.0",
```

- [ ] **Step 2: Update the CLI version string**

In `src/cli/index.ts` find:
```ts
  .version('1.4.0');
```
Change to:
```ts
  .version('1.5.0');
```

- [ ] **Step 3: Add a short usage section to `README.md`**

Read `README.md` first to find a sensible insertion point (likely just after the existing "Usage" or "CLI" section). Add this short section:

```markdown
### Caption an existing clip (free, no API)

If you already have a short-form clip and just want Shards-style captions on it:

```bash
# CLI
shards-cli caption /path/to/clip.mp4 --theme matrix --position bottom

# TUI
shards
# → Caption existing clip
```

This path uses local Whisper + FFmpeg only — no Anthropic API key required.
```

- [ ] **Step 4: Build + smoke test version output**

Run: `npm run build && node dist/cli/index.js --version`
Expected: `1.5.0`.

- [ ] **Step 5: Final test pass**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json src/cli/index.ts README.md
git commit -m "chore: v1.5.0 — caption-existing-clip feature"
```

- [ ] **Step 7: Pause for user authorization before pushing or tagging**

Do **NOT** push, tag, or release without explicit user confirmation. The user's release workflow requires per-task auth for push/tag operations.

---

## Notes for the implementing engineer

- **No new dependencies.** Everything reuses what's already in `package.json`.
- **Python venv:** the existing `setupPython()` covers Whisper. The caption-only path triggers it the same way the main pipeline does.
- **Output naming:** intentionally next to the source, not in iCloud Snag. The Snag pattern is for "process this long video into many clips into a folder" — a single-clip → single-clip transform is more naturally placed next to its source. Users can still override with `-o`.
- **Why not extend `runPipeline`:** the existing orchestrator requires `anthropicApiKey`, runs face detection, runs viral analysis. Bolting a "skip-everything" flag onto it would muddy the signature and risk regressing the main flow. A separate orchestrator is cleaner and easier to delete if the feature flops.
- **Tests:** the new tests use `vi.mock` to keep the suite hermetic (no real Whisper, no real ffmpeg). The boundaries test already in the repo doesn't touch these modules, so there's no mock collision.
