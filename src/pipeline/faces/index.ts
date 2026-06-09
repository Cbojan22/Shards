import {
  FaceDetectionResult,
  IdentityClusterResult,
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
  detector: 'mtcnn' | 'haar' = 'mtcnn',
  onProgress?: (msg: string) => void
): Promise<FaceDetectionResult> {
  const args: Record<string, string> = { input: inputPath, detector };
  if (sampleRate !== undefined) {
    args['sample-rate'] = String(sampleRate);
  }

  onProgress?.(`Detecting faces (${detector})...`);

  const result = await runPythonScript<FaceDetectionResult>(
    'detect_faces.py',
    args,
    onProgress
  );

  if (!result.faces || typeof result.faces !== 'object') {
    throw new Error('Invalid face detection result');
  }

  const faceCount = Object.keys(result.faces).length;
  onProgress?.(`Found ${faceCount} face track(s)`);

  return result;
}

/**
 * Cluster per-frame face appearances into persistent person identities by
 * cosine-clustering their embeddings. Solves the cross-frame identity gap
 * that the position-only Haar tracker leaves: same person across multiple
 * tracks → one personId; ad / poster / B-roll faces → dropped by the
 * minScreenTime filter rather than scored against speakers.
 */
export async function clusterIdentities(
  faceData: FaceDetectionResult,
  options?: { cosineThreshold?: number; minScreenTime?: number },
  onProgress?: (msg: string) => void,
): Promise<IdentityClusterResult> {
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shards-cluster-'));
    const facesPath = path.join(tempDir, 'faces.json');
    await writeFile(facesPath, JSON.stringify(faceData));

    const args: Record<string, string> = { faces: facesPath };
    if (options?.cosineThreshold !== undefined) {
      args['cosine-threshold'] = String(options.cosineThreshold);
    }
    if (options?.minScreenTime !== undefined) {
      args['min-screen-time'] = String(options.minScreenTime);
    }

    onProgress?.('Clustering face identities...');
    const result = await runPythonScript<IdentityClusterResult>(
      'cluster_identities.py',
      args,
      onProgress,
    );

    if (!result.persons || typeof result.persons !== 'object') {
      throw new Error('Invalid identity cluster result');
    }
    onProgress?.(
      `${Object.keys(result.persons).length} person(s) identified ` +
      `(${result.filtered_short_lived} short-lived clusters dropped)`,
    );
    return result;
  } finally {
    if (tempDir) {
      try {
        await unlink(path.join(tempDir, 'faces.json')).catch(() => {});
        await rmdir(tempDir).catch(() => {});
      } catch { /* best-effort */ }
    }
  }
}

export async function mapSpeakersToFaces(
  transcript: TranscriptResult,
  faceData: FaceDetectionResult,
  personData?: IdentityClusterResult,
  onProgress?: (msg: string) => void
): Promise<SpeakerFaceMapping> {
  let tempDir: string | null = null;

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shards-map-'));
    const transcriptPath = path.join(tempDir, 'transcript.json');
    const facesPath = path.join(tempDir, 'faces.json');
    const personsPath = path.join(tempDir, 'persons.json');

    const writes: Promise<void>[] = [
      writeFile(transcriptPath, JSON.stringify(transcript)),
    ];
    if (personData) {
      writes.push(writeFile(personsPath, JSON.stringify(personData)));
    } else {
      writes.push(writeFile(facesPath, JSON.stringify(faceData)));
    }
    await Promise.all(writes);

    onProgress?.(personData ? 'Mapping speakers to persons...' : 'Mapping speakers to faces...');

    const args: Record<string, string> = { transcript: transcriptPath };
    if (personData) {
      args.persons = personsPath;
    } else {
      args.faces = facesPath;
    }

    const result = await runPythonScript<SpeakerFaceMapping>(
      'map_speakers.py',
      args,
      onProgress,
    );

    if (!result.mapping || typeof result.mapping !== 'object') {
      throw new Error('Invalid speaker mapping result');
    }

    for (const [speaker, entity] of Object.entries(result.mapping)) {
      const conf = result.confidence?.[speaker] ?? 0;
      onProgress?.(`  ${speaker} → ${entity} (confidence: ${(conf * 100).toFixed(0)}%)`);
    }

    return result;
  } finally {
    if (tempDir) {
      try {
        const files = ['transcript.json', 'faces.json', 'persons.json'];
        await Promise.all(files.map((f) => unlink(path.join(tempDir!, f)).catch(() => {})));
        await rmdir(tempDir).catch(() => {});
      } catch { /* cleanup best-effort */ }
    }
  }
}
