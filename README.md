# Video Clipper

CLI tool that takes long-form videos (podcasts, interviews, lectures) and automatically generates short-form vertical clips optimized for TikTok, Instagram Reels, and YouTube Shorts.

## What it does

- Transcribes audio with word-level timestamps (Whisper)
- Detects and tracks faces throughout the video (OpenCV)
- Uses Claude AI to identify the most viral-worthy moments
- Renders 9:16 vertical clips that dynamically follow the active speaker's face
- Burns in styled captions (ALL CAPS, multi-color emphasis on key words)
- Exports everything to a folder with metadata and viral scores

## Prerequisites

- **Node.js** >= 18
- **Python** 3.8+ (for Whisper and OpenCV)
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

## Setup

```bash
# Clone and install
git clone https://github.com/your-username/video-clipper.git
cd video-clipper
npm install

# Set your API key (preferred method)
export ANTHROPIC_API_KEY=your_key_here

# Or add to .env file
echo "ANTHROPIC_API_KEY=your_key_here" > .env

# Install Python dependencies (runs automatically on first use)
npx tsx src/cli/index.ts setup
```

## Usage

### Process a video

```bash
npx tsx src/cli/index.ts process /path/to/video.mp4
```

This will:
1. Transcribe the video and detect speakers
2. Detect and track faces
3. Analyze the transcript for viral moments using Claude
4. Render vertical clips with face tracking and captions
5. Save clips to iCloud Drive/Snag/<video name>/ (macOS) or next to the input file

### Options

```bash
npx tsx src/cli/index.ts process /path/to/video.mp4 \
  --output /custom/output/dir \
  --max-clips 10 \
  --min-duration 15 \
  --max-duration 120 \
  --quality high \
  --format mp4 \
  --no-captions \
  --model base \
  --language en
```

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | iCloud/Snag or input dir | Output directory |
| `--max-clips <n>` | 20 | Maximum clips to generate |
| `--min-duration <sec>` | 15 | Minimum clip length in seconds |
| `--max-duration <sec>` | 180 | Maximum clip length in seconds |
| `-q, --quality <level>` | high | Export quality (high/medium/low) |
| `-f, --format <fmt>` | mp4 | Export format (mp4/mov/webm) |
| `--no-captions` | - | Disable caption overlay |
| `-m, --model <size>` | base | Whisper model (tiny/base/small/medium/large) |
| `-l, --language <code>` | en | Language code |

### Configure defaults

```bash
# View current config
npx tsx src/cli/index.ts config --show

# Set defaults
npx tsx src/cli/index.ts config --quality medium
npx tsx src/cli/index.ts config --max-clips 10
npx tsx src/cli/index.ts config --caption-size 104
npx tsx src/cli/index.ts config --highlight-color "#FF0000"
npx tsx src/cli/index.ts config --caption-position bottom
npx tsx src/cli/index.ts config --words-per-group 2
```

| Config Option | Description |
|---------------|-------------|
| `--quality <level>` | high, medium, low |
| `--format <fmt>` | mp4, mov, webm |
| `--max-clips <n>` | Max clips per video |
| `--min-duration <sec>` | Minimum clip duration |
| `--max-duration <sec>` | Maximum clip duration |
| `--model <size>` | Whisper model size |
| `--caption-font <name>` | Font family (e.g. "Arial Black") |
| `--caption-size <px>` | Font size in pixels |
| `--caption-color <hex>` | Primary text color |
| `--highlight-color <hex>` | Emphasis word color |
| `--caption-position <pos>` | top, center, bottom |
| `--words-per-group <n>` | Words displayed at once (1-3) |

## Output

Each run produces a folder containing:

```
video_name/
  clip_001_catchy_title.mp4
  clip_002_another_title.mp4
  ...
  clip_001_captions.ass      # Subtitle files
  clip_002_captions.ass
  clips_metadata.json        # Full metadata for all clips
```

### Metadata

`clips_metadata.json` includes for each clip:

- Title, start/end timestamps, duration
- Viral score (0-100)
- Category (hot_take, humor, insight, revelation, etc.)
- Reason why it was selected
- Full transcript text
- Speaker labels
- Suggested hashtag keywords

## How it works

### Pipeline stages

1. **Transcribe** — Whisper generates word-level timestamps with speaker diarization
2. **Face Detection** — OpenCV Haar cascades track faces across sampled frames
3. **Speaker-Face Mapping** — Correlates speaker segments with detected face positions
4. **Viral Analysis** — Claude analyzes the transcript and scores moments for viral potential
5. **Render** — FFmpeg crops to 9:16, dynamically following the largest visible face with smooth keyframe interpolation
6. **Captions** — ASS subtitles with ALL CAPS text, multi-color emphasis on key words, burned into the video

### Caption style

Captions follow the Hormozi-style format:
- ALL CAPS text
- 2 words at a time
- Key words highlighted in gold
- Large bold font with outline
- Positioned in the lower third

### Face tracking

The renderer samples face positions every 0.5 seconds and:
- Picks the largest visible face (most likely the active speaker in a close-up)
- Applies center-preference scoring for two-person wide shots
- Smooths keyframes with a 7-frame moving average
- Preserves quick transitions on speaker changes
- Backfills early frames to ensure the clip starts on a face

## Whisper models

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| tiny | 39M | Fastest | Basic |
| base | 74M | Fast | Good (default) |
| small | 244M | Medium | Better |
| medium | 769M | Slow | Great |
| large | 1.5G | Slowest | Best |

For most podcasts/interviews, `base` is sufficient. Use `small` or `medium` for noisy audio or non-English content.

## License

MIT
