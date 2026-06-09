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

export interface FaceLandmarks {
  leftEye: [number, number];
  rightEye: [number, number];
  nose: [number, number];
  mouthLeft: [number, number];
  mouthRight: [number, number];
}

export interface FaceAppearance {
  time: number;
  bbox: [number, number, number, number];
  lip_movement: number;
  position: 'left' | 'right' | 'center';
  // Present when MTCNN-based detection ran (useIdentityTracking on). Old Haar
  // path leaves these undefined; downstream code must guard.
  embedding?: number[];
  landmarks?: FaceLandmarks;
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

// A persistent person identity stitched together by clustering face embeddings
// across the whole video. Solves the "same person appears in N separate Haar
// tracks" problem and lets us reject transient ad/poster faces by screen time.
export interface Person {
  personId: string;
  appearances: FaceAppearance[];
  total_screen_time: number;
  first_seen: number;
  last_seen: number;
  // Mean of this person's appearance embeddings — used as the cluster centroid
  // for cross-clip matching and as the comparison anchor in debug-tracking.
  centroid_embedding?: number[];
}

export interface IdentityClusterResult {
  persons: Record<string, Person>;
  cosine_threshold: number;
  min_screen_time_seconds: number;
  // Total faces dropped because their cluster fell under min_screen_time —
  // this is the count we report when the data drives a threshold change.
  filtered_short_lived: number;
}

// Maps a transcript speaker to a tracked entity. When useIdentityTracking is
// on, mapping values are personId strings (from IdentityClusterResult). When
// it's off, mapping values are faceId strings (from FaceDetectionResult).
// Consumers shouldn't care which — both look up via the same key.
export interface SpeakerFaceMapping {
  mapping: Record<string, string>;
  confidence: Record<string, number>;
}

// Per-keyframe debug record written when --debug-tracking is on. Scoped down
// from the larger sidecar that was reverted on 2026-05-18 — just enough to
// pick thresholds from observed value ranges per
// [[shards-no-heuristic-fixes-without-data]].
export interface TrackingDebugEntry {
  time: number;
  speaker: string | null;
  mappedTargetId: string | null;
  pickedId: string | null;
  pickedScore: number;
  runnerUpId: string | null;
  runnerUpScore: number;
  speakerConfidence: number;
  lipMovement: number;
  embeddingDistance: number | null;
  bbox: [number, number, number, number] | null;
}

export interface TrackingDebugRecord {
  clipId: string;
  clipTitle: string;
  videoFormat: 'fullscreen' | 'centered';
  useIdentityTracking: boolean;
  entries: TrackingDebugEntry[];
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
  /**
   * True when at least one chunk failed during analysis. Partial results are
   * still returned (so users see what succeeded) but the resume layer refuses
   * to reuse them — re-running should re-attempt the failed chunks.
   */
  partial?: boolean;
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
  // Present when useIdentityTracking is on. Renderer keys tracking on
  // personId rather than per-frame faceId. Absent → old Haar path.
  personData?: IdentityClusterResult;
  // When true, the renderer writes a <clip>_tracking.json sidecar alongside
  // the mp4. Off by default — controlled by --debug-tracking on shards-cli.
  debugTracking?: boolean;
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
  /**
   * Use MTCNN + embedding-based identity tracking. Default true. Set false to
   * fall back to the old Haar-cascade per-frame pipeline (kept until two
   * confirmed-good real-world clips against the new path).
   */
  useIdentityTracking?: boolean;
  /**
   * Write a <clip>_tracking.json sidecar with per-keyframe scoring. Off by
   * default; used for the data-driven verification required by the
   * no-heuristic-fixes-without-data rule.
   */
  debugTracking?: boolean;
  /**
   * When true, ignore any existing transcript/faces checkpoints in the output
   * dir and recompute from scratch. Default false — resume is automatic when
   * cached checkpoints match the current input + relevant config.
   */
  noResume?: boolean;
  /**
   * Analyze-only mode: transcribe + viral analysis, then write
   * viral_moments.json with timestamps and stop. Skips face detection,
   * identity clustering, speaker mapping, and rendering entirely — for users
   * who cut the clips themselves and only need to know where the moments are.
   */
  analyzeOnly?: boolean;
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
