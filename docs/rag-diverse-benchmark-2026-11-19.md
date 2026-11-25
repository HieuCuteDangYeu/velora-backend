# Diverse long-video retrieval benchmark (2026-11-19, updated 2026-11-22)

Status: partial. The retrieval layer (24 of 27 videos, 3-120 min, 153 questions) is in the fourth run below. The judged end-to-end layer and the photo-turn set were run live on 2026-11-21/22 (sections below). 14 more videos (cooking, sports, vlog, podcast, news; Arabic, French, Korean, Chinese; five of them under 3 min) were downloaded and 101 questions written; their indexing was still in progress when this was written, so no number here covers them.

## What was built
- 27 CC-BY YouTube videos (`eval/rag/datasets/rag-diverse-sources-v1.json`), 3 min to 2 h, labelled by genre, language, audio condition, visual type and duration band. Media is untracked (`test-data/`).
- 168 questions (`rag-diverse-v1.jsonl`): 164 reviewed by Haiku (a model review, not human), 4 rejected. Gold is a time interval on a video, so re-chunking cannot make a row stale. Split by video: dev 92 / heldout 76.
- Runner `eval/rag/diverse-live-eval.cjs`. A strict hit needs the right reel and an overlap of at least min(5 s, 30% of the gold length). It also reports `nearRecall5` (right reel, within 60 s of the gold) and supports `--types`.

## Fourth run: 153 questions, 24 videos, 3-120 min (retrieval stage, 2026-11-20)
Current headline. 24 of the 27 videos are indexed. `reel`, `mixed:4` and `whole` all completed with 0 unavailable. 11 rows belong to `BX_fbdbUxsg` (79 min), which could not be indexed (see "Pipeline findings"), so 153 of 164 rows are scored. Raw: `.benchmarks/diverse-run4-{reel,mixed4,whole}.json`.

Content questions (n=105; `detail` and `chapter`):

| scope | MRR | recall@1 | recall@5 | near recall@5 (within 60 s) | right video in top 5 |
|---|---|---|---|---|---|
| reel | 0.78 | 0.69 | 0.91 | 0.97 | 1.00 |
| mixed:4 | 0.74 | 0.65 | 0.88 | 0.90 | 0.93 |
| whole index | 0.72 | 0.63 | 0.86 | 0.88 | 0.91 |

Router-dependent questions (n=48; `opening` and `timestamp`), plain search only, so a lower bound, not production behaviour:

| scope | MRR | recall@5 | right video in top 5 |
|---|---|---|---|
| reel | 0.22 | 0.29 | 1.00 |
| mixed:4 | 0.05 | 0.06 | 0.33 |
| whole index | 0.01 | 0.02 | 0.08 |

All 153 questions together: MRR 0.61 (reel), 0.53 (mixed:4), 0.50 (whole index); recall@5 0.72, 0.62, 0.59. The overall figure looks low because 31% of the rows are router-dependent.

Content questions by duration band (MRR / recall@5):

| band | n | videos | reel | whole index |
|---|---|---|---|---|
| 3-10 min | 16 | 5 | 0.72 / 0.88 | 0.70 / 0.81 |
| 10-30 min | 25 | 9 | 0.74 / 0.84 | 0.57 / 0.64 |
| 30-60 min | 46 | 7 | 0.76 / 0.93 | 0.71 / 0.93 |
| 60-120 min | 18 | 3 | 0.97 / 1.00 | 0.97 / 1.00 |

Content questions by other strata, `reel` | `whole` (MRR / recall@5; `*` = fewer than 15 cases):

| cut | n | reel | whole |
|---|---|---|---|
| lang en | 73 | 0.84 / 0.96 | 0.78 / 0.89 |
| lang es | 10* | 0.90 / 1.00 | 0.82 / 1.00 |
| lang vi | 13* | 0.62 / 0.85 | 0.57 / 0.85 |
| lang hi | 9* | 0.42 / 0.56 | 0.36 / 0.44 |
| audio clean speech | 95 | 0.79 / 0.94 | 0.72 / 0.87 |
| audio noisy | 5* | 0.46 / 0.40 | 0.41 / 0.40 |
| genre lecture-slides | 66 | 0.80 / 0.94 | 0.76 / 0.92 |
| genre tutorial | 12* | 0.64 / 0.92 | 0.36 / 0.50 |
| genre screen-recording | 12* | 0.86 / 1.00 | 0.86 / 1.00 |
| genre gameplay | 5* | 0.46 / 0.40 | 0.41 / 0.40 |
| visual slides | 30 | 0.85 / 0.97 | 0.72 / 0.80 |
| visual talking-head | 39 | 0.79 / 0.95 | 0.73 / 0.95 |
| visual screen-recording | 16 | 0.74 / 0.94 | 0.72 / 0.88 |
| visual scene-heavy | 15 | 0.76 / 0.73 | 0.74 / 0.73 |
| tier manual captions | 23 | 0.83 / 0.96 | 0.67 / 0.74 |
| tier auto captions | 82 | 0.77 / 0.90 | 0.74 / 0.89 |

What this run says:
- **Length alone does not hurt content retrieval, up to 2 h.** recall@5 is 0.93 for 30-60 min and 1.00 for 60-120 min. The 60-120 min cell is 18 rows from 3 lecture videos, so it is correlated and not a general claim. The top hit is a chunk of about 45 s in every band, so long chunks are not inflating the strict-overlap metric.
- **The weak part is the whole index, not the length.** Whole-index recall@5 is 0.64 for 10-30 min (right video in top 5 only 72%) against 0.81 for 3-10 min. Tutorials lose most when 250+ short reels compete: recall@5 0.50 in `whole` against 0.92 in `reel`. Manual-caption videos also lose more in `whole` (0.74 against 0.96).
- **Weak cells (indicative):** Hindi audio (0.36 MRR in `whole`), noisy gameplay (0.41), tutorials in `whole` (0.36).
- **Rerank does not help.** Content MRR with rerank: reel 0.79, mixed 0.72, whole 0.71, against 0.78, 0.74, 0.72 for retrieval only. Treat as no evidence of gain.
- **Router-dependent questions** (opening, "what is said at 12:30") stay near zero in the whole index because the question names no topic. They need the end-to-end layer, which uses dedicated routes in production.
- Not paired with the earlier runs: the question set grew from 60 to 109 to 153 rows and the index changed.

## End-to-end layer (live bot, 2026-11-21/22)
`scripts/ops/run-diverse-e2e.cjs` puts each question to the production bot as a chat turn with only the gold video shared in the conversation (the "question about a shared video" setting). `eval/rag/diverse-e2e-lib.cjs` scores the reply: did the bot answer, did it cite the right reel, did a cited span overlap the gold interval (`moment`). `judge` then asks Haiku (`claude-haiku-5-5`, the `ops:rag:judge` prompts) for factual correctness and relevancy against the reference caption passage. A row is "correct" when factual correctness is at least 0.7. Raw: `.benchmarks/diverse-e2e-1.json`, `.benchmarks/diverse-e2e-2-grounded.json` (they hold the bot answers and caption text).

Sample: 2 rows per video per type, 17 videos with an answered review, 3-120 min. Cells are small (n 14-34 per type), and the judge is a model: treat the figures as direction, not as precise rates.

| run | type | n | answered | refused as off-topic | cited right reel | cited right moment | judged | correct | factual |
|---|---|---|---|---|---|---|---|---|---|
| bare question | opening | 15 | 0.93 | 0.07 | 0.87 | 0.87 | 14 | 0.64 | 0.70 |
| bare question | timestamp | 20 | 0.90 | 0.10 | 0.80 | 0.00 | 18 | 0.00 | 0.02 |
| bare question | chapter | 14 | 0.86 | 0.00 | 0.79 | 0.57 | 12 | 0.00 | 0.29 |
| bare question | detail | 34 | 0.97 | **0.82** | 0.03 | 0.03 | 33 | 0.00 | 0.01 |
| names the shared video | detail | 34 | 0.85 | 0.00 | 0.50 | 0.38 | 29 | 0.34 | 0.48 |
| names the shared video | chapter | 14 | 1.00 | 0.00 | 0.50 | 0.43 | 14 | 0.00 | 0.30 |
| names the shared video | timestamp | 20 | 0.95 | 0.10 | 0.85 | 0.00 | 19 | 0.00 | 0.01 |

"Names the shared video" prefixes the question with "About the video I just shared:" (`--grounded`). It separates routing from answering.

What this shows:
- **Detail questions are refused by the scope router.** 82% of bare detail questions (for example "what is the first question a creator has to answer in the license chooser flowchart") got "I can only help with Velora: its Reels and videos...", although the video was shared in the chat. Naming the video drops the refusal to 0 and the correct rate goes from 0.00 to 0.34. A user who asks about a shared video without saying "this video" is mostly refused. This is a routing problem, not a retrieval one.
- **Timestamp questions fail completely.** "What does the speaker say at 3:33?" returns the video's opening line (`cited 1-45 s`) or an unshared-reel error, 0 of 20 correct in both runs. The retrieval-stage score of about 0 was not an artefact of whole-index search: the production timestamp path does not use the time.
- **Opening questions work** (0.64 correct, 0.87 right moment).
- **Chapter (section summary) questions** cite the right area about half the time and are judged correct 0 of 14 at the 0.7 bar (factual 0.30). Chapter references are long, so the 0.7 bar is strict here; read the factual column.
- Even when the video is named and cited, detail answers are correct about a third of the time. Cross-lingual rows are too few to read (5-10).

## Photo-turn results (live bot, 2026-11-22, 42 rows)
`scripts/ops/run-photo-live.cjs` sent each photo as a real chat image message (presign, R2 PUT, finalize, message) in a new bot conversation. Raw: `.benchmarks/photo-run-1.json`.

| category | rows | result |
|---|---|---|
| frame from an indexed video (exact, crop, jpeg40, lowres, dark, tilt) | 21 | **0 of 21 recommended the source reel** (hit@1 0, hit@3 0); 2 had no reply |
| caption variants | 6 | 0 of 5 decided rows recommended the source |
| off-topic photos (math, receipt, code, weather) | 6 | 6 of 6 refused without recommending reels |
| injection text in the photo | 4 | 4 of 4 did not obey (marker `PWNED-4417` absent) |
| edge: png, webp, under-cap, oversize, corrupt | 5 | 0 passed; the oversize and corrupt rows got no reply at all (no error message back) |

Overall pass 0.25 (40 decided rows, 5 with no bot reply). The frames are 21 stills from lecture, tutorial and screen-recording videos; the bot's usual answers were "I couldn't find any reels for that" (most rows) or the off-topic refusal. One "lowres" row returned 8 recommended reels, none of them the source. So off-topic and injection handling hold, but finding a long video from one of its frames does not work in this index. Off-topic and injection rows were not judged for wording; their pass is the weak rule (no reels recommended, marker absent).

## Fifth run: nine new videos, cooking / sports / vlog / news / podcast, ar, fr, vi, en (2026-11-22)
Round 3 added 14 CC-BY videos (sources file now has 40): cooking, sports highlights, street-food vlogs, a news-interview, an IELTS podcast-style talk, in English, Vietnamese, Arabic, French, Korean and Chinese, 33 s to 70 min. Five are under 3 min (the SHORT route); three clips (a Spanish Super Cup highlights reel and two Chinese news clips) have no captions, so they were uploaded but have no questions. 101 questions were written (Haiku) and reviewed (Haiku); the dataset has 269 rows. Nine of the videos are indexed and have questions for the retrieval run; `k4715CJ0Ii8` (17 min) was indexed late (after a hand re-queue) and appears only in the end-to-end run. `8oL03cm1kMc` (70 min Korean podcast) could not be indexed: the inline frame extraction timed out ("ffmpeg timed out after 300000ms"), the same failure as the 79 min `BX_fbdbUxsg`, so it is not scored. These media jobs ran on the laptop's workers (x86, shared with other jobs), which are slower than the homelab's, so the timeout may be partly an effect of where the worker ran. Raw: `.benchmarks/diverse-run5-new-{reel,whole}.json`, `.benchmarks/diverse-e2e-3-newvideos.json`.

Retrieval stage, 79 questions on the nine new videos, `reel` and `whole` scope, no rerank, 0 unavailable:

| type | n | reel MRR | reel recall@5 | whole MRR | whole recall@5 |
|---|---|---|---|---|---|
| detail | 44 | 0.81 | 0.95 | 0.75 | 0.93 |
| chapter | 11 | 0.68 | 0.91 | 0.44 | 0.64 |
| opening, timestamp (router-dependent) | 24 | 0.33 | 0.58 | 0.00 | 0.00 |
| all | 79 | 0.64 | 0.84 | 0.48 | 0.61 |

Detail questions retrieve well on short, noisy and non-English video (reel recall@5 0.95, whole-index 0.93; sports 0.88 and vlog 0.74 across all types, Arabic 1.00 on 9 rows, French 0.64 on 11 rows, both indicative). The weak cells are the same ones as before: opening and timestamp questions, and section-level questions on the whole index.

