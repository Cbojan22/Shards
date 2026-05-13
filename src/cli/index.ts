#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import readline from 'readline';
import { access, readFile } from 'fs/promises';
import { runPipeline } from '../pipeline/index.js';
import { isPythonSetup, setupPython } from '../utils/python.js';
import { applyTheme, CAPTION_THEME_IDS, type CaptionThemeId } from '../pipeline/captions/themes.js';
import { generateThemesPreview, defaultPreviewPath } from '../pipeline/preview.js';
import { captionExistingClip } from '../pipeline/captionOnly/index.js';
import { loadConfig, saveConfig, configPath } from '../utils/config.js';
import type { PipelineConfig, CaptionOnlyOptions } from '../types/index.js';

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
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
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

const program = new Command();

program
  .name('shards-cli')
  .description('Shards — scripted entry point for the AI viral clip generator (use `shards` for the TUI)')
  .version('1.5.0');

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
  .option('--no-captions', 'Disable caption overlay')
  .option('-q, --quality <level>', 'Export quality (high, medium, low)', '')
  .option('-f, --format <fmt>', 'Export format (mp4, mov, webm)', '')
  .option('--video-format <kind>', 'Layout: fullscreen | centered (skips the prompt)')
  .option('--caption-theme <id>', 'Caption theme (run `shards-cli config --show` to list all 16)')
  .option('--api-key <key>', 'Anthropic API key (prefer ANTHROPIC_API_KEY env var)')
  .option('--end-padding <sec>', 'Tail padding after each clip ending (default 0.6)')
  .option('--soft-cap-ratio <ratio>', 'Hard ceiling = max-duration × ratio (default 1.5)')
  .option('--no-strict-completeness', 'Keep clips Claude flagged as incomplete (default: drop them)')
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

      // Ask which video framing the user wants for this run. We do this before
      // any heavy setup so the pipeline knows the layout up front and can apply
      // it uniformly across every clip. The saved default is shown as the
      // suggested choice but the user can override per-run.
      const videoFormat = (opts.videoFormat as 'fullscreen' | 'centered' | undefined)
        ?? (await promptVideoFormat(config.videoFormat));

      // Check Python setup
      spinner.start('Checking Python dependencies...');
      if (!(await isPythonSetup())) {
        spinner.text = 'Setting up Python environment (first run)...';
        await setupPython();
      }
      spinner.succeed('Python environment ready');

      // Build output directory name — default to iCloud Drive/Snag/<video name> on macOS
      const inputName = path.basename(inputPath, path.extname(inputPath));
      const icloudSnag = process.env.HOME
        ? path.join(process.env.HOME, 'Library/Mobile Documents/com~apple~CloudDocs/Snag')
        : '';
      const icloudAvailable = icloudSnag && await access(path.dirname(icloudSnag)).then(() => true).catch(() => false);
      const defaultOutput = icloudAvailable
        ? path.join(icloudSnag, inputName)
        : path.join(path.dirname(inputPath), `${inputName}_clips`);
      const outputDir = opts.output ? path.resolve(opts.output as string) : defaultOutput;

      // Pick the active theme: per-run override wins, else the saved default.
      const themeArg = opts.captionTheme as CaptionThemeId | undefined;
      const captionTheme: CaptionThemeId = themeArg && CAPTION_THEME_IDS.includes(themeArg)
        ? themeArg
        : config.captionTheme;
      const themedCaptionStyle = applyTheme(config.captionStyle, captionTheme);

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
        exportOptions: {
          outputDir,
          format: ((opts.format as string) || config.format) as 'mp4' | 'mov' | 'webm',
          quality: ((opts.quality as string) || config.quality) as 'high' | 'medium' | 'low',
          resolution: { width: 1080, height: 1920 },
          videoFormat,
          withCaptions: opts.captions !== false && config.withCaptions,
          captionStyle: themedCaptionStyle,
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
      console.log(chalk.white(`  Quality:  ${pipelineConfig.exportOptions.quality}`));
      console.log(chalk.white(`  Format:   ${videoFormat === 'centered' ? 'centered (half-height with black bars)' : 'fullscreen (fill 9:16)'}`));
      console.log(chalk.white(`  Captions: ${pipelineConfig.exportOptions.withCaptions ? 'yes' : 'no'}`));
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
      console.log(chalk.bold.green('  Processing complete!'));
      console.log(chalk.white(`  Time elapsed: ${elapsed}s`));
      console.log(chalk.white(`  Clips generated: ${result.renderedPaths.length}`));
      console.log(chalk.white(`  Output folder: ${result.outputDir}`));

      if (result.clips.clips.length > 0) {
        console.log('');
        console.log(chalk.bold('  Clip Rankings:'));
        for (const clip of result.clips.clips) {
          const scoreColor = clip.viralScore >= 80 ? chalk.green :
                            clip.viralScore >= 60 ? chalk.yellow : chalk.gray;
          console.log(
            `    ${scoreColor(`[${clip.viralScore}]`)} ${chalk.white(clip.title)} ` +
            `${chalk.gray(`(${clip.duration}s, ${clip.category})`)}`
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
program
  .command('config')
  .description('View or update Shards configuration')
  .option('--api-key <key>', 'Set Anthropic API key')
  .option('--model <size>', 'Set default Whisper model')
  .option('--language <code>', 'Set default language')
  .option('--quality <level>', 'Set default quality (high/medium/low)')
  .option('--format <fmt>', 'Set default format (mp4/mov/webm)')
  .option('--video-format <kind>', 'Set default video format (fullscreen/centered)')
  .option('--caption-theme <id>', 'Set default caption theme (16 options — see README for the full list)')
  .option('--max-clips <n>', 'Set max clips per video')
  .option('--min-duration <sec>', 'Set minimum clip duration')
  .option('--max-duration <sec>', 'Set maximum clip duration')
  .option('--end-padding <sec>', 'Set tail padding (seconds) added after each clip ending')
  .option('--soft-cap-ratio <ratio>', 'Set soft-cap multiplier on max-duration')
  .option('--strict-completeness <bool>', 'Set strict completeness gate (true/false)')
  .option('--caption-font <name>', 'Set caption font family')
  .option('--caption-size <px>', 'Set caption font size')
  .option('--caption-color <hex>', 'Set primary caption color')
  .option('--highlight-color <hex>', 'Set emphasis word color')
  .option('--caption-position <pos>', 'Set caption position (top/center/bottom)')
  .option('--words-per-group <n>', 'Words shown at a time (1-3)')
  .option('--show', 'Show current config')
  .action(async (opts: Record<string, string | boolean>) => {
    const config = await loadConfig();
    let changed = false;

    if (opts.apiKey) {
      console.warn(chalk.yellow('Warning: API key will be stored in plaintext in ~/.shards/config.json.'));
      console.warn(chalk.yellow('Prefer: export ANTHROPIC_API_KEY=your_key'));
      config.anthropicApiKey = opts.apiKey as string; changed = true;
    }
    if (opts.model) { config.whisperModel = opts.model as string; changed = true; }
    if (opts.language) { config.language = opts.language as string; changed = true; }
    if (opts.quality) { config.quality = opts.quality as 'high' | 'medium' | 'low'; changed = true; }
    if (opts.format) { config.format = opts.format as 'mp4' | 'mov' | 'webm'; changed = true; }
    if (opts.videoFormat) {
      const vf = opts.videoFormat as 'fullscreen' | 'centered';
      if (vf !== 'fullscreen' && vf !== 'centered') {
        console.error(chalk.red(`Invalid video format: ${vf}. Expected 'fullscreen' or 'centered'.`));
        process.exit(1);
      }
      config.videoFormat = vf; changed = true;
    }
    if (opts.captionTheme) {
      const ct = opts.captionTheme as CaptionThemeId;
      if (!CAPTION_THEME_IDS.includes(ct)) {
        console.error(chalk.red(`Invalid caption theme: ${ct}. Expected one of ${CAPTION_THEME_IDS.join(', ')}.`));
        process.exit(1);
      }
      config.captionTheme = ct; changed = true;
    }
    if (opts.maxClips) { config.maxClips = parseInt(opts.maxClips as string); changed = true; }
    if (opts.minDuration) { config.minClipDuration = parseInt(opts.minDuration as string); changed = true; }
    if (opts.maxDuration) { config.maxClipDuration = parseInt(opts.maxDuration as string); changed = true; }
    if (opts.endPadding) { config.endPaddingSec = parseFloat(opts.endPadding as string); changed = true; }
    if (opts.softCapRatio) { config.softCapRatio = parseFloat(opts.softCapRatio as string); changed = true; }
    if (opts.strictCompleteness !== undefined) {
      const v = String(opts.strictCompleteness).toLowerCase();
      if (v !== 'true' && v !== 'false') {
        console.error(chalk.red(`Invalid --strict-completeness: ${v}. Expected true or false.`));
        process.exit(1);
      }
      config.strictCompleteness = v === 'true'; changed = true;
    }
    if (opts.captionFont) { config.captionStyle.fontFamily = opts.captionFont as string; changed = true; }
    if (opts.captionSize) { config.captionStyle.fontSize = parseInt(opts.captionSize as string); changed = true; }
    if (opts.captionColor) { config.captionStyle.primaryColor = opts.captionColor as string; changed = true; }
    if (opts.highlightColor) { config.captionStyle.highlightColor = opts.highlightColor as string; changed = true; }
    if (opts.captionPosition) { config.captionStyle.position = opts.captionPosition as 'top' | 'center' | 'bottom'; changed = true; }
    if (opts.wordsPerGroup) { config.captionStyle.wordsPerGroup = parseInt(opts.wordsPerGroup as string); changed = true; }

    if (changed) {
      await saveConfig(config);
      console.log(chalk.green('Configuration saved.'));
    }

    // Always show config
    const display = { ...config, anthropicApiKey: config.anthropicApiKey ? '***set***' : '(not set)' };
    console.log('');
    console.log(chalk.bold('  Current Configuration:'));
    console.log(chalk.gray(`  path: ${configPath()}`));
    console.log(chalk.gray('  ' + '-'.repeat(40)));
    for (const [key, value] of Object.entries(display)) {
      if (typeof value === 'object') {
        console.log(chalk.cyan(`  ${key}:`));
        for (const [k, v] of Object.entries(value as object)) {
          console.log(chalk.white(`    ${k}: ${v}`));
        }
      } else {
        console.log(chalk.white(`  ${key}: ${value}`));
      }
    }
    console.log('');
  });

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

// === PREVIEW COMMAND ===
program
  .command('preview')
  .description('Render an MP4 walking through every caption theme')
  .option('-o, --output <path>', 'Where to save the preview MP4 (default: iCloud/Snag)')
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
      console.log(chalk.gray('  Installed: openai-whisper, opencv-python-headless, numpy'));
    } catch (err) {
      spinner.fail('Setup failed');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parse();
