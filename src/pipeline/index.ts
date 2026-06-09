import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import {
  PipelineConfig,
  ViralAnalysisResult,
  ExportOptions,
  IdentityClusterResult,
  SpeakerFaceMapping,
} from '../types/index.js';
import { getVideoMetadata, VideoMetadata } from '../utils/ffmpeg.js';
import { transcribeVideo } from './transcribe/index.js';
import { detectFaces, clusterIdentities, mapSpeakersToFaces } from './faces/index.js';
import { analyzeForViralClips } from './analyze/index.js';
import { renderAllClips } from './render/index.js';
import { DEFAULT_CAPTION_STYLE } from './captions/index.js';
import {
  checkpointDirFor,
  loadAnalyzeCheckpoint,
  loadFacesCheckpoint,
  loadTranscriptCheckpoint,
  saveAnalyzeCheckpoint,
  saveFacesCheckpoint,
  saveTranscriptCheckpoint,
  type AnalyzeCheckpointConfig,
} from './checkpoints.js';

// The analyze model the pipeline pins to. Keep in sync with the default in
// src/pipeline/analyze/index.ts — if you change one, change the other, and
// existing analyze checkpoints will auto-invalidate via the cache key.
const ANALYZE_MODEL = 'claude-sonnet-4-6';

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

  // Stage 2 & 3: Transcription and face detection (can run in parallel).
  // Both stages checkpoint to <outputDir>/.shards/ so a later-stage failure
  // (analyze API error, render crash) doesn't force a full re-run.
  // Analyze-only mode skips face detection entirely — the user cuts clips
  // manually, so face/identity data is never needed.
  const analyzeOnly = config.analyzeOnly === true;
  const useIdentityTracking = config.useIdentityTracking !== false;
  const detector: 'mtcnn' | 'haar' = useIdentityTracking ? 'mtcnn' : 'haar';

  const cachedTranscript = config.noResume
    ? null
    : await loadTranscriptCheckpoint(
        config.outputDir, config.inputPath, config.whisperModel, config.language,
      );
  const cachedFaces = analyzeOnly || config.noResume
    ? null
    : await loadFacesCheckpoint(
        config.outputDir, config.inputPath, config.faceSampleRate, detector,
      );

  if (cachedTranscript) {
    progress(
      'transcribe',
      `Resumed from cached transcript (${cachedTranscript.segments.length} segments)`,
    );
  }
  if (cachedFaces) {
    progress(
      'faces',
      `Resumed from cached face data (${Object.keys(cachedFaces.faces).length} tracks)`,
    );
  }
  if (cachedTranscript || cachedFaces) {
    progress(
      'init',
      `Delete ${checkpointDirFor(config.outputDir)} to force a clean re-run`,
    );
  }

  if (analyzeOnly) {
    progress('analyze', cachedTranscript
      ? 'Analyze-only mode — face detection skipped.'
      : 'Analyze-only mode — starting transcription (face detection skipped)...');
  } else if (!cachedTranscript && !cachedFaces) {
    progress('analyze', 'Starting transcription and face detection...');
  } else if (!cachedTranscript) {
    progress('analyze', 'Resuming — running transcription only...');
  } else if (!cachedFaces) {
    progress('analyze', 'Resuming — running face detection only...');
  }

  const [transcript, faceData] = await Promise.all([
    cachedTranscript
      ? Promise.resolve(cachedTranscript)
      : transcribeVideo(
          config.inputPath,
          { model: config.whisperModel, language: config.language },
          (msg) => progress('transcribe', msg)
        ),
    analyzeOnly
      ? Promise.resolve(null)
      : cachedFaces
        ? Promise.resolve(cachedFaces)
        : detectFaces(
            config.inputPath,
            config.faceSampleRate,
            detector,
            (msg) => progress('faces', msg)
          ),
  ]);

  // Persist only stages we just computed; cached results already match disk.
  const checkpointWrites: Promise<void>[] = [];
  if (!cachedTranscript) {
    checkpointWrites.push(
      saveTranscriptCheckpoint(
        config.outputDir, config.inputPath, config.whisperModel, config.language, transcript,
      ),
    );
  }
  if (!cachedFaces && faceData) {
    checkpointWrites.push(
      saveFacesCheckpoint(
        config.outputDir, config.inputPath, config.faceSampleRate, detector, faceData,
      ),
    );
  }
  if (checkpointWrites.length > 0) {
    await Promise.all(checkpointWrites);
    progress('init', `Checkpointed to ${checkpointDirFor(config.outputDir)}`);
  }

  // Stages 3.5 & 4 only matter for rendering — analyze-only mode never
  // touches faces, so both are skipped along with detection above.
  let personData: IdentityClusterResult | undefined;
  let speakerFaceMap: SpeakerFaceMapping | null = null;
  if (faceData) {
    // Stage 3.5: Cluster face embeddings into persistent person identities.
    // Only runs in identity mode — Haar fallback skips this and maps speakers
    // straight to per-frame face tracks like it did before.
    if (useIdentityTracking) {
      progress('mapping', 'Clustering face identities...');
      personData = await clusterIdentities(
        faceData,
        undefined,
        (msg) => progress('mapping', msg),
      );
    }

    // Stage 4: Map speakers to faces (or persons, in identity mode)
    progress('mapping', useIdentityTracking
      ? 'Correlating speakers with persons...'
      : 'Correlating speakers with detected faces...');
    speakerFaceMap = await mapSpeakersToFaces(
      transcript,
      faceData,
      personData,
      (msg) => progress('mapping', msg)
    );
  }

  // Stage 5: AI viral clip analysis. Cached separately from transcript/faces
  // because it's the only stage that costs Anthropic API tokens — a successful
  // analyze + render-stage crash should NOT re-bill Claude on the next run.
  // analyzeConfig captures every input that changes the model's output; if any
  // changes, the cache invalidates and we re-call. Partial results are still
  // returned to the caller but the load-side refuses to restore them.
  const analyzeConfig: AnalyzeCheckpointConfig = {
    maxClips: config.maxClips,
    minDuration: config.minClipDuration,
    maxDuration: config.maxClipDuration,
    endPaddingSec: config.endPaddingSec ?? 0.6,
    softCapRatio: config.softCapRatio ?? 1.5,
    strictCompleteness: config.strictCompleteness ?? true,
    model: ANALYZE_MODEL,
  };

  const cachedAnalyze = config.noResume
    ? null
    : await loadAnalyzeCheckpoint(
        config.outputDir,
        config.inputPath,
        config.whisperModel,
        config.language,
        analyzeConfig,
      );

  let viralResult: ViralAnalysisResult;
  if (cachedAnalyze) {
    progress(
      'viral',
      `Resumed from cached analyze (${cachedAnalyze.clips.length} clips, no API call)`,
    );
    viralResult = cachedAnalyze;
  } else {
    progress('viral', 'Analyzing transcript for viral moments...');
    viralResult = await analyzeForViralClips(
      transcript,
      {
        apiKey: config.anthropicApiKey,
        maxClips: config.maxClips,
        minDuration: config.minClipDuration,
        maxDuration: config.maxClipDuration,
        model: ANALYZE_MODEL,
        endPaddingSec: config.endPaddingSec,
        softCapRatio: config.softCapRatio,
        strictCompleteness: config.strictCompleteness,
      },
      (msg) => progress('viral', msg)
    );

    // Persist only when we actually got something usable. The load-side already
    // refuses partial caches, so writing them is harmless but pointless.
    if (viralResult.clips.length > 0 && !viralResult.partial) {
      await saveAnalyzeCheckpoint(
        config.outputDir,
        config.inputPath,
        config.whisperModel,
        config.language,
        analyzeConfig,
        viralResult,
      );
      progress('viral', `Checkpointed analyze result to ${checkpointDirFor(config.outputDir)}`);
    }
  }

  // Analyze-only mode stops here: write the timestamps report and return.
  // The report always lands in the output dir (even when zero clips survive
  // the filters) so the user has a definitive artifact per run.
  if (analyzeOnly) {
    const reportPath = path.join(config.outputDir, 'viral_moments.json');
    const report = {
      mode: 'analyze-only',
      source: {
        path: config.inputPath,
        duration: metadata.duration,
        resolution: `${metadata.width}x${metadata.height}`,
      },
      clips: viralResult.clips.map((clip) => ({
        ...clip,
        startTimecode: formatTimecode(clip.start),
        endTimecode: formatTimecode(clip.end),
      })),
      speakers: transcript.speakers,
      generatedAt: new Date().toISOString(),
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    progress('export', `Viral moments saved: ${reportPath}`);
    progress('complete', viralResult.clips.length === 0
      ? `No viral clips identified. Report written to ${reportPath}`
      : `Done! ${viralResult.clips.length} viral moments written to ${reportPath}`);
    return {
      outputDir: config.outputDir,
      clips: viralResult,
      renderedPaths: [],
      metadata,
    };
  }

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

  // faceData/speakerFaceMap are only null in analyze-only mode, which
  // returned above — assert non-null for the render path.
  const renderedPaths = await renderAllClips(
    viralResult.clips,
    config.inputPath,
    transcript,
    faceData!,
    speakerFaceMap!,
    exportOptions,
    (msg) => progress('render', msg),
    personData,
    config.debugTracking === true,
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

// "HH:MM:SS.s" — matches the timecode fields most editors accept, so the
// analyze-only report can be used for manual cutting without math.
function formatTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
