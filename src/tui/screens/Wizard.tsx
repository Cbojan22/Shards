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
import { WhisperModelStep } from '../components/WhisperModelStep.js';
import { TUI } from '../theme.js';
import { defaultClipOutputDir } from '../../utils/config.js';
import {
  CAPTION_THEMES,
  CAPTION_THEME_IDS,
  type CaptionThemeId,
} from '../../pipeline/captions/themes.js';

export type WizardMode = 'run' | 'defaults';

export interface WizardAnswers {
  inputPath: string;
  outputDir: string;          // '' means: derive default at run time
  whisperModel: string;
  language: string;
  minClipDuration: number;
  maxClipDuration: number;
  maxClips: number;
  quality: 'high' | 'medium' | 'low';
  format: 'mp4' | 'mov' | 'webm';
  videoFormat: 'fullscreen' | 'centered';
  withCaptions: boolean;
  captionTheme: CaptionThemeId;
  captionPosition: 'top' | 'center' | 'bottom';
  captionWordsPerGroup: number;
  captionFontSize: number;
}

interface WizardProps {
  mode: WizardMode;
  initial: WizardAnswers;
  /** Saved base folder for clip runs ('' = next to the input). */
  outputBaseDir: string;
  onCancel: () => void;
  onSubmit: (answers: WizardAnswers) => void;
}

type StepKey =
  | 'inputPath'
  | 'outputDir'
  | 'whisperModel'
  | 'minDuration'
  | 'maxDuration'
  | 'maxClips'
  | 'quality'
  | 'format'
  | 'videoFormat'
  | 'captions'
  | 'captionTheme'
  | 'captionPosition'
  | 'confirm';

const ALL_STEPS: StepKey[] = [
  'inputPath',
  'outputDir',
  'whisperModel',
  'minDuration',
  'maxDuration',
  'maxClips',
  'quality',
  'format',
  'videoFormat',
  'captions',
  'captionTheme',
  'captionPosition',
  'confirm',
];

export function Wizard({ mode, initial, outputBaseDir, onCancel, onSubmit }: WizardProps): React.ReactElement {
  const [answers, setAnswers] = useState<WizardAnswers>(initial);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Filter out steps that don't apply to the current mode/answers, then drive
  // navigation by index into the filtered list. Recomputed on every render so
  // changes to `withCaptions` immediately reshape the flow.
  const activeSteps = useMemo<StepKey[]>(() => {
    return ALL_STEPS.filter((key) => {
      if (mode === 'defaults' && key === 'inputPath') return false;
      if (!answers.withCaptions && (key === 'captionTheme' || key === 'captionPosition')) return false;
      return true;
    });
  }, [mode, answers.withCaptions]);

  // Clamp the cursor whenever the active step list shrinks under our feet
  // (e.g. user toggles captions off after we'd already advanced past them).
  useEffect(() => {
    if (step >= activeSteps.length) setStep(activeSteps.length - 1);
  }, [activeSteps.length, step]);

  const currentKey = activeSteps[step] ?? 'confirm';

  // ESC always backs up by one step, or cancels the wizard from step 0.
  useInput((_, key) => {
    if (key.escape) {
      setError(null);
      if (step === 0) onCancel();
      else setStep((s) => Math.max(0, s - 1));
    }
  });

  const advance = () => {
    setError(null);
    setStep((s) => Math.min(activeSteps.length - 1, s + 1));
  };

  const update = <K extends keyof WizardAnswers>(key: K, value: WizardAnswers[K]) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <Box flexDirection="column">
      <Header step={step + 1} total={activeSteps.length} mode={mode} />
      {renderStep({
        key: currentKey,
        answers,
        outputBaseDir,
        update,
        advance,
        onSubmit,
        error,
        setError,
      })}
      <Box marginTop={1}>
        <Text color={TUI.dim}>
          enter to continue · esc to {step === 0 ? 'cancel' : 'go back'}
        </Text>
      </Box>
    </Box>
  );
}

function Header({ step, total, mode }: { step: number; total: number; mode: WizardMode }) {
  const title = mode === 'defaults' ? 'edit defaults' : 'new clip run';
  const bar = renderProgressBar(step, total);
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text color={TUI.primary} bold>
        SHARDS // {title}
      </Text>
      <Text color={TUI.dim}>
        step {step}/{total} {bar}
      </Text>
    </Box>
  );
}

