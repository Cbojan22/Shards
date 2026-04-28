import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { Splash } from './screens/Splash.js';
import { Menu, type MenuChoice } from './screens/Menu.js';
import { Guide } from './screens/Guide.js';
import { Wizard, type WizardAnswers, type WizardMode } from './screens/Wizard.js';
import { Run } from './screens/Run.js';
import { TUI } from './theme.js';
import {
  configPath,
  loadConfig,
  saveConfig,
  type UserConfig,
} from '../utils/config.js';

type Screen =
  | { kind: 'splash' }
  | { kind: 'menu' }
  | { kind: 'guide' }
  | { kind: 'wizard'; mode: WizardMode }
  | { kind: 'run'; answers: WizardAnswers };

interface AppProps {
  initialApiKey: string;
}

export function App({ initialApiKey }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: 'splash' });
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [apiKey, setApiKey] = useState<string>(initialApiKey);
  const [bootError, setBootError] = useState<string | null>(null);

  // Hydrate the saved config once at boot. Errors don't block the splash —
  // we just surface them in the menu so the user can still see the guide.
  useEffect(() => {
    loadConfig()
      .then((c) => {
        setConfig(c);
        if (!apiKey && c.anthropicApiKey) setApiKey(c.anthropicApiKey);
      })
      .catch((e) => {
        setBootError(e instanceof Error ? e.message : String(e));
        setConfig(null);
      });
  }, []);

  const persist = async (next: UserConfig) => {
    setConfig(next);
    try {
      await saveConfig(next);
    } catch (e) {
      setBootError(`Could not save config: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleMenu = (choice: MenuChoice) => {
    switch (choice) {
      case 'run':      return setScreen({ kind: 'wizard', mode: 'run' });
      case 'defaults': return setScreen({ kind: 'wizard', mode: 'defaults' });
      case 'guide':    return setScreen({ kind: 'guide' });
      case 'quit':     return exit();
    }
  };

  if (bootError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={TUI.error}>SHARDS could not start:</Text>
        <Text color={TUI.fg}>{bootError}</Text>
      </Box>
    );
  }

  if (!config) {
    return (
      <Box padding={1}>
        <Text color={TUI.dim}>loading config…</Text>
      </Box>
    );
  }

  switch (screen.kind) {
    case 'splash':
      return <Splash onContinue={() => setScreen({ kind: 'menu' })} />;

    case 'menu':
      return (
        <Menu
          onSelect={handleMenu}
          configPath={configPath()}
          apiKeyPresent={Boolean(apiKey)}
        />
      );

    case 'guide':
      return <Guide onBack={() => setScreen({ kind: 'menu' })} />;

    case 'wizard': {
      const initial = wizardInitialFromConfig(config);
      return (
        <Wizard
          mode={screen.mode}
          initial={initial}
          onCancel={() => setScreen({ kind: 'menu' })}
          onSubmit={async (answers) => {
            // Always persist the latest answers so they become the new
            // defaults — even when the user aborts the run later.
            const merged = mergeAnswersIntoConfig(config, answers);
            await persist(merged);

            if (screen.mode === 'defaults') {
              setScreen({ kind: 'menu' });
            } else {
              setScreen({ kind: 'run', answers });
            }
          }}
        />
      );
    }

    case 'run':
      return (
        <Run
          answers={screen.answers}
          baseConfig={config}
          apiKey={apiKey}
          onDone={() => setScreen({ kind: 'menu' })}
        />
      );
  }
}

function wizardInitialFromConfig(config: UserConfig): WizardAnswers {
  return {
    inputPath: '',
    outputDir: '',
    whisperModel: config.whisperModel,
    language: config.language,
    minClipDuration: config.minClipDuration,
    maxClipDuration: config.maxClipDuration,
    maxClips: config.maxClips,
    quality: config.quality,
    format: config.format,
    videoFormat: config.videoFormat,
    withCaptions: config.withCaptions,
    captionTheme: config.captionTheme,
    captionPosition: config.captionStyle.position,
    captionWordsPerGroup: config.captionStyle.wordsPerGroup,
    captionFontSize: config.captionStyle.fontSize,
  };
}

function mergeAnswersIntoConfig(config: UserConfig, answers: WizardAnswers): UserConfig {
  return {
    ...config,
    whisperModel: answers.whisperModel,
    minClipDuration: answers.minClipDuration,
    maxClipDuration: answers.maxClipDuration,
    maxClips: answers.maxClips,
    quality: answers.quality,
    format: answers.format,
    videoFormat: answers.videoFormat,
    withCaptions: answers.withCaptions,
    captionTheme: answers.captionTheme,
    captionStyle: {
      ...config.captionStyle,
      position: answers.captionPosition,
      wordsPerGroup: answers.captionWordsPerGroup,
      fontSize: answers.captionFontSize,
    },
  };
}
