#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import readline from 'readline';
import { access, readFile } from 'fs/promises';
import { runPipeline } from '../pipeline/index.js';
import { isPythonSetup, setupPython } from '../utils/python.js';
import { applyTheme } from '../pipeline/captions/themes.js';
import { generateThemesPreview, defaultPreviewPath } from '../pipeline/preview.js';
import { captionExistingClip } from '../pipeline/captionOnly/index.js';
import { loadConfig, saveConfig, defaultClipOutputDir } from '../utils/config.js';
import type { PipelineConfig, CaptionOnlyOptions } from '../types/index.js';
import { captionOverridesOrExit, formatThemeList, THEME_COUNT } from './captionOptions.js';
import { registerConfigCommand } from './configCommand.js';

// Auto-load .env at the project root so users only need to set
// ANTHROPIC_API_KEY once — they don't have to re-export it every shell.
async function loadDotEnv(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) return;
  try {
    const text = await readFile(path.resolve(process.cwd(), '.env'), 'utf-8');
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
  } catch {
    // No .env — fall back to config file / CLI flag / shell env.
  }
}

async function promptVideoFormat(
  defaultChoice: 'fullscreen' | 'centered',
): Promise<'fullscreen' | 'centered'> {
  // Bail out cleanly when stdin isn't a real terminal (piped/CI runs) so the
  // pipeline doesn't hang forever waiting for a keystroke.
  if (!process.stdin.isTTY) return defaultChoice;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  const defaultLabel = defaultChoice === 'centered' ? '2' : '1';

  console.log('');
  console.log(chalk.bold('  Select video format:'));
  console.log(`    ${chalk.cyan('1)')} Fullscreen — video fills the entire 9:16 frame`);
  console.log(`    ${chalk.cyan('2)')} Centered   — wider crop, half-height with black bars top and bottom`);

  let choice: 'fullscreen' | 'centered' = defaultChoice;
  while (true) {
    const answer = (await ask(`  Choice [1/2] (default ${defaultLabel}): `)).trim();
    if (answer === '') { choice = defaultChoice; break; }
    if (answer === '1') { choice = 'fullscreen'; break; }
    if (answer === '2') { choice = 'centered'; break; }
    console.log(chalk.yellow('  Please enter 1 or 2.'));
  }
  rl.close();
  return choice;
}

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid number: "${value}", using default: ${fallback}`);
    return fallback;
  }
  return parsed;
}

function parseFloatOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid number: "${value}", using default: ${fallback}`);
    return fallback;
  }
  return parsed;
}

// "HH:MM:SS" for the analyze-only rankings printout — full precision lives in
// viral_moments.json; the console just needs to be scannable.
function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

const program = new Command();

program
  .name('shards-cli')
  .description('Shards — scripted entry point for the AI viral clip generator (use `shards` for the TUI)')
  .version('1.9.0');

