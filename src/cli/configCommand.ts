import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { loadConfig, saveConfig, configPath } from '../utils/config.js';
import { captionOverridesOrExit, THEME_COUNT, type CaptionOverrides } from './captionOptions.js';

/** `shards-cli config` — view or update the saved defaults in ~/.shards/config.json. */
export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('View or update Shards configuration')
    .option('--api-key <key>', 'Set Anthropic API key')
    .option('--model <size>', 'Set default Whisper model')
    .option('--language <code>', 'Set default language')
    .option('--quality <level>', 'Set default quality (high/medium/low)')
    .option('--format <fmt>', 'Set default format (mp4/mov/webm)')
    .option('--video-format <kind>', 'Set default video format (fullscreen/centered)')
    .option('--output-dir <path>', 'Set base folder for clips (<path>/<video name>); "" = next to the input')
    .option('--caption-theme <id>', `Set default caption theme / font (run \`shards-cli themes\` to list all ${THEME_COUNT})`)
    .option('--captions <bool>', 'Burn captions by default (true/false)')
    .option('--max-clips <n>', 'Set max clips per video')
    .option('--min-duration <sec>', 'Set minimum clip duration')
    .option('--max-duration <sec>', 'Set maximum clip duration')
    .option('--end-padding <sec>', 'Set tail padding (seconds) added after each clip ending')
    .option('--soft-cap-ratio <ratio>', 'Set soft-cap multiplier on max-duration')
    .option('--strict-completeness <bool>', 'Set strict completeness gate (true/false)')
    .option('--identity-tracking <bool>', 'Use MTCNN + identity-embedding tracker (true/false)')
    .option('--debug-tracking <bool>', 'Write per-clip _tracking.json sidecars (true/false)')
    .option('--caption-size <px>', 'Set caption font size (24–240)')
    .option('--caption-position <pos>', 'Set caption position (top/center/bottom)')
    .option('--words-per-group <n>', 'Words shown at a time (1–5)')
    .option('--show', 'Show current config')
    .action(async (opts: Record<string, string | boolean>) => {
      const config = await loadConfig();
      let changed = false;

      if (opts.apiKey) {
        console.warn(chalk.yellow('Warning: API key will be stored in plaintext in ~/.shards/config.json.'));
        console.warn(chalk.yellow('Prefer: export ANTHROPIC_API_KEY=your_key'));
        config.anthropicApiKey = opts.apiKey as string; changed = true;
      }
      if (opts.outputDir !== undefined) {
        const dir = opts.outputDir as string;
        config.outputDir = dir && !dir.startsWith('~/') ? path.resolve(dir) : dir;
        changed = true;
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
      const captionFlags: CaptionOverrides = {
        theme: opts.captionTheme as string | undefined,
        position: opts.captionPosition as string | undefined,
        fontSize: opts.captionSize as string | undefined,
        wordsPerGroup: opts.wordsPerGroup as string | undefined,
      };
      if (Object.values(captionFlags).some((v) => v !== undefined)) {
        const next = captionOverridesOrExit(config.captionStyle, config.captionTheme, captionFlags);
        config.captionTheme = next.captionTheme;
        config.captionStyle = next.captionStyle;
        changed = true;
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
      if (opts.identityTracking !== undefined) {
        const v = String(opts.identityTracking).toLowerCase();
        if (v !== 'true' && v !== 'false') {
          console.error(chalk.red(`Invalid --identity-tracking: ${v}. Expected true or false.`));
          process.exit(1);
        }
        config.useIdentityTracking = v === 'true'; changed = true;
      }
      if (opts.captions !== undefined) {
        const v = String(opts.captions).toLowerCase();
        if (v !== 'true' && v !== 'false') {
          console.error(chalk.red(`Invalid --captions: ${v}. Expected true or false.`));
          process.exit(1);
        }
        config.withCaptions = v === 'true'; changed = true;
      }
      if (opts.debugTracking !== undefined) {
        const v = String(opts.debugTracking).toLowerCase();
        if (v !== 'true' && v !== 'false') {
          console.error(chalk.red(`Invalid --debug-tracking: ${v}. Expected true or false.`));
          process.exit(1);
        }
        config.debugTracking = v === 'true'; changed = true;
      }

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
}
