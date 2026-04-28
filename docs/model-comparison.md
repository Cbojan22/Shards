# Model Comparison — Shards

A practical guide to which models to use for the **video analysis** (viral moment selection) and **transcription/captioning** stages of this project. Updated April 2026.

---

## TL;DR

| Concern | Current | Best quality | Best value | Cheapest viable |
|---------|---------|--------------|------------|-----------------|
| **Viral analysis (LLM)** | Claude Sonnet 4 (`claude-sonnet-4-20250514`) | Claude Opus 4.7 | **Claude Sonnet 4.6** *(upgrade in place)* | Gemini 2.5 Flash |
| **Transcription (Whisper)** | `base` model, local, free | `large-v3` local | **`small`** local *(current default after recent bump)* | `tiny` (poor accuracy) |
| **Face tracking** | OpenCV Haar, local, free | — | OpenCV is fine; no obvious upgrade | — |

**Recommendation:** Upgrade the hard-coded model string to `claude-sonnet-4-6` (Sonnet 4.6) for ~free quality bump, keep faster-whisper at `small` for transcripts, and turn on **prompt caching** on the system prompt to cut per-video cost ~30-50%.

---

## What this project actually pays for

The pipeline has 4 stages. Only one of them costs money per run:

| Stage | Where it runs | Cost model |
|-------|---------------|------------|
| Transcription (faster-whisper) | Local Python | Free (CPU only) |
| Face detection (OpenCV) | Local Python | Free |
| Speaker↔face mapping | Local TS | Free |
| **Viral analysis (Anthropic API)** | Cloud | **$ per token** |
| FFmpeg render | Local | Free |

So this whole guide is really about (a) which LLM to use for viral analysis, and (b) which Whisper variant to use for the transcript that feeds it.

---

## 1. Viral Analysis — LLM Comparison

This is the cost driver. The job: read a 10k-100k token transcript, output a JSON list of clip suggestions with titles, scores, categories, and reasons. Reasoning-heavy, structured output, light on "needle-in-haystack" recall.

### Cost per 1-hour podcast

Assumptions: ~12k input tokens (formatted transcript with timestamps), ~3k output tokens (~10 clip suggestions), 1 API call.

| Model | Input $/M | Output $/M | Per 1-hr video | Per 3-hr podcast | Quality (subjective) |
|-------|----------:|-----------:|---------------:|-----------------:|----------------------|
| **Claude Opus 4.7** | $5 | $25 | ~$0.14 | ~$0.42 | Best reasoning |
| Claude Sonnet 4.6 | $3 | $15 | ~$0.08 | ~$0.25 | **Sweet spot** |
| Claude Sonnet 4 *(currently used)* | $3 | $15 | ~$0.08 | ~$0.25 | Good, slightly older |
| Claude Haiku 4.5 | $1 | $5 | ~$0.027 | ~$0.08 | Capable, sometimes shallow |
| GPT-5 | $1.25 | $10 | ~$0.045 | ~$0.14 | Top tier reasoning |
| GPT-4.1 | $2 | $8 | ~$0.048 | ~$0.14 | Solid, 1M context |
| GPT-4.1 mini | ~$0.40 | ~$1.60 | ~$0.010 | ~$0.030 | Decent, cheap |
| GPT-4.1 nano | $0.10 | $0.40 | ~$0.0024 | ~$0.007 | Limited reasoning |
| **Gemini 2.5 Pro** | $1.25 (≤200k) | $10 | ~$0.045 | ~$0.14 | Strong, 1M context |
| **Gemini 2.5 Flash** | $0.30 | $2.50 | ~$0.011 | ~$0.033 | Surprisingly good for cost |

> Numbers are list price. **Anthropic prompt caching** cuts input cost 90% on cached blocks (the system prompt is ~600 tokens — cache it). **Anthropic Batch API** halves both input and output cost with a 24-hour SLA.

### Quality, not just price

Picking viral moments isn't a recall task — it's a *judgment* task. The model has to grok hooks, controversy, payoff structure, and quotability. Frontier reasoning models pull noticeably ahead here. From practical testing patterns:

