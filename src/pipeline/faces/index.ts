import {
  FaceDetectionResult,
  SpeakerFaceMapping,
  TranscriptResult,
} from '../../types/index.js';
import { runPythonScript } from '../../utils/python.js';
import path from 'path';
import { writeFile, mkdtemp, unlink, rmdir } from 'fs/promises';
import { tmpdir } from 'os';

export async function detectFaces(
  inputPath: string,
  sampleRate?: number,
  onProgress?: (msg: string) => void
): Promise<FaceDetectionResult> {
  const args: Record<string, string> = { input: inputPath };
  if (sampleRate !== undefined) {
    args['sample-rate'] = String(sampleRate);
  }

  onProgress?.('Detecting faces in video...');

  const result = await runPythonScript<FaceDetectionResult>(
    'detect_faces.py',
    args,
    onProgress
  );

  if (!result.faces || typeof result.faces !== 'object') {
    throw new Error('Invalid face detection result');
  }

  const faceCount = Object.keys(result.faces).length;
  onProgress?.(`Found ${faceCount} face(s) in video`);

  return result;
}

export async function mapSpeakersToFaces(
  transcript: TranscriptResult,
  faceData: FaceDetectionResult,
  onProgress?: (msg: string) => void
): Promise<SpeakerFaceMapping> {
  let tempDir: string | null = null;

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), 'clipper-map-'));
    const transcriptPath = path.join(tempDir, 'transcript.json');
    const facesPath = path.join(tempDir, 'faces.json');

    await Promise.all([
      writeFile(transcriptPath, JSON.stringify(transcript)),
      writeFile(facesPath, JSON.stringify(faceData)),
    ]);

    onProgress?.('Mapping speakers to faces...');

    const result = await runPythonScript<SpeakerFaceMapping>(
      'map_speakers.py',
      { transcript: transcriptPath, faces: facesPath },
      onProgress
    );

    if (!result.mapping || typeof result.mapping !== 'object') {
      throw new Error('Invalid speaker-face mapping result');
    }

    for (const [speaker, face] of Object.entries(result.mapping)) {
      const conf = result.confidence?.[speaker] ?? 0;
      onProgress?.(`  ${speaker} → ${face} (confidence: ${(conf * 100).toFixed(0)}%)`);
    }

    return result;
  } finally {
    if (tempDir) {
      try {
        const files = ['transcript.json', 'faces.json'];
        await Promise.all(files.map((f) => unlink(path.join(tempDir!, f)).catch(() => {})));
        await rmdir(tempDir).catch(() => {});
      } catch { /* cleanup best-effort */ }
    }
  }
}
