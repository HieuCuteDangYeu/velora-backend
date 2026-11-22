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