// === PROCESS COMMAND ===
program
  .command('process')
  .description('Process a long-form video into viral short-form clips')
  .argument('<input>', 'Path to input MP4 video')
  .option('-o, --output <dir>', 'Output directory', '')
  .option('-m, --model <size>', 'Whisper model (tiny, base, small, medium, large)', '')
  .option('-l, --language <code>', 'Language code', '')
  .option('--min-duration <sec>', 'Minimum clip duration in seconds', '')
  .option('--max-duration <sec>', 'Maximum clip duration in seconds', '')
  .option('--max-clips <n>', 'Maximum number of clips to generate', '')
  .option('--captions', 'Burn captions for this run (overrides a saved "off" default)')
  .option('--no-captions', 'Disable caption overlay for this run')
  .option('-q, --quality <level>', 'Export quality (high, medium, low)', '')
  .option('-f, --format <fmt>', 'Export format (mp4, mov, webm)', '')
  .option('--video-format <kind>', 'Layout: fullscreen | centered (skips the prompt)')
  .option('--caption-theme <id>', `Caption theme / font (run \`shards-cli themes\` to list all ${THEME_COUNT})`)
  .option('--caption-position <pos>', 'Caption position (top, center, bottom)')
  .option('--font-size <px>', 'Caption font size override (24–240)')
  .option('--words-per-group <n>', 'Words shown per caption (1–5, soft target)')
  .option('--api-key <key>', 'Anthropic API key (prefer ANTHROPIC_API_KEY env var)')
  .option('--end-padding <sec>', 'Tail padding after each clip ending (default 0.6)')
  .option('--soft-cap-ratio <ratio>', 'Hard ceiling = max-duration × ratio (default 1.5)')
  .option('--no-strict-completeness', 'Keep clips Claude flagged as incomplete (default: drop them)')
  .option('--no-identity-tracking', 'Disable MTCNN + identity-embedding tracker (fall back to Haar). Default: enabled.')
  .option('--debug-tracking', 'Write a <clip>_tracking.json sidecar per clip with per-keyframe scoring')
  .option('--no-resume', 'Ignore any cached transcript/face data in the output dir and recompute from scratch')
  .option('--analyze-only', 'Find viral moments and write viral_moments.json with timestamps — no face tracking, no rendering')
  .action(async (input: string, opts: Record<string, string | boolean>) => {
    const spinner = ora();

    try {
      // Pull ANTHROPIC_API_KEY out of .env if it isn't already in the shell env.
      await loadDotEnv();

      // Resolve input path
      const inputPath = path.resolve(input);
      try {
        await access(inputPath);
      } catch {
        console.error(chalk.red(`Error: Input file not found: ${inputPath}`));
        process.exit(1);
      }

      // Load config with CLI overrides
      const config = await loadConfig();

      const apiKey = process.env.ANTHROPIC_API_KEY || config.anthropicApiKey || (opts.apiKey as string) || '';
      if (opts.apiKey) {
        console.warn(chalk.yellow('Warning: passing API keys via CLI args is insecure (visible in process list/shell history).'));
        console.warn(chalk.yellow('Prefer: export ANTHROPIC_API_KEY=your_key'));
      }
      if (!apiKey) {
        console.error(chalk.red('Error: Anthropic API key required.'));
        console.error(chalk.yellow('Set it via: shards-cli config --api-key YOUR_KEY'));
        console.error(chalk.yellow('Or: export ANTHROPIC_API_KEY=YOUR_KEY'));
        process.exit(1);
      }

      const analyzeOnly = opts.analyzeOnly === true;

      // Validate caption flags before any prompt. Analyze-only never renders,
      // so its caption flags are ignored rather than rejected.
      const { captionTheme, captionStyle: captionBaseStyle } = analyzeOnly
        ? { captionTheme: config.captionTheme, captionStyle: config.captionStyle }
        : captionOverridesOrExit(config.captionStyle, config.captionTheme, {
          theme: opts.captionTheme as string | undefined,
          position: opts.captionPosition as string | undefined,
          fontSize: opts.fontSize as string | undefined,
          wordsPerGroup: opts.wordsPerGroup as string | undefined,
        });

      // Ask which video framing the user wants for this run. We do this before
      // any heavy setup so the pipeline knows the layout up front and can apply
      // it uniformly across every clip. The saved default is shown as the
      // suggested choice but the user can override per-run. Analyze-only runs
      // never render, so the prompt is skipped there.
      const videoFormat = analyzeOnly
        ? config.videoFormat
        : (opts.videoFormat as 'fullscreen' | 'centered' | undefined)
          ?? (await promptVideoFormat(config.videoFormat));

      // Check Python setup
      spinner.start('Checking Python dependencies...');
      if (!(await isPythonSetup())) {
        spinner.text = 'Setting up Python environment (first run)...';
        await setupPython();
      }
      spinner.succeed('Python environment ready');

      const outputDir = opts.output
        ? path.resolve(opts.output as string)
        : defaultClipOutputDir(inputPath, config.outputDir);

      // Build pipeline config
      const pipelineConfig: PipelineConfig = {
        inputPath,
        outputDir,
        whisperModel: (opts.model as string) || config.whisperModel,
        language: (opts.language as string) || config.language,
        minClipDuration: parseIntOrDefault(opts.minDuration as string, config.minClipDuration),
        maxClipDuration: parseIntOrDefault(opts.maxDuration as string, config.maxClipDuration),
        maxClips: parseIntOrDefault(opts.maxClips as string, config.maxClips),
        faceSampleRate: config.faceSampleRate,
        anthropicApiKey: apiKey,
        endPaddingSec: parseFloatOrDefault(opts.endPadding as string, config.endPaddingSec),
        softCapRatio: parseFloatOrDefault(opts.softCapRatio as string, config.softCapRatio),
        // commander inverts --no-strict-completeness into opts.strictCompleteness === false
        strictCompleteness: opts.strictCompleteness !== false && config.strictCompleteness,
        // commander inverts --no-identity-tracking into opts.identityTracking === false
        useIdentityTracking: opts.identityTracking !== false && config.useIdentityTracking,
        debugTracking: opts.debugTracking === true || config.debugTracking,
        // commander inverts --no-resume into opts.resume === false
        noResume: opts.resume === false,
        analyzeOnly,
        exportOptions: {
          outputDir,
          format: ((opts.format as string) || config.format) as 'mp4' | 'mov' | 'webm',
          quality: ((opts.quality as string) || config.quality) as 'high' | 'medium' | 'low',
          resolution: { width: 1080, height: 1920 },
          videoFormat,
          // --captions / --no-captions override the saved default; neither = saved.
          withCaptions: (opts.captions as boolean | undefined) ?? config.withCaptions,
          captionStyle: applyTheme(captionBaseStyle, captionTheme),
          // User wants finished output dirs to contain mp4 files only —
          // no clips_metadata.json, no .ass files alongside the videos.
          includeMetadata: false,
        },
      };

      // Persist this run's choices so subsequent runs (and `shards`) start
      // with the same defaults.
      await saveConfig({
        ...config,
        videoFormat,
        captionTheme,
        captionStyle: captionBaseStyle,
      });

      // Print header
      console.log('');
      console.log(chalk.bold.green('  SHARDS'));
      console.log(chalk.gray('  AI-powered viral clip generator'));
      console.log('');
      console.log(chalk.white(`  Input:    ${inputPath}`));
      console.log(chalk.white(`  Output:   ${outputDir}`));
      console.log(chalk.white(`  Model:    Whisper ${pipelineConfig.whisperModel}`));
      console.log(chalk.white(`  Clips:    ${pipelineConfig.minClipDuration}-${pipelineConfig.maxClipDuration}s, max ${pipelineConfig.maxClips}`));
      if (analyzeOnly) {
        console.log(chalk.white(`  Mode:     analyze-only (timestamps → viral_moments.json, no rendering)`));
      } else {
        console.log(chalk.white(`  Quality:  ${pipelineConfig.exportOptions.quality}`));
        console.log(chalk.white(`  Format:   ${videoFormat === 'centered' ? 'centered (half-height with black bars)' : 'fullscreen (fill 9:16)'}`));
        console.log(chalk.white(`  Captions: ${pipelineConfig.exportOptions.withCaptions ? 'yes' : 'no'}`));
        console.log(chalk.white(`  Tracker:  ${pipelineConfig.useIdentityTracking ? 'mtcnn + identity (default)' : 'haar (legacy)'}`));
        if (pipelineConfig.debugTracking) {
          console.log(chalk.white(`  Debug:    writing _tracking.json sidecars`));
        }
      }
      console.log('');

      // Run pipeline
      const startTime = Date.now();

      const result = await runPipeline(pipelineConfig, (stage, message) => {
        const stageColors: Record<string, (s: string) => string> = {
          init: chalk.blue,
          transcribe: chalk.magenta,
          faces: chalk.yellow,
          analyze: chalk.cyan,
          mapping: chalk.green,
          viral: chalk.red,
          render: chalk.blue,
          export: chalk.green,
          complete: chalk.bold.green,
        };
        const colorFn = stageColors[stage] || chalk.white;
        const prefix = chalk.gray(`[${stage}]`);
        console.log(`  ${prefix} ${colorFn(message)}`);
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Print summary
      console.log('');
      console.log(chalk.bold.green(analyzeOnly ? '  Analysis complete!' : '  Processing complete!'));
      console.log(chalk.white(`  Time elapsed: ${elapsed}s`));
      if (analyzeOnly) {
        console.log(chalk.white(`  Viral moments found: ${result.clips.clips.length}`));
        console.log(chalk.white(`  Timestamps: ${path.join(result.outputDir, 'viral_moments.json')}`));
      } else {
        console.log(chalk.white(`  Clips generated: ${result.renderedPaths.length}`));
      }
      console.log(chalk.white(`  Output folder: ${result.outputDir}`));

      if (result.clips.clips.length > 0) {
        console.log('');
        console.log(chalk.bold('  Clip Rankings:'));
        for (const clip of result.clips.clips) {
          const scoreColor = clip.viralScore >= 80 ? chalk.green :
                            clip.viralScore >= 60 ? chalk.yellow : chalk.gray;
          const timing = analyzeOnly
            ? `(${formatClock(clip.start)} → ${formatClock(clip.end)}, ${clip.duration}s, ${clip.category})`
            : `(${clip.duration}s, ${clip.category})`;
          console.log(
            `    ${scoreColor(`[${clip.viralScore}]`)} ${chalk.white(clip.title)} ` +
            `${chalk.gray(timing)}`
          );
        }
      }

      console.log('');

    } catch (err) {
      spinner.fail('Pipeline failed');
      console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// === CONFIG COMMAND ===
registerConfigCommand(program);

// === CAPTION COMMAND ===
program
  .command('caption')
  .description('Burn captions onto an existing short-form clip (no Anthropic API, free)')
  .argument('<input>', 'Path to an MP4 clip you already have')
  .option('-o, --output <path>', 'Output file path (default: <input>_captioned.mp4 next to source)')
  .option('-m, --model <size>', 'Whisper model (tiny, base, small, medium, large)', '')
  .option('-l, --language <code>', 'Language code', '')
  .option('-q, --quality <level>', 'Render quality (high, medium, low)', '')
  .option('--theme <id>', `Caption theme / font (run \`shards-cli themes\` to list all ${THEME_COUNT})`)
  .option('--position <pos>', 'Caption position (top, center, bottom)')
  .option('--font-size <px>', 'Caption font size override (24–240)')
  .option('--words-per-group <n>', 'Words shown per caption (1–5, soft target)')
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

      const { captionTheme, captionStyle: captionBaseStyle } = captionOverridesOrExit(config.captionStyle, config.captionTheme, {
        theme: opts.theme,
        position: opts.position,
        fontSize: opts.fontSize,
        wordsPerGroup: opts.wordsPerGroup,
      });
      const captionStyle = applyTheme(captionBaseStyle, captionTheme);

      // Ensure the Python venv is ready (Whisper needs it).
      spinner.start('Checking Python environment…');
      if (!(await isPythonSetup())) {
        spinner.text = 'Setting up Python venv (first run, ~1 min)…';
        await setupPython();
      }
      spinner.succeed('Python environment ready');

      // Persist the caption choices (consistent with `process` and the TUI).
      await saveConfig({ ...config, captionTheme, captionStyle: captionBaseStyle });

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

// === THEMES COMMAND ===
program
  .command('themes')
  .description('List every caption theme and its font (use the id with --caption-theme / --theme)')
  .action(async () => {
    const { captionTheme } = await loadConfig();
    for (const line of formatThemeList(captionTheme)) console.log(line);
  });

// === PREVIEW COMMAND ===
program
  .command('preview')
  .description('Render an MP4 walking through every caption theme')
  .option('-o, --output <path>', 'Where to save the preview MP4 (default: previews/ in the repo)')
  .action(async (opts: Record<string, string>) => {
    const outPath = (opts.output as string) || defaultPreviewPath();
    const spinner = ora('Generating themes preview…').start();
    try {
      await generateThemesPreview(outPath, (msg) => { spinner.text = msg; });
      spinner.succeed(`Preview saved: ${outPath}`);
    } catch (err) {
      spinner.fail('Preview failed');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// === SETUP COMMAND ===
program
  .command('setup')
  .description('Install Python dependencies (Whisper, OpenCV)')
  .action(async () => {
    const spinner = ora('Setting up Python environment...').start();
    try {
      await setupPython();
      spinner.succeed('Python environment ready!');
      console.log(chalk.gray('  Installed: faster-whisper, opencv-python-headless, numpy, torch, torchvision, facenet-pytorch'));
    } catch (err) {
      spinner.fail('Setup failed');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parse();