function renderProgressBar(step: number, total: number): string {
  const width = 20;
  const filled = Math.round((step / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

interface StepCtx {
  key: StepKey;
  answers: WizardAnswers;
  outputBaseDir: string;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
  advance: () => void;
  onSubmit: (a: WizardAnswers) => void;
  error: string | null;
  setError: (s: string | null) => void;
}

function renderStep(ctx: StepCtx): React.ReactElement {
  switch (ctx.key) {
    case 'inputPath':       return <PathStep ctx={ctx} />;
    case 'outputDir':       return <OutputDirStep ctx={ctx} />;
    case 'whisperModel':    return <ModelStep ctx={ctx} />;
    case 'minDuration':     return <NumberStep ctx={ctx} field="minClipDuration" title="min clip duration (seconds)" hint="lower bound for any generated clip" min={5} max={120} />;
    case 'maxDuration':     return <NumberStep ctx={ctx} field="maxClipDuration" title="max clip duration (seconds)" hint="upper bound; viral clips usually live in 30–90s" min={10} max={600} />;
    case 'maxClips':        return <NumberStep ctx={ctx} field="maxClips" title="max clips per run" hint="cap on how many clips Claude is asked to surface" min={1} max={50} />;
    case 'quality':         return <QualityStep ctx={ctx} />;
    case 'format':          return <FormatStep ctx={ctx} />;
    case 'videoFormat':     return <VideoFormatStep ctx={ctx} />;
    case 'captions':        return <CaptionsToggleStep ctx={ctx} />;
    case 'captionTheme':    return <ThemeStep ctx={ctx} />;
    case 'captionPosition': return <CaptionPositionStep ctx={ctx} />;
    case 'confirm':         return <ConfirmStep ctx={ctx} />;
  }
}

// ─── steps ────────────────────────────────────────────────────────────────

function PathStep({ ctx }: { ctx: StepCtx }) {
  const [value, setValue] = useState(ctx.answers.inputPath);

  const onSubmit = async (raw: string) => {
    const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!trimmed) {
      ctx.setError('Path is required.');
      return;
    }
    const resolved = path.resolve(trimmed.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    try {
      await access(resolved);
    } catch {
      ctx.setError(`File not found: ${resolved}`);
      return;
    }
    ctx.update('inputPath', resolved);
    ctx.advance();
  };

  return (
    <Frame title="input video" subtitle="absolute or ~ path; tab/space don't expand here">
      <Box>
        <Text color={TUI.primary}>{'> '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} placeholder="/path/to/video.mp4" />
      </Box>
      {ctx.error && (
        <Box marginTop={1}>
          <Text color={TUI.error}>{ctx.error}</Text>
        </Box>
      )}
    </Frame>
  );
}

function OutputDirStep({ ctx }: { ctx: StepCtx }) {
  const [value, setValue] = useState(ctx.answers.outputDir);
  const fallback = useMemo(
    () => deriveDefaultOutput(ctx.answers.inputPath, ctx.outputBaseDir),
    [ctx.answers.inputPath, ctx.outputBaseDir],
  );

  const onSubmit = (raw: string) => {
    const trimmed = raw.trim();
    ctx.update('outputDir', trimmed);
    ctx.advance();
  };

  return (
    <Frame title="output directory" subtitle="leave blank to use the default below">
      <Box>
        <Text color={TUI.primary}>{'> '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} placeholder={fallback} />
      </Box>
      <Box marginTop={1}>
        <Text color={TUI.dim}>default: <Text color={TUI.fg}>{fallback}</Text></Text>
      </Box>
    </Frame>
  );
}

function ModelStep({ ctx }: { ctx: StepCtx }) {
  return (
    <WhisperModelStep
      value={ctx.answers.whisperModel}
      onSelect={(model) => {
        ctx.update('whisperModel', model);
        ctx.advance();
      }}
    />
  );
}

function NumberStep({
  ctx, field, title, hint, min, max,
}: {
  ctx: StepCtx;
  field: 'minClipDuration' | 'maxClipDuration' | 'maxClips';
  title: string;
  hint: string;
  min: number;
  max: number;
}) {
  const [value, setValue] = useState(String(ctx.answers[field]));

  const onSubmit = (raw: string) => {
    const n = parseInt(raw.trim(), 10);
    if (Number.isNaN(n)) {
      ctx.setError('Enter a whole number.');
      return;
    }
    if (n < min || n > max) {
      ctx.setError(`Must be between ${min} and ${max}.`);
      return;
    }
    if (field === 'maxClipDuration' && n <= ctx.answers.minClipDuration) {
      ctx.setError(`Max must be greater than min (${ctx.answers.minClipDuration}).`);
      return;
    }
    ctx.update(field, n);
    ctx.advance();
  };

  return (
    <Frame title={title} subtitle={hint}>
      <Box>
        <Text color={TUI.primary}>{'> '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      <Box marginTop={1}>
        <Text color={TUI.dim}>range: {min}–{max}</Text>
      </Box>
      {ctx.error && (
        <Box marginTop={1}>
          <Text color={TUI.error}>{ctx.error}</Text>
        </Box>
      )}
    </Frame>
  );
}

function QualityStep({ ctx }: { ctx: StepCtx }) {
  const items = [
    { label: 'high    — slow encode, lowest CRF',         value: 'high' },
    { label: 'medium  — balanced',                        value: 'medium' },
    { label: 'low     — fast, smaller files',             value: 'low' },
  ];
  const initial = items.findIndex((i) => i.value === ctx.answers.quality);
  return (
    <Frame title="render quality" subtitle="trade-off between encode speed, file size, and visual fidelity">
      <SelectInput
        items={items}
        initialIndex={initial >= 0 ? initial : 0}
        onSelect={(item: { value: string }) => {
          ctx.update('quality', item.value as WizardAnswers['quality']);
          ctx.advance();
        }}
      />
    </Frame>
  );
}

function FormatStep({ ctx }: { ctx: StepCtx }) {
  const items = [
    { label: 'mp4 — universal, best for social',  value: 'mp4' },
    { label: 'mov — Apple-friendly container',    value: 'mov' },
    { label: 'webm — VP9, smaller for web',       value: 'webm' },
  ];
  const initial = items.findIndex((i) => i.value === ctx.answers.format);
  return (
    <Frame title="output container" subtitle="file format for the rendered clips">
      <SelectInput
        items={items}
        initialIndex={initial >= 0 ? initial : 0}
        onSelect={(item: { value: string }) => {
          ctx.update('format', item.value as WizardAnswers['format']);
          ctx.advance();
        }}
      />
    </Frame>
  );
}

function VideoFormatStep({ ctx }: { ctx: StepCtx }) {
  const items = [
    { label: 'fullscreen — fills the entire 9:16 frame', value: 'fullscreen' },
    { label: 'centered   — half-height with black bars', value: 'centered' },
  ];
  const initial = items.findIndex((i) => i.value === ctx.answers.videoFormat);
  return (
    <Frame title="video format" subtitle="how the source video sits inside the 9:16 output">
      <SelectInput
        items={items}
        initialIndex={initial >= 0 ? initial : 0}
        onSelect={(item: { value: string }) => {
          ctx.update('videoFormat', item.value as WizardAnswers['videoFormat']);
          ctx.advance();
        }}
      />
    </Frame>
  );
}

function CaptionsToggleStep({ ctx }: { ctx: StepCtx }) {
  const items = [
    { label: 'on  — burn captions into the clip', value: 'on' },
    { label: 'off — no captions',                 value: 'off' },
  ];
  const initial = ctx.answers.withCaptions ? 0 : 1;
  return (
    <Frame title="captions" subtitle="word-level karaoke captions, generated from the transcript">
      <SelectInput
        items={items}
        initialIndex={initial}
        onSelect={(item: { value: string }) => {
          ctx.update('withCaptions', item.value === 'on');
          ctx.advance();
        }}
      />
    </Frame>
  );
}

function ThemeStep({ ctx }: { ctx: StepCtx }) {
  const items = CAPTION_THEME_IDS.map((id) => ({
    label: `${CAPTION_THEMES[id].name.padEnd(10)} ${CAPTION_THEMES[id].tagline}`,
    value: id,
  }));
  const initial = items.findIndex((i) => i.value === ctx.answers.captionTheme);
  const [highlighted, setHighlighted] = useState<CaptionThemeId>(ctx.answers.captionTheme);

  return (
    <Frame title="caption theme" subtitle="font + colour preset — preview shows the highlighted theme">
      <SelectInput
        items={items}
        initialIndex={initial >= 0 ? initial : 0}
        onHighlight={(item: { value: CaptionThemeId }) => setHighlighted(item.value)}
        onSelect={(item: { value: CaptionThemeId }) => {
          ctx.update('captionTheme', item.value);
          ctx.advance();
        }}
      />
      <Box marginTop={1}>
        <ThemePreview themeId={highlighted} />
      </Box>
    </Frame>
  );
}

function ThemePreview({ themeId }: { themeId: CaptionThemeId }) {
  const t = CAPTION_THEMES[themeId];
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.swatchFg} backgroundColor={t.swatchBg} bold>
          {' THIS IS YOUR '}
          <Text color={t.highlightColor} backgroundColor={t.swatchBg} bold>
            VIRAL
          </Text>
          {' '}
          <Text color={t.highlightColor} backgroundColor={t.swatchBg} bold>
            MOMENT
          </Text>
          {' '}
        </Text>
      </Box>
      <Text color={TUI.dim}>{t.fontFamily} · {t.tagline}</Text>
    </Box>
  );
}

function CaptionPositionStep({ ctx }: { ctx: StepCtx }) {
  const items = [
    { label: 'bottom — most readable on phones',  value: 'bottom' },
    { label: 'center — TikTok-style centerpiece', value: 'center' },
    { label: 'top    — keep the speaker visible', value: 'top' },
  ];
  const initial = items.findIndex((i) => i.value === ctx.answers.captionPosition);
  return (
    <Frame title="caption position" subtitle="where captions sit inside the 9:16 frame">
      <SelectInput
        items={items}
        initialIndex={initial >= 0 ? initial : 0}
        onSelect={(item: { value: string }) => {
          ctx.update('captionPosition', item.value as WizardAnswers['captionPosition']);
          ctx.advance();
        }}
      />
    </Frame>
  );
}

function ConfirmStep({ ctx }: { ctx: StepCtx }) {
  const choices = ctx.answers.inputPath
    ? [
        { label: 'start run — begin processing now', value: 'go' },
        { label: 'cancel — back to menu',            value: 'cancel' },
      ]
    : [
        { label: 'save defaults — write to ~/.shards/config.json', value: 'go' },
        { label: 'cancel — back to menu',                          value: 'cancel' },
      ];

  return (
    <Frame title="review" subtitle="press enter on the highlighted action">
      <Summary answers={ctx.answers} outputBaseDir={ctx.outputBaseDir} />
      <Box marginTop={1}>
        <SelectInput
          items={choices}
          onSelect={(item: { value: string }) => {
            if (item.value === 'go') ctx.onSubmit(ctx.answers);
            else ctx.advance();
          }}
        />
      </Box>
    </Frame>
  );
}

function Summary({ answers, outputBaseDir }: { answers: WizardAnswers; outputBaseDir: string }) {
  const rows: Array<[string, string]> = [
    ['input',         answers.inputPath || '(not used in defaults mode)'],
    ['output',        answers.outputDir || `default (${deriveDefaultOutput(answers.inputPath, outputBaseDir)})`],
    ['whisper',       answers.whisperModel],
    ['clip range',    `${answers.minClipDuration}–${answers.maxClipDuration}s, max ${answers.maxClips}`],
    ['quality',       answers.quality],
    ['container',     answers.format],
    ['video format',  answers.videoFormat],
    ['captions',      answers.withCaptions ? `${CAPTION_THEMES[answers.captionTheme].name} @ ${answers.captionPosition}` : 'off'],
  ];
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  return (
    <Box flexDirection="column">
      {rows.map(([k, v]) => (
        <Text key={k} color={TUI.fg}>
          <Text color={TUI.accent}>{k.padEnd(labelWidth)}</Text>
          {'  '}
          {v}
        </Text>
      ))}
    </Box>
  );
}

function deriveDefaultOutput(inputPath: string, outputBaseDir: string): string {
  if (!inputPath) return outputBaseDir ? path.join(outputBaseDir, '<name>') : '<input folder>/<name>_clips';
  return defaultClipOutputDir(inputPath, outputBaseDir);
}
