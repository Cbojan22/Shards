import React from 'react';
import { Box, Text } from 'ink';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-select-input ships its own loose types
import SelectInput from 'ink-select-input';
import { Frame } from '../components/Frame.js';
import { TUI } from '../theme.js';

export type MenuChoice = 'run' | 'caption' | 'guide' | 'defaults' | 'preview' | 'quit';

interface MenuItem {
  label: string;
  value: MenuChoice;
}

const ITEMS: MenuItem[] = [
  { label: '> New clip run',          value: 'run' },
  { label: '> Caption existing clip', value: 'caption' },
  { label: '> Edit defaults',         value: 'defaults' },
  { label: '> Preview themes',        value: 'preview' },
  { label: '> View quick guide',      value: 'guide' },
  { label: '> Quit',                  value: 'quit' },
];

const HINTS: Record<MenuChoice, string> = {
  run:      'Pick a video, configure, and process',
  caption:  'Burn captions onto a clip you already have (free, no API)',
  defaults: 'Adjust saved settings without running',
  preview:  'Render an MP4 showing every caption theme burned in',
  guide:    'How SHARDS works, what you need',
  quit:     'Leave SHARDS',
};

interface MenuProps {
  onSelect: (choice: MenuChoice) => void;
  configPath: string;
  apiKeyPresent: boolean;
}

// Decorate the labels with a green chevron via the indicator slot so the
// selection cursor looks like a terminal prompt.
const Indicator = ({ isSelected }: { isSelected?: boolean }) => (
  <Text color={isSelected ? TUI.primary : TUI.dim}>{isSelected ? '> ' : '  '}</Text>
);

const ItemLabel = ({ isSelected, label }: { isSelected?: boolean; label: string }) => (
  <Text color={isSelected ? TUI.fg : TUI.muted} bold={isSelected}>
    {label.replace(/^> /, '')}
  </Text>
);

export function Menu({ onSelect, configPath, apiKeyPresent }: MenuProps): React.ReactElement {
  const [highlighted, setHighlighted] = React.useState<MenuChoice>('run');
  const hint = HINTS[highlighted];

  return (
    <Box flexDirection="column">
      <Frame title="SHARDS // main" subtitle="select an action and press enter">
        <SelectInput
          items={ITEMS}
          itemComponent={ItemLabel}
          indicatorComponent={Indicator}
          onSelect={(item: MenuItem) => onSelect(item.value)}
          onHighlight={(item: MenuItem) => setHighlighted(item.value)}
        />
        <Box marginTop={1}>
          <Text color={TUI.dim}>{hint}</Text>
        </Box>
      </Frame>
      <Box marginTop={1} flexDirection="column">
        <Text color={TUI.dim}>config: <Text color={TUI.fg}>{configPath}</Text></Text>
        <Text color={TUI.dim}>
          ANTHROPIC_API_KEY:{' '}
          <Text color={apiKeyPresent ? TUI.primary : TUI.error}>
            {apiKeyPresent ? 'detected' : 'missing — set it before running'}
          </Text>
        </Text>
      </Box>
    </Box>
  );
}
