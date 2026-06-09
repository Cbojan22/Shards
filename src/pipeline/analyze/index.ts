import Anthropic from '@anthropic-ai/sdk';
import { TranscriptResult, ViralClip, ViralAnalysisResult } from '../../types/index.js';
import {
  snapEndForward,
  snapStartBackward,
  clampSoftCap,
  applyTailPadding,
} from './boundaries.js';

interface AnalyzeOptions {
  apiKey: string;
  maxClips?: number;
  minDuration?: number;
  maxDuration?: number;
  model?: string;
  /** Seconds of breathing room added after the snapped end. Default 0.6. */
  endPaddingSec?: number;
  /** Hard ceiling = maxDuration * softCapRatio. Default 1.5. */
  softCapRatio?: number;
  /** When true, drop clips with completeness_score < 70 or ending_type "trail_off". Default true. */
  strictCompleteness?: boolean;
}

const SNAP_END_SEARCH_SEC = 5;
const SNAP_START_SEARCH_SEC = 2;
const SNAP_MIN_PAUSE_SEC = 0.4;
const COMPLETENESS_THRESHOLD = 70;

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
- COMPLETENESS: Does the clip make sense on its own without needing the full context?

CRITICAL — ENDINGS LAND CLIPS. The biggest mistake auto-clippers make is cutting before the payoff. A clip without its punchline / answer / conclusion feels broken and viewers swipe away frustrated. Every clip you select must include the moment that resolves the tension you set up:
- Setup → Payoff: include both. Never just the setup.
- Joke: include the punchline AND the reaction beat (laugh, "oh damn", silence after the line).
- Question: include the full answer plus its key qualifier — not just the question.
- Story: include the result/twist, not the lead-in to it.
- Hot take: include the speaker's full claim and the reasoning, not the windup.
- Game / competition / challenge moment: include the outcome (who won, what happened, the reveal). Never cut before the result.
Endings should land on a natural pause where the speaker visibly resolves the thought. Never end on: a question being asked, a setup line, a connector word ("and", "but", "so", "because"), a pronoun without its referent, or mid-sentence.`;

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
    endPaddingSec = 0.6,
    softCapRatio = 1.5,
    strictCompleteness = true,
  } = options;

  // maxRetries=4 covers most transient API hiccups (5xx, ECONNRESET, etc.)
  // before we hand control back to the per-chunk fallback below.
  const client = new Anthropic({ apiKey, maxRetries: 4 });

  onProgress?.('Formatting transcript for analysis...');
  const formattedTranscript = formatTranscript(transcript);

  onProgress?.('Analyzing transcript for viral moments...');

  // 120k chars/chunk fits comfortably within Sonnet 4.6's 200k context (room
  // left for cached prefix + 4k output) and cuts the number of API calls by
  // ~33% on long videos vs. the old 80k cap. Net cost win, also slight quality
  // gain — Claude sees more context per call.
  const chunks = chunkTranscript(formattedTranscript, transcript, 120000);
  const allRawClips: RawClipSuggestion[] = [];
  let chunkFailures = 0;

  for (let i = 0; i < chunks.length; i++) {
    // Always print chunk progress — used to gate this on chunks.length > 1
    // which meant single-chunk runs printed nothing during a 30-90s API call
    // and looked like a hang.
    const chunkChars = chunks[i].length;
    onProgress?.(
      `Analyzing chunk ${i + 1}/${chunks.length} (${chunkChars.toLocaleString()} chars, may take 30-90s)...`
    );

    // Heartbeat every 15s while the API call is in flight so the user can
    // tell the program hasn't stalled. cleared in the finally block.
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      onProgress?.(`  ...still analyzing chunk ${i + 1} (${elapsed}s elapsed)`);
    }, 15000);

    try {
      const rawClips = await analyzeChunk(
        client, model, chunks[i], minDuration, maxDuration, maxClips
      );
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      onProgress?.(`  Chunk ${i + 1} done in ${elapsed}s, ${rawClips.length} candidates`);
      allRawClips.push(...rawClips);
    } catch (err) {
      // Don't let one bad chunk burn the cost of the chunks that already
      // succeeded. Log, count, and keep going.
      chunkFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.(`Chunk ${i + 1}/${chunks.length} failed (${msg}); skipping and continuing.`);
    } finally {
      clearInterval(heartbeat);
    }
  }

  if (chunkFailures > 0) {
    onProgress?.(
      `${chunkFailures} of ${chunks.length} chunks failed — results are partial.`
    );
  }

  if (allRawClips.length === 0) {
    throw new Error(
      chunkFailures > 0
        ? `All ${chunks.length} chunks failed during analysis.`
        : 'No clip suggestions returned by the analysis.'
    );
  }

  onProgress?.(`Found ${allRawClips.length} potential clips, filtering...`);

  const clips = postProcess(allRawClips, transcript, {
    maxClips,
    minDuration,
    maxDuration,
    endPaddingSec,
    softCapRatio,
    strictCompleteness,
  });

  onProgress?.(`Final selection: ${clips.length} viral clips`);

  return {
    clips,
    totalAnalyzed: transcript.segments.length,
    videoTitle: inferTitle(transcript),
    partial: chunkFailures > 0,
  };
}

type EndingType = 'punchline' | 'conclusion' | 'revelation' | 'reaction' | 'trail_off';

interface RawClipSuggestion {
  title: string;
  start: number;
  end: number;
  viral_score: number;
  category: string;
  reason: string;
  keywords: string[];
  completeness_score: number;
  ending_type: EndingType;
  overrun: boolean;
}

const VALID_ENDING_TYPES: ReadonlySet<EndingType> = new Set([
  'punchline',
  'conclusion',
  'revelation',
  'reaction',
  'trail_off',
]);

async function analyzeChunk(
  client: Anthropic,
  model: string,
  chunk: string,
  minDuration: number,
  maxDuration: number,
  maxClips: number
): Promise<RawClipSuggestion[]> {
  const softCapMax = Math.round(maxDuration * 1.5);

  // Static across every chunk in a run — cacheable.
  const userPromptPrefix = `Analyze this transcript and identify up to ${maxClips} moments that would make viral short-form video clips.

