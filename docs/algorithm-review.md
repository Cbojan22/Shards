# Algorithm Review — Picking & Editing

A code-level audit of the two intelligent stages: **clip selection** (which moments become clips) and **clip editing** (face tracking, framing, captions). Findings are ordered by leverage — biggest impact first.

---

## TL;DR — Highest-leverage fixes

| # | Issue | File | Effort | Impact |
|---|-------|------|--------|--------|
| 1 | ~~**`speakerFaceMap` is computed but never used during rendering.** The whole `scripts/map_speakers.py` pipeline is dead weight.~~ **Fixed** — render now prefers the active speaker's mapped face when confidence ≥ 0.4, with multiplicative bonus that gracefully falls back to largest-face when the target isn't visible. | `src/pipeline/render/index.ts` | Small | High — better framing on two-person shots |
| 2 | Haar cascades miss profile/angled/occluded faces and small subjects | `scripts/detect_faces.py:45` | Medium | High — no more dropped faces in interviews |
| 3 | LLM is asked to *find* clips but not to *mark emphasis words* | `src/pipeline/analyze/index.ts:92`, `captions/index.ts:67` | Small | Medium — better caption styling |
| 4 | Moving-average smoothing causes 3.5s of lag in camera motion | `src/pipeline/render/index.ts:155` | Small | Medium — feels more responsive |
| 5 | No adaptive zoom — wide source shots look distant in 9:16 | `src/pipeline/render/index.ts:84-86` | Medium | Medium — polished framing |
| 6 | Output `max_tokens` of 4096 can truncate clip lists on long videos | `src/pipeline/analyze/index.ts:123` | Trivial | Low — but a real bug |
| 7 | `effectiveMin = minDuration - 5` silently violates user's min duration | `src/pipeline/analyze/index.ts:180` | Trivial | Low |

---

## A. Clip Picking (the LLM-driven analysis)

### A1. How it works today

`src/pipeline/analyze/index.ts`:
1. Format transcript: `[start - end] SPEAKER: text` lines (`formatTranscript`, line 254)
2. Chunk at 80,000 chars with 20-line overlap (`chunkTranscript`, line 263)
3. Each chunk → one Claude call asking for "up to N viral moments" with JSON schema
4. Combine candidates from all chunks
5. Filter by duration, sort by `viral_score`, dedupe overlaps (>50% time overlap = duplicate), keep top N (`postProcess`, line 172)

This is a clean architecture — single-pass, generative, LLM does the judgment.

### A2. Issues

**A2a. Output token ceiling truncates long clip lists.** `src/pipeline/analyze/index.ts:123` sets `max_tokens: 4096`. For 20 clips with reason + keywords each, that's ~150-200 tokens × 20 = 3000-4000 tokens. Right at the ceiling. Sonnet 4.6 supports 64k output. Bump to 8192 for headroom.

**A2b. `effectiveMin = Math.max(5, minDuration - 5)`** (line 180). User asks for "min 15s" and gets 10s clips. Probably a workaround for the LLM occasionally returning slightly-too-short clips, but it should be either fixed strictly or made an explicit `--min-tolerance` flag.

**A2c. Single-pass scoring.** The LLM judges clips in isolation within a chunk. It doesn't see the whole video at once for ranking. Could improve to a **two-stage approach**:
- Stage 1: cheap model (Haiku 4.5 or Gemini Flash) extracts ~50 *candidate* moments per chunk
- Stage 2: strong model (Sonnet 4.6) re-ranks the merged candidate list with the global view

This is "extract → re-rank" and tends to outperform single-pass selection meaningfully on subjective tasks. Cost goes up modestly because Stage 1 is cheap.

**A2d. Chunk-boundary clip splits.** A clip that straddles the chunk boundary may be returned by neither chunk (each sees only half of the moment). The 20-line overlap helps but doesn't guarantee it. A boundary-aware chunker would split *between* speaker turns or at natural pauses, never mid-thought.

**A2e. No re-ask.** If `parseClipSuggestions` returns 0 clips (malformed JSON), there's a single retry with the same prompt. Could add a "your last response wasn't valid JSON, here's the parse error, please return only the array" follow-up.

**A2f. Emphasis words aren't surfaced.** While Claude is reading the transcript anyway, asking it to also mark emphasis words per clip is essentially free. Right now `src/pipeline/captions/index.ts:67` uses heuristics (length >6, ALL CAPS, hardcoded list of 50 words) which miss context-specific emphasis ("the *number* changed everything" — "number" isn't in the list). Adding `"emphasis_words": ["number", "everything"]` to the schema would dramatically improve caption styling.

### A3. Recommendations (picking)

1. **Bump `max_tokens` to 8192** in `analyzeChunk()`.
2. **Tighten `effectiveMin`** — use exactly `minDuration` or expose tolerance as a config option.
3. **Add `emphasis_words` to the JSON schema** and thread through to caption generation. Highest-leverage change of this whole list.
4. **Consider extract-then-rerank** if you want to push viral hit rate. Use Haiku 4.5 / Gemini Flash for Stage 1.
5. **Smarter chunking:** split at the speaker turn nearest the size boundary, not mid-line.

