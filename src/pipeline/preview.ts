import path from 'path';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import {
  CAPTION_THEMES,
  CAPTION_THEME_IDS,
  type CaptionTheme,
} from './captions/themes.js';
import { hexToASS, formatASSTime } from './captions/index.js';
import { runFFmpeg, bundledFontsFilterSuffix } from '../utils/ffmpeg.js';

// Renders one mp4 that walks through every caption theme back-to-back. Each
// theme gets its own segment with the theme name banner and a short karaoke
// caption sample, so the user sees the actual fonts/colours/emphasis effects
// libass produces — not an approximation.

const PREVIEW_WIDTH = 1080;
const PREVIEW_HEIGHT = 1920;
const PREVIEW_FPS = 30;
const SEGMENT_SECONDS = 7;
const TITLE_SECONDS = 3;

interface CaptionSample {
  start: number;
  end: number;
  // Words are split on space; emphasis indices get the highlight colour and
  // the same scale-up the real captions use.
  words: string[];
  emphasis: number[];
}

const SAMPLES: CaptionSample[] = [
  { start: 0.6, end: 2.1, words: ['THIS', 'IS'],          emphasis: [] },
  { start: 2.1, end: 3.6, words: ['YOUR', 'VIRAL'],       emphasis: [1] },
  { start: 3.6, end: 5.1, words: ['MOMENT', 'INCOMING'],  emphasis: [0, 1] },
  { start: 5.1, end: 6.7, words: ['ABSOLUTELY', 'UNREAL'], emphasis: [0, 1] },
];

export function defaultPreviewPath(): string {
  // Preview artifacts land inside the project repo (under `previews/`) so
  // the user can open them directly from their IDE — not in iCloud, not in
  // a hidden folder. Rendered final clips still default to iCloud/Snag;
  // previews are inspection artifacts and stay local.
  // `import.meta.url` is the real path of this module after symlink
  // resolution, so this works whether shards-cli was invoked from the
  // project dir or via an `npm link`-installed global bin.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // From src/pipeline/preview.ts OR dist/pipeline/preview.js the project
  // root is two directories up.
  const projectRoot = path.resolve(moduleDir, '..', '..');
  return path.join(projectRoot, 'previews', 'themes-preview.mp4');
}