REQUIREMENTS:
- TARGET duration: ${minDuration}-${maxDuration} seconds.
- SOFT CAP: you may exceed ${maxDuration}s by up to 50% (i.e. up to ${softCapMax}s) ONLY when the additional seconds are required for the payoff/punchline/conclusion to fully land. When you do this, set "overrun": true. Do not exceed ${softCapMax}s under any condition.
- MINIMUM duration: ${minDuration}s. Never return a clip shorter than this.
- Use the exact second timestamps from the transcript (the numbers before "s" in brackets).
- Clips must START at the beginning of a sentence (right after a pause or on a clean speaker turn).
- Clips must END after the payoff has fully landed (see CRITICAL section in system prompt).
- No overlapping clips.
- Score each clip 0-100 on viral potential. Be selective — only 90+ for truly exceptional moments.

For each clip, also rate:
- "completeness_score" (0-100): how complete and self-contained the clip feels — would a viewer who saw nothing else understand it AND feel the payoff land? Be honest. If it ends on a setup or mid-thought, score this low.
- "ending_type": one of "punchline" | "conclusion" | "revelation" | "reaction" | "trail_off". Use "trail_off" only when there is no clean ending available — these clips will be dropped.
- "overrun": true if you exceeded ${maxDuration}s for completeness, false otherwise.

Return ONLY a JSON array with this exact structure (no other text):
[
  {
    "title": "Catchy clip title for social media",
    "start": 125.5,
    "end": 168.2,
    "viral_score": 85,
    "category": "hot_take",
    "reason": "Why this would go viral in 1-2 sentences",
    "keywords": ["hashtag1", "hashtag2", "hashtag3"],
    "completeness_score": 90,
    "ending_type": "punchline",
    "overrun": false
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

  // Stream the response instead of using messages.create(). Non-streaming
  // requests can hang on the wire for 5+ minutes when Anthropic's edge holds
  // the socket without flushing, tripping Node undici's body timeout and
  // surfacing as a generic "Connection error." Streaming flushes deltas
  // continuously so the socket never goes silent long enough to trip that.
  // Billing is identical; SDK still applies maxRetries=4 to transient 5xx /
  // network errors. .finalMessage() assembles the deltas into the same Message
  // shape we used to get from messages.create().
  let response: Anthropic.Message;
  try {
    const stream = client.messages.stream(requestPayload);
    response = await stream.finalMessage();
  } catch (err) {
    throw new Error(`Claude API failed: ${describeApiError(err)}`);
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return parseClipSuggestions(text);
}

// Anthropic SDK's default error.message often loses useful detail (network
// failures collapse to "Connection error."). Pull out status, headers, and
// the underlying cause when present so logs explain *why*, not just *what*.
function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const parts = [`${err.name}`];
    if (err.status) parts.push(`status ${err.status}`);
    const requestId = err.headers?.['request-id'];
    if (requestId) parts.push(`request-id ${requestId}`);
    parts.push(err.message || '(no message)');
    return parts.join(' · ');
  }
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      return `${err.name}: ${err.message} (cause: ${cause.name}: ${cause.message})`;
    }
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