---

## B. Clip Editing (face tracking, framing, smoothing)

### B1. How it works today

`scripts/detect_faces.py`:
1. Sample 2 fps with OpenCV
2. Detect faces with Haar cascade `haarcascade_frontalface_default.xml`
3. Track by horizontal proximity (within 15% of frame width)
4. Compute lip-movement metric per frame (absolute diff of mouth region grayscale)

`scripts/map_speakers.py`:
- Correlate lip movement with speaker-active ranges, assign each speaker → one face

`src/pipeline/render/index.ts`:
- `findBestVisibleFace(time)` picks the largest face at each 0.5s interval, biased toward center
- `generateCropKeyframes` builds per-second keyframes
- `smoothKeyframes` applies a 7-frame moving average (≈3.5s window)
- FFmpeg crops to 9:16 at full source height with linear-interpolated `x` per keyframe

### B2. Issues

**B2a. (BUG) `speakerFaceMap` is collected but ignored.**
`src/pipeline/render/index.ts:78` — `generateCropKeyframes` accepts `speakerFaceMap` as a parameter but never reads it. (This is the unused-parameter TypeScript warning you may have seen.) The whole `map_speakers.py` script — which figures out which face belongs to which speaker via lip-movement correlation — produces output that is then thrown away.

The current implementation just picks the *largest* face on screen. That works for single-shot interviews but fails for static two-shots: if Person A is talking and Person B has the bigger face on screen (closer to camera), the crop locks on Person B. The fix:

```ts
// In findBestVisibleFace, accept activeSpeaker + speakerFaceMap
const targetFaceId = speakerFaceMap.mapping[activeSpeaker];
if (targetFaceId && faceData.faces[targetFaceId]) {
  // Use this face's bbox at the requested time, with size-fallback
  // if the target face isn't visible right now (e.g., camera cut).
}
```

This is the single highest-leverage editing fix. One file, ~30 lines.

**B2b. Haar cascades are 1990s tech.**
`haarcascade_frontalface_default.xml` only detects roughly-frontal faces. Profile shots, head-tilts >30°, low light, or partial occlusions (mic, hand on chin) are all missed. Modern alternatives:

| Detector | Quality | Speed (CPU) | Setup |
|----------|---------|-------------|-------|
| Haar (current) | Poor on non-frontal | Fastest | None |
| MediaPipe Face Detection | Good, handles angles | Fast | `pip install mediapipe` |
| YOLOv8-face / YOLOv11-face | Excellent | Medium | Pre-trained weights |
| RetinaFace | Best accuracy | Slowest | Heavyweight model |

**MediaPipe is the obvious upgrade** — Google's lightweight model, robust to angles and lighting, runs at >30 fps on CPU. Drop-in replacement, ~50 lines of Python change.

**B2c. Tracking by horizontal-only proximity is fragile.**
`match_faces_to_tracks` (line 157 of `detect_faces.py`) matches detected faces to existing tracks using only horizontal center distance. If two people swap seats, the tracks switch. If someone leans out of frame and back, a new track ID is created. There's no appearance-based re-identification.

A real upgrade: ByteTrack or DeepSORT with embedding-based re-ID. For the scope of this project, a simpler intermediate is **2D distance + face size + IOU** — combines existing-track location with whether the bbox overlaps. Easy upgrade in `match_faces_to_tracks`.

**B2d. Lip movement metric is noisy.**
`detect_faces.py:103-111` — absolute grayscale difference of the lower-third of the face. Sensitive to camera shake, head movement, lighting flicker. A meaningful improvement: compute the diff *only after* registering the face (subtract face center motion), or use optical flow magnitude in the mouth region. MediaPipe Face Mesh (468 landmarks) gives you actual lip landmarks — the proper way to measure mouth motion.

**B2e. Moving-average smoothing causes lag.**
`smoothKeyframes(keyframes, 7)` (line 152, 155) — at 0.5s sampling rate, a 7-frame window means the camera reacts ~1.75s *after* the speaker actually moves. This feels mushy. Better filters:

- **Exponential moving average (EMA):** `x_smooth = 0.6 * x_smooth_prev + 0.4 * x_new` — smooth but with much less lag
- **One-Euro filter:** the gold standard for hand/face tracking; explicitly trades off jitter vs. lag based on velocity (low velocity → heavier smoothing; fast moves → snappy)
- **Kalman filter:** predictive — anticipates motion using velocity, looks great for slower pans

One-Euro is roughly 30 lines of code, no dependencies, and is what the better video editors and AR apps use under the hood.

**B2f. No adaptive zoom — fixed crop height.**
`generateCropKeyframes` line 84-86 always crops at full source height with width = sourceHeight × 9/16. For a wide shot where the speaker's face is 100px tall in a 1080p frame, that face ends up tiny in the 9:16 output. Better:

- Compute target face height (e.g., face should be 30% of output height)
- Set crop height = `target / face_height_in_source × source_height`, clamped to source bounds
- Center vertically on the face

This unlocks "subject-relative zoom" — wide shots zoom in, close-ups stay un-cropped vertically.

**B2g. Vertical position is hardcoded `y = 0`.**
Render line 127 just sets `y: 0`. Means the crop always starts at the very top of the source. Fine for chest-up framings, but a face high in the frame gets the top of the head cut off; a face low in the frame floats in the upper portion of the output. Should compute `y` from face center the same way `x` is computed.

**B2h. Speaker-change "snap" detection is binary.**
Line 167-180 — if any keyframe in the smoothing window has a different speaker, smoothing is disabled for that frame entirely. Causes a hard jump. Better: use a shorter window for that frame (still smoothing, but less), giving a quick-but-not-jarring transition.

### B3. Recommendations (editing)

In priority order:

1. **Wire `speakerFaceMap` into `findBestVisibleFace`** — picks the active speaker's face when known. (B2a, the bug fix.)
2. **Replace Haar with MediaPipe Face Detection** in `scripts/detect_faces.py`. (B2b)
3. **Replace 7-frame moving average with One-Euro filter.** (B2e)
4. **Add adaptive zoom + vertical positioning.** (B2f, B2g)
5. **Upgrade lip movement to MediaPipe Face Mesh landmarks** if you want better speaker-face mapping. (B2d) Lower priority since #1 alone fixes most cases.

---

## C. Captions

### C1. How it works today

`src/pipeline/captions/index.ts`:
- Pull words within `[clipStart, paddedEnd]`
- Group into N-word chunks (default 2), splitting on pauses >0.3s
- Heuristic emphasis: ALL CAPS / >6 chars / known list / has digits
- Build ASS file with three styles (Default, Highlight, Accent)
- Burn in via FFmpeg `ass` filter

### C2. Issues

**C2a. Whisper word-level timestamps drift.**
faster-whisper's word boundaries can be 50-150ms off, especially on fast speech. Captions can pop in slightly late. Fix: **WhisperX** uses forced alignment (wav2vec2) to nail word timing within ~20ms. Drop-in via `whisperx` Python package. Worth doing alongside other diarization improvements if you go that route.

**C2b. Heuristic emphasis is context-blind.**
"The *number* changed everything" — `number` isn't in `EMPHASIS_WORDS` and isn't long enough. Caption misses the actual emphasis. Already mentioned in A2f. Fix: have the LLM mark emphasis words during clip selection.

**C2c. No "burst" timing.**
Hormozi-style captions show one or two words at a time, snapping to the syllable rhythm of the speaker. The current `wordsPerGroup` setting groups words but doesn't pace them dynamically. Could shorten group display time when speech is fast and lengthen on slow words.

**C2d. No display-line breaking.**
`buildEventText` joins all words in a group with spaces. With long words, the caption can overflow horizontally on 9:16. ASS supports `\N` line breaks; could insert one when group width exceeds threshold.

### C3. Recommendations (captions)

1. **LLM-marked emphasis words** (paired with A2f).
2. **WhisperX alignment** for timing accuracy — only worth it if captions feel late.
3. **Width-aware line wrapping** — minor, but cleaner output.

---

## D. What's already good

- The **pipeline architecture** is clean: independent stages, parallel transcribe + face-detect, JSON contracts between Python scripts and TS code. Easy to swap pieces.
- **End-padding fix** to clip duration is the right kind of small heuristic — solves a real problem (truncated last word) at the right layer (render).
- **Backfill of early keyframes** when no face is detected at clip start (line 137-149) is a thoughtful detail that prevents off-frame cold opens.
- **Smoothing breaks on speaker changes** — correct intuition, just executed too bluntly (B2h).
- **`extractClipWords`** correctly clips word window to clip range and sorts by start time. Good defensive code.

---

## E. Suggested order of work

If you want to ship the most improvement per line changed:

1. **Fix the `speakerFaceMap` bug** (B2a). 30 lines. Best framing improvement of any change here.
2. **Add `emphasis_words` to clip schema** (A2f / C2b). Two prompt tweaks + one caption-side change. Roughly 40 lines.
3. **One-Euro smoothing filter** (B2e). 30-line replacement of `smoothKeyframes`. Removes the "delayed camera" feel.
4. **Bump `max_tokens` to 8192** (A2a). One-line bug fix.
5. **Tighten `effectiveMin`** (A2b). One-line correctness fix.
6. **Adaptive zoom + y-position** (B2f, B2g). Bigger change, ~80 lines in `generateCropKeyframes`.
7. **MediaPipe face detection** (B2b). Python script rewrite — needs care, but high payoff.

Items 1-5 are essentially free wins. 6-7 are larger investments that meaningfully raise the ceiling on output quality.
