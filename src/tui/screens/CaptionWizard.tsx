import React, { useMemo, useState } from 'react';
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
  captionFontSize: number;
  captionWordsPerGroup: number;
}

interface CaptionWizardProps {
  initial: CaptionWizardAnswers;
  onCancel: () => void;
  onSubmit: (answers: CaptionWizardAnswers) => void;
}

type StepKey = 'inputPath' | 'theme' | 'position' | 'fontSize' | 'wordsPerGroup' | 'confirm';
const STEPS: StepKey[] = ['inputPath', 'theme', 'position', 'fontSize', 'wordsPerGroup', 'confirm'];

const FONT_SIZE_MIN = 24;
const FONT_SIZE_MAX = 240;
const WORDS_PER_GROUP_MIN = 1;
const WORDS_PER_GROUP_MAX = 5;

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
      {STEPS[step] === 'fontSize' && <FontSizeStep answers={answers} update={update} advance={advance} error={error} setError={setError} />}
      {STEPS[step] === 'wordsPerGroup' && <WordsPerGroupStep answers={answers} update={update} advance={advance} error={error} setError={setError} />}
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

function FontSizeStep({ answers, update, advance, error, setError }: StepProps) {
  const [value, setValue] = useState(String(answers.captionFontSize));
  const onSubmit = (raw: string) => {
    const n = parseInt(raw.trim(), 10);
    if (Number.isNaN(n)) { setError?.('Enter a whole number.'); return; }
    if (n < FONT_SIZE_MIN || n > FONT_SIZE_MAX) {
      setError?.(`Must be between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}.`);
      return;
    }
    update('captionFontSize', n);
    advance();
  };
  return (
    <Frame title="caption font size" subtitle="larger = more screen real estate, easier to read on mobile">
      <Box>
        <Text color={TUI.primary}>{'> '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      <Box marginTop={1}>
        <Text color={TUI.dim}>range: {FONT_SIZE_MIN}–{FONT_SIZE_MAX} · default 104</Text>
      </Box>
      {error && (
        <Box marginTop={1}><Text color={TUI.error}>{error}</Text></Box>
      )}
    </Frame>
  );
}

function WordsPerGroupStep({ answers, update, advance, error, setError }: StepProps) {
  const [value, setValue] = useState(String(answers.captionWordsPerGroup));
  const onSubmit = (raw: string) => {
    const n = parseInt(raw.trim(), 10);
    if (Number.isNaN(n)) { setError?.('Enter a whole number.'); return; }
    if (n < WORDS_PER_GROUP_MIN || n > WORDS_PER_GROUP_MAX) {
      setError?.(`Must be between ${WORDS_PER_GROUP_MIN} and ${WORDS_PER_GROUP_MAX}.`);
      return;
    }
    update('captionWordsPerGroup', n);
    advance();
  };
  return (
    <Frame title="words per caption" subtitle="soft target — phrase cohesion can grow groups when the line fits">
      <Box>
        <Text color={TUI.primary}>{'> '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      <Box marginTop={1}>
        <Text color={TUI.dim}>range: {WORDS_PER_GROUP_MIN}–{WORDS_PER_GROUP_MAX} · default 3</Text>
      </Box>
      {error && (
        <Box marginTop={1}><Text color={TUI.error}>{error}</Text></Box>
      )}
    </Frame>
  );
}

function ConfirmStep({ answers, onSubmit, advance }: { answers: CaptionWizardAnswers; onSubmit: (a: CaptionWizardAnswers) => void; advance: () => void; }) {
  const defaultOut = useMemo(() => deriveDefaultOutput(answers.inputPath), [answers.inputPath]);
  const rows: Array<[string, string]> = [
    ['input',     answers.inputPath],
    ['output',    answers.outputPath || defaultOut],
    ['theme',     answers.captionTheme],
    ['position',  answers.captionPosition],
    ['font size', String(answers.captionFontSize)],
    ['words/cap', String(answers.captionWordsPerGroup)],
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
