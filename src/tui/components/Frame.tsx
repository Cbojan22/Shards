import React from 'react';
import { Box, Text } from 'ink';
import { TUI } from '../theme.js';

interface FrameProps {
  title?: string;
  subtitle?: string;
  borderColor?: string;
  width?: number;
  children: React.ReactNode;
}

// Bordered panel with a small title bar. Used as the chrome for every
// screen so all of SHARDS reads as one application.
export function Frame({
  title,
  subtitle,
  borderColor = TUI.primary,
  width,
  children,
}: FrameProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      width={width}
    >
      {title && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={borderColor}>
            {title}
          </Text>
          {subtitle && (
            <Text color={TUI.dim}>{subtitle}</Text>
          )}
        </Box>
      )}
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}
