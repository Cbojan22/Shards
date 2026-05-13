export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
  words: WordTimestamp[];
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  speakers: string[];
  language: string;
  duration: number;
}

export interface FaceAppearance {
  time: number;
  bbox: [number, number, number, number];
  lip_movement: number;
  position: 'left' | 'right' | 'center';
}

export interface FaceData {
  appearances: FaceAppearance[];
}

export interface FaceDetectionResult {
  fps: number;
  width: number;
  height: number;
  sample_rate: number;
  faces: Record<string, FaceData>;
  frame_count: number;
  duration: number;
}

export interface SpeakerFaceMapping {
  mapping: Record<string, string>;
  confidence: Record<string, number>;
}

export interface ViralClip {
  id: string;
  title: string;
  start: number;
  end: number;
  duration: number;
  viralScore: number;
  category: string;
  reason: string;
  transcript: string;
  speakers: string[];
  keywords: string[];
}

export interface ViralAnalysisResult {
  clips: ViralClip[];
  totalAnalyzed: number;
  videoTitle: string;
}

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  primaryColor: string;
  highlightColor: string;
  accentColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadowColor: string;
  position: 'bottom' | 'center' | 'top';
  wordsPerGroup: number;
  bold: boolean;
}

export interface ExportOptions {
  outputDir: string;
  format: 'mp4' | 'mov' | 'webm';
  quality: 'high' | 'medium' | 'low';
  resolution: { width: number; height: number };
  // 'fullscreen' fills the 9:16 frame edge-to-edge (current default).
  // 'centered' shows a wider crop scaled into the middle half, with equal
  // black bars on top and bottom — useful when the action needs more
  // horizontal context than a pure 9:16 close-up gives.
  videoFormat: 'fullscreen' | 'centered';
  withCaptions: boolean;
  captionStyle: CaptionStyle;
  includeMetadata: boolean;
}

export interface ClipRenderJob {
  clip: ViralClip;
  inputPath: string;
  outputPath: string;
  exportOptions: ExportOptions;
  speakerFaceMap: SpeakerFaceMapping;
  faceData: FaceDetectionResult;
  transcript: TranscriptResult;
}

export interface PipelineConfig {
  inputPath: string;
  outputDir: string;
  whisperModel: string;
  language: string;
  minClipDuration: number;
  maxClipDuration: number;
  maxClips: number;
  faceSampleRate: number;
  anthropicApiKey: string;
  exportOptions: ExportOptions;
  /** Seconds of breathing room added after each clip's snapped ending. Default 0.6. */
  endPaddingSec?: number;
  /** Hard ceiling = maxClipDuration * softCapRatio. Default 1.5. */
  softCapRatio?: number;
  /** When true, drop clips Claude flagged as incomplete or trail-off endings. Default true. */
  strictCompleteness?: boolean;
}

export interface PipelineProgress {
  stage: string;
  progress: number;
  message: string;
}

/**
 * Inputs for the caption-only flow. Used by both the CLI subcommand and the
 * TUI's caption-only run screen. Captures everything needed to transcribe an
 * already-finished short-form clip and burn captions onto it — no Anthropic
 * API, no face detection, no reframing.
 */
export interface CaptionOnlyOptions {
  inputPath: string;
  outputPath: string;
  whisperModel: string;
  language: string;
  quality: 'high' | 'medium' | 'low';
  captionStyle: CaptionStyle;
}
