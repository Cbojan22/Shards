import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { TUI } from '../theme.js';

interface GuideProps {
  onBack: () => void;
}

const STEPS: Array<{ label: string; lines: string[] }> = [
  {
    label: '1. What this does',
    lines: [
      'SHARDS turns long-form video (podcasts, interviews, talks) into',
      'short-form vertical clips ranked by viral potential. It transcribes,',
      'tracks faces, asks Claude which moments would land best, and renders',
      'each pick as a captioned 9:16 mp4 you can post directly.',
    ],
  },
  {
    label: '2. What you need first',
    lines: [
      '• ffmpeg installed and on your PATH (`brew install ffmpeg`)',
      '• An Anthropic API key exposed as ANTHROPIC_API_KEY',
      '• A long-form video on disk (mp4, mov, etc.)',
      '• On first run, SHARDS will set up a Python venv for Whisper + OpenCV.',
    ],
  },
  {
    label: '3. The flow',
    lines: [
      '> New clip run  —  pick a video, walk through settings, watch it render.',
      '> Edit defaults —  adjust Whisper model, durations, themes, and the',
      '                   default video format without starting a run.',
      'Your latest answers become the new defaults so the next run is faster.',
    ],
  },
  {
    label: '4. Video formats',
    lines: [
      'Fullscreen — the speaker fills the whole 9:16 frame. Use for tight',
      '             talking-head clips where the action is the face.',
      'Centered   — wider crop, scaled into the middle half with black bars',
      '             top and bottom. Use when you need to see hands, props,',
      '             or a wider stage.',
    ],
  },
  {
    label: '5. Caption themes',
    lines: [
      'Six baked-in looks: Golden, Matrix, Cyberpunk, VHS, Mono, Sunset.',
      'Each pairs a font with a colour set; you can preview the swatch in',
      'the wizard before committing.',
    ],
  },
];

// One-screen scrollable-ish guide. Any key returns to the menu.
export function Guide({ onBack }: GuideProps): React.ReactElement {
  useInput((_, key) => {
    if (key.escape || key.return) onBack();
  });

  return (
    <Frame
      title="SHARDS // quick guide"
      subtitle="enter or esc to return to the menu"
    >
      {STEPS.map((step) => (
        <Box key={step.label} flexDirection="column" marginBottom={1}>
          <Text color={TUI.accent} bold>
            {step.label}
          </Text>
          {step.lines.map((line, i) => (
            <Text key={i} color={TUI.fg}>
              {'  '}
              {line}
            </Text>
          ))}
        </Box>
      ))}
      <Text color={TUI.dim}>press enter to go back</Text>
    </Frame>
  );
}
