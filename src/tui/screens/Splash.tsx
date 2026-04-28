import React from 'react';
import { Box, Text, useInput } from 'ink';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-big-text ships without typings
import BigText from 'ink-big-text';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-gradient ships without typings
import Gradient from 'ink-gradient';
import { TUI } from '../theme.js';

interface SplashProps {
  onContinue: () => void;
}

// Boot screen. Any keypress moves on; Ctrl-C still exits Ink as usual.
export function Splash({ onContinue }: SplashProps): React.ReactElement {
  useInput(() => onContinue());

  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Gradient name="vice">
        <BigText text="SHARDS" font="block" />
      </Gradient>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color={TUI.primary}>
          {'> '}
          <Text color={TUI.fg}>cut long-form down to viral shorts</Text>
        </Text>
        <Text color={TUI.dim}>v1.0.0 — local-first, AI-driven</Text>
      </Box>
      <Box marginTop={2}>
        <Text color={TUI.accent}>[ press any key to continue ]</Text>
      </Box>
    </Box>
  );
}
