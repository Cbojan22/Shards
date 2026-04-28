import Anthropic from '@anthropic-ai/sdk';
import { TranscriptResult, ViralClip, ViralAnalysisResult } from '../../types/index.js';

interface AnalyzeOptions {
  apiKey: string;
  maxClips?: number;
  minDuration?: number;
  maxDuration?: number;
  model?: string;
}

const SYSTEM_PROMPT = `You are an expert viral content strategist who has studied thousands of viral short-form videos on TikTok, Instagram Reels, and YouTube Shorts. You understand what makes content go viral: emotional hooks, controversial opinions, relatable moments, storytelling, humor, and surprising insights.

Your job is to analyze a podcast/interview transcript and identify the moments that would make the best short-form viral clips. You have an exceptional eye for content that will generate engagement, shares, and comments.

When evaluating clips, consider:
- HOOK STRENGTH: Does the first 3 seconds grab attention? Would someone stop scrolling?
- EMOTIONAL INTENSITY: Does it evoke strong feelings (surprise, anger, laughter, inspiration)?
- SHAREABILITY: Would someone send this to a friend or repost it?
- QUOTABILITY: Are there memorable one-liners or phrases?
- CONTROVERSY/DEBATE: Does it present a strong opinion people will argue about?
- RELATABILITY: Will viewers see themselves in this moment?
- STORYTELLING: Is there a narrative arc, even in 30-60 seconds?
- SURPRISE FACTOR: Is there an unexpected twist, revelation, or counterintuitive insight?
- COMPLETENESS: Does the clip make sense on its own without needing the full context?`;

export async function analyzeForViralClips(
  transcript: TranscriptResult,
  options: AnalyzeOptions,
  onProgress?: (msg: string) => void
): Promise<ViralAnalysisResult> {
  const {
    apiKey,
    maxClips = 20,
    minDuration = 15,
    maxDuration = 180,
    model = 'claude-sonnet-4-6',
  } = options;

  const client = new Anthropic({ apiKey });

  onProgress?.('Formatting transcript for analysis...');
  const formattedTranscript = formatTranscript(transcript);

  onProgress?.('Analyzing transcript for viral moments...');

  const chunks = chunkTranscript(formattedTranscript, transcript, 80000);
  const allRawClips: RawClipSuggestion[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) {
      onProgress?.(`Analyzing chunk ${i + 1}/${chunks.length}...`);
    }

    const rawClips = await analyzeChunk(
      client, model, chunks[i], minDuration, maxDuration, maxClips
    );
    allRawClips.push(...rawClips);
  }

  onProgress?.(`Found ${allRawClips.length} potential clips, filtering...`);

  const clips = postProcess(allRawClips, transcript, maxClips, minDuration, maxDuration);

  onProgress?.(`Final selection: ${clips.length} viral clips`);

  return {
    clips,
    totalAnalyzed: transcript.segments.length,
    videoTitle: inferTitle(transcript),
  };
}

interface RawClipSuggestion {
  title: string;
  start: number;
  end: number;
  viral_score: number;
  category: string;
  reason: string;
  keywords: string[];
}

