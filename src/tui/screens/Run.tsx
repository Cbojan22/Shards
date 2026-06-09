import React, { useEffect, useRef, useState } from 'react';
import path from 'path';
import { access } from 'fs/promises';
import { Box, Static, Text, useInput } from 'ink';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-spinner ships its own loose types
import Spinner from 'ink-spinner';
import { Frame } from '../components/Frame.js';
import { TUI } from '../theme.js';
import { runPipeline, type PipelineResult } from '../../pipeline/index.js';
import { isPythonSetup, setupPython } from '../../utils/python.js';
import { applyTheme } from '../../pipeline/captions/themes.js';
import type { PipelineConfig } from '../../types/index.js';
import type { WizardAnswers } from './Wizard.js';
import type { UserConfig } from '../../utils/config.js';

interface RunProps {
  answers: WizardAnswers;
  baseConfig: UserConfig;
  apiKey: string;
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
  faces: '#FACC15',
  analyze: '#22D3EE',
  mapping: '#34D399',
  viral: '#F87171',
  render: '#60A5FA',
  export: '#86EFAC',
  complete: '#22C55E',
  setup: '#A1A1AA',
  ready: '#22C55E',
  error: '#EF4444',
};

// Live run screen: kicks off the pipeline once on mount, streams progress
// events into a styled log panel, and replaces the panel with a results
// summary when the pipeline finishes (or with an error block on failure).
export function Run({ answers, baseConfig, apiKey, onDone }: RunProps): React.ReactElement {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [currentStage, setCurrentStage] = useState<string>('init');
  const [currentMessage, setCurrentMessage] = useState<string>('starting up…');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);
  const startTimeRef = useRef(Date.now());

  // After the run finishes, any keypress takes us back to the menu.
  useInput((_input, key) => {
    if (done && (key.return || key.escape)) onDone();
  });

  // Tick the elapsed clock once a second so the user sees life during the
  // (often long) transcribe + render stages.
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

    const append = (stage: string, message: string) => {
      setCurrentStage(stage);
      setCurrentMessage(message);
      setLogs((prev) => [
        ...prev,
        {
          id: prev.length,
          stage,
          message,
          timestamp: new Date().toLocaleTimeString([], { hour12: false }),
        },
      ]);
    };

    (async () => {
      try {
        // Resolve output dir — the wizard accepts blank to mean "default".
        const outputDir = answers.outputDir || (await deriveDefaultOutput(answers.inputPath));

        // Make sure the source video still exists. The wizard validated it
        // when entered, but the user could have moved it since.
        try {
          await access(answers.inputPath);
        } catch {
          throw new Error(`Input file not found: ${answers.inputPath}`);
        }

        append('setup', 'Checking Python environment…');
        if (!(await isPythonSetup())) {
          append('setup', 'Setting up Python venv (first run, ~1 min)…');
          await setupPython();
        }
        append('ready', 'Python ready, starting pipeline');

        const captionStyle = applyTheme(
          {
            ...baseConfig.captionStyle,
            position: answers.captionPosition,
            wordsPerGroup: answers.captionWordsPerGroup,
            fontSize: answers.captionFontSize,
          },
          answers.captionTheme,
        );

        const pipelineConfig: PipelineConfig = {
          inputPath: answers.inputPath,
          outputDir,
          whisperModel: answers.whisperModel,
          language: baseConfig.language,
          minClipDuration: answers.minClipDuration,
          maxClipDuration: answers.maxClipDuration,
          maxClips: answers.maxClips,
          faceSampleRate: baseConfig.faceSampleRate,
          anthropicApiKey: apiKey,
          endPaddingSec: baseConfig.endPaddingSec,
          softCapRatio: baseConfig.softCapRatio,
          strictCompleteness: baseConfig.strictCompleteness,
          useIdentityTracking: baseConfig.useIdentityTracking,
          debugTracking: baseConfig.debugTracking,
          exportOptions: {
            outputDir,
            format: answers.format,
            quality: answers.quality,
            resolution: { width: 1080, height: 1920 },
            videoFormat: answers.videoFormat,
            withCaptions: answers.withCaptions,
            captionStyle,
            // Output folder stays mp4-only — see CLI for the same setting.
            includeMetadata: false,
          },
        };

        const res = await runPipeline(pipelineConfig, append);
        setResult(res);
        setDone(true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        append('error', message);
        setError(message);
        setDone(true);
      }
    })();
  }, [answers, baseConfig, apiKey]);

  return (
    <Box flexDirection="column">
      <Static items={logs}>
        {(line) => (
          <Box key={line.id}>
            <Text color={TUI.dim}>{line.timestamp} </Text>
            <Text color={STAGE_COLORS[line.stage] ?? TUI.fg}>
              [{line.stage.padEnd(10)}]
            </Text>
            <Text color={TUI.fg}> {line.message}</Text>
          </Box>
        )}
      </Static>

      {!done && (
        <Frame
          title="SHARDS // running"
          subtitle={`elapsed ${formatElapsed(elapsed)} — ctrl+c aborts`}
          borderColor={TUI.accent}
        >
          <Box>
            <Text color={STAGE_COLORS[currentStage] ?? TUI.fg}>
              <Spinner type="dots" />{'  '}
              [{currentStage}] {currentMessage}
            </Text>
          </Box>
        </Frame>
      )}

      {done && error && (
        <Frame title="SHARDS // failed" subtitle="press enter to return to the menu" borderColor={TUI.error}>
          <Text color={TUI.error}>{error}</Text>
        </Frame>
      )}

      {done && !error && result && (
        <Frame title="SHARDS // complete" subtitle="press enter to return to the menu" borderColor={TUI.primary}>
          <Text color={TUI.fg}>
            rendered <Text color={TUI.accent} bold>{result.renderedPaths.length}</Text> clips
            in <Text color={TUI.accent} bold>{formatElapsed(elapsed)}</Text>
          </Text>
          <Text color={TUI.dim}>output: <Text color={TUI.fg}>{result.outputDir}</Text></Text>
          {result.clips.clips.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={TUI.accent} bold>clip rankings</Text>
              {result.clips.clips.map((clip) => (
                <Text key={clip.id} color={TUI.fg}>
                  <Text color={scoreColor(clip.viralScore)} bold>
                    [{String(clip.viralScore).padStart(3)}]
                  </Text>{' '}
                  <Text color={TUI.fg}>{clip.title}</Text>{' '}
                  <Text color={TUI.dim}>({clip.duration}s · {clip.category})</Text>
                </Text>
              ))}
            </Box>
          )}
        </Frame>
      )}
    </Box>
  );
}

function scoreColor(score: number): string {
  if (score >= 80) return TUI.primary;
  if (score >= 60) return TUI.warn;
  return TUI.dim;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

async function deriveDefaultOutput(inputPath: string): Promise<string> {
  const base = path.basename(inputPath, path.extname(inputPath));
  const home = process.env.HOME;
  if (!home) return path.join(path.dirname(inputPath), `${base}_clips`);
  const icloudSnag = path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs/Snag');
  try {
    await access(path.dirname(icloudSnag));
    return path.join(icloudSnag, base);
  } catch {
    return path.join(path.dirname(inputPath), `${base}_clips`);
  }
}
