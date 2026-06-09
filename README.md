# Shards

Shards turns long-form video (podcasts, interviews, lectures, talks) into short-form vertical clips ranked by viral potential. It transcribes, tracks faces, asks Claude which moments would land best, and renders each pick as a captioned 9:16 mp4 you can post directly.

There are two ways to use it:

- **`shards`** — a dark, retro terminal GUI that walks you through everything (recommended).
- **`shards-cli`** — a scripted Commander-based CLI for one-shot or automated runs.

## What it does

- Transcribes audio with word-level timestamps (Whisper)
- Detects and tracks faces throughout the video, clustering them into persistent person identities
- Uses Claude to identify the most viral-worthy moments
- Renders 9:16 vertical clips that dynamically follow the active speaker's face
- Burns in styled captions with selectable theme presets
- Lets you choose between **fullscreen** and **centered** (half-height with black bars) framing
- **Analyze-only mode**: skip rendering entirely and just get a `viral_moments.json` with exact timestamps, so you can cut the clips yourself
- Captions an existing clip you already cut — no API key needed
- Resumes interrupted runs from checkpoints, so a crash never re-bills the API

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
| `--analyze-only` | — | Timestamps only — no face tracking, no rendering (see below) |
| `--end-padding <sec>` | 0.6 | Breathing room added after each clip's ending |
| `--soft-cap-ratio <ratio>` | 1.5 | Clips may overrun max-duration up to this multiple for the payoff |
| `--no-strict-completeness` | — | Keep clips Claude flagged as incomplete (default: drop them) |
| `--no-identity-tracking` | — | Fall back to the legacy Haar face tracker |
| `--debug-tracking` | — | Write a `<clip>_tracking.json` sidecar per clip with per-keyframe scoring |
| `--no-resume` | — | Ignore cached checkpoints and recompute from scratch |

### Analyze only — just the timestamps

Want to cut the clips yourself? `--analyze-only` runs transcription and the Claude viral analysis, then writes the timestamps and stops — no face tracking, no rendering, no framing prompt:

```bash
shards-cli process /path/to/video.mp4 --analyze-only
```

This writes `viral_moments.json` to the output directory with, for each moment: start/end in seconds **and** editor-ready timecodes (`HH:MM:SS.s`), viral score, title, category, the reason it was picked, transcript text, speakers, and hashtag keywords. The console also prints each moment's time range next to its score.

API cost is the same as a full run (the analysis step is the only thing that bills Anthropic — everything else is local), but you skip all the face-tracking compute and any auto-crop mistakes. Pair it with `shards-cli caption` to caption your hand-cut clips for free.

### Caption an existing clip (free, no API)

Already have a short-form clip and just want Shards-style captions on it? Skip the full pipeline:

```bash
# CLI
shards-cli caption /path/to/clip.mp4 --theme matrix --position bottom

# Optional styling overrides
shards-cli caption clip.mp4 --font-size 96 --words-per-group 2

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

A full run produces a folder of ready-to-post mp4s (captions are burned in; no sidecar files):

```
video_name/
  clip_001_catchy_title.mp4
  clip_002_another_title.mp4
  ...
  .shards/                     # Resume checkpoints (transcript, faces, analysis)
```

An `--analyze-only` run produces `viral_moments.json` instead of mp4s, containing for each moment:

- Title, start/end in seconds plus `HH:MM:SS.s` timecodes, duration
- Viral score (0–100)
- Category (hot_take, humor, insight, revelation, etc.)
- Reason it was selected
- Full transcript text and speaker labels
- Suggested hashtag keywords

The hidden `.shards/` folder lets interrupted or repeated runs reuse the transcript, face data, and Claude analysis instead of recomputing (or re-billing) them. Delete it — or pass `--no-resume` — to force a clean run.

## How it works

1. **Transcribe** — Whisper generates word-level timestamps with speaker diarization.
2. **Face detection** — MTCNN detects faces with landmarks and identity embeddings across sampled frames (`--no-identity-tracking` falls back to OpenCV Haar cascades).
3. **Identity clustering** — Embeddings are clustered into persistent person identities, filtering out transient faces (ads, posters, b-roll).
4. **Speaker–face mapping** — Correlates speaker segments with persons via lip-movement activity.
5. **Viral analysis** — Claude scores moments for hook strength, emotional intensity, shareability. This is the only step that calls the Anthropic API; `--analyze-only` stops here and writes the timestamps.
6. **Render** — FFmpeg crops to 9:16 (or 9:8 in centered mode), dynamically following the active speaker with smooth keyframe interpolation and camera-cut detection.
7. **Captions** — ASS subtitles with karaoke-style word emphasis, burned in via libass.

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
