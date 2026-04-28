import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useInput } from 'ink';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-spinner ships its own loose types
import Spinner from 'ink-spinner';
import { Frame } from '../components/Frame.js';
import { TUI } from '../theme.js';
import { generateThemesPreview, defaultPreviewPath } from '../../pipeline/preview.js';

interface PreviewProps {
  onDone: () => void;
}

interface LogLine {
  id: number;
  message: string;
  timestamp: string;
}

// Renders the themes preview in the background and streams progress events
// into a styled log panel. Mirrors the Run screen's UX so the TUI feels
// consistent across long-running tasks.
export function Preview({ onDone }: PreviewProps): React.ReactElement {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [current, setCurrent] = useState('starting…');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const startedRef = useRef(false);

  useInput((_input, key) => {
    if (done && (key.return || key.escape)) onDone();
  });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const target = defaultPreviewPath();

    const append = (message: string) => {
      setCurrent(message);
      setLogs((prev) => [
        ...prev,
        {
          id: prev.length,
          message,
          timestamp: new Date().toLocaleTimeString([], { hour12: false }),
        },
      ]);
    };

    (async () => {
      try {
        const out = await generateThemesPreview(target, append);
        setOutputPath(out);
        setDone(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setDone(true);
      }
    })();
  }, []);

  return (
    <Box flexDirection="column">
      <Static items={logs}>
        {(line) => (
          <Box key={line.id}>
            <Text color={TUI.dim}>{line.timestamp} </Text>
            <Text color={TUI.accent}>[preview ]</Text>
            <Text color={TUI.fg}> {line.message}</Text>
          </Box>
        )}
      </Static>

      {!done && (
        <Frame
          title="SHARDS // theme preview"
          subtitle="rendering ~45s of mp4 with every theme — ctrl+c aborts"
          borderColor={TUI.accent}
        >
          <Text color={TUI.accent}>
            <Spinner type="dots" />{'  '}{current}
          </Text>
        </Frame>
      )}

      {done && error && (
        <Frame title="SHARDS // preview failed" subtitle="press enter to return to the menu" borderColor={TUI.error}>
          <Text color={TUI.error}>{error}</Text>
        </Frame>
      )}

      {done && !error && outputPath && (
        <Frame title="SHARDS // preview ready" subtitle="press enter to return to the menu" borderColor={TUI.primary}>
          <Text color={TUI.fg}>file: <Text color={TUI.accent} bold>{outputPath}</Text></Text>
          <Text color={TUI.dim}>open it in any video player to see every theme back-to-back.</Text>
        </Frame>
      )}
    </Box>
  );
}