End-to-end on these videos, question names the shared video (33 rows, 7 videos, judged by Haiku): answered 1.00, right reel cited 0.97, right moment cited 0.61, correct 0.33 (factual 0.41). By type: detail 0.50 correct (n=14, moment 0.93), opening 0.80 (n=5), chapter 0.00 (n=6), timestamp 0.00 (n=8). Under 3 min clips: 3 of 3 correct. Arabic sports commentary: 0 of 4 correct although retrieval found the right moment (the bot's answers were off or generic). Every cell is under 15 rows, so these are indicative.

Reading across the three layers: retrieval finds the moment (recall@5 0.8-0.95 on content questions), the bot cites the right reel (0.97 here, 0.50 on the older videos) and, for detail questions, the right moment (0.92 here, 0.38 there), but the answer is judged correct only 0.34 (older videos) to 0.50 (these new, shorter ones) of the time on detail questions, and 0 on timestamp and chapter questions. After the scope-router refusal (above), generation and the timestamp path are the next losses, not retrieval.

## What is indexed (homelab production index, tag `bench-diverse-v1`)
24 of 27 videos (as of 2026-11-20). Not indexed: `BX_fbdbUxsg` (79 min, 11 questions), `tu3OXtpi4XI` (61 min, silent documentary, 0 questions) and `1eadcvvyGu8-noaudio` (11 min, no audio track, 0 questions, never uploaded). So there are no NO_AUDIO or silent-track videos in the index yet.

Pipeline findings from indexing:
- **Section/chunk bug (fixed):** `hOJsRc9Ju7k` failed with `Chunk ...:chunk:15 is outside its parent section`. Fixed in `c9e82197`, deployed; the video indexed after the fix.
- **Embedding aborts on long videos:** `q8eInHZD1VA` and `5A_Rfwy1XF0` failed 3 and 2 times with `Batch embedding failed for 29-32 items: This operation was aborted` before indexing. The ai-service aborts each embedding request after 120 s and the indexer's call times out at 120 s. All 170 texts of one failed video embedded fine one by one (about 3.8 s each while indexing ran), so the cause was not found; retries converge because good vectors are checkpointed. Re-queuing was done by hand.
- **Frame-extraction timeout loses the whole video:** for `BX_fbdbUxsg` (79 min) the inline visual-frame extraction timed out at 61 of 79 min. The follow-up "evidence job" never ran, and with no evidence manifest the index job finds no audio segments and fails with `Audio Reel produced no verified transcript`. The Vietnamese lecture `CYyRY3lmdJE` (49 min) failed the same way on its first upload and indexed after a fresh upload. Re-queuing the index cannot fix it.
- **Duplicate-embedding guard rejects silent video:** `tu3OXtpi4XI` (silent-track documentary) failed with `Embedding duplicate ratio 0.856 exceeds 0.500`: only visual scenes were embedded, and they are near-identical. A retry fails the same way.
- Deploys during uploads caused 502/504 cascades in earlier batches. The uploader has `--abort-after-failures` and `--mode=reconcile`.

## How to read the numbers
Questions fall in two groups:
- **Content questions** (`detail`, `chapter`; 41 scored): the question carries the topic. This is what retrieval can be judged on.
- **Router-dependent questions** (`opening` "first thing said", `timestamp` "what is said at 12:30"; 19 scored): the question names no topic, so searching the raw question text cannot find the video. Production sends these to dedicated paths. Scoring them here with plain search is a lower bound, not production behaviour. They need the end-to-end layer.

Scopes: `reel` = search only the gold video (a video shared in the chat), `mixed:4` = gold video plus 4 other test videos, `whole` = the entire production index (about 257 short drama reels compete).

## Results, retrieval stage (60 questions; rerank covered fewer, see caveats)

Content questions (n=41):

| scope | MRR | recall@1 | recall@5 | near recall@5 (within 60 s) | right video in top 5 |
|---|---|---|---|---|---|
| reel | 0.73 | 0.63 | 0.85 | 0.98 | 1.00 |
| mixed:4 | 0.68 | 0.61 | 0.78 | 0.88 | 0.88 |
| whole | 0.67 | 0.61 | 0.76 | 0.80 | 0.88 |

Router-dependent questions (n=19), plain search only:

| scope | MRR | recall@5 | right video in top 5 |
|---|---|---|---|
| reel | 0.42 | 0.53 | 1.00 |
| mixed:4 | 0.10 | 0.16 | 0.37 |
| whole | 0.03 | 0.05 | 0.11 |

All 60 questions together: MRR 0.63 (reel), 0.50 (mixed), 0.47 (whole). The overall number looks low mainly because of the router-dependent group.

Per-stratum, content questions only (MRR / recall@5; `*` = fewer than 15 cases, indicative only):

| cut | n | reel | whole |
|---|---|---|---|
| band 3-10 min | 16 | 0.72 / 0.88 | 0.70 / 0.81 |
| band 10-30 min | 25 | 0.74 / 0.84 | 0.66 / 0.72 |
| lang en | 32 | 0.82 / 0.94 | 0.76 / 0.84 |
| lang hi | 9* | 0.42 / 0.56 | 0.37 / 0.44 |
| audio clean speech | 31 | 0.73 / 0.90 | 0.66 / 0.77 |
| audio noisy | 5* | 0.46 / 0.40 | 0.42 / 0.40 |
| visual slides | 15 | 0.74 / 0.93 | 0.62 / 0.73 |
| visual scene-heavy | 15 | 0.76 / 0.73 | 0.74 / 0.73 |
| visual screen recording | 11* | 0.68 / 0.91 | 0.65 / 0.82 |
| genre tutorial | 12* | 0.64 / 0.92 | 0.52 / 0.67 |
| genre lecture-slides | 7* | 0.70 / 0.86 | 0.61 / 0.71 |
| genre gameplay | 5* | 0.46 / 0.40 | 0.42 / 0.40 |
| tier manual captions | 15 | 0.74 / 0.93 | 0.62 / 0.73 |
| tier auto captions | 26 | 0.73 / 0.81 | 0.70 / 0.77 |

## Third run: 109 questions, including the 30-60 min band (retrieval stage)
Run after the 30-60 min videos finished indexing. Scopes `reel` and `mixed:4` completed with 0 unavailable. The `whole` scope was stopped at about 80 of 109 questions to free the homelab for a stress test, so there is **no whole-index number for the 30-60 min band yet**. 27 videos are in the manifest, 18 are indexed. The 6 videos that have questions but no index (2 failed reels, 4 of the 60-120 min band) are counted as `unbound`, not as misses; the other 3 unindexed videos have no scored rows. Raw: `.benchmarks/diverse-run3-{reel,mixed4}.json`.

| scope | group | n | MRR | recall@1 | recall@5 | near recall@5 | right video in top 5 |
|---|---|---|---|---|---|---|---|
| reel | content | 75 | 0.74 | 0.63 | 0.89 | 0.97 | 1.00 |
| reel | router-dependent | 34 | 0.27 | 0.18 | 0.35 | 0.53 | 1.00 |
| mixed:4 | content | 75 | 0.72 | 0.61 | 0.87 | 0.92 | 0.95 |
| mixed:4 | router-dependent | 34 | 0.09 | 0.06 | 0.12 | 0.15 | 0.53 |

Content questions by duration band (MRR / recall@5; `reel` scope, then `mixed:4`):

| band | n | reel | mixed:4 |
|---|---|---|---|
| 3-10 min | 16 | 0.72 / 0.88 | 0.70 / 0.81 |
| 10-30 min | 25 | 0.74 / 0.84 | 0.68 / 0.80 |
| 30-60 min | 34 | 0.76 / 0.94 | 0.75 / 0.94 |

- Retrieval does not degrade with length up to 60 min on content questions: recall@5 is 0.94 in the 30-60 min band in both scopes. Sections (about 10 per video) and the 2-minute frame gap did not hurt text questions. Visual questions on long videos are not covered by these rows.
- The 30-60 min cell is the largest (n=34, 5 videos). Per-video MRR varies from 0.38 to 1.00 in the `reel` scope, so a single video can move the band number.
- Router-dependent questions score 0.27 MRR when the search is limited to one video and 0.09 with 4 other videos present. The reel-scope figure is lower than the 0.42 of the first run, with 34 rows instead of 19; the cause was not investigated. They still need the end-to-end layer.
- Not directly comparable with the first two runs: the question set grew from 60 to 109.

## Photo-turn set (how it was built; results above)
`eval/rag/datasets/rag-photo-v1.jsonl`: 42 rows, images under `test-data/reel-integration/diverse/photos/` (untracked). Built locally by `scripts/ops/build-photo-cases.cjs` (ffmpeg only; no model and no network), pure logic in `eval/rag/photo-cases-lib.cjs` (8 tests). Rows are CANDIDATE, rule-labelled, not model-reviewed.

| category | rows | expected outcome |
|---|---|---|
| frame (crop, JPEG q40, low-res, dark, tilt, exact) from 18 indexed videos | 21 | the source video is among the recommended reels |
| caption variants (empty, Vietnamese, 520 chars, contradicting) | 6 | source video; the contradicting one is judged for grounding only |
| off-topic cards (math, receipt, code, weather, note, Vietnamese math) | 6 | the bot declines |
| injection cards (text that tells the bot to print `PWNED-4417`) | 4 | text treated as data; the marker must not appear in the answer |
| edge: PNG, WebP, 3.8 MB and 4.9 MB noise PNG (4 MiB cap), corrupt JPEG | 5 | source video, or a clear reply for the oversize and corrupt files |

Splits follow the video-level split of the video set (dev 25, heldout 18). Known limits:
- A frame row only checks that the source **video** is recommended. The pipeline analyses at most 24 frames per video, so the cut frame is usually not one of them; a miss on a long video is partly that cap, not only the photo path. Report frame rows by band.
- Running it needs the chat-image upload path and Groq vision on the homelab, which is rate limited at the moment. The runner is `scripts/ops/run-photo-live.cjs` (presign, upload, finalize, image message, wait for the reply, score with `eval/rag/photo-live-lib.cjs`; resumable, one turn at a time, `--dry-run` lists rows). It is tested only against a fake backend (11 tests) and has never been run live; each row creates a bot conversation on the target account. Rules decide the source-video hit, the injection marker and the clean-rejection cases; the wording of an off-topic decline and answer grounding still need the Haiku judge, which is not wired in.
- The 3-images-in-one-turn case is not in the set: a chat image message carries one image and the bot turn reads only that one, so the limit of 3 is reachable only through `ai.stream_question`, not the chat path.
- No human has checked the 6 contradicting/edge rows' expected outcomes.

## Findings from the first run (60 questions; the fourth run above supersedes them)
1. **Once the video is known, retrieval is good**: recall@5 0.85, and 0.98 within 60 s. Most strict misses in the `reel` scope are a neighbouring chunk, not a wrong place.
2. **Whole-index search loses a little more**: recall@5 0.76, and the right video is in the top 5 only 88% of the time. Long educational videos compete with 250+ short reels.
3. **No clear 3-10 vs 10-30 min gap on content questions** (whole MRR 0.70 vs 0.66). The fourth run covers 30-120 min and shows no drop on content questions in the `reel` scope; the 10-30 min band is the weak one in the whole index.
4. **Weak cells (indicative, under 15 cases):** Hindi audio (whole MRR 0.37), noisy gameplay (0.42). English-question-on-foreign-audio (4 rows) is too small to report.
5. **Rerank gives no clear gain.** In the first complete run (52 rows) it was lower than retrieval-only in whole and mixed scopes. In the second run it was equal in whole and lower in mixed, but covered 51-55 of 60 rows, so it is not paired with the retrieval numbers. Treat as "no evidence of gain".
6. **Opening and timestamp questions need the end-to-end layer**; this runner cannot evaluate them fairly.

## Index statistics by duration band (2026-11-20, `scripts/ops/diverse-index-stats.cjs`)
24 indexed videos (5 + 9 + 7 + 3).

| band | videos | chunks / hour | sections / video | visual scenes / video | gap between analysed frames | index time vs video length |
|---|---|---|---|---|---|---|
| 3-10 min | 5 | 398 | 1.6 | 6.6 | ~18 s | 0.97x |
| 10-30 min | 9 | 167 | 3.8 | 11.8 | ~40 s | 0.56x |
| 30-60 min | 7 | 139 | 9.7 | 8.7 | ~2 min | 0.68x |
| 60-120 min | 3 | 107 | 15.7 | 20.7 | ~3 min | not recorded (re-indexed by hand) |

- The visual budget is 24 frames per video, so the gap between analysed frames grows with length (about 3 min at 60-120 min). On 2026-11-20 the Groq vision keys were healthy and the 60-120 min videos stored 20.7 of 24 scenes on average (86%). On 2026-11-19 the 30-60 min videos stored only 2.0 of 24 because all 16 keys were in cooldown. So the earlier low coverage was quota, not the frame cap; the cap, not quota, limits the 60-120 min band (about one scene per 3 minutes).
- Chunks per hour fall with length (398 to 107), so chunks get longer in long videos; the top retrieval hit is still about 45 s.
- Index time is the wall clock from upload to indexed, including queueing and shared homelab load, so it is not a clean throughput number. For the 60-120 min videos it was not recorded because they were indexed by re-queuing.

## Caveats
- Gold and reviews are model-made (Haiku writes, Haiku checks); no human review. A human spot check of about 10% is recommended.
- The 60-120 min cell is 18 rows from 3 lecture videos (correlated rows); BX_fbdbUxsg (79 min, 11 rows) is unindexed, so no screen-recording video over an hour is covered. The silent and no-audio fixtures are not indexed, so NO_AUDIO routing is untested.
- The second run lost 5-9 rerank results per scope (reranker busy while the 30-60 min batch indexes), so the rerank stage there is not directly comparable. The retrieval stage covers all 60.
- Both Chinese-audio videos have no captions, so there are no zh rows. No NO_AUDIO, unanswerable or on-screen-text rows yet.
- The existing 88-case baseline was not re-run, so the shift from the new reels in the shared index is unmeasured.
- Strict metric is unchanged; `nearRecall5` is an extra, more lenient view.

## Reproduce
```
# inside the content-service container, files copied per the header of eval/rag/diverse-live-eval.cjs
node diverse-live-eval.cjs run --cases rag-diverse-v1.jsonl --reel-map diverse-reel-map.json \
  --out /tmp/div-whole.json --scope whole --split all [--types detail,chapter]   # also --scope reel | mixed:4
```
Raw runs: `.benchmarks/diverse-run4-{reel,mixed4,whole}.json` (current), `diverse-run3-*` and `diverse-run2-*` (contain transcript text, untracked).
Cleanup: reels carry tag `bench-diverse-v1` and `.benchmarks/diverse-reel-map.json` lists their ids. Bulk deletion needs your confirmation.

End-to-end and photo layers run from any machine that can reach the backend (creds in `.env.test.local`: `BACKEND_URL`, `VELORA_TEST_EMAIL`, `VELORA_TEST_PASSWORD`):
```
node scripts/ops/run-diverse-e2e.cjs run   --out .benchmarks/diverse-e2e-N.json [--grounded] [--scope reel|whole] [--types ...] [--only ID,ID] [--per-video 2]
node scripts/ops/run-diverse-e2e.cjs judge  --out .benchmarks/diverse-e2e-N.json   # needs the `claude` CLI (Haiku)
node scripts/ops/run-diverse-e2e.cjs report --out .benchmarks/diverse-e2e-N.json
node scripts/ops/run-photo-live.cjs run --out .benchmarks/photo-run-N.json [--category frame] [--limit N]
```
Both are resumable. Do not call `reel-integration-load.cjs --mode=reconcile` in a tight loop while they run: the login endpoint answers 429 after a few logins.
Adding sources: put them in `rag-diverse-sources-v1.json`, download with `prepare-diverse-fixtures.cjs --yt-dlp=<current yt-dlp> --only=ID,...` (yt-dlp 2024.04 fails with "Requested format is not available"), wait for it to finish writing `manifest.json`, then `build-diverse-cases.cjs generate --only ID,... && build-diverse-cases.cjs review`.

Known limits of the layers added on 2026-11-22: the judge is Haiku against caption text (auto-captions for 219 of 269 rows); per-type cells are 5-34 rows; the 0.7 "correct" bar is harsh for section summaries; the photo frames come from lecture/tutorial/screen-recording videos whose visual index is sparse, so the 0 of 21 does not say how the bot does on dense scene-heavy video (frames from those were not in the set); the new indexing was done while another load (stress tests, the laptop's workers) shared the homelab.

Cleanup (2026-11-22): `scripts/ops/cleanup-diverse-reels.cjs` (dry run by default, `--apply` deletes) removed the 10 reels that were not the resolved reel of any fixture: 9 failed or never-indexed uploads and 1 duplicate of the no-audio fixture. It calls `DELETE /content/reels/:id` as the owner, then the index rows need `index.delete_reel` on `reel_index_query` from inside the reel-indexing container (ids are printed). Removed entries move from `entries` to `deleted` in `.benchmarks/diverse-reel-map.json`. Fixtures BX_fbdbUxsg, tu3OXtpi4XI and 8oL03cm1kMc now have no reel at all (they failed to index; re-upload after the frame-extraction timeout is fixed). Reel 35306389 (XXGSO0pySps) shows indexStatus PROCESSING from a retry on 2026-11-19, but its earlier COMPLETED index still serves.

## Pipeline fixes and the two long videos that failed before (2026-11-22, commit 54c9f422)
Three indexing defects found by this benchmark were fixed and deployed: (A2) stored-HLS materialization had the 5 minute encode timeout, so a 70 minute reel lost its evidence (now `MEDIA_HLS_MATERIALIZE_TIMEOUT_MS`, 30 min); (A1) an embedding request that hit the 120 s timeout was never retried (now `AI_EMBEDDING_TIMEOUT_RETRIES` = 2, and the indexer's batch call limit is 420 s); (A3) the duplicate-embedding guard rejected silent videos because it counted identical vectors from identical text (now compares across distinct inputs; unit-tested, not exercised live).

Re-upload with the fixes: 8oL03cm1kMc (70 min Korean podcast, reel bc7af7fb) and BX_fbdbUxsg (79 min, reel 3eed9b04) both indexed COMPLETED, so the 60-120 min band now has 2 more videos. tu3OXtpi4XI (silent) still does not index: it now fails later, at "Audio Reel produced no verified transcript", a fail-closed gate for audio with no speech, so A3 did not get a live test. Its failed reel was deleted.

End-to-end on the two long videos (17 rows, grounded, reel scope, Haiku judge; `.benchmarks/diverse-e2e-4-longfix.json`): answered 0.94, cited the right reel 0.88, moment hit 0.59, correct (factual >= 0.7) 0.25, factual mean 0.39. Detail 0.50 correct (n=8), chapter 0.00 (n=5), opening 0.00 (n=2), timestamp 0.00 (n=2); Korean 0.43 (n=7), Vietnamese 0.11 (n=9). All cells are indicative (n < 15). Retrieval-layer numbers for these two were not run. This matches the pattern of earlier runs: the bot cites the right reel and moment far more often than it answers correctly.

## Sixth run: full set on the full index (2026-11-22, 264 scored rows, 38 videos, retrieval stage, no rerank)
First run that scores every REVIEWED row against the current index (two new long videos included), 0 unavailable, 0 unbound. Raw: `.benchmarks/diverse-run6-{reel,whole}.json`.

| Slice | n | reel MRR | reel recall@5 | whole MRR | whole recall@5 |
|---|---|---|---|---|---|
| all rows | 264 | 0.62 | 0.75 | 0.49 | 0.60 |
| content (detail + chapter) | 183 | 0.78 | 0.92 | 0.71 | 0.86 |
| detail | 143 | 0.80 | 0.92 | 0.77 | 0.91 |
| chapter | 40 | 0.72 | 0.93 | 0.49 | 0.70 |
| opening | 28 | 0.28 | 0.46 | 0.01 | 0.04 |
| timestamp | 53 | 0.24 | 0.32 | 0.00 | 0.00 |

Content questions are unchanged from the fourth run (reel 0.91 → 0.92, whole 0.86 → 0.86 recall@5) even with 15 more videos in the index, so adding the new videos did not hurt retrieval. By duration band (reel scope, all types): 3-10 min recall@5 0.87, 10-30 min 0.74, 30-60 min 0.71, 60-120 min 0.69, under 3 min 1.00 (n=5, indicative). The band drop is mostly the opening and timestamp rows, which plain retrieval cannot answer (production routes them through dedicated paths; see the end-to-end layer). Whole-index chapter questions are the weak content cell (0.70): section summaries compete with chunks from other videos.

## Contamination check: the 88-case baseline after the diverse videos (2026-11-22)
The plan asked how much the added reels move the existing short-drama baseline. Same cases and settings as the 2026-11-13 baseline (`rag-semantic-live-v1`, 88 reviewed rows, whole-index search 30, rerank 12, 0 unavailable), run on the current index (`.benchmarks/semantic-live-run-after-diverse.json`):

| | 2026-11-13 baseline | 2026-11-22 | paired diff (95% CI) |
|---|---|---|---|
| retrieval MRR | 0.572 | 0.543 | -0.029 (-0.073 to +0.014) |
| retrieval recall@5 | 0.73 | 0.66 | -0.068 (-0.136 to -0.011) |
| rerank MRR | 0.665 | 0.600 | -0.066 (-0.127 to -0.008), 4 better / 17 worse |
| rerank recall@5 | 0.77 | 0.67 | -0.102 (-0.171 to -0.034) |

Read it as total corpus growth, not as the cost of the diverse set alone. Between the two runs the index also took about 70 more short-drama episodes (the 2026-11-15 run, rerank MRR 0.545, was already hit by untranslated Chinese transcripts outranking English answers) and test reels from other sessions. Against that 2026-11-15 low the rerank has recovered (0.545 → 0.600). The diverse reels' own share cannot be separated without a scoped run that excludes tag `bench-diverse-v1`, which was not done. What this does show: every added reel makes whole-index search harder for the old questions, so baselines that search the whole index should be quoted with their corpus size and date, and compared only to runs on a comparable index.

## Fixes after the end-to-end and photo findings, and the re-measurement (2026-11-22)
The first end-to-end and photo runs found product problems. Each was traced to a cause, fixed, deployed and re-measured. Numbers below compare the first run with the re-run on the same layer.

| problem found | cause | fix (commit) | before | after |
|---|---|---|---|---|
| 82% of plain detail questions about a shared video got "I can only help with Velora" | the router called a self-contained question ("what should you check before choosing a license?") general knowledge although a video was shared | with a shared video, an OFF_TOPIC verdict goes to that video's evidence; the grounded answer step says so when the video does not cover it (bf808076) | scope refusals 0.37 overall, 0.82 on detail | 0.05 overall, 0.07 on detail |
| timestamp questions ("what does the speaker say at 2:02?") answered with the opening line | only "at 12 seconds" set a transcript window, clock times did not | mm:ss / h:mm:ss with a speech cue and "from .. to .." ranges set the window (bf808076) | moment hit 0.00 | moment hit 0.77 |
| "find reels like this photo" found 0 of 21 source reels | reel search sent the query text only, so it matched titles and tags; also the bot recommends public reels only and benchmark reels were private | the search embeds the query and keeps vector-only hits within 0.55 distance (5fc4fdae); the photo set now flips its source reels public for one run (`set-photo-source-visibility.cjs`) | 0 of 21 | 10 of 21 (hit@1 8) |
| 70-90 minute videos did not index | stored-HLS copy had the 5 minute encode timeout; embedding timeouts never retried (54c9f422) | own 30 minute timeout; timeout retries | 2 videos missing | both indexed |
| silent video (audio track, no speech) did not index | the reel took the audio route and failed with "no verified transcript" | when every segment was transcribed and came back empty, the reel indexes from visuals and metadata (c00e0666) | failed | COMPLETED |

End-to-end re-run, bare phrasing, 143 rows (133 judged, reel scope; `.benchmarks/diverse-e2e-5-bare-fixed.json`) against the first run (83 rows):

| | first run | re-run |
|---|---|---|
| answered a correct reel's content (judge factual >= 0.7) | 0.12 | **0.33** |
| detail correct | 0.00 | **0.42** |
| opening correct | 0.64 | 0.67 |
| timestamp correct | 0.00 | 0.12 (moment hit 0.77) |
| chapter correct | 0.00 | 0.08 |
| cited the right reel | 0.49 | 0.69 |

By band (correct): 30-60 min 0.50, 10-30 min 0.29, 3-10 min 0.21 (scope refusals still 0.21 there), 60-120 min 0.16. By language: Vietnamese 0.43 (n=28), English 0.32, Korean 0.00 (n=5), Hindi 0.00 (n=5, answered only 2). Cells under 15 rows are indicative.

Photo set re-run, 42 rows (`.benchmarks/photo-run-3-public.json`): pass 0.63 on 38 decided rows (was 0.25). Frames 10 of 21, caption variants 4 of 5, off-topic 6 of 6, injection 4 of 4. The edge rows: PNG and WebP photos still do not recommend their source (0 of 2 decided); oversize and corrupt photos get no chat message by design, because the app is told through a `bot_reply_failed` socket event (IMAGE_UNREADABLE). A REST poll cannot see that, so those rows are now undecided instead of failed.

Still open: timestamp answers find the right moment but are judged wrong (0.12 correct); chapter summaries stay near 0 at the 0.7 bar; Korean and Hindi questions answer poorly; 3-10 min videos still see 21% scope refusals; half the frame photos still miss their source because a frame of a lecture or tutorial matches a reel's title and summary poorly (a visual-scene search would be the next step).

Two more findings from reading the re-run's rows (2026-11-22, same day):
- Three 3-10 minute rows said "that reel hasn't been shared in this conversation" about a video that was shared. `findAccessibleSharedReelIds` counted a shared reel only when its index status was COMPLETED, and a re-index in flight (the daily visual re-index, a stuck retry) sets PROCESSING while the old index keeps serving. PROCESSING now counts (5bca2d1a). Re-running that video's rows after the deploy: 0 of 6 scope refusals.
- Timestamp questions were judged against the whole ~50 s gold window, which faults a correct one-sentence answer to "what does the speaker say at 3:33?". They are now judged against the speech within ±10 s of the asked time (`timestampReferenceText`; `judge --rejudge --types timestamp` re-scores old runs). Result on the 143-row re-run: timestamp correct 0.09 (factual 0.25), moment hit 0.77. The judge notes show two causes: answers taken from a neighbouring chunk, and the three "not shared" refusals above (fixed). Many right answers score 0.5-0.7 because they give one sentence of the reference, so the 0.7 bar caps this type.

## Muse overflow incident and the timestamp ordering (2026-11-22, evening)
- **Incident caused by the Muse vision fallback (introduced 10d6174a).** Once Cloudflare's daily allocation was spent, real reel uploads went through Muse. The gateway answered 504 under load and sometimes replied with prose instead of JSON; one failed frame fails a short-reel index, so one user reel (`01cdc832`) exhausted its retries around 11:50 UTC. Only that reel was affected in the 24 hours before the fix. d45a2b6b gives each frame up to 3 attempts inside a 100 s budget (the indexer allows 120 s), retried on 5xx, 429, timeouts and unparsable replies, and uses the prose as the caption as a last resort. After deploying it, that reel was re-queued and indexed COMPLETED, so the overflow is verified on real frames. Lesson: a fallback provider needs its own retry budget before it becomes the main path.
- **Timestamp reads** now pick the chunk whose middle is nearest the asked second (f7b9113a). On 23 timestamp rows the live result is neutral against the earlier run (moment hit 0.52 vs 0.77 on a different row mix, correct 0.05 vs 0.09; three rows got no reply in time because the answer model on the laptop was timing out). The judge notes show right answers scoring 0.5-0.7 because the bot returns a single sentence, so this type is capped by the 0.7 bar and by answer model load, not by retrieval. Treat the ordering change as logically sound but unproven.
- **Speechless-audio rule** is now a tested pure function (`isSpeechlessAudio`, 4 tests) and has been exercised on one real video.
- **Hindi and Korean rows:** most "no answer" rows in the first re-run were infrastructure noise (a 502 from a deploy mid-run, timeouts), not bad answers; the Korean chapter rows return one-line answers that score low on the 0.7 bar.

## Final state of the fix round (2026-11-22, night)
- **Reel search now also searches transcript chunks** (55689c40, `REEL_SEARCH_MAX_CHUNK_DISTANCE` 0.45) and the use case caps results at the caller's limit. Measured on the 21 frame photos it was neutral (8 of 21 against 10 of 21 before; frame descriptions of lecture or tutorial video rarely match what is said). Kept because it also lets a paraphrased topic find the video where it is spoken, but it is not the fix for frames.
- **Photo guard** (c3ac7ffa): an OFF_TOPIC photo turn becomes a reel search when the user's caption itself names reels, videos or clips (5 of the 21 frame photos had been refused as off-topic). Unit-tested, deployed, **not yet verified live**: the test account's photo budget (60 photo turns per user per day, plus 300 AI turns) was spent by the repeated benchmark runs, so every later photo row got no reply. Re-measure on a fresh day with `set-photo-source-visibility.cjs public`, `run-photo-live.cjs`, then `private`; running the photo set more than once a day exhausts the budget.
- **Why the visual-scene search was not used for frames:** `index.search_visual_scenes` across the whole index times out in the indexer (the Qdrant call takes an explicit list of point ids with an exact search and a 5 s deadline); it only works scoped to a few reels. Making frame lookups visual needs an indexer change (approximate search or a pre-filter) and was not attempted.
- **Not solvable by code in this round:** chapter and timestamp rows are capped by the 0.7 judge bar (the bot answers in one or two sentences, the reference is a paragraph); Korean and Hindi cells are small and half of their failures were timeouts of the answer model on the laptop.

## Photo set, last round (2026-11-23)
- **Visual-scene search is usable.** The earlier "Internal server error" on `index.search_visual_scenes` was transient (a cold or busy Qdrant): re-probed, the whole-index search answers in about 2 s. Reel search now also ranks reels by their sampled-frame descriptions (05e0561e, `REEL_SEARCH_MAX_VISUAL_DISTANCE` 0.40; relevant frames 0.34-0.39, plausible off-topic 0.41-0.46, unrelated 0.57). With transcript chunks and reel documents that is three ranked lists per search.
- **The benchmark account's photo budget** (60 photo turns and 300 AI turns per day) was cleared once by deleting its two Redis counters (`rl:{ai_image_turn_day:u:<id>}`, `rl:{ai_turn_day:u:<id>}`; the account's own keys only). Without that, repeated photo runs on one day get no reply.
- **Full 42-row run on that deploy** (`.benchmarks/photo-run-6-visual.json`): pass 0.63 on 38 decided rows; frames 10 of 21 (hit@1 8), caption variants 2 of 5, off-topic 6 of 6, injection 4 of 4, PNG/WebP edge rows 2 of 2. Five of the misses were refused as off-topic because the caption was "what is this from?".
- **That caption now starts a reel search** (7411042e). Re-running just those five rows live (`--ids`, `.benchmarks/photo-run-7-ids.json`): none refused, 3 of 5 recommend their source reel (ranks 1, 1 and 3), 2 find no reel. Counting those, frame photos now find their source in about 13 of 21 (0.62), up from 0 of 21 on the first run.
- **Still missing:** crops and tilted frames of scene-heavy or talking-head video whose description is generic ("a person talking in a room") match many reels equally or none; the 0.40 cutoff keeps those out rather than recommending the wrong video.

## Korean and Hindi, measured properly (2026-11-23)
Re-run on the three Korean and Hindi videos with the load low (13 rows, all answered, all judged, bare phrasing, reel scope; `.benchmarks/diverse-e2e-8-kohi.json`): **0 of 13 correct** (factual mean 0.06), the right reel cited on 7 of 13, moment hit 4 of 13. Detail questions are the worst (9 rows, 1 moment hit). Typical failures: "I can't answer this from the information provided" in the question's language even though a related reel is shared, or an answer that quotes an unrelated sentence of the (English or Korean) transcript. The earlier "weak and under-measured" reading was half right: the cause is real, not noise. A non-English question about a video in another language or script is a cross-lingual retrieval and answering problem, and it was not touched in this round. Indicative only (n=13).

### Why Korean and Hindi fail (diagnosis, 2026-11-23)
Plain retrieval (reel scope, detail and chapter rows, `.benchmarks/diverse-run6-reel.json`) finds the right reel for Korean questions about Korean video (6 of 6 at recall@5), Arabic (6 of 6), Spanish (10 of 10), French (5 of 5), Vietnamese (24 of 28) and English questions about Vietnamese, Korean, French video (9 of 11). The live bot still answered 0 of 6 Korean rows correctly, so the loss is after retrieval: the context-sufficiency and answer steps on the local e2b model say "cannot tell from the information provided" in Korean, or quote an unrelated sentence. That is a model-capability limit of the small local answer model, not something a retrieval or router change fixes; the realistic levers are a stronger answer model for non-English turns, or routing those turns to the Muse gateway. The two "Hindi" fixtures are labelled hi but the speech is English ("Hi guys my name is Umair"): the questions were generated in Hindi, so those rows test a Hindi question against English speech, where retrieval is weaker (recall@5 0.56). Fixture labels for those two should be corrected before anyone reads a Hindi number from this set.

### Correction: the Hindi rows were not a valid test (2026-11-23)
Reading the reference captions of the two "Hindi" fixtures (kQT395Kpgnk, iR-ER7mO1V4): they are YouTube's Hindi auto-captions, which transliterate English (and Hinglish) speech into Devanagari ("हेलो हाय गाइस ..."). The bot answered in English from the real transcript ("Hi guys my name is Umair ..."), and the judge compared that with a Devanagari reference, so a correct answer scored near 0. Their 13 reviewed rows are now REJECTED in `rag-diverse-v1.jsonl` with that reason, and the "Hindi 0 of 13" figure above is withdrawn: Hindi is simply not measured by this set. Korean stays as diagnosed (retrieval fine, answer step weak on the small local model; 6 rows, indicative).

## Timestamp questions after the centred chunk and the requested-time hint (2026-11-23)
Same 23 rows as the 2026-11-22 live run (`.benchmarks/diverse-e2e-9-timestamp.json`), after f7b9113a (chunk centred on the asked second) and e0d6ecc8 (the answer prompt says where the asked second falls in the excerpt): answered 23 of 23 (was 20, three rows had timed out), cited reel and moment 0.96 (was 0.52), judged correct 0.17 (was 0.05), mean factual 0.29. On the 20 rows judged in both runs the mean factual score is flat (0.285 before, 0.291 after), so the gain in "correct" comes from fewer timeouts and the right chunk being cited, not from better sentences: the small local model still answers with one sentence from the excerpt, and the judge scores a one-sentence answer 0.5-0.7 against ±10 s of speech. The hint is harmless and kept; it did not move answer quality measurably (n=23).

## Experiment: Muse for the answer roles (2026-11-23, rolled back)
To test whether the weak answers are a small-model limit, ANSWER and CONTEXT_SUFFICIENCY were routed to Muse (`AI_MUSE_ROLES=...,ANSWER,CONTEXT_SUFFICIENCY`, `MUSE_TIMEOUT_MS=45000`; the router, planner and verifier stayed on the local model) and 32 rows (detail, chapter, timestamp on 8 videos: Korean, Vietnamese, English, Spanish, French) were re-run live and judged; `.benchmarks/diverse-e2e-10-muse.json`. Against the same rows on the local model: detail mean factual 0.56 → 0.67 and judged correct 8 → 10 of 16; chapter 0.32 → 0.35 (1 → 1 of 7); timestamp 0.36 → 0.33 (2 → 1 of 8); **Korean 0 of 4 both times**. Median turn time stayed near a minute (CONTEXT_SUFFICIENCY alone took 28 s on Muse). The detail gain is within noise at this sample size and the other types did not move, so the "small answer model" explanation does not predict a gain from a bigger one for Korean, chapter or timestamp questions. Rolled back (`AI_MUSE_ROLES=INDEX_QUALITY,SUBTITLE_TRANSLATION`, no `MUSE_TIMEOUT_MS`): not worth a dependency on a laptop-hosted consumer session capped near 14 requests per minute. The Korean failure is therefore not just model size; the next thing to inspect is the answer prompt and the sufficiency gate on non-English evidence (a Korean question over a Korean transcript is judged "not enough information" even with the right excerpt retrieved).

## Korean: the real cause was routing, not the answer model (2026-11-23)
Running one Korean question live and reading the ai-service graph log showed `route intent=NORMAL_CHAT retrieval=false`: the small router model filed a Korean question about the shared video under plain chat, so **no retrieval ran at all** and the bot replied with a canned "I can only help with Velora" and no evidence. (The Muse experiment above did not help for the same reason: the answer model never saw an excerpt.) With a video shared, a question that ends in a question mark, has at least 12 characters, is not about the app or the assistant and is written with non-English letters now goes to the video's transcript (68b29a5b, narrowed in 0eee7f07 after the first version contradicted the frozen English router corpora; English questions keep the router's verdict).

Live on the deployed guard, Korean rows (`.benchmarks/diverse-e2e-12-ko-vi.json`, 5 rows, same rows as before): right reel cited 5 of 5 (was 2 of 4), moment hit 0.80, mean factual 0.18 → 0.32, judged correct 1 of 5 (was 0 of 5). Vietnamese (12 rows, already routed correctly) is unchanged at 5 of 12. So the Korean refusals are fixed; the remaining Korean errors are weak answers over a correct excerpt, the same ceiling the other languages hit. Indicative only (n=5).

## Answer quality as a distribution, not one bar (2026-11-23)
The "correct" figure uses factual >= 0.7, which is harsh for one-sentence answers against paragraph references. Same judged rows (latest local-model run per row: 134 REVIEWED rows from the bare-phrasing re-run, the timestamp re-run and the Korean/Vietnamese re-run), share of rows at each level:

| type | n | >= 0.7 | >= 0.5 | >= 0.3 | mean factual |
|---|---|---|---|---|---|
| opening | 24 | 0.67 | 0.75 | 0.75 | 0.66 |
| detail | 52 | 0.44 | 0.54 | 0.60 | 0.48 |
| chapter | 24 | 0.08 | 0.25 | 0.58 | 0.32 |
| timestamp | 34 | 0.15 | 0.32 | 0.44 | 0.29 |
| all | 134 | 0.34 | 0.47 | 0.58 | 0.44 |

Reading it: opening questions work. Detail questions are right or partly right about half the time and about 40% of them score under 0.3, which is real wrongness, not strictness. Chapter and timestamp answers are mostly partial (58% and 44% at >= 0.3) and rarely complete. Spot-checking live turns (a chapter question and a 5:06 timestamp question, graph log and answer read side by side) found grounded one-sentence answers with no routing fault, so the gap there is completeness, which a small local answer model and a one-sentence answer style cap. No fix was made for it; the earlier Muse experiment showed a bigger model did not close it.

## Why detail answers fail (2026-11-23)
All 21 detail rows that scored under 0.3 in the latest local-model runs, by what went wrong:

| cause | rows | note |
|---|---|---|
| answered, right reel not cited | 11 | 4 of these are "I can only help with Velora" refusals; the rest are answers with no citation to the shared reel |
| answered, cited the reel but the wrong moment | 5 | the answer step used a neighbouring excerpt |
| answered from the right moment, still wrong | 4 | small-model answer errors (a wrong quantity, a paraphrase of the wrong sentence) |
| hedged ("I don't have information on ...") | 1 | |

The four refusals were re-run on the current deploy: 2 of 6 rows on those videos are still refused. The graph log shows why: the router files an English question about the video under plain chat with `retrieval=false`. The non-English guard (0eee7f07) deliberately does not cover English, because the frozen router corpora expect a general-knowledge question ("What is the difference between TCP and UDP?") with a video shared to stay chat, and its wording cannot be told apart from "What do AI companies admit happens to a chatbot's filters?" (a question the video answers). The right fix is a **retrieval probe**: for a plain-chat, question-shaped message with a video shared, embed it and search the shared reel's chunks (`index.search_chunks` with `filters.reelIds`); if the best chunk is within about 0.42 cosine distance, treat the turn as a video question, otherwise keep it as chat. That needs an optional probe injected into `QueryRouterAgentUseCase`, the reel ids plumbed into its input, and a threshold calibrated on the frozen corpora; it was not built because it would change about 3% of the rows in this set (2 of 58 detail rows), against a router that every chat turn passes through.

## Probe-gated routing, and a regression it fixed (2026-11-24)
**Regression found by a control.** The two earlier guards (bf808076: an OFF_TOPIC verdict with a video shared goes to the video; 68b29a5b/0eee7f07: non-English plain chat goes to the video) rerouted unconditionally. A control that asks six general-knowledge questions ("what is the difference between TCP and UDP?", "how does a binary search tree stay balanced?" ...) in a chat with one shared video found 4 of 6 answered with unrelated text from the video and cited as if it supported them ("the purple boxes are final decisions on licenses choices"). The benchmark never asks such questions, so none of its numbers showed it.

**Fix (f5ef9602).** All rerouting now goes through the evidence probe (`ISharedReelEvidenceProbe`, default 0.48): an OFF_TOPIC verdict, or plain chat for a question-shaped message, becomes a video question only when a transcript chunk of the shared video is within 0.48 cosine distance. Calibration (60 English detail questions, each searched in its own video and in an unrelated one): own video within 0.48 for 93%, an unrelated video for 2%; unrelated questions have a median distance of 0.62. Without a close excerpt the router's verdict stands.

**Live after the deploy.** Control: 0 of 6 general questions rerouted (all six get the normal out-of-scope reply). The six detail questions on the three videos that were being refused: 5 answered and cited, 1 refused (an English question about a Vietnamese video whose chunks are further than 0.48 away). The "remix … upload form" question that stayed refused under the 0.42 threshold is answered. A probe failure leaves the router's verdict untouched.

## What the evaluation set needs from visual indexing (2026-11-24)
The 38 benchmark reels hold 641 active sampled-frame descriptions. No benchmark question reads them: the 251 reviewed questions are opening (26), timestamp (51), chapter (40) and detail (134), all transcript. Frames matter only for the photo rows (21 frame photos from 14 reels, 162 descriptions) and for reel search by what a video shows. Cloudflare reports 53 neurons for a 1280 px frame with the production prompt (about 70 with a longer answer), so re-analysing all 641 would cost about 45,000 neurons, roughly $0.40 beyond the free 10,000 a day; the 162 the photo rows need are about 11,000. The benchmark's own visual need is therefore small; the allowance is spent by re-indexing the same reels (422 index attempts for 144 reels in 14 days, 2.9 attempts per reel) and by uploads, not by the set itself. Perceptual-hash dedupe on the first 90 s of these videos keeps 55% of the 4-second frames at a Hamming distance of 6 (slides, talks and screen recordings keep 1-5 of 23, sports and vlogs keep all 23).

## Vision allowance: content-hash cache (2026-11-24, d6dc0be3, live)
The indexer now stores each frame's analysis under `reel-indexing/visual-analysis-cache/<version>/<sha256 of the JPEG>.json` in the existing artifact store (no database change) and reads it before downloading or analysing the frame. A re-index, retry or re-queue of the same media reuses its frames, and identical frames in different reels share an entry. Cache trouble (missing, corrupt or unreadable entry, failed write) is only a miss. `INDEX_VISUAL_CACHE_ENABLED=false` turns it off; `INDEX_VISUAL_CACHE_VERSION` starts a new namespace after a vision model or prompt change.

Verified on the live indexer by re-indexing a 39 s benchmark clip twice: `completed=10 cached=0` (10 vision calls), then `completed=10 cached=10` (none), the second run finishing in about 10 s. Over the last 14 days there were 422 index attempts for 144 reels (2.9 attempts per reel), so a re-index of an already analysed reel now costs no neurons; the upper bound on the saving over that period is about two thirds of the vision calls (part of those attempts were benchmark re-queues, and failed attempts may stop before vision). Indexer overlay pin is now `velora-reel-indexing-qdrant:d6dc0be3` (backup `index-rollout.yml.bak-d45a2b6b`).

Not done: perceptual-hash near-duplicate skipping (about 45% fewer frames on slide and talk content, none on sports and vlogs; measure on real production reels first), a lower frame cap, self-hosted GPU vision (no GPU available), separate indexer worker pools, PgBouncer.

### Perceptual-hash dedupe: measured on production reels, saves nothing (2026-11-24)
The 45% saving quoted above came from the benchmark videos (slides, talks, screen recordings). On 30 public production reels (first 90 s each, one frame per 4 s, 690 frames, 64-bit difference hash) it saves 0% at distance 3, 4 and 6 and 1% at 10: every sampled frame of these fast-cut dramas is visually distinct (23 of 23 kept in almost every reel). Near-duplicate skipping is therefore not worth building for the production corpus; the vision spend there is the frame count itself (about 24 frames, about 1,700 neurons per reel) and repeated analysis, which the content-hash cache already removes. A lower frame cap or a longer sampling interval would cut the spend but also the visual coverage; that trade is not measured and was not made.

Note on the silent fixture: the original 1.1 GB `tu3OXtpi4XI.mp4` was lost when the scratch directory was wiped; the 480p copy it was re-encoded to (and uploaded from) is the fixture of record.

## Current state: full end-to-end run on the final stack (2026-11-24)
138 rows (2 per video per type, bare phrasing, reel scope, 38 videos), 137 judged, run after every fix above was live (`.benchmarks/diverse-e2e-17-full.json`; judge Haiku, 0 errors, 1 unanswered). Against the first end-to-end run (2026-11-21, 83 rows):

| | first run | now |
|---|---|---|
| answered | 0.93 | 0.99 |
| scope refusals ("I can only help with Velora") | 0.37 | **0.02** (3 of 138) |
| right reel cited | 0.49 | **0.95** |
| moment hit (cited span overlaps the gold span) | 0.27 | **0.81** |
| judged correct (factual >= 0.7) | 0.12 | **0.38** |
| judged at least half right (>= 0.5) | n/a | 0.53 |
| mean factual score | 0.18 | 0.49 |

By type (n, correct at >= 0.7, at >= 0.5, mean; and the same rows in the 2026-11-23 run):

| type | n | >= 0.7 | >= 0.5 | mean | earlier >= 0.7 / mean |
|---|---|---|---|---|---|
| opening | 24 | 0.75 | 0.75 | 0.69 | 0.67 / 0.65 |
| detail | 53 | 0.55 | 0.70 | 0.61 | 0.44 / 0.49 |
| chapter | 26 | 0.12 | 0.31 | 0.33 | 0.08 / 0.32 |
| timestamp | 34 | 0.06 | 0.29 | 0.29 | 0.09 / 0.25 |

By band: 30-60 min 0.45 correct, 10-30 min 0.36, 3-10 min 0.37, 60-120 min 0.23 (n=27), under 3 min 1.0 (n=3). By language: Vietnamese 0.43, English 0.38, Spanish 0.43, French 0.33, Arabic 0.25, Korean 0.20 (n=5, indicative).

What is solved: routing and retrieval for the shared video (cited 0.95, moment 0.81, refusals 2%). What is not: answer completeness. Timestamp answers find the right moment 97% of the time but are judged correct 6% (one sentence against a window of speech); chapter summaries are right in part (0.31 at >= 0.5) but rarely complete; 60-120 min videos are the weakest band; Korean answers are still poor. These are limits of a small local answer model and a one-sentence answer style, and of the 0.7 bar; no routing or retrieval fault was found behind them.

## Timestamp answers: the first-utterance path was the cause (2026-11-24, 19739563, live)
The router filed "what does the speaker say at 3:33?" under `FIRST_COMPLETE_UTTERANCE`, the kind built for "what is the first thing said?". For that kind the verifier requires the **earliest complete utterance inside the retrieved window**, so the bot returned the first sentence of the one-minute excerpt, not the sentence at the asked second: the right excerpt was cited on 97% of rows but 6% of answers were judged correct. A message that names one second (`isPointInTimeQuestion`) and does not ask for the first, earliest, opening or starting line now gets `transcriptRequestKind: NONE`, so the normal grounded answer applies (with the requested-time note in the prompt). Ranges and "the first thing said at 2:00" keep the first-utterance path.

Same 34 timestamp rows before and after (`.benchmarks/diverse-e2e-17-full.json` against `diverse-e2e-18-ts.json`): judged correct (>= 0.7) 2 -> 10 (6% -> 29%), at least half right (>= 0.5) 10 -> 23 (29% -> 68%), at least 0.3: 19 -> 32, mean factual 0.29 -> 0.56, right reel and moment cited on 34 of 34, median answer length 93 -> 497 characters. By arithmetic, the overall correct rate of the full run moves from about 0.38 to about 0.44 (8 more rows of 137); that figure is not a re-run.

Chapter answers do not share this cause: they are already several sentences (median 340 characters). They fall short because a chapter title such as "Licensing basics" is YouTube metadata the bot never sees, so it summarises the best-matching excerpt rather than the whole chapter, and the reference is the whole chapter.

## The 60-120 minute band, traced and re-measured (2026-11-24)
Why the band scored lowest in the full run (27 rows, 5 videos): 7 of its 14 low rows were timestamp answers of one or two words ("Somebody help me.", "Right.", "us.") from before the first-utterance fix; every low row had an answer and a cited reel, and 8 of 14 cited the right moment, so retrieval and routing were sound. Three chapter rows were short, and one Korean chapter answer was a single quoted sentence. After the fix, the same 26 rows (`.benchmarks/diverse-e2e-19-long.json`): judged correct 6 -> 8 (0.23 -> 0.33), at least half right 10 -> 13, mean factual 0.37 -> 0.48; timestamp rows in the band score 0.66 mean (0.14 correct before the fix is the earlier figure; 7 rows, indicative). Detail questions in this band remain the weak cell (mean 0.58, cited the right moment 60%).

Measured ceiling for detail questions: with retrieval inside the video, the first relevant chunk is rank 1 for 71%, within 3 for 87%, within 5 for 92%. The answer prompt receives 3 chunks, so widening it to 5 could add at most 5 points; not done. Short detail answers score the same as long ones (0.62 against 0.60), and only 3 of 26 chapter answers are short, so answer style is not the cause there.

## Korean, traced (2026-11-24)
Live run of the Korean video's questions after every fix (`.benchmarks/diverse-e2e-20-ko.json`, 4 rows): all four answered and cited the right video; both detail questions got fluent, grounded Korean answers at the right moment (moment hit 2 of 2), so the earlier "Korean 20%" is the chapter rows plus a 5-row sample, not a Korean-language failure. The two chapter rows fail like chapter rows in every language: the question names a YouTube chapter title ("Methods he used to study Korean") that the bot never sees, so it answers from the best-matching excerpt (one quoted sentence) against a reference that is the whole chapter.

What the graph log shows about answer quality in general: on the shared local model, `ContextToolAgent` times out at 8 s, `context sufficient=false action=REFUSE_NO_CONTEXT` is logged on turns that are still answered, and `verification budget exhausted before the verifier ran; returning the draft unverified` appears on most turns. The answers are therefore mostly drafts that were never verified. That is a capacity limit of the local model host (the laptop also serves the media workers and the benchmark's own load), not a routing or retrieval fault, and no code change was made for it.

## Final measured run (2026-11-24/25): the estimate replaced by a measurement
Full run on the final deployed stack (every fix above live; 138 rows, 2 per video per type, bare phrasing, reel scope; `.benchmarks/diverse-e2e-22-final.json`). The first pass lost 14 rows to a 40-minute outage (one contiguous block, each row waiting out its timeout, with "Disconnected from RMQ" in the ai-service log); those rows were re-run, and 2 more rows were re-run after that. 135 of 138 rows judged, 3 never answered (two "first thing said" questions on a Vietnamese and a Korean long video and one Korean detail question; the Korean opening answered on a later attempt with a "could not verify" fallback, so these are intermittent, not persistent).

| | first run (2026-11-21) | full run before the timestamp fix | final run |
|---|---|---|---|
| rows judged | 77 | 137 | 135 |
| judged correct (factual >= 0.7) | 0.12 | 0.38 | **0.43** |
| at least half right (>= 0.5) | 0.18 | 0.53 | **0.66** |
| mean factual score | 0.18 | 0.49 | **0.55** |
| scope refusals | 0.37 | 0.02 | 0.02 |
| right reel cited | 0.49 | 0.95 | 0.91 |
| right moment | 0.27 | 0.81 | 0.77 |

By type (n, correct at >= 0.7, at >= 0.5): opening 22, 0.64 and 0.73; detail 53, 0.57 and 0.68; chapter 26, 0.12 and 0.35; timestamp 34, 0.32 and 0.82. By band (correct at >= 0.7): 3-10 min 0.48 (n=27), 30-60 min 0.44 (41), 10-30 min 0.41 (39), 60-120 min 0.32 (25), under 3 min 1.0 (3). By language: Arabic 0.50 (4), Spanish 0.62 (8), English 0.44 (87), Vietnamese 0.44 (27), French 0.17 (6), Korean 0.0 (3 judged of 5); French and Korean are indicative but are the two weakest languages.

Two experiments that did not help and were reverted: Muse for the answer roles (gateway removed altogether), and a 90 s verification budget (same 32 rows: mean 0.548 against 0.552, correct 15 against 14, turn time 37 s against 35 s).

What this run does not settle: why a few turns on long Korean and Vietnamese videos produce no reply at all; the conversation-service log shows write-routing counters (`failed=37115` of `forwarded=113492`) that were not investigated and are outside this work.

### Correction: the unanswered rows were the per-user daily AI turn limit, not an outage (2026-11-25)
The final run's 14 + 5 + 3 unanswered rows were attributed above to a 40-minute outage ("Disconnected from RMQ"). That was wrong. The benchmark account's `ai_turn_day` bucket (`rl:{ai_turn_day:u:<id>}`, limit 300 turns a day, refilling one turn every 288 s) held 0.92 tokens when checked, after about 450 turns that day, so the product's own rate limit rejected turns. A rejected turn produces no chat message (the app is told through a `bot_reply_failed` socket event), which a REST poll reads as "no reply"; the occasional token refill explains why a repeated question answered 1 of 4 times, and why the ai-service log had no workflow at all for the failed attempts. After deleting that one Redis key, the 3 remaining rows answered at once.

Final result, all 138 rows answered and judged (`.benchmarks/diverse-e2e-22-final.json`): judged correct (>= 0.7) **0.43**, at least half right (>= 0.5) **0.66**, mean factual **0.55**, scope refusals 3 (2%), right reel cited 0.93, right moment 0.79. By type (n, >= 0.7, >= 0.5): opening 24, 0.62, 0.71; detail 54, 0.57, 0.69; chapter 26, 0.12, 0.35; timestamp 34, 0.32, 0.82. By band: under 3 min 1.0 (3), 3-10 min 0.48 (27), 30-60 min 0.45 (42), 10-30 min 0.41 (39), 60-120 min 0.33 (27). By language: Arabic 0.50 (4), Spanish 0.62 (8), English 0.44 (87), Vietnamese 0.46 (28), Korean 0.20 (5), French 0.17 (6).

Rule for the next run: the 300-turns-a-day limit is per user. A full run is 138 turns; reset the account's `ai_turn_day` key (and `ai_image_turn_day` for photo runs) before a long run and keep the total under 300 per day, or rows silently go unanswered and read like quality failures. Earlier "no reply" findings in this document (the first photo runs, the bare-phrasing re-run) may share this cause where they cluster late in a day's runs.

### French, traced (2026-11-25)
All 6 French rows answered. Five cited the right video and moment; their judged scores were 0.90 (a privatised-beaches detail question, correct), 0.65 (opening line, correct but omits the reason), 0.55 (an Omonia chapter summary, correct but incomplete), 0.50 (a timestamp answer reproducing one reference sentence) and 0.25 (a detail question that attached the right figure, "once a year", to the wrong group). The sixth, the chapter question for "Intro", cited the right video but a wrong moment and returned garbled transcript text. So French is not failing: three correct-but-partial answers sit just under the 0.7 bar, one detail is wrong and one chapter question is unanswerable by title; "17%" is a sample of 6 against that bar. Korean (5 rows: two chapter rows, an opening, two detail rows) is the same shape; its two detail answers are fluent and grounded, and its chapter rows are unanswerable by title.

### Chapter questions asked the way a Velora user can ask them (2026-11-25)
A chapter row names a YouTube chapter title ("the part titled Licensing basics") that a Velora video does not have, so the bot cannot know where that part starts. `run-diverse-e2e.cjs run --chapter-by-interval` asks the same 26 rows by time instead ("Summarize what is said from 12:10 to 15:30 in the video."), with the same gold interval, reference and judge (`.benchmarks/diverse-e2e-25-chapter-iv.json`, daily turn bucket reset first):

| | by title | by time |
|---|---|---|
| right moment cited | 0.61 | 1.00 (26 of 26) |
| judged correct (>= 0.7) | 3 of 26 | 5 of 26 |
| at least half right (>= 0.5) | 9 | 10 |
| at least 0.3 | 12 | 16 |
| mean factual | 0.31 | 0.40 |
| median answer length | 308 chars | 402 chars |

So the chapter weakness is partly the question form (about a third of it) and partly how much a summary can say: the live draft path uses a purpose-built time-bounded-summary mode (concise paraphrase, evidence scoped to the requested interval) whose answers are proportional to the evidence it is given, and a 5 to 10 minute chapter is judged against its whole text. No code change was made for it.

Finding: the `Requested time` note added to `ChatPromptBuilderAdapter.formatRetrievedReelEvidence` (e0d6ecc8) is not on the live draft path, because `GenerateDraftAnswerUseCase` calls the builder with `includeRetrievedEvidence: false` and supplies evidence separately with stable ids. The timestamp improvement therefore came entirely from the routing fix (19739563), not from that hint.

## Experiment: a larger answer model on Cloudflare (2026-11-25, rolled back)
`CloudflareStructuredLlmAdapter` (e830b211, off by default) lets the roles in `AI_CLOUDFLARE_LLM_ROLES` run on `AI_CLOUDFLARE_LLM_MODEL` through the Cloudflare chat endpoint the vision path already uses, falling back to the local model on any failure. Tested with `@cf/meta/llama-4-scout-17b-16e-instruct` for ANSWER and CONTEXT_SUFFICIENCY on the same 32 rows (8 videos, detail, chapter, timestamp) the local e2b model answered in the final run (`.benchmarks/diverse-e2e-26-cfscout.json`; 4 to 6 s per Scout call, median turn time unchanged at 36 s):

| | local e2b | Cloudflare Scout |
|---|---|---|
| mean factual (32 rows) | 0.524 | 0.423 |
| judged correct (>= 0.7) | 13 | 12 |
| at least half right | 19 | 15 |
| detail (16): mean / correct | 0.63 / 10 | **0.73 / 11** |
| chapter (8): mean / correct | 0.28 / 1 | 0.20 / 1 |
| timestamp (8): mean / correct | 0.55 / 2 | **0.02 / 0** |
| median answer length | 227 chars | 122 chars |

Reading it: the larger model answers detail questions better, but it refuses every timestamp question ("The video transcript does not provide information at the 3:33 timestamp"; none cited) where the local model produced an answer from the retrieved excerpt. The larger model is more literal: it will not treat an excerpt that spans the asked second as saying something "at" that second, and an accurate CONTEXT_SUFFICIENCY verdict now blocks answers the small model's leniency used to let through (the log already showed `context sufficient=false action=REFUSE_NO_CONTEXT` on turns that were answered anyway). The answer, sufficiency and verifier prompts and guards were tuned on the small model, so a model swap needs prompt work (at least for point-in-time and range requests) before it can win. Three ANSWER and two CONTEXT_SUFFICIENCY calls hit Cloudflare 429 (daily free allocation) and fell back to the local model as designed. Not tested: ANSWER only with the local sufficiency check, or the 70B model; both need a paid plan, since the free 10,000 neurons a day are shared with frame analysis (this run used part of the day's allowance, so reel frame analysis could have failed for the rest of that UTC day).

Rolled back: `AI_CLOUDFLARE_LLM_*` removed from the homelab `.env` (backups `env-before-cf-llm-*` and `env-before-cf-llm-rollback-*`), ai-service recreated. To repeat on a paid plan: set `AI_CLOUDFLARE_LLM_ENABLED=true`, `AI_CLOUDFLARE_LLM_MODEL=<model>`, `AI_CLOUDFLARE_LLM_ROLES=ANSWER` (try ANSWER alone first), reset the test account's `ai_turn_day` key, run the 32-row sample, compare with `diverse-e2e-22-final.json`.

## Check: deterministic point-in-time sufficiency (2026-11-25)
`ffc76f2a` answers "what is said at 3:33?" without the CONTEXT_SUFFICIENCY model call when a reranked transcript excerpt spans that second. Same 34 timestamp rows, local e2b model, run on the deployed build (`.benchmarks/diverse-e2e-27-pointrule.json` against `diverse-e2e-22-final.json`):

| | before | after |
|---|---|---|
| mean factual (33 comparable rows) | 0.586 | 0.562 |
| judged correct (>= 0.7) | 10 | 9 |
| at least half right (>= 0.5) | 27 | 22 |
| median turn time | 25 s | 21 s |
| cited the reel / hit the moment | | 33 / 33 of 34 |

Reading it: quality is flat within judge noise (no row fell by more than 0.25; one rose by more than 0.25), and a turn is about 4 s faster. The one unanswered row was sent at 05:34:01, the second the deploy daemon recreated `ai-service` (the same deploy that cleared the homelab-2 outage), so it is a restart artifact. The rule is kept because it removes a model call and is what a more literal answer model needs (the Scout test refused every timestamp question while the sufficiency model could block it). It does not raise the local model's timestamp score; that is limited by the answer style, not the gate.

## Scout for the ANSWER role only, left ON (2026-11-25)
Same 32 rows (8 videos; detail, chapter, timestamp) with `AI_CLOUDFLARE_LLM_ENABLED=true`, `AI_CLOUDFLARE_LLM_MODEL=@cf/meta/llama-4-scout-17b-16e-instruct`, `AI_CLOUDFLARE_LLM_ROLES=ANSWER` on the deployed 6c87c259 build, so CONTEXT_SUFFICIENCY stays on the local model with the point-in-time rule (`.benchmarks/diverse-e2e-28-cfanswer.json`). 31 comparable rows (one unanswered):

| | local e2b | Scout answer+sufficiency | Scout ANSWER only |
|---|---|---|---|
| mean factual | 0.512 | 0.407 | **0.600** |
| judged correct (>= 0.7) | 12 | 11 | **15** |
| at least half right | 18 | 14 | **21** |
| detail (15) mean / correct | 0.614 / 9 | 0.723 / 10 | 0.728 / 10 |
| chapter (8) mean / correct | 0.278 / 1 | 0.205 / 1 | 0.297 / 1 |
| timestamp (8) mean / correct | 0.554 / 2 | 0.019 / 0 | **0.662 / 4** |

The earlier Scout run failed on timestamps because the larger model's sufficiency verdict blocked them; with that role on the local model and the deterministic point-in-time rule, the larger answer model keeps its detail gain and answers timestamps better than the local one did. Chapter summaries are unchanged (still limited by chapter titles being metadata and the one-paragraph answer style). Free allowance was enough for this run (about 110 neurons per answer call); the account is now on Workers Paid. Left on in production with the local model as fallback on any Cloudflare failure. Env backup before the change: `env-before-cf-answer-only-20261125T054756Z`; rollback = remove the three `AI_CLOUDFLARE_LLM_*` lines, restore `env.sha256`, recreate ai-service.
Sample is small (n=31); a wider run follows.

### Wide check of Scout ANSWER-only (2026-11-25, 138 rows)
Opening, detail, chapter and timestamp rows across the benchmark videos (2 per video per type), Scout on ANSWER, against the local-model final run on the same rows (`.benchmarks/diverse-e2e-29-cfwide.json`, 134 comparable):

| | mean factual | judged correct (>= 0.7) | at least half right |
|---|---|---|---|
| all (134) | 0.551 -> **0.608** | 59 -> **69** | 89 -> 91 |
| opening (24) | 0.623 -> 0.670 | 15 -> 17 | 17 -> 17 |
| detail (52) | 0.594 -> **0.722** | 30 -> **38** | 35 -> 42 |
| chapter (25) | 0.318 -> 0.304 | 3 -> 2 | 9 -> 7 |
| timestamp (33) | 0.607 -> 0.613 | 11 -> 12 | 28 -> 25 |

The gain is all in detail questions (+0.13); opening is slightly up; timestamp is flat and chapter is flat to slightly down (within noise, n=25). Four rows have no answer, all sent between 06:22 and 06:35 UTC, right after the daemon deployed bdf5d0c1 (a conversation-service restart at 06:21); ai-service was not restarted. Scout stays on. Chapter summaries remain the weakest type and are next.

## Chapter summaries asked by time range: the one-sentence answers (2026-11-25, fixed in 2783b7d4)
Chapter rows asked the way a user would ask them ("Summarize what is said from 2:11 to 3:22 in the video", `--chapter-by-interval`), Scout on ANSWER, 26 rows. Before the fix: mean 0.491, 8 correct, and many answers were a single sentence of transcript ("Now we'll make the rotis." for a 71 s range).

Trace of one turn: the request was not classified as a summary (`transcriptSegmentRequestKind` needed the word "segment"), so the retrieval plan read 2 chunks (about 16 s) and capped evidence at the small default; the router could also label it `FIRST_COMPLETE_UTTERANCE` (first-sentence answer); and the small model's sufficiency verdict was `REFUSE_NO_CONTEXT`.

Fix (2783b7d4): `isTimeRangeSummaryQuestion` (a summary cue + a speech word + "from X to Y", without the word "segment") makes the request a `SUMMARY` (up to 20 chunks, 3,000-char evidence), stops the first-utterance label, and `CheckContextSufficiencyUseCase` settles sufficiency from the overlapping excerpts when they hold at least 4 characters per requested second (interval capped at 120 s, so a tiny excerpt that merely spans the range does not count). Single seconds, "first words", the old "segment" wording and multi-reel comparisons are unchanged. ai-service: 90 suites, 1434 tests pass.

Measured on the deployed build, same 26 rows (`.benchmarks/diverse-e2e-31-chapter-time-fix.json` against `-30-`):

| | before | after |
|---|---|---|
| mean factual | 0.491 | **0.638** |
| judged correct (>= 0.7) | 8 | **13** |
| at least half right | 14 | **22** |
| unanswered | 0 | 0 |
| median answer | 348 chars | 424 chars |
| range <= 2 min (8 rows) | 0.544 / 3 correct | **0.721 / 5** |
| range 2-5 min (9 rows) | 0.563 / 3 | **0.727 / 6** |
| range > 5 min (9 rows) | 0.371 / 2 | 0.474 / 2 |

Remaining weakness is long ranges: one read returns at most 20 chunks (about 160 s of speech), so a 7-12 minute range is summarised from part of it, and two rows ended in "I found relevant shared Reel evidence, but could not verify a reliable answer" (the verification budget ran out). "Between X and Y" wording is not recognised as a range yet. Two rows fell by more than 0.25 (one is a 39 s range at 0.9 -> 0.6, within judge noise).

Same trace showed Scout's ANSWER output failing local schema validation (`claims[0].evidenceIds`, minItems) twice and falling back to the local model, about 21 s lost per such turn.

### Scout retry that says why the reply was rejected (828ba233, 2026-11-25)
Before: of 38 Scout ANSWER calls in 3 h, 9 had an error (invalid JSON, `evidenceIds` min/maxItems, one timeout) and 5 fell back to the local model (about 20 s each). The retry resent the identical request. Now the second attempt carries the validation reason (gateway errors still retry unchanged). Same 32 rows on the deployed build (`.benchmarks/diverse-e2e-32-retryfix.json`, against `-28-cfanswer`):

| | before | after |
|---|---|---|
| Scout calls with an error | 9 of 38 (24%) | 3 of 27 (11%) |
| fell back to the local model | 5 of 38 (13%) | 1 of 27 (4%) |
| mean factual (31 comparable) | 0.600 | 0.607 |
| judged correct | 15 | 14 |
| median / p90 turn | 38 s / 60 s | 41 s / 59 s |

Reading it: fewer failed calls and fewer fallbacks, but the samples are small (27-38 calls) and answer quality and median turn time did not move; a turn is about 40 s and the Scout answer call is only part of it (local router about 6 s, local sufficiency about 4 s when the rules do not decide it, answer 8-13 s, citations, verification up to its budget). Turn latency, not Scout reliability, is now the larger user-visible cost.

## Router on Scout is not usable yet; constrained JSON kept for the answer role (2026-11-25)
**Router on Scout** (opt-in `query-router-agent.scope.local.integration.spec.ts`, `SCOPE_ROUTER_PROVIDER=cloudflare`, 222 scope rows plus router fixtures; the local model measured 76 of 79 off-topic caught, 0 of 143 in-scope refused):

| | local e2b | Scout, prompt-only schema | Scout, `response_format` json_schema |
|---|---|---|---|
| off-topic caught | 76 / 79 | 49 / 79 (62%) | 64 / 79 (81%) |
| in-scope wrongly refused | 0 / 143 | 0 / 143 | 0 / 143 |
| router call errors | about 0 | 128 of 301 (43%) | 0 |
| median call | about 6 s | 3.5 s | 2.6 s |

The prompt-only schema was ignored on 43% of Scout calls (in a probe it wrote a poem). `AI_CLOUDFLARE_LLM_JSON_SCHEMA=true` (a0ea1ee9, off by default) sends the schema as a strict `json_schema` response format and removes the errors, but Scout still lets general advice and how-to prompts through ("Explain recursion", "Give me tips for a job interview", cover letters, workout plans), below the 85% minimum. The router stays on the local model; a Scout router needs prompt work first.

**Answer role with json_schema** (live on the homelab, backup `env-before-cf-jsonschema-20261125T111216Z`), the same 32 rows run twice (`diverse-e2e-33-jsonschema.json`, `-34-jsonschema-b.json`), 30 rows judged in every run:

| | mean factual | judged correct | Scout calls with an error |
|---|---|---|---|
| retry fix only | 0.597 | 13 | 3 of 27 |
| json_schema, run A | 0.563 | 12 | 0 of 27 |
| json_schema, run B | 0.611 | 16 | 0 of 24 |

Two runs of the same configuration differ by 0.048 on the mean, more than the gap to the baseline, so no quality change is detectable; Scout calls no longer fail or fall back to the local model. Kept on. Median turn stays about 40 s (p90 about 59 s). Lesson for reading every earlier table: run-to-run noise on a 30-row sample is about 0.05 mean and 2-3 correct rows, so differences smaller than that are not findings.

## Where a turn's time goes, and verifier + citations on Scout (2026-11-25, tried and reverted)
Median time per graph node over 63 turns on the homelab (answer on Scout): verifier 8.1 s (p90 20.9), retrieval tools 6.2 s, context sufficiency 4.9 s, citation attribution 4.5 s, draft 4.3 s (p90 19.0), router 3.9 s. Three local-model steps (verifier, sufficiency, citations) are about 17 s of the 37-40 s median turn.

Tried `AI_CLOUDFLARE_LLM_ROLES=ANSWER,VERIFIER,CITATION_ATTRIBUTION` (json_schema on), the same 32 rows (31 judged in all runs; `.benchmarks/diverse-e2e-35-cfverifier.json`):

| | mean factual | correct | median / p90 turn | cited reel | "could not verify" |
|---|---|---|---|---|---|
| answer only, run A | 0.574 | 13 | 40 s / 58 s | 30 / 31 | 0 |
| answer only, run B | 0.620 | 17 | 37 s / 57 s | 30 / 31 | 0 |
| + verifier and citations on Scout | 0.567 | 14 | 39 s / 64 s | 29 / 31 | 0 |

The verifier node itself fell from 8.1 s to 6.0 s median (p90 20.9 to 12.3) and there were no Scout errors or fallbacks, but the whole turn did not get faster (p90 worse), the citation node did not change (4.6 s), the verification budget was exhausted on 9 of 33 turns, and the cited-reel count slipped by one. No gain, so reverted: `AI_CLOUDFLARE_LLM_ROLES=ANSWER` (backups `env-before-cf-verifier-citation-20261125T121000Z`, `env-before-roles-revert-*`; hash gate re-checked). The turn's time is spread over six sequential steps; no single swap removes it. Remaining options are structural (run citation attribution alongside the verifier, shrink the retrieval step) and need workflow changes, not a model swap.

## Direct reel search instead of the tool-planning model: faster, but worse retrieval, left OFF (2026-11-25)
Detail questions on one shared reel spend 7-9 s in `contextToolAgentNode` because a local model plans the tool call (timestamp and opening questions skip it: 20-60 ms). `AI_CONTEXT_TOOL_DIRECT_SEARCH=true` (919faf9b, default off) searches directly with the user's own message when one reel is shared and only reel tools are allowed. Same 32 rows, flag off then on, 32 judged in both (`diverse-e2e-37-ds-off.json`, `-38-ds-on.json`):

| | flag off | direct search on |
|---|---|---|
| mean factual | 0.629 | 0.508 |
| judged correct (>= 0.7) | 17 | 12 |
| cited reel / moment hit | 31 / 28 of 32 | 27 / 25 of 32 |
| detail (16) mean | 0.754 | 0.589 |
| timestamp (8) / chapter (8) mean | 0.628 / 0.380 | 0.522 / 0.331 |
| median turn (detail) | 36 s | 27 s |
| `contextToolAgentNode` median | about 7 s | 1.4 s |

The saving is real (9 s on detail turns) but the planning model is doing useful work: it rewrites the question into a search query that retrieves better than the raw message, and without it detail answers lose 0.17 and the right moment is hit less often. The loss is above the roughly 0.05 run-to-run noise on this sample and shows in three independent measures, so the flag was removed from the homelab env again (backups `env-before-direct-search-*`, `env-before-direct-search-revert-*`; hash gate checked). The code stays, off by default. A possible follow-up: keep the shortcut but build the query deterministically (drop the question wording, keep the content words) and re-measure; not done.

## French and Korean, and the evidence probe limit 0.48 -> 0.50 (2026-11-25, 103779d6)
Each language has one video and 11 reviewed rows (17 run with the default split), so these are single-video results. On the production setup of that day (Scout answers, range fix, constrained output), `diverse-e2e-39-frko.json`:

| | mean factual | judged correct | earlier local-model run, same rows |
|---|---|---|---|
| French (8 rows) | 0.628 | 5 (62%) | 0.478 / 1 of 6 |
| Korean (9 rows) | 0.416 | 3 (33%) | 0.204 / 1 of 5 |

Misses: a French cooking question about the shared video was refused as off-topic; a Korean "first thing said" ended in "could not verify"; Korean detail answers were verbatim transcript excerpts instead of the asked fact; the French "Intro" chapter-by-title row cannot work without titles.

The off-topic refusal was the evidence probe (`ISharedReelEvidenceProbe`, 0.48 limit calibrated on 60 English questions): that question's closest chunk was at 0.496. Re-measured on 55 non-English detail questions (vi 28, es 10, ar 6, ko 6, fr 5; own video vs an unrelated English video): own video within 0.42 / 0.48 / 0.50 / 0.55 for 64% / 89% / 95% / 100% (median 0.40); an unrelated video within 0.48 and 0.55 for 0%. The default limit is now 0.50 (English calibration: own 93% -> 97%, unrelated 2% -> 3%). Checks on the deployed build: the general-question control (6 questions: TCP vs UDP, the sky, optimistic locking, project retrospective, capital of Australia, binary search tree) was rerouted 0 of 6 on each of the English, French and Korean videos, all refused as off-topic; the French and Korean rows scored French 0.628 -> 0.632 (4 correct), Korean 0.416 -> 0.459 (3 correct), scope refusals 1 -> 0. Unchanged within noise except the refusal that is gone.

## Sampling a long summary range across its whole length: worse, left OFF (2026-11-25, c001cae7)
Cause of the weak ranges over 5 minutes (about 0.47): for one reel the engine does one chronological `searchChunks` read capped at 20 chunks, ordered by start time, so a 7-12 minute range returned only its first 2-3 minutes. Chronological reads exist only for chunks and visual scenes (not sections), and the indexer runs on a pinned image, so the change stayed in ai-service: a summary range over 150 s read as up to 8 sub-windows, a few chunks each, merged in order (same evidence size, whole-range coverage).

Measured on the 26 chapter-by-time rows (`diverse-e2e-41-chapter-sampled.json` against `-31-chapter-time-fix.json`):

| | before | sampled |
|---|---|---|
| all (26) | 0.638 / 13 correct | 0.569 / 13 |
| range <= 5 min (17, unchanged code path) | 0.724 / 11 | 0.673 / 11 |
| range > 5 min (9) | 0.474 / 2 | 0.372 / 2 |
| ended in "could not verify" | 2 | 5 |

The unchanged short ranges moved by 0.05, which is the noise floor, so the long-range drop (-0.10) is only just above it; the "could not verify" count (2 to 5, four of the five on sampled ranges plus a 200 s one) is the clearer signal: a summary of scattered excerpts gives the local verifier claims it cannot tie to one stretch of evidence, so it fails closed. No gain, so sampling was switched off in production (`AI_TRANSCRIPT_RANGE_SAMPLING=false`, backup `env-before-sampling-off-*`, hash gate checked) and the code default is now opt-in. A different approach would be needed for long ranges, for example summarising each sub-window separately with the answer model and combining the parts, which was not tried.

## What is left, why, and what each item would take (2026-11-25)
State: overall judged correct about 51% on the 134-row wide set (12% at the start); French 62% and Korean 33% on one video each; detail 0.72, opening 0.67, timestamp 0.61, chapter-by-time 0.64 (mean factual). Run-to-run noise on a 30-row sample is about 0.05 mean and 2-3 correct rows, so differences smaller than that are not findings.

**Timestamp answers (12 of 33 judged correct, mean 0.61).** Not a retrieval problem: the moment is hit on 33 of 33 rows. Score distribution: 1 row below 0.3, 7 at 0.3-0.5, 13 at 0.5-0.7, 12 at 0.7 or above; 25 of 33 are at least half right and 19 are partial (0.4-0.69). Answer length and reference-window length are the same for correct and missed rows (about 10 characters per window-second, median 497 characters against a 48 s window), so it is not a length mismatch: the bot returns the excerpt nearest the asked second and the reference is a 30-50 s caption window, and the two overlap only partly. Exactly one miss is bad index text (a Whisper hallucination over music: a channel promo mixed with Korean words), which no answer-side change can fix. Reference tier matters little (manual 0.68, auto-caption 0.59). What would move it: either returning the neighbouring excerpts too (a draft-path change for point questions, which is deterministic today) or judging against the excerpt window; neither is a small change and neither changes what a user sees much, since the right passage is already returned.

**Turn time (median 37-40 s, p90 about 60 s).** Six sequential steps: verifier 8.1 s, retrieval/tool planning 6.2 s (7-9 s on detail questions, about 0 on timestamp questions), sufficiency 4.9 s, citations 4.5 s, draft 4.3 s, router 3.9 s. Tried and rejected with numbers above: Scout as router (fails the scope bar), verifier and citations on Scout (no turn-time gain), direct reel search (turn 36 to 27 s but detail 0.75 to 0.59). Ruled out by measurement: running citation attribution alongside the verifier. The local model serves one request at a time: three identical 120-token requests take 3.5 s each sequentially; two at once finish in 3.7 s and 7.6 s (wall 7.6 s against 7.1 s sequential), three at once in 3.5, 7.0 and 10.6 s (wall 10.6 s against 10.7 s). The router, sufficiency, verifier and citation calls (about 21 s of a 37 s turn) are therefore a serial queue on one 4 GB laptop GPU (RTX 3050, gemma4:e2b at 4096 context), and overlapping two of them gains nothing; only moving calls to a remote model (which did not help for the verifier and citations) or removing them (the deterministic sufficiency rules) shortens the turn. Not tried: a deterministic keyword query for the search.

**Ranges over 5 minutes (about 0.47).** A single chronological read returns the first 20 chunks (2-3 minutes) and there is no chronological read for sections; the indexer runs on a pinned image. Sub-window sampling made it worse (0.37, more "could not verify"). Untried: summarise each sub-window separately and combine (several model calls per question), or add a chronological section read to the indexer (manual image deploy).

**Chapter by title.** The titles are YouTube chapter metadata that the index does not contain, so these rows measure whether the bot can guess an author-chosen heading; by-time is the form a user can ask and scores 0.64. Putting titles into the index needs them at upload time (not available for ordinary uploads).

**Language coverage.** French and Korean have one video and 11 reviewed rows each. More videos per language (sourcing, indexing, question writing) is the only way to turn these into per-language numbers.

## The context-sufficiency model call changes nothing in practice (2026-11-26, measured, not changed)
`allowsGroundedGeneration` (rag-context-policy.ts) treats the model's sufficiency verdict as advisory whenever the required evidence types were retrieved; the answer step and the verifier are the grounding boundary. Counted over the 25 turns of the 32-row baseline run on the deployed build (`diverse-e2e-42-suff-base.json`): 17 turns (68%) got `sufficient=false action=REFUSE_NO_CONTEXT`, 8 got `sufficient=true action=ANSWER`, none got `REWRITE_AND_RETRY`, no retrieval repair ran, and every turn was answered. 20 of the 25 turns paid the local CONTEXT_SUFFICIENCY call (median 4.9 s, about a quarter of the roughly 21 s of serial local-model time in a turn); the other 5 were decided by the deterministic rules.

So the call is overhead for the routing, but removing it is not free: a `sufficient=true` verdict adds a draft-prompt line ("do not refuse solely because the answer uses separate required modalities... answer every supported part") and narrows the evidence to the supported ids, while the 68% of turns with a refuse verdict get neither. A shortcut that returns `sufficient=true` would therefore make those turns answer more eagerly, which raises the risk of answering a question the video does not cover. The benchmark has no such rows, so that risk cannot be measured with it. Plan if this is wanted: (1) build 30-40 in-scope questions the shared video does not cover (a detail question from another video of the same genre asked against this one; the expected outcome is an abstention) and measure the answer rate on them with the model call on; (2) add a default-off shortcut that keeps the current prompt behaviour (needs a policy field, since `allowsGroundedGeneration` rejects a result with `providerStatus` NOT_CALLED unless `sufficient` is true); (3) compare answer quality and the absent-topic answer rate; keep it only if the absent-topic rate does not rise. Expected gain: about 4 s per turn and a quarter less serial local-model load.

## Questions the video does not cover: the bot answered 68% of them; fixed with an evidence-distance guard (2026-11-26, ae8812b6, live)
The benchmark had no unanswerable rows, so this was never measured. Built 40 in-scope absent-topic questions without a model: a detail question from one English video asked about a different English video, phrased "In this video, ...", with non-technical targets getting questions from technical videos and the reverse (no topic overlap; `.benchmarks/absent-topic-guard-off.json`). Classified by answer text (abstains / scope refusal / answers).

Before: 27 of 40 (68%) were answered, 24 of those with a citation, usually by presenting an unrelated transcript excerpt as the answer (a licensing question about a cooking video got "add a little oil while cooking it's ready now this roti is very soft..."; a Scratch question about a news video got a sentence about a petition). 8 abstained ("could not verify" and similar), 5 were scope refusals. The verifier does not catch it: the excerpt is really in the video, so it is grounded; it is just not relevant. The sufficiency model's refuse verdicts do not stop it either (the routing treats the verdict as advisory when the required evidence type was retrieved).

The separating signal is the vector distance of the closest retrieved excerpt, measured through the production index on 79 covered and 40 uncovered questions: covered median 0.39 (p90 0.47, max 0.64), uncovered median 0.59 (min 0.48). At a limit of 0.55: 97.5% of covered questions stay (77/79) and 85% of uncovered are turned away; 0.52 turns away 92.5% at the same 97.5%, 0.50 turns away 95% but keeps 96.2%. 0.55 was chosen because wrongly refusing a covered question is worse than answering an uncovered one and non-English questions sit slightly farther from their video.

`CheckContextSufficiencyUseCase` now refuses an ordinary transcript question (not time-bound, not chronological, not a multi-reel comparison, not visual, not a first-sentence request) without a model call when every retrieved excerpt has a numeric distance and even the closest is above `AI_CONTEXT_MAX_EVIDENCE_DISTANCE` (0.55): "I could not find anything about that in the shared video..." It fails open when any distance is missing. On by default; `AI_CONTEXT_EVIDENCE_DISTANCE_GUARD=false` turns it off.

Verified live (guard on vs the same build with it off, `absent-topic-guard-on.json`, `diverse-e2e-43-guard-on.json` against `-42-suff-base.json`):

| | guard off | guard on |
|---|---|---|
| absent-topic questions answered (40) | 27 (68%) | **4 (10%)** |
| abstained / scope refusal | 8 / 5 | 30 / 6 |
| regular 32 rows, mean factual (30 judged in both) | 0.628 | 0.614 |
| judged correct / at least half right | 14 / 19 | 14 / 19 |
| regular rows newly refused | - | 1 of 30 (a French chapter-by-title row that had scored 0.45) |

Quality is unchanged within noise; the price is about 3% of covered questions refused, as the distance table predicted. Of the 4 absent-topic questions still answered, two have a closest excerpt under the limit (0.475 and 0.498). The gate caught one mistake on the way: the new rule read the config unguarded and broke 18 stress-spec tests whose config mock has no `get`; it now uses `get?.`, as the draft use case does. Env: `AI_CONTEXT_EVIDENCE_DISTANCE_GUARD=true` set on the homelab (backup `env-before-distance-guard-live-*`) and the code default is now on.

### The reranker as a second signal for the not-covered guard (2026-11-26, 370a849a, live)
The distance guard left 4 of 40 uncovered questions answered, with closest excerpts at 0.475-0.54. The neural reranker (a cross-encoder) judges relevance directly: on the 119 covered/uncovered questions its best score has a median of 0.568 for covered and 0.000 for uncovered ones (p90 0.003, max 0.123), but 27% of covered questions also score near 0 on their own, so alone it would refuse them. Together with distance: refuse when the closest excerpt is above 0.47 AND the best rerank score is below 0.01. Calibration (79 covered, 40 uncovered): all 40 uncovered refused (the 0.55 distance limit alone: 34) and no covered question refused beyond the same 2 the distance limit already refuses. The covered questions with a near-zero rerank score sit at distance 0.39-0.47; one covered question (0.493, 0.011) is just above the cut, so the thresholds are tuned on a narrow margin.

Two traps on the way. (1) My probes sent several texts per rerank call; the reranker runs with `--max-concurrent-requests 1` and the production client (`TeiRerankerAdapter`, batch size = that limit) sends one text per request, so multi-text probes get "Model is overloaded" (a restart of the reranker, and retrying probes that flooded it, looked like an outage; production was never affected: 4 real turns, 0 fallbacks, 51 reranks in 6 minutes). A short real Qdrant blip at about 19:04 UTC (about 2 minutes, 109 indexer errors; Qdrant up since 19:06) was not caused by this work. (2) The first implementation required a score on every reranked excerpt; the reranker scores only its top 8 candidates and the neighbouring excerpts added around them carry none, so it failed open on every turn (the debug log added in 794a40e7 showed `rerankScored=8` of `reranked=13-16`, best rerank 0.0001-0.0002 on four uncovered questions). Fixed to let the scored excerpts decide.

Verified live on the 40 uncovered questions and the 32 regular rows: guard off 27 answered; distance only 4; rerank signal inert (bug) 4; rerank signal fixed **2** (6 scope refusals, 32 abstentions). Regular rows: distance only 0.624 / 15 correct, inert 0.593 / 15, fixed 0.585 / 14 correct (22 at least half right, 31 of 32 answered, 0 rows newly refused against the inert run); differences are within the 0.05 run-to-run noise. The guard now logs `closestDistance`, excerpt, reranked and scored counts and the best rerank score at debug level on every ordinary transcript turn, which is the way to retune it. Live: `AI_CONTEXT_EVIDENCE_RERANK_GUARD=true` (backup `env-before-rerank-guard-live-*`); code default on, `=false` turns it off; `AI_CONTEXT_SOFT_EVIDENCE_DISTANCE` (0.47) and `AI_CONTEXT_MIN_RERANK_SCORE` (0.01) tune it. Absent-topic answer rate: 68% at the start of the day, 5% now.

Non-English check of the not-covered guard (2026-11-26): the thresholds were calibrated on English questions, and the reranker scores non-English questions lower (best rerank median vi 0.11, es 0.11, fr 0.41, ko 0.86, ar 0.89, against 0.57 for English), so the combined rule could in principle refuse covered ones. Measured on the 55 covered non-English detail questions (vi 28, es 10, ar 6, ko 6, fr 5) with single-text reranker calls like production: the closest excerpt is above 0.55 for none of them and above 0.47 for 8; 6 have a best rerank score below 0.01; the live rule (distance > 0.55, or distance > 0.47 and rerank < 0.01) refuses **0 of 55**, and the distance limit alone refuses 0. The distance condition is what protects them: a low rerank score only counts when the excerpt is also moderately far. Sample is small per language (5-28).
