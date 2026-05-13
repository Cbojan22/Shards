import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useInput } from 'ink';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-spinner ships its own loose types
import Spinner from 'ink-spinner';
import { Frame } from '../components/Frame.js';
import { TUI } from '../theme.js';
import { isPythonSetup, setupPython } from '../../utils/python.js';
import { applyTheme } from '../../pipeline/captions/themes.js';
import { captionExistingClip, type CaptionOnlyResult } from '../../pipeline/captionOnly/index.js';
import type { CaptionWizardAnswers } from './CaptionWizard.js';
import type { UserConfig } from '../../utils/config.js';

interface CaptionRunProps {
  answers: CaptionWizardAnswers;
  baseConfig: UserConfig;
  onDone: () => void;
}

interface LogLine {
  id: number;
  stage: string;
  message: string;
  timestamp: string;
}

const STAGE_COLORS: Record<string, string> = {
  init: '#7DD3FC',
  transcribe: '#C084FC',
  captions: '#22D3EE',
  render: '#60A5FA',
  complete: '#22C55E',
  setup: '#A1A1AA',
  ready: '#22C55E',
  error: '#EF4444',
};

export function CaptionRun({ answers, baseConfig, onDone }: CaptionRunProps): React.ReactElement {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [stage, setStage] = useState('init');
  const [message, setMessage] = useState('starting up…');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptionOnlyResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);
  const startTimeRef = useRef(Date.now());

  useInput((_input, key) => {
    if (done && (key.return || key.escape)) onDone();
  });

  useEffect(() => {
    if (done) return;
    const t = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [done]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const append = (s: string, m: string) => {
      setStage(s);
      setMessage(m);
      setLogs((prev) => [
        ...prev,
        { id: prev.length, stage: s, message: m, timestamp: new Date().toLocaleTimeString([], { hour12: false }) },
      ]);
    };

    (async () => {
      try {
        append('setup', 'Checking Python environment…');
        if (!(await isPythonSetup())) {
          append('setup', 'Setting up Python venv (first run, ~1 min)…');
          await setupPython();
        }
        append('ready', 'Python ready, starting caption pass');

        const captionStyle = applyTheme(
          { ...baseConfig.captionStyle, position: answers.captionPosition },
          answers.captionTheme,
        );

        const res = await captionExistingClip(
          {
            inputPath: answers.inputPath,
            outputPath: answers.outputPath,
            whisperModel: baseConfig.whisperModel,
            language: baseConfig.language,
            quality: baseConfig.quality,
            captionStyle,
          },
          append,
        );
        setResult(res);
        setDone(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        append('error', msg);
        setError(msg);
        setDone(true);
      }
    })();
  }, [answers, baseConfig]);

  return (
    <Box flexDirection="column">
      <Static items={logs}>
        {(line) => (
          <Box key={line.id}>
            <Text color={TUI.dim}>{line.timestamp} </Text>
            <Text color={STAGE_COLORS[line.stage] ?? TUI.fg}>[{line.stage.padEnd(10)}]</Text>
            <Text color={TUI.fg}> {line.message}</Text>
          </Box>
        )}
      </Static>

      {!done && (
        <Frame title="SHARDS // captioning" subtitle={`elapsed ${formatElapsed(elapsed)} — ctrl+c aborts`} borderColor={TUI.accent}>
          <Text color={STAGE_COLORS[stage] ?? TUI.fg}>
            <Spinner type="dots" />{'  '}[{stage}] {message}
          </Text>
        </Frame>
      )}

      {done && error && (
        <Frame title="SHARDS // failed" subtitle="press enter to return to the menu" borderColor={TUI.error}>
          <Text color={TUI.error}>{error}</Text>
        </Frame>
      )}

      {done && !error && result && (
        <Frame title="SHARDS // complete" subtitle="press enter to return to the menu" borderColor={TUI.primary}>
          <Text color={TUI.fg}>captioned in <Text color={TUI.accent} bold>{formatElapsed(elapsed)}</Text></Text>
          <Text color={TUI.dim}>output: <Text color={TUI.fg}>{result.outputPath}</Text></Text>
          {!result.usedAssFilter && (
            <Text color={TUI.warn}>note: libass missing, used soft mov_text track instead</Text>
          )}
        </Frame>
      )}
    </Box>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