- **Opus 4.7 / GPT-5** — best at narrative arc detection, will catch the subtle "earned punchline" clips smaller models miss. Worth it for premium content (paid newsletters, client work).
- **Sonnet 4.6 / Gemini 2.5 Pro** — the practical sweet spot. ~95% of the picks of a frontier model at ~3x lower cost. Use this as the default.
- **Haiku 4.5 / Gemini 2.5 Flash / GPT-4.1 mini** — fine for breadth (lots of suggestions to filter) but tend to over-pick mid-quality moments and miss layered ones. Acceptable if you're already culling by `viralScore` threshold.
- **Nano/tiny tier** — skip for this task. The reasoning is a real bottleneck.

### Recommendation

1. **Default:** swap `claude-sonnet-4-20250514` → `claude-sonnet-4-6` in `src/pipeline/analyze/index.ts:37`. Same price, newer training.
2. **Add prompt caching** on the `SYSTEM_PROMPT` block. Anthropic SDK v0.39 supports it via `cache_control: { type: 'ephemeral' }`. Cuts effective input cost ~30% over a full video (system prompt is reused across chunks).
3. **For batch jobs** (re-processing a back catalog): wrap chunk calls in the Batch API for 50% off both directions.
4. **For volume / cheap tier:** add a `--model` flag in the analyze options and let users pick `haiku` or `gemini-2.5-flash`. Wire Gemini via the OpenAI-compatible endpoint or a Vercel AI SDK abstraction.

---

## 2. Transcription — Whisper Variant Comparison

All free, all run locally. The only knob is **model size** (and which Whisper implementation you use under the hood).

### Whisper model size (faster-whisper, current setup)

| Model | Params | RAM | Speed (CPU) | Caption accuracy on podcasts |
|-------|--------|-----|-------------|------------------------------|
| `tiny` | 39M | ~1 GB | Fastest | Poor — drops uncommon nouns |
| `base` | 74M | ~1 GB | Fast | OK for clean audio |
| **`small`** *(default)* | 244M | ~2 GB | Medium | **Good — recommended baseline** |
| `medium` | 769M | ~5 GB | Slow | Great for noisy / fast speakers |
| `large-v3` | 1.55B | ~10 GB | Slowest | Best — pro level |

For a typical podcast episode on a M-series Mac, `small` runs in roughly real-time, `medium` at ~0.4x. The accuracy delta from `base` → `small` is substantial; `small` → `medium` is smaller but matters on accents and crosstalk.

### Whisper implementation alternatives

| Implementation | Speed vs OpenAI Whisper | Key feature | When to use |
|----------------|------------------------|-------------|-------------|
| **faster-whisper** *(current)* | ~4× faster, less RAM | CTranslate2 backend, int8 CPU | Default — already perfect for CPU |
| WhisperX | 70× faster on GPU | Forced alignment + word-precise timestamps + diarization (pyannote) | If you get a GPU and want pro diarization |
| Distil-Whisper | 6× faster than large-v3 | Half size, ~1% WER hit | If you want `medium` accuracy at `small` speed |
| insanely-fast-whisper | Fastest single-GPU | Flash Attention | Pure speed on a CUDA box |

### Cloud STT alternatives (if local Whisper becomes a bottleneck)

You don't need these now — local Whisper is free and good. But if processing time becomes painful, here's the lay of the land:

| Provider | Per-hour cost | Notes |
|----------|--------------:|-------|
| **AssemblyAI Universal-2** (batch) | $0.15 | Cheapest cloud option; excellent diarization |
| Deepgram Nova-3 (batch) | $0.26 (PAYG $0.46) | Fastest cloud; word timestamps strong |
| OpenAI Whisper API | $0.36 | OpenAI-hosted Whisper large; simplest |

For 100 hours of podcast/month, that's $15-46 to never touch Python again. Tradeoff: you give up local privacy and add a network dependency.

### Recommendation

Stay on faster-whisper local. The `base` → `small` upgrade you just shipped is the highest-leverage change. Only consider:
- **`medium`** if you regularly process accented or low-bitrate audio.
- **WhisperX** if/when you add GPU support — its diarization beats this project's hand-rolled energy heuristic.
- **AssemblyAI** if processing latency starts blocking your workflow.

---

## 3. Future option — Native video understanding models

Currently this project sees the video as text-via-Whisper plus geometry-via-OpenCV. Modern multimodal models can ingest the actual video file:

