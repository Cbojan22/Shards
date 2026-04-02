import { TranscriptResult } from '../../types/index.js';
import { runPythonScript } from '../../utils/python.js';

export async function transcribeVideo(
  inputPath: string,
  options: { model?: string; language?: string } = {},
  onProgress?: (msg: string) => void
): Promise<TranscriptResult> {
  const args: Record<string, string> = {
    input: inputPath,
  };

  if (options.model) args.model = options.model;
  if (options.language) args.language = options.language;

  onProgress?.('Starting transcription with Whisper...');

  const result = await runPythonScript<TranscriptResult>(
    'transcribe.py',
    args,
    onProgress
  );

  if (!result.segments || !Array.isArray(result.segments)) {
    throw new Error('Invalid transcription result: missing segments array');
  }

  if (!result.speakers || !Array.isArray(result.speakers)) {
    result.speakers = [...new Set(result.segments.map((s) => s.speaker))];
  }

  onProgress?.(
    `Transcription complete: ${result.segments.length} segments, ` +
    `${result.speakers.length} speakers, ${result.duration?.toFixed(1)}s`
  );

  return result;
}
