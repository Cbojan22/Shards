#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { access, readFile, writeFile, mkdir } from 'fs/promises';
import { runPipeline } from '../pipeline/index.js';
import { isPythonSetup, setupPython } from '../utils/python.js';
import { DEFAULT_CAPTION_STYLE } from '../pipeline/captions/index.js';
import type { PipelineConfig, CaptionStyle, ExportOptions } from '../types/index.js';

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid number: "${value}", using default: ${fallback}`);
    return fallback;
  }
  return parsed;
}

const CONFIG_DIR = path.join(process.cwd(), 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'clipper.json');

interface CliConfig {
  whisperModel: string;
  language: string;
  minClipDuration: number;
  maxClipDuration: number;
  maxClips: number;
  faceSampleRate: number;
  anthropicApiKey: string;
  format: 'mp4' | 'mov' | 'webm';
  quality: 'high' | 'medium' | 'low';
  withCaptions: boolean;
  captionStyle: CaptionStyle;
}

const DEFAULT_CONFIG: CliConfig = {
  whisperModel: 'base',
  language: 'en',
  minClipDuration: 15,
  maxClipDuration: 180,
  maxClips: 20,
  faceSampleRate: 2,
  anthropicApiKey: '',
  format: 'mp4',
  quality: 'high',
  withCaptions: true,
  captionStyle: DEFAULT_CAPTION_STYLE,
};

async function loadConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const program = new Command();

program
  .name('clipper')
  .description('AI-powered long-form video to viral short-form clip generator')
  .version('1.0.0');

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
  .option('--api-key <key>', 'Anthropic API key (prefer ANTHROPIC_API_KEY env var)')
  .action(async (input: string, opts: Record<string, string | boolean>) => {
    const spinner = ora();

    try {
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
        console.error(chalk.yellow('Set it via: clipper config --api-key YOUR_KEY'));
        console.error(chalk.yellow('Or: export ANTHROPIC_API_KEY=YOUR_KEY'));
        process.exit(1);
      }

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
        exportOptions: {
          outputDir,
          format: ((opts.format as string) || config.format) as 'mp4' | 'mov' | 'webm',
          quality: ((opts.quality as string) || config.quality) as 'high' | 'medium' | 'low',
          resolution: { width: 1080, height: 1920 },
          withCaptions: opts.captions !== false && config.withCaptions,
          captionStyle: config.captionStyle,
          includeMetadata: true,
        },
      };

      // Print header
      console.log('');
      console.log(chalk.bold.cyan('  Video Clipper'));
      console.log(chalk.gray('  AI-powered viral clip generator'));
      console.log('');
      console.log(chalk.white(`  Input:    ${inputPath}`));
      console.log(chalk.white(`  Output:   ${outputDir}`));
      console.log(chalk.white(`  Model:    Whisper ${pipelineConfig.whisperModel}`));
      console.log(chalk.white(`  Clips:    ${pipelineConfig.minClipDuration}-${pipelineConfig.maxClipDuration}s, max ${pipelineConfig.maxClips}`));
      console.log(chalk.white(`  Quality:  ${pipelineConfig.exportOptions.quality}`));
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
  .description('View or update clipper configuration')
  .option('--api-key <key>', 'Set Anthropic API key')
  .option('--model <size>', 'Set default Whisper model')
  .option('--language <code>', 'Set default language')
  .option('--quality <level>', 'Set default quality (high/medium/low)')
  .option('--format <fmt>', 'Set default format (mp4/mov/webm)')
  .option('--max-clips <n>', 'Set max clips per video')
  .option('--min-duration <sec>', 'Set minimum clip duration')
  .option('--max-duration <sec>', 'Set maximum clip duration')
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
      console.warn(chalk.yellow('Warning: API key will be stored in plaintext in config/clipper.json.'));
      console.warn(chalk.yellow('Prefer: export ANTHROPIC_API_KEY=your_key'));
      config.anthropicApiKey = opts.apiKey as string; changed = true;
    }
    if (opts.model) { config.whisperModel = opts.model as string; changed = true; }
    if (opts.language) { config.language = opts.language as string; changed = true; }
    if (opts.quality) { config.quality = opts.quality as 'high' | 'medium' | 'low'; changed = true; }
    if (opts.format) { config.format = opts.format as 'mp4' | 'mov' | 'webm'; changed = true; }
    if (opts.maxClips) { config.maxClips = parseInt(opts.maxClips as string); changed = true; }
    if (opts.minDuration) { config.minClipDuration = parseInt(opts.minDuration as string); changed = true; }
    if (opts.maxDuration) { config.maxClipDuration = parseInt(opts.maxDuration as string); changed = true; }
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