export async function generateThemesPreview(
  outputPath: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), 'shards-preview-'));

  try {
    const segments: string[] = [];

    onProgress?.('Rendering title card');
    const titleSeg = path.join(work, '00-title.mp4');
    const titleAss = path.join(work, '00-title.ass');
    await writeFile(titleAss, buildTitleAss(TITLE_SECONDS));
    await renderSegment({
      duration: TITLE_SECONDS,
      assPath: titleAss,
      backgroundColor: '#000000',
      output: titleSeg,
    });
    segments.push(titleSeg);

    let i = 1;
    for (const themeId of CAPTION_THEME_IDS) {
      const theme = CAPTION_THEMES[themeId];
      onProgress?.(`Rendering ${theme.name}`);
      const segPath = path.join(work, `${String(i).padStart(2, '0')}-${themeId}.mp4`);
      const assPath = path.join(work, `${String(i).padStart(2, '0')}-${themeId}.ass`);
      await writeFile(assPath, buildThemeAss(theme, SEGMENT_SECONDS));
      await renderSegment({
        duration: SEGMENT_SECONDS,
        assPath,
        backgroundColor: theme.swatchBg,
        output: segPath,
      });
      segments.push(segPath);
      i++;
    }

    onProgress?.('Concatenating segments');
    await concatSegments(segments, outputPath, work);
    return outputPath;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderSegment({
  duration,
  assPath,
  output,
  backgroundColor,
}: {
  duration: number;
  assPath: string;
  output: string;
  backgroundColor: string;
}): Promise<void> {
  // Filter goes through a script file because the ASS path can contain
  // characters (colons, commas) that ffmpeg's -vf parser splits on.
  const filterScript = path.join(tmpdir(), `shards_preview_${randomUUID()}.txt`);
  await writeFile(filterScript, `ass=${assPath.replace(/:/g, '\\:')}${bundledFontsFilterSuffix()}`);

  const encoder = process.platform === 'darwin'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '8M']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];

  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${ffmpegColor(backgroundColor)}:s=${PREVIEW_WIDTH}x${PREVIEW_HEIGHT}:d=${duration}:r=${PREVIEW_FPS}`,
    // Concat demuxer with `-c copy` is happier when every segment has the
    // same stream layout. Adding silent stereo audio keeps the layout
    // consistent and makes the preview play cleanly in any video app.
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest',
    '-filter_script:v', filterScript,
    ...encoder,
    '-c:a', 'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ];

  try {
    await runFFmpeg(args);
  } finally {
    await unlink(filterScript).catch(() => {});
  }
}

async function concatSegments(
  segments: string[],
  outputPath: string,
  workDir: string,
): Promise<void> {
  const listPath = path.join(workDir, 'concat.txt');
  // Single-quote each path and escape any embedded quotes — the concat
  // demuxer's own quoting rules.
  const lines = segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
  await writeFile(listPath, lines.join('\n'));
  await runFFmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outputPath,
  ]);
}

function ffmpegColor(hex: string): string {
  return `0x${hex.replace('#', '').toUpperCase()}`;
}

// ─── ASS file builders ────────────────────────────────────────────────────

function buildTitleAss(duration: number): string {
  const primary = hexToASS('#FFFFFF');
  const accent = hexToASS('#00FF41');
  const muted = hexToASS('#9CA3AF');
  const outline = hexToASS('#000000');
  const shadow = hexToASS('#000000');

  const titleStyle = styleLine('Title', 'Helvetica Neue', 220, primary, primary, outline, shadow, -1, 6, 5, 540);
  const subtitleStyle = styleLine('Subtitle', 'Helvetica Neue', 70, accent, accent, outline, shadow, -1, 4, 5, 360);
  const helpStyle = styleLine('Help', 'Helvetica Neue', 50, muted, muted, outline, shadow, 0, 3, 5, 220);

  const events: string[] = [
    dialogue(0, duration, 'Title', 'SHARDS'),
    dialogue(0, duration, 'Subtitle', 'CAPTION THEME PREVIEW'),
    dialogue(0.5, duration, 'Help', 'six themes coming up — fonts and colours as they render in real clips'),
  ];

  return assDocument([titleStyle, subtitleStyle, helpStyle], events);
}

function buildThemeAss(theme: CaptionTheme, duration: number): string {
  const primary = hexToASS(theme.primaryColor);
  const highlight = hexToASS(theme.highlightColor);
  const accent = hexToASS(theme.accentColor);
  const outline = hexToASS(theme.outlineColor);
  const shadow = hexToASS(theme.shadowColor);
  const tagline = hexToASS('#9CA3AF');

  // ThemeName: top-of-frame banner using the theme's own font + colour.
  // alignment 8 = top center (Numpad layout).
  const nameStyle = styleLine(
    'ThemeName',
    theme.fontFamily,
    180,
    primary,
    primary,
    outline,
    shadow,
    theme.bold ? -1 : 0,
    theme.outlineWidth,
    8,
    160,
  );

  // Tagline: smaller, muted gray under the banner.
  const taglineStyle = styleLine(
    'Tagline',
    theme.fontFamily,
    46,
    tagline,
    tagline,
    outline,
    shadow,
    0,
    3,
    8,
    380,
  );

  // Caption: bottom-positioned karaoke captions, same style libass uses
  // when burning real clips. Highlight colour is applied inline per word.
  const captionStyle = styleLine(
    'Caption',
    theme.fontFamily,
    104,
    primary,
    primary,
    outline,
    shadow,
    theme.bold ? -1 : 0,
    theme.outlineWidth,
    2,
    420,
  );

  const events: string[] = [
    dialogue(0, duration, 'ThemeName', theme.name.toUpperCase()),
    dialogue(0.4, duration, 'Tagline', theme.tagline),
  ];

  for (const sample of SAMPLES) {
    const text = sample.words
      .map((word, i) =>
        sample.emphasis.includes(i)
          ? `{\\c${highlight}\\fscx110\\fscy110}${word}{\\r}`
          : word,
      )
      .join(' ');
    events.push(dialogue(sample.start, sample.end, 'Caption', text));
  }

  // Reference accent for completeness — small line at the bottom showing
  // the accent colour live (some themes use it; the karaoke captions
  // themselves only ever use primary + highlight).
  events.push(
    dialogue(
      duration - 1.2,
      duration,
      'Caption',
      `{\\c${accent}\\fscx80\\fscy80}{\\bord3}accent · ${theme.fontFamily}{\\r}`,
    ),
  );

  return assDocument([nameStyle, taglineStyle, captionStyle], events);
}

// ─── ASS plumbing ─────────────────────────────────────────────────────────

function assDocument(styles: string[], events: string[]): string {
  const header = `[Script Info]
Title: Shards Theme Preview
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: ${PREVIEW_WIDTH}
PlayResY: ${PREVIEW_HEIGHT}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.map((s) => `Style: ${s}`).join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
  return header;
}

function styleLine(
  name: string,
  font: string,
  fontSize: number,
  primaryBGR: string,
  secondaryBGR: string,
  outlineBGR: string,
  shadowBGR: string,
  bold: -1 | 0,
  outlineWidth: number,
  alignment: number,
  marginV: number,
): string {
  return [
    name,
    font,
    fontSize,
    primaryBGR,
    secondaryBGR,
    outlineBGR,
    shadowBGR,
    bold,
    0, 0, 0,        // italic, underline, strikeout
    100, 100, 0, 0, // scaleX, scaleY, spacing, angle
    1,              // border style
    outlineWidth,
    1,              // shadow
    alignment,
    20, 20,
    marginV,
    1,              // encoding
  ].join(',');
}

function dialogue(start: number, end: number, style: string, text: string): string {
  return `Dialogue: 0,${formatASSTime(start)},${formatASSTime(end)},${style},,0,0,0,,${text}`;
}