- **Gemini 2.5 Pro** — natively multimodal. 1M-token context = ~1 hour of HD video in one call. State-of-the-art on video benchmarks; rivals specialized fine-tuned models on dense captioning.
- **Gemini 2.5 Flash** — same multimodal capability at ~5× lower cost.

This unlocks things the current pipeline can't see:
- Visual hooks (gesture, reaction, surprised face) that don't show up in transcript
- B-roll / cutaway detection
- Crowd reactions, comedic timing visual cues

It's a future direction, not a swap-in. The current architecture (Whisper + OpenCV + LLM-on-text) is much cheaper per video and preserves the tight FFmpeg control you have over rendering. But if you want a "v2" experiment, a Gemini-2.5-Flash pass over the raw video to flag visual moments — *combined* with the existing transcript pass — would catch a class of clips you currently miss.

---

## 4. Concrete cost ranges, end-to-end

Per video, with current defaults (faster-whisper `small` local + Sonnet 4.6 + cached system prompt):

| Video length | Whisper compute time (M-series Mac) | LLM cost | Total $ |
|--------------|-------------------------------------|---------:|--------:|
| 30 min | ~3 min | ~$0.04 | ~$0.04 |
| 1 hour | ~6 min | ~$0.06 | ~$0.06 |
| 2 hours | ~12 min | ~$0.13 | ~$0.13 |
| 3 hours | ~18 min | ~$0.20 | ~$0.20 |

So the marginal cost of running this pipeline on a typical 1-2 hour podcast is around **5-15 cents** in API spend. The expensive resource is your Mac's CPU time, not the LLM bill.

---

## 5. Action items

1. ~~**Code change (cheap win):** update `model` default in `src/pipeline/analyze/index.ts:37` to `claude-sonnet-4-6`.~~ **Done.**
2. ~~**Code change (medium win):** add `cache_control` on the system prompt and static user-prompt prefix in `analyzeChunk()`.~~ **Done** — both are now cached as ephemeral blocks. Saves on multi-chunk videos (>80k chars of transcript) where the same prefix is reused across calls within a 5-minute window.
3. **Config (open):** expose a `--model` flag for the LLM so you can A/B test Haiku 4.5 or Gemini 2.5 Flash on representative episodes before committing.
4. **Observation:** keep `whisperModel: 'small'` as the default. Only upgrade to `medium` per-job (`--model medium`) if a specific episode has caption errors.
5. **Future experiment:** prototype a Gemini-2.5-Flash visual-pass that flags moments based on facial reactions and gestures, then merge with the LLM-on-transcript pass.
6. **Future experiment:** for re-processing a back catalog (overnight runs), wrap the chunk calls in Anthropic's Batch API for 50% off both directions. Requires a polling loop + 24-hour SLA — not a drop-in change.

---

## Sources

- [Claude API Pricing 2026 — Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic Claude API Pricing 2026: Opus 4.7, Sonnet 4.6, Haiku — AI Pricing Guru](https://www.aipricing.guru/anthropic-pricing/)
- [Gemini Developer API Pricing — Google AI for Developers](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini 2.5 Pro Review 2026 — TokenMix](https://tokenmix.ai/blog/gemini-2-5-pro-review)
- [Advancing the frontier of video understanding with Gemini 2.5 — Google Developers Blog](https://developers.googleblog.com/en/gemini-2-5-video-understanding/)
- [OpenAI API Pricing — OpenAI](https://openai.com/api/pricing/)
- [GPT-5 API Pricing 2026 — pricepertoken.com](https://pricepertoken.com/pricing-page/model/openai-gpt-5)
- [Choosing between Whisper variants — Modal](https://modal.com/blog/choosing-whisper-variants)
- [Best open-source STT in 2026 (with benchmarks) — Northflank](https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks)
- [WhisperX vs Competitors: AI Transcription Comparison 2026 — BrassTranscripts](https://brasstranscripts.com/blog/whisperx-vs-competitors-accuracy-benchmark)
- [Speech-to-Text API Pricing (Feb 2026) — BuildMVPFast](https://www.buildmvpfast.com/api-costs/transcription)
- [Deepgram Pricing 2026: Nova-3 at $0.46/hr — BrassTranscripts](https://brasstranscripts.com/blog/deepgram-pricing-per-minute-2025-real-time-vs-batch)
- [faster-whisper — SYSTRAN/GitHub](https://github.com/SYSTRAN/faster-whisper)
