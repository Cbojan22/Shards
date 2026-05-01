import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import {
  PipelineConfig,
  ViralAnalysisResult,
  ExportOptions,
} from '../types/index.js';
import { getVideoMetadata, VideoMetadata } from '../utils/ffmpeg.js';
import { transcribeVideo } from './transcribe/index.js';
import { detectFaces, mapSpeakersToFaces } from './faces/index.js';
import { analyzeForViralClips } from './analyze/index.js';
import { renderAllClips } from './render/index.js';
import { DEFAULT_CAPTION_STYLE } from './captions/index.js';

export interface PipelineResult {
  outputDir: string;
  clips: ViralAnalysisResult;
  renderedPaths: string[];
  metadata: VideoMetadata;
}

export async function runPipeline(
  config: PipelineConfig,
  onProgress?: (stage: string, message: string) => void
): Promise<PipelineResult> {
  const progress = (stage: string, msg: string) => {
    onProgress?.(stage, msg);
  };

  // Stage 1: Validate input and get metadata
  progress('init', 'Analyzing input video...');
  const metadata = await getVideoMetadata(config.inputPath);
  progress('init', `Video: ${metadata.width}x${metadata.height}, ${metadata.fps}fps, ${formatDuration(metadata.duration)}`);

  // Create output directory
  await mkdir(config.outputDir, { recursive: true });

  // Stage 2 & 3: Transcription and face detection (can run in parallel)
  progress('analyze', 'Starting transcription and face detection...');

  const [transcript, faceData] = await Promise.all([
    transcribeVideo(
      config.inputPath,
      { model: config.whisperModel, language: config.language },
      (msg) => progress('transcribe', msg)
    ),
    detectFaces(
      config.inputPath,
      config.faceSampleRate,
      (msg) => progress('faces', msg)
    ),
  ]);

  // Stage 4: Map speakers to faces
  progress('mapping', 'Correlating speakers with detected faces...');
  const speakerFaceMap = await mapSpeakersToFaces(
    transcript,
    faceData,
    (msg) => progress('mapping', msg)
  );

  // Stage 5: AI viral clip analysis
  progress('viral', 'Analyzing transcript for viral moments...');
  const viralResult = await analyzeForViralClips(
    transcript,
    {
      apiKey: config.anthropicApiKey,
      maxClips: config.maxClips,
      minDuration: config.minClipDuration,
      maxDuration: config.maxClipDuration,
      endPaddingSec: config.endPaddingSec,
      softCapRatio: config.softCapRatio,
      strictCompleteness: config.strictCompleteness,
    },
    (msg) => progress('viral', msg)
  );

  if (viralResult.clips.length === 0) {
    progress('complete', 'No viral clips identified.');
    return {
      outputDir: config.outputDir,
      clips: viralResult,
      renderedPaths: [],
      metadata,
    };
  }

  // Stage 6: Render all clips
  progress('render', `Rendering ${viralResult.clips.length} clips...`);
  const exportOptions: ExportOptions = config.exportOptions || {
    outputDir: config.outputDir,
    format: 'mp4',
    quality: 'high',
    resolution: { width: 1080, height: 1920 },
    videoFormat: 'fullscreen',
    withCaptions: true,
    captionStyle: DEFAULT_CAPTION_STYLE,
    includeMetadata: true,
  };
  exportOptions.outputDir = config.outputDir;

  const renderedPaths = await renderAllClips(
    viralResult.clips,
    config.inputPath,
    transcript,
    faceData,
    speakerFaceMap,
    exportOptions,
    (msg) => progress('render', msg)
  );

  // Stage 7: Save metadata
  if (exportOptions.includeMetadata) {
    const metadataPath = path.join(config.outputDir, 'clips_metadata.json');
    const metadataOutput = {
      source: {
        path: config.inputPath,
        duration: metadata.duration,
        resolution: `${metadata.width}x${metadata.height}`,
      },
      clips: viralResult.clips.map((clip, i) => ({
        ...clip,
        outputFile: renderedPaths[i] ? path.basename(renderedPaths[i]) : null,
      })),
      speakers: transcript.speakers,
      speakerFaceMapping: speakerFaceMap,
      exportOptions: {
        format: exportOptions.format,
        quality: exportOptions.quality,
        resolution: exportOptions.resolution,
        withCaptions: exportOptions.withCaptions,
      },
      generatedAt: new Date().toISOString(),
    };
    await writeFile(metadataPath, JSON.stringify(metadataOutput, null, 2));
    progress('export', `Metadata saved: ${metadataPath}`);
  }

  progress('complete', `Done! ${renderedPaths.length} clips exported to ${config.outputDir}`);

  return {
    outputDir: config.outputDir,
    clips: viralResult,
    renderedPaths,
    metadata,
  };
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