async function analyzeChunk(
  client: Anthropic,
  model: string,
  chunk: string,
  minDuration: number,
  maxDuration: number,
  maxClips: number
): Promise<RawClipSuggestion[]> {
  // Static across every chunk in a run — cacheable.
  const userPromptPrefix = `Analyze this transcript and identify up to ${maxClips} moments that would make viral short-form video clips.

REQUIREMENTS:
- Each clip MUST be ${minDuration}-${maxDuration} seconds long (end - start >= ${minDuration})
- Use the exact second timestamps from the transcript (the numbers before "s" in brackets)
- Clips must start at the beginning of a sentence and end at the end of a complete thought
- No overlapping clips
- Score each clip 0-100 on viral potential (be selective — only 90+ for truly exceptional moments)

Return ONLY a JSON array with this exact structure (no other text):
[
  {
    "title": "Catchy clip title for social media",
    "start": 125.5,
    "end": 168.2,
    "viral_score": 85,
    "category": "hot_take",
    "reason": "Why this would go viral in 1-2 sentences",
    "keywords": ["hashtag1", "hashtag2", "hashtag3"]
  }
]

Categories: hot_take, emotional, humor, storytelling, insight, debate, revelation, quotable, relatable, shocking_stat

TRANSCRIPT:
`;

  // System and user-prompt prefix are identical across all chunks in a run; mark them
  // for ephemeral (5-min) prompt caching. Anthropic silently no-ops if the cached
  // prefix is below the model's minimum cacheable token count.
  const requestPayload: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 4096,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userPromptPrefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: chunk },
        ],
      },
    ],
  };

  let response: Anthropic.Message;
  try {
    response = await client.messages.create(requestPayload);
  } catch (err) {
    // Retry once
    try {
      response = await client.messages.create(requestPayload);
    } catch (retryErr) {
      throw new Error(
        `Claude API failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
      );
    }
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return parseClipSuggestions(text);
}

function parseClipSuggestions(text: string): RawClipSuggestion[] {
  // Extract JSON array from response (handles markdown code blocks)
  const jsonMatch = text.match(/\[[\s\S]*?\](?:\s*)$/) || text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item: Record<string, unknown>) =>
        typeof item.start === 'number' &&
        typeof item.end === 'number' &&
        typeof item.viral_score === 'number' &&
        item.end > item.start
    ) as RawClipSuggestion[];
  } catch {
    return [];
  }
}

function postProcess(
  rawClips: RawClipSuggestion[],
  transcript: TranscriptResult,
  maxClips: number,
  minDuration: number,
  maxDuration: number
): ViralClip[] {
  // Filter by duration — use a 5s tolerance on minimum to avoid edge cases
  const effectiveMin = Math.max(5, minDuration - 5);
  let clips = rawClips.filter((c) => {
    const dur = c.end - c.start;
    return dur >= effectiveMin && dur <= maxDuration;
  });

  // Sort by score descending
  clips.sort((a, b) => b.viral_score - a.viral_score);

  // Remove overlapping clips (keep higher scored)
  const selected: RawClipSuggestion[] = [];
  for (const clip of clips) {
    const overlaps = selected.some((s) => {
      const overlapStart = Math.max(s.start, clip.start);
      const overlapEnd = Math.min(s.end, clip.end);
      const overlapDuration = overlapEnd - overlapStart;
      const minDur = Math.min(s.end - s.start, clip.end - clip.start);
      return overlapDuration > minDur * 0.5;
    });

    if (!overlaps) {
      selected.push(clip);
    }

    if (selected.length >= maxClips) break;
  }

  // Build final clip objects with transcript text
  return selected.map((raw, i) => {
    const clipText = extractTranscriptText(transcript, raw.start, raw.end);
    const clipSpeakers = extractSpeakers(transcript, raw.start, raw.end);

    return {
      id: `clip_${String(i + 1).padStart(3, '0')}`,
      title: raw.title || `Clip ${i + 1}`,
      start: raw.start,
      end: raw.end,
      duration: Math.round((raw.end - raw.start) * 10) / 10,
      viralScore: Math.min(100, Math.max(0, Math.round(raw.viral_score))),
      category: raw.category || 'insight',
      reason: raw.reason || '',
      transcript: clipText,
      speakers: clipSpeakers,
      keywords: raw.keywords || [],
    };
  });
}

function extractTranscriptText(
  transcript: TranscriptResult,
  start: number,
  end: number
): string {
  const texts: string[] = [];
  for (const seg of transcript.segments) {
    if (seg.end <= start || seg.start >= end) continue;
    texts.push(`[${seg.speaker}]: ${seg.text}`);
  }
  return texts.join(' ');
}

function extractSpeakers(
  transcript: TranscriptResult,
  start: number,
  end: number
): string[] {
  const speakers = new Set<string>();
  for (const seg of transcript.segments) {
    if (seg.end <= start || seg.start >= end) continue;
    speakers.add(seg.speaker);
  }
  return [...speakers];
}

function formatTranscript(transcript: TranscriptResult): string {
  return transcript.segments
    .map(
      (seg) =>
        `[${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s] ${seg.speaker}: ${seg.text}`
    )
    .join('\n');
}

function chunkTranscript(
  formatted: string,
  _transcript: TranscriptResult,
  maxChars: number
): string[] {
  if (formatted.length <= maxChars) return [formatted];

  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;
  const overlapLines = 20;

  const lines = formatted.split('\n');

  for (const line of lines) {
    if (currentLen + line.length > maxChars && currentLines.length > 0) {
      chunks.push(currentLines.join('\n'));
      // Keep last N lines for overlap
      const overlap = currentLines.slice(-overlapLines);
      currentLines = [...overlap];
      currentLen = overlap.reduce((sum, l) => sum + l.length + 1, 0);
    }
    currentLines.push(line);
    currentLen += line.length + 1;
  }

  if (currentLines.length > 0) {
    chunks.push(currentLines.join('\n'));
  }

  return chunks;
}

function inferTitle(transcript: TranscriptResult): string {
  const firstText = transcript.segments.slice(0, 5).map((s) => s.text).join(' ');
  return firstText.length > 100 ? firstText.slice(0, 100) + '...' : firstText;
}
