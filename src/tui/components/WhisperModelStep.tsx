import React from 'react';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-select-input ships its own loose types
import SelectInput from 'ink-select-input';
import { Frame } from './Frame.js';

const MODEL_ITEMS = [
  { label: 'tiny    — fastest, lowest quality',     value: 'tiny' },
  { label: 'base    — quick, decent accuracy',      value: 'base' },
  { label: 'small   — balanced (recommended)',      value: 'small' },
  { label: 'medium  — slower, sharper transcripts', value: 'medium' },
  { label: 'large   — slowest, most accurate',      value: 'large' },
];

/**
 * Picker items, keeping a custom saved model (e.g. `config --model large-v3`)
 * selectable instead of silently swapping it for a stock size.
 */
export function whisperModelItems(current: string): Array<{ label: string; value: string }> {
  if (!current || MODEL_ITEMS.some((i) => i.value === current)) return MODEL_ITEMS;
  return [{ label: `${current.padEnd(7)} — your saved model`, value: current }, ...MODEL_ITEMS];
}

/** Whisper model step shared by the clip-run and caption-a-clip wizards. */
export function WhisperModelStep({ value, onSelect }: {
  value: string;
  onSelect: (model: string) => void;
}): React.ReactElement {
  const items = whisperModelItems(value);
  const initial = items.findIndex((i) => i.value === value);
  const smallIndex = items.findIndex((i) => i.value === 'small');
  return (
    <Frame title="whisper model" subtitle="local transcription engine — bigger = slower + better">
      <SelectInput
        items={items}
        initialIndex={initial >= 0 ? initial : smallIndex}
        onSelect={(item: { value: string }) => onSelect(item.value)}
      />
    </Frame>
  );
}
