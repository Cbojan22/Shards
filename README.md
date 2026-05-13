# Shards

Shards turns long-form video (podcasts, interviews, lectures, talks) into short-form vertical clips ranked by viral potential. It transcribes, tracks faces, asks Claude which moments would land best, and renders each pick as a captioned 9:16 mp4 you can post directly.

There are two ways to use it:

- **`shards`** — a dark, retro terminal GUI that walks you through everything (recommended).
- **`shards-cli`** — a scripted Commander-based CLI for one-shot or automated runs.

## What it does

- Transcribes audio with word-level timestamps (Whisper)
- Detects and tracks faces throughout the video (OpenCV)
- Uses Claude to identify the most viral-worthy moments
- Renders 9:16 vertical clips that dynamically follow the active speaker's face
- Burns in styled captions with selectable theme presets
- Lets you choose between **fullscreen** and **centered** (half-height with black bars) framing
- Exports everything to a folder with metadata and viral scores

## Prerequisites

- **Node.js** >= 18
- **Python** 3.8+ (for Whisper and OpenCV — Shards sets up its own venv on first run)
- **FFmpeg** with libass support (for burned-in captions)
- **Anthropic API key**

### Install FFmpeg (macOS)

```bash
brew install ffmpeg
```

For burned-in caption support (recommended):

```bash
brew install homebrew-ffmpeg/ffmpeg/ffmpeg-full
```

## Install

```bash
git clone https://github.com/Cbojan22/Shards.git
cd Shards
npm install
npm run build
npm link
```

`npm link` installs `shards` and `shards-cli` as global commands so you can run them from any directory.

Set your API key (preferred — keeps it out of source):

```bash
export ANTHROPIC_API_KEY=your_key_here
```

Or stash it in a `.env` file at the project root (Shards walks up from the launch directory looking for one):

```bash
echo "ANTHROPIC_API_KEY=your_key_here" > .env
```

## Usage — TUI

```bash
shards
```

You'll get a splash screen, then a main menu:

- **New clip run** — pick a video and walk through every setting (input path, output dir, Whisper model, durations, quality, format, video framing, caption theme, caption position).
- **Edit defaults** — same wizard, but skips the input-path step; just saves your answers as the new defaults.
- **View quick guide** — a built-in primer on what Shards does and what you need.
- **Quit**

Your latest answers always become the new defaults so the next run is faster.

### Caption themes

Sixteen baked-in looks, each pairing a font with a colour palette. The wizard previews the highlighted theme inline before you commit. To see them all in motion, run `shards-cli preview` or pick **Preview themes** from the TUI menu.

| Theme | Vibe | Font |
|-------|------|------|
| `golden` | White with gold emphasis (default) | Arial Black |
| `matrix` | Phosphor green monospace | Menlo |
| `cyberpunk` | Magenta / cyan neon | Helvetica Neue |
| `vhs` | Bold red on black | Impact |
| `mono` | Plain white, no emphasis | Helvetica Neue |
| `sunset` | Warm orange + coral | Futura |
| `newsprint` | Editorial serif with newspaper-red emphasis | Times New Roman |
| `frost` | Cool tech minimal — Apple Keynote energy | Helvetica Neue |
| `inferno` | Heavy condensed orange — sports hype | Impact |
| `brutalist` | Stark white with thick black borders | Helvetica Neue |
| `pastel` | Soft femme dreamy — wellness vibes | Avenir Next |
| `y2k` | Early-internet maximalist | Trebuchet MS |
| `amber` | Warm CRT amber, Matrix's analog cousin | Courier New |
| `magazine` | Didot serif with champagne gold — Vogue cover | Didot |
| `notebook` | Marker Felt navy ink — handwritten margin notes | Marker Felt |
| `vapor` | 80s vaporwave — pink + cyan + purple | Futura |

### Video format

| Mode | What you get | Use when |
|------|--------------|----------|
| `fullscreen` | Source crop fills the entire 9:16 frame | Tight talking-head close-ups |
| `centered` | Wider crop scaled into the middle half, black bars top + bottom | You need to see hands, props, or a wider stage |

## Usage — scripted CLI

For automation or one-shot runs, `shards-cli process` skips the wizard:

```bash
shards-cli process /path/to/video.mp4 \
  --output /custom/output/dir \
  --max-clips 10 \
  --min-duration 15 \
  --max-duration 120 \
  --quality high \
  --format mp4 \
  --video-format centered \
  --caption-theme matrix
```

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | iCloud/Snag/<name> or input dir | Output directory |
| `--max-clips <n>` | 20 | Maximum clips to generate |
| `--min-duration <sec>` | 15 | Minimum clip length |
| `--max-duration <sec>` | 180 | Maximum clip length |
| `-q, --quality <level>` | high | Export quality (high/medium/low) |
| `-f, --format <fmt>` | mp4 | Container format (mp4/mov/webm) |
| `--video-format <kind>` | fullscreen | Layout (fullscreen/centered) |
| `--caption-theme <id>` | golden | Caption theme (see table above) |
| `--no-captions` | — | Disable caption overlay |
| `-m, --model <size>` | small | Whisper model |
| `-l, --language <code>` | en | Language code |

### Caption an existing clip (free, no API)

Already have a short-form clip and just want Shards-style captions on it? Skip the full pipeline:

```bash
# CLI
shards-cli caption /path/to/clip.mp4 --theme matrix --position bottom

# TUI
shards
# → Caption existing clip
```

This path uses local Whisper + FFmpeg only — no Anthropic API key required. Output defaults to `<input>_captioned.mp4` next to the source.

### Configure defaults

Both `shards` (via "Edit defaults") and `shards-cli config` read and write the same file at `~/.shards/config.json`.

```bash
# View current config
shards-cli config --show

# Set defaults
shards-cli config --quality medium
shards-cli config --video-format centered
shards-cli config --caption-theme cyberpunk
shards-cli config --caption-position bottom
shards-cli config --words-per-group 2
```

## Output

Each run produces a folder containing:

```
video_name/
  clip_001_catchy_title.mp4
  clip_002_another_title.mp4
  ...
  clip_001_captions.ass        # Subtitle source
  clip_002_captions.ass
  clips_metadata.json          # Full metadata for all clips
```

`clips_metadata.json` includes for each clip:

- Title, start/end timestamps, duration
- Viral score (0–100)
- Category (hot_take, humor, insight, revelation, etc.)
- Reason it was selected
- Full transcript text and speaker labels
- Suggested hashtag keywords

## How it works

1. **Transcribe** — Whisper generates word-level timestamps with speaker diarization.
2. **Face detection** — OpenCV Haar cascades track faces across sampled frames.
3. **Speaker–face mapping** — Correlates speaker segments with detected face positions.
4. **Viral analysis** — Claude scores moments for hook strength, emotional intensity, shareability.
5. **Render** — FFmpeg crops to 9:16 (or 9:8 in centered mode), dynamically following the largest visible face with smooth keyframe interpolation.
6. **Captions** — ASS subtitles with karaoke-style word emphasis, burned in via libass.

## Whisper models

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| tiny | 39M | Fastest | Basic |
| base | 74M | Fast | Good |
| small | 244M | Medium | Better (default) |
| medium | 769M | Slow | Great |
| large | 1.5G | Slowest | Best |

For most podcasts/interviews, `small` is sufficient. Use `medium` or `large` for noisy audio or non-English content.

## License

MIT