function parseClipSuggestions(text: string): RawClipSuggestion[] {
  // Extract JSON array from response (handles markdown code blocks)
  const jsonMatch = text.match(/\[[\s\S]*?\](?:\s*)$/) || text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item: Record<string, unknown>) =>
          typeof item.start === 'number' &&
          typeof item.end === 'number' &&
          typeof item.viral_score === 'number' &&
          item.end > item.start
      )
      .map((item: Record<string, unknown>): RawClipSuggestion => {
        const rawEnding = item.ending_type;
        const ending: EndingType =
          typeof rawEnding === 'string' && VALID_ENDING_TYPES.has(rawEnding as EndingType)
            ? (rawEnding as EndingType)
            : 'conclusion';

        return {
          title: typeof item.title === 'string' ? item.title : '',
          start: item.start as number,
          end: item.end as number,
          viral_score: item.viral_score as number,
          category: typeof item.category === 'string' ? item.category : 'insight',
          reason: typeof item.reason === 'string' ? item.reason : '',
          keywords: Array.isArray(item.keywords)
            ? (item.keywords as unknown[]).filter((k): k is string => typeof k === 'string')
            : [],
          // Default to 100 when missing so old prompts / parser fallbacks don't get
          // their clips erroneously dropped by the completeness gate.
          completeness_score:
            typeof item.completeness_score === 'number'
              ? Math.min(100, Math.max(0, item.completeness_score))
              : 100,
          ending_type: ending,
          overrun: typeof item.overrun === 'boolean' ? item.overrun : false,
        };
      });
  } catch {
    return [];
  }
}

interface PostProcessOptions {
  maxClips: number;
  minDuration: number;
  maxDuration: number;
  endPaddingSec: number;
  softCapRatio: number;
  strictCompleteness: boolean;
}

function postProcess(
  rawClips: RawClipSuggestion[],
  transcript: TranscriptResult,
  options: PostProcessOptions
): ViralClip[] {
  const {
    maxClips,
    minDuration,
    maxDuration,
    endPaddingSec,
    softCapRatio,
    strictCompleteness,
  } = options;

  // 1. Snap each clip's boundaries to natural pauses, add tail padding,
  //    then clamp to the soft-cap ceiling.
  const snapEndOpts = { searchSec: SNAP_END_SEARCH_SEC, minPauseSec: SNAP_MIN_PAUSE_SEC };
  const snapStartOpts = { searchSec: SNAP_START_SEARCH_SEC, minPauseSec: SNAP_MIN_PAUSE_SEC };

  const snapped: RawClipSuggestion[] = rawClips.map((c) => {
    const snappedStart = snapStartBackward(transcript.segments, c.start, snapStartOpts);
    const snappedEnd = snapEndForward(transcript.segments, c.end, snapEndOpts);
    const padded = applyTailPadding(snappedEnd, endPaddingSec, transcript.duration);
    const clamped = clampSoftCap(snappedStart, padded, maxDuration, softCapRatio);
    return { ...c, start: snappedStart, end: clamped };
  });

  // 2. Drop clips below minDuration. The previous code accepted clips up to 5s
  //    shorter than the user's minimum — that masked the "cut too short" issue.
  let clips = snapped.filter((c) => {
    const dur = c.end - c.start;
    return dur >= minDuration;
  });

  // 3. Strict completeness gate — drop clips Claude itself flagged as incomplete.
  if (strictCompleteness) {
    clips = clips.filter(
      (c) => c.completeness_score >= COMPLETENESS_THRESHOLD && c.ending_type !== 'trail_off'
    );
  }

  // 4. Sort by score descending
  clips.sort((a, b) => b.viral_score - a.viral_score);

  // 5. Remove overlapping clips (keep higher scored). Snapping can change
  //    boundaries, so dedupe AFTER snap, not before.
  const selected: RawClipSuggestion[] = [];
  for (const clip of clips) {
    const overlaps = selected.some((s) => {
      const overlapStart = Math.max(s.start, clip.start);
      const overlapEnd = Math.min(s.end, clip.end);
      const overlapDuration = overlapEnd - overlapStart;
      const minDur = Math.min(s.end - s.start, clip.end - clip.start);
      return overlapDuration > minDur * 0.5;
    });

    if (!overlaps) selected.push(clip);
    if (selected.length >= maxClips) break;
  }

  // 6. Build final clip objects with transcript text
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

  // Note: maxDuration is intentionally NOT used as a hard upper filter here.
  // Claude is allowed to flag overrun:true to deliver the payoff, and
  // clampSoftCap caps the upside at maxDuration * softCapRatio.
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
