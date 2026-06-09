import path from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import type {
  FaceDetectionResult,
  TranscriptResult,
  ViralAnalysisResult,
} from '../types/index.js';

// Bump when the on-disk shape changes in a way old caches can't be trusted for.
const CHECKPOINT_VERSION = 1;
// Bump independently when the analyze prompt, chunk size, or default model
// change — those don't show up in any cached field but they do change the
// output, so old analyze caches would silently mislead.
const ANALYZE_PROMPT_VERSION = 1;
const CHECKPOINT_DIR = '.shards';

interface InputFingerprint {
  path: string;
  mtimeMs: number;
  size: number;
}

interface TranscriptCheckpoint {
  version: number;
  input: InputFingerprint;
  config: { whisperModel: string; language: string };
  result: TranscriptResult;
}

interface FacesCheckpoint {
  version: number;
  input: InputFingerprint;
  config: { faceSampleRate: number; detector: 'mtcnn' | 'haar' };
  result: FaceDetectionResult;
}

function checkpointDir(outputDir: string): string {
  return path.join(outputDir, CHECKPOINT_DIR);
}

export function checkpointDirFor(outputDir: string): string {
  return checkpointDir(outputDir);
}

async function fingerprintInput(inputPath: string): Promise<InputFingerprint> {
  const s = await stat(inputPath);
  return { path: path.resolve(inputPath), mtimeMs: s.mtimeMs, size: s.size };
}

function fingerprintsMatch(a: InputFingerprint, b: InputFingerprint): boolean {
  // mtimeMs is a float on macOS HFS+/APFS; sub-ms slop avoids spurious cache misses.
  return a.path === b.path && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data));
}

export async function loadTranscriptCheckpoint(
  outputDir: string,
  inputPath: string,
  whisperModel: string,
  language: string,
): Promise<TranscriptResult | null> {
  const ckpt = await readJson<TranscriptCheckpoint>(
    path.join(checkpointDir(outputDir), 'transcript.json'),
  );
  if (!ckpt || ckpt.version !== CHECKPOINT_VERSION) return null;

  const current = await fingerprintInput(inputPath).catch(() => null);
  if (!current || !fingerprintsMatch(ckpt.input, current)) return null;

  if (ckpt.config.whisperModel !== whisperModel) return null;
  if (ckpt.config.language !== language) return null;

  return ckpt.result;
}

export async function saveTranscriptCheckpoint(
  outputDir: string,
  inputPath: string,
  whisperModel: string,
  language: string,
  result: TranscriptResult,
): Promise<void> {
  const ckpt: TranscriptCheckpoint = {
    version: CHECKPOINT_VERSION,
    input: await fingerprintInput(inputPath),
    config: { whisperModel, language },
    result,
  };
  await writeJson(path.join(checkpointDir(outputDir), 'transcript.json'), ckpt);
}

export async function loadFacesCheckpoint(
  outputDir: string,
  inputPath: string,
  faceSampleRate: number,
  detector: 'mtcnn' | 'haar',
): Promise<FaceDetectionResult | null> {
  const ckpt = await readJson<FacesCheckpoint>(
    path.join(checkpointDir(outputDir), 'faces.json'),
  );
  if (!ckpt || ckpt.version !== CHECKPOINT_VERSION) return null;

  const current = await fingerprintInput(inputPath).catch(() => null);
  if (!current || !fingerprintsMatch(ckpt.input, current)) return null;

  if (ckpt.config.faceSampleRate !== faceSampleRate) return null;
  if (ckpt.config.detector !== detector) return null;

  return ckpt.result;
}

export async function saveFacesCheckpoint(
  outputDir: string,
  inputPath: string,
  faceSampleRate: number,
  detector: 'mtcnn' | 'haar',
  result: FaceDetectionResult,
): Promise<void> {
  const ckpt: FacesCheckpoint = {
    version: CHECKPOINT_VERSION,
    input: await fingerprintInput(inputPath),
    config: { faceSampleRate, detector },
    result,
  };
  await writeJson(path.join(checkpointDir(outputDir), 'faces.json'), ckpt);
}

export interface AnalyzeCheckpointConfig {
  maxClips: number;
  minDuration: number;
  maxDuration: number;
  endPaddingSec: number;
  softCapRatio: number;
  strictCompleteness: boolean;
  model: string;
}

interface AnalyzeCheckpoint {
  version: number;
  promptVersion: number;
  input: InputFingerprint;
  // Mirrors the transcript checkpoint's config. If transcript would
  // re-compute, analyze must re-compute too — it ate that transcript.
  transcriptConfig: { whisperModel: string; language: string };
  analyzeConfig: AnalyzeCheckpointConfig;
  result: ViralAnalysisResult;
}

function analyzeConfigsMatch(
  a: AnalyzeCheckpointConfig,
  b: AnalyzeCheckpointConfig,
): boolean {
  return (
    a.maxClips === b.maxClips &&
    a.minDuration === b.minDuration &&
    a.maxDuration === b.maxDuration &&
    a.endPaddingSec === b.endPaddingSec &&
    a.softCapRatio === b.softCapRatio &&
    a.strictCompleteness === b.strictCompleteness &&
    a.model === b.model
  );
}

export async function loadAnalyzeCheckpoint(
  outputDir: string,
  inputPath: string,
  whisperModel: string,
  language: string,
  analyzeConfig: AnalyzeCheckpointConfig,
): Promise<ViralAnalysisResult | null> {
  const ckpt = await readJson<AnalyzeCheckpoint>(
    path.join(checkpointDir(outputDir), 'analyze.json'),
  );
  if (!ckpt || ckpt.version !== CHECKPOINT_VERSION) return null;
  if (ckpt.promptVersion !== ANALYZE_PROMPT_VERSION) return null;

  const current = await fingerprintInput(inputPath).catch(() => null);
  if (!current || !fingerprintsMatch(ckpt.input, current)) return null;

  if (ckpt.transcriptConfig.whisperModel !== whisperModel) return null;
  if (ckpt.transcriptConfig.language !== language) return null;

  if (!analyzeConfigsMatch(ckpt.analyzeConfig, analyzeConfig)) return null;

  // Refuse to restore partial runs — the user should re-attempt failed chunks
  // rather than silently inheriting a degraded result.
  if (ckpt.result.partial) return null;

  return ckpt.result;
}

export async function saveAnalyzeCheckpoint(
  outputDir: string,
  inputPath: string,
  whisperModel: string,
  language: string,
  analyzeConfig: AnalyzeCheckpointConfig,
  result: ViralAnalysisResult,
): Promise<void> {
  const ckpt: AnalyzeCheckpoint = {
    version: CHECKPOINT_VERSION,
    promptVersion: ANALYZE_PROMPT_VERSION,
    input: await fingerprintInput(inputPath),
    transcriptConfig: { whisperModel, language },
    analyzeConfig,
    result,
  };
  await writeJson(path.join(checkpointDir(outputDir), 'analyze.json'), ckpt);
}
