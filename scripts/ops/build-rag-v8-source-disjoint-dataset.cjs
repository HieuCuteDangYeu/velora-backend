#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

const root = path.resolve(__dirname, '../..');
const runDir = path.join(root, '.benchmarks/rag-remediation-v8-20261026-01');
const sourceDir = path.join(runDir, 'source');
const datasetDir = path.join(runDir, 'dataset-v8-source-disjoint-20261026-03');
const datasetVersion = 'rag-v8-source-disjoint-20261026-03';
const developmentIds = new Set([
  '233c6609-35da-4d33-b901-1a9f5df80369',
  'd839b7ca-2770-4ccc-b423-e161c8462401',
  '62393976-fc6a-4082-b112-662ed08eec14',
  'a5946e98-0518-430c-9029-c2013f6a3692',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const transcriptCases = {
  '233c6609-35da-4d33-b901-1a9f5df80369': [
    [0, 'What promise about war does the father make if she marries into the other kingdom?', 'He says there will be no more war once she marries into their kingdom.'],
    [0, 'How does the mother describe the vampire clan?', 'She calls it a den of wolves.'],
    [0, 'What does the mother fear about saying farewell?', 'She fears that this is farewell forever.'],
    [1, 'What does the prince say about the marriage?', 'He says he never meant to marry her and that it was all an act.'],
    [1, 'What does the sister say about the marriage?', 'She says the marriage was never meant to be hers.'],
    [1, 'How does the narrator describe her kingdom and love?', 'She says her kingdom does not want her and her love abandoned her.'],
    [1, 'Who does the narrator say betrayed her?', 'She says her sister betrayed her.'],
  ],
  'd839b7ca-2770-4ccc-b423-e161c8462401': [
    [0, 'What does the speaker ask their parents to forgive?', 'The speaker asks their father and mother to forgive them.'],
    [0, 'What does Lucy say she can no longer be?', 'She says she can no longer be a pawn.'],
    [0, 'Who does the transcript say cast Lucy out?', 'It says Ben cast her out.'],
    [0, 'Who does Lucy say betrayed her?', 'She says Lily betrayed her.'],
    [0, 'What does William say about pity?', 'He says he never pities anyone.'],
    [0, 'What does William say he wants?', 'He says he wants Lucy as his wife.'],
    [0, 'What title does William give Lucy, and what does he say about anyone who slights her?', 'He says Lucy is his countess and that whoever slights her makes an enemy of him.'],
  ],
  '62393976-fc6a-4082-b112-662ed08eec14': [
    [0, 'What does William say he wants from her?', 'He says he wants her heart, not her obedience.'],
    [0, 'How long do they say they have known each other?', 'They say they have known each other for only one day.'],
    [0, 'What does he say about belonging to him?', 'He says that from that night on she belongs only to him.'],
    [0, 'How does the speaker describe being forced into the marriage?', 'The speaker says she was forced into the marriage.'],
    [0, 'Why does the speaker say his embrace feels safe?', 'She says his embrace makes her feel safe.'],
    [1, 'How long does Lucy say she has waited for this day?', 'She says she has waited ten years for this day.'],
    [1, 'What does the transcript say the Count did with the flowers?', 'The Count had the flowers transplanted from her homeland just for her.'],
  ],
  'a5946e98-0518-430c-9029-c2013f6a3692': [
    [0, 'What does the speaker say happened to her fiancé?', 'She says her sister stole her fiancé.'],
    [0, 'What does the transcript say about the one woman in his heart?', 'It says there has only ever been one woman in his heart.'],
    [0, 'How does the speaker describe the woman he has not forgotten?', 'She says the woman is his first love.'],
    [1, 'What does the speaker call herself in relation to his first love?', 'She says she is just a substitute.'],
    [1, 'Why does Lucy ask why he married her?', 'She asks whether he married her to pity her or to humiliate her.'],
    [1, 'What does Lucy ask William about the woman he cannot forget?', 'She asks who the woman he cannot forget is.'],
    [1, 'What does William finally tell Lucy about that woman?', 'He tells her that the woman has always been her.'],
  ],
  'da64f40a-de3a-4497-87bb-01fbb6234d5c': [
    [0, 'Who does the woman say she saved in the forest?', 'She says she saved a boy in the forest.'],
    [0, 'How long ago did she save the boy?', 'She says it was ten years ago.'],
    [0, 'Where was the boy lying, and what condition was he in?', 'He was lying by a stream and covered in blood.'],
    [0, 'How long does she say she watched over him?', 'She watched over him all night.'],
    [0, 'How does she describe her feelings for him?', 'She says he is the only man she ever loved.'],
    [0, 'Why is the man afraid to tell her the truth?', 'He is afraid she will not believe him.'],
    [0, 'What does the adviser say about delaying the truth?', 'He says dragging it on hurts them both.'],
  ],
  'cf32eb98-9bc5-4fbb-a034-19a171b71e3f': [
    [0, 'How long does William say he remembered that one glance?', 'He says he remembered it for ten years.'],
    [0, 'What does she ask him after recognizing the memory?', 'She asks why he did not tell her sooner.'],
    [1, 'What is William afraid she remembers without loving him?', 'He is afraid she only remembered the boy and did not love him.'],
    [1, 'What does William call her?', 'He calls her a fool.'],
    [1, 'What does William say about his first love?', 'He says she was his first love too.'],
    [1, 'What promise does William make about protecting her?', 'He says he will guard her for the rest of his life.'],
    [1, 'What does William say he will never let her get away with?', 'He says he will never let her get away with this.'],
  ],
  'b439472b-926d-42c9-98a1-137746b18398': [
    [0, 'What does Aiyuan say they pledged by the river?', 'He says they pledged by the river.'],
    [0, 'What does Aiyuan say the jade was?', 'He says the jade was her token.'],
    [0, 'What does the woman say when she rejects his claim?', 'She says, "I do not know you" and calls him a liar.'],
    [1, 'What does the Count say he is looking for?', 'He says he is looking for his betrothed.'],
    [1, 'What does the man say about the scrap of jade?', 'He asks whether a scrap of jade is enough to slander his wife.'],
    [2, 'What warning does the man give Vivian?', 'He says that if she touches her again, he will forget they are family.'],
    [2, 'What does the speaker say about whom they believe?', 'The speaker says, "In this world, I believe only you."'],
  ],
  'f06a9b8f-37b8-4a48-a902-58b286883e0b': [
    [0, 'Why does the speaker say the food was prepared?', 'The speaker was afraid she would not get used to the food there.'],
    [0, 'How does the narrator describe how the Count treats her?', 'The narrator says the Count spoils her beyond measure.'],
    [0, 'What does the Count say he will do to whoever laughs at her?', 'He says he will punish them.'],
    [0, 'What does the speaker say has happened to her?', 'She says she has been crying.'],
    [0, 'What question does the speaker ask about dragging him down?', 'She asks, "Am I dragging you down?"'],
    [0, 'What does the speaker say she would be without him?', 'She says she would be an empty shell.'],
    [0, 'What does the speaker say about loving her despite opposition?', 'He says that even if the world opposes it, he wants her.'],
  ],
};

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return shortHash(fs.readFileSync(file));
}

function buildDataset() {
  const source = readJson(path.join(sourceDir, 'content-index-snapshot-v2-safe.json'));
  const visualReview = readJson(path.join(sourceDir, 'visual-frame-review-agent-v1.json'));
  const visualCapture = readJson(path.join(sourceDir, 'visual-frame-capture.json'));
  const v7Path = path.join(
    root,
    '.benchmarks/rag-remediation-v7-20261022-01/dataset-v7-visual-reviewed-20261022-02',
  );
  const v7Rows = ['development', 'held_out', 'operational'].flatMap((name) =>
    readJson(path.join(v7Path, `${name}.json`)),
  );
  const v7Sources = new Set(
    [...new Set(JSON.stringify(v7Rows).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])].map((id) => id.toLowerCase()),
  );
  const documents = new Map(source.documents.map((doc) => [doc.reelId, doc]));
  const chunks = new Map(source.transcriptChunks.map((chunk) => [chunk.id, chunk]));
  const scenes = new Map(source.reviewedVisualScenes.map((scene) => [scene.id, scene]));
  const records = new Map(source.contentRecords.map((record) => [record.id, record]));
  const metadata = new Map(source.contentIndexMetadata.map((record) => [record.id, record]));
  const splitByReel = new Map();
  for (const reelId of developmentIds) splitByReel.set(reelId, 'DEVELOPMENT');
  for (const reelId of metadata.keys())
    if (!splitByReel.has(reelId)) splitByReel.set(reelId, 'HELD_OUT');

  if (source.schemaVersion !== 'rag-v8-source-snapshot-v2')
    throw new Error('unsupported V8 source snapshot');
  if (visualReview.status !== 'PASS' || visualReview.humanApproved !== false)
    throw new Error('V8 image review is incomplete or has wrong authority');
  if (metadata.size !== 9 || records.size !== 9 || documents.size !== 9)
    throw new Error('V8 source snapshot must contain 9 accessible, indexed Reels');
  for (const reelId of metadata.keys()) {
    if (v7Sources.has(reelId)) throw new Error(`V8 source overlaps V7: ${reelId}`);
    const content = metadata.get(reelId);
    const document = documents.get(reelId);
    if (
      content.indexStatus !== 'COMPLETED' ||
      content.mediaStatus !== 'COMPLETED' ||
      !document ||
      content.indexAttemptId !== document.indexAttemptId ||
      content.indexVersion !== document.indexVersion
    )
      throw new Error(`V8 Reel is not bound to its active document: ${reelId}`);
  }
  for (const record of [
    ...source.documents,
    ...source.transcriptChunks,
    ...source.reviewedVisualScenes,
  ]) {
    if (record.indexAttemptId !== metadata.get(record.reelId)?.indexAttemptId)
      throw new Error(`V8 evidence is not from the active index attempt: ${record.id}`);
  }

  const visualReviews = new Map(visualReview.cases.map((item) => [item.caseId, item]));
  const capturedFrames = new Map(
    visualCapture.frames.map((frame) => [`${frame.reelId}:${frame.ordinal}`, frame]),
  );
  if (
    visualCapture.schemaVersion !== 'rag-v8-visual-frame-capture-v1' ||
    visualCapture.frameCount !== 16 ||
    visualCapture.frames.length !== 16
  )
    throw new Error('V8 exact frame capture is incomplete');
  for (const review of visualReview.cases) {
    const scene = scenes.get(review.sceneId);
    const frame = capturedFrames.get(`${review.reelId}:${review.ordinal}`);
    const content = metadata.get(review.reelId);
    if (
      !scene ||
      !frame ||
      review.decision !== 'ANSWERABLE' ||
      !review.indexAttemptMatches ||
      !review.timestampMatches ||
      !fs.existsSync(path.resolve(root, review.framePath)) ||
      sha256File(path.resolve(root, review.framePath)) !== review.frameSha256 ||
      frame.frameSha256 !== review.frameSha256 ||
      frame.mediaAttemptId !== content.mediaAttemptId ||
      frame.manifestKeySha256 !== content.manifestKeySha256 ||
      frame.indexAttemptId !== content.indexAttemptId ||
      scene.indexAttemptId !== content.indexAttemptId ||
      Math.abs(frame.timestampMs / 1000 - scene.startTime) > 0.01
    )
      throw new Error(`V8 visual source review is not bound: ${review.caseId}`);
  }

  const cases = [];
  const bucketCounts = {};
  function add({ reelIds, bucket, answerType, question, answer, evidenceIds, evidenceTypes, reviewNote }) {
    const split = splitByReel.get(reelIds[0]);
    if (!split || reelIds.some((id) => splitByReel.get(id) !== split))
      throw new Error('A V8 item crosses the development/held-out Reel split');
    const id = `rag-v8-03-${String(cases.length + 1).padStart(4, '0')}`;
    const sourceRows = evidenceIds.map((evidenceId, index) => {
      const type = evidenceTypes[index];
      const sourceRow =
        type === 'TRANSCRIPT'
          ? chunks.get(evidenceId)
          : type === 'VISUAL'
            ? scenes.get(evidenceId)
            : documents.get(reelIds.find((reelId) => evidenceId === `reel:${reelId}`));
      if (type !== 'METADATA' && !sourceRow)
        throw new Error(`V8 source evidence missing: ${evidenceId}`);
      return { evidenceId, evidenceType: type, sourceHash: sourceRow?.evidenceHash ?? null };
    });
    const item = {
      id,
      input: {
        question,
        reelIds,
        evidenceIds,
        ...(new Set(evidenceTypes).size === 1 ? { modality: evidenceTypes[0] } : {}),
      },
      expectedOutput: {
        answer,
        answerType,
        reelIds: answerType === 'ABSTENTION' ? [] : reelIds,
        evidenceIds,
        relevantEvidenceGroups: evidenceIds.map((evidenceId) => [evidenceId]),
        expectedEvidenceTypes: evidenceTypes,
        assertions: [
          'Use only the authorized Reel evidence named by the question.',
          'Do not infer a speaker identity or non-speech sound from a still image or transcript.',
        ],
        ...(new Set(evidenceTypes).size === 1 && evidenceTypes.length
          ? { modality: evidenceTypes[0] }
          : {}),
      },
      metadata: {
        datasetVersion,
        bucket,
        split,
        answerType,
        language: 'en',
        annotationStatus: 'AGENT_REVIEWED_CANDIDATE',
        annotationSource: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
        reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
        humanApproved: false,
        historicallyUnseenSources: true,
        reelIds,
        evidenceIds,
        sourceEvidence: sourceRows,
        sourceSnapshotSha256: fingerprint(source),
        visualReviewSha256: shortHash(fs.readFileSync(path.join(sourceDir, 'visual-frame-review-agent-v1.json'))),
        reviewNote,
      },
    };
    cases.push(item);
    bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    return item;
  }

  for (const [reelId, definitions] of Object.entries(transcriptCases)) {
    const doc = documents.get(reelId);
    for (const [ordinal, query, answer] of definitions) {
      const chunk = source.transcriptChunks.find(
        (item) => item.reelId === reelId && item.ordinal === ordinal,
      );
      if (!chunk) throw new Error(`missing transcript chunk ${reelId}:${ordinal}`);
      add({
        reelIds: [reelId], bucket: 'TRANSCRIPT', answerType: 'SEMANTIC_FACTS',
        question: `In "${doc.title}", ${query} Refer to the indexed dialogue at ${chunk.startTime}-${chunk.endTime} seconds.`,
        answer,
        evidenceIds: [chunk.id], evidenceTypes: ['TRANSCRIPT'],
        reviewNote: `Reference checked against ${chunk.id}.`,
      });
    }
  }

  for (const review of visualReview.cases) {
    const scene = scenes.get(review.sceneId);
    add({
      reelIds: [review.reelId], bucket: 'VISUAL', answerType: 'SCENE_DESCRIPTION',
      question: review.question,
      answer: review.referenceAnswer,
      evidenceIds: [scene.id], evidenceTypes: ['VISUAL'],
      reviewNote: review.observation,
    });
  }

  const combinedCases = [
    ['233c6609-35da-4d33-b901-1a9f5df80369',8,0,`Describe the visible gown and jewelry, then state what the narrator fears about the farewell.`,`Visible: a woman in a purple gown with a jeweled crown and pearl jewelry. Said: the narrator fears this is farewell forever.`],
    ['233c6609-35da-4d33-b901-1a9f5df80369',23,1,`Describe what the woman is doing, then say what the narrator says about her kingdom.`,`Visible: a woman in a white wedding dress and veil is kneeling on the floor. Said: she says her kingdom does not want her.`],
    ['62393976-fc6a-4082-b112-662ed08eec14',0,0,`Describe the man's robe, then say what he wants from her.`,`Visible: the man wears an open blue robe. Said: he wants her heart, not her obedience.`],
    ['62393976-fc6a-4082-b112-662ed08eec14',20,1,`Describe the woman's necklace, then say how long she has waited for this day.`,`Visible: she wears a necklace with a pendant. Said: she has waited ten years for this day.`],
    ['a5946e98-0518-430c-9029-c2013f6a3692',0,0,`Describe the woman's dress and crown, then say who the speaker calls his first love.`,`Visible: she wears a blue dress and a gold crown. Said: the speaker refers to his first love.`],
    ['a5946e98-0518-430c-9029-c2013f6a3692',23,1,`Describe the man's visible expression, then say what Lucy asks William.`,`Visible: the man has tears on his cheeks. Said: Lucy asks who the woman he cannot forget is.`],
    ['b439472b-926d-42c9-98a1-137746b18398',12,1,`Describe the man's coat, then state what he says about the scrap of jade.`,`Visible: the man wears a black coat with gold embroidery. Said: he asks whether a scrap of jade is enough to slander his wife.`],
    ['b439472b-926d-42c9-98a1-137746b18398',23,2,`Describe the pendant, then say what the speaker says about whom they believe.`,`Visible: a hand holds a white pendant with a cloud design. Said: the speaker says that in this world they believe only the other person.`],
    ['cf32eb98-9bc5-4fbb-a034-19a171b71e3f',12,1,`Describe what the two people are doing, then say what William says he will do for her.`,`Visible: the woman in white embraces the man. Said: William says he will guard her for the rest of his life.`],
    ['cf32eb98-9bc5-4fbb-a034-19a171b71e3f',20,0,`Describe the woman's clothing and headwear, then say how long William remembered the glance.`,`Visible: she wears a blue dress and a jeweled crown. Said: he remembered the glance for ten years.`],
    ['d839b7ca-2770-4ccc-b423-e161c8462401',0,0,`Describe what is beyond the woman, then say who cast Lucy out.`,`Visible: a woman in white stands on a rocky cliff facing a castle under the moon. Said: Ben cast Lucy out.`],
    ['d839b7ca-2770-4ccc-b423-e161c8462401',20,0,`Describe the man's jacket, then state what William says he wants.`,`Visible: the man wears a dark blue ornate jacket. Said: William says he wants Lucy as his wife.`],
    ['da64f40a-de3a-4497-87bb-01fbb6234d5c',4,0,`Describe the hand near the woman's arm, then say what the woman says about the boy she saved.`,`Visible: another hand reaches toward the woman's arm. Said: she saved a boy in the forest.`],
    ['da64f40a-de3a-4497-87bb-01fbb6234d5c',16,0,`Describe the young man's jacket, then say how long ago the boy was saved.`,`Visible: the young man wears a dark blue jacket. Said: the boy was saved ten years ago.`],
    ['f06a9b8f-37b8-4a48-a902-58b286883e0b',16,0,`Describe what the man and woman are doing, then say what she asks about dragging him down.`,`Visible: the man and woman embrace. Said: she asks whether she is dragging him down.`],
    ['f06a9b8f-37b8-4a48-a902-58b286883e0b',23,0,`Describe what the older man is holding, then say what the Count will do to people who laugh at her.`,`Visible: the older man holds a tan envelope sealed with red wax. Said: the Count says he will punish whoever laughs at her.`],
  ];
  for (const [reelId, sceneOrdinal, chunkOrdinal, query, answer] of combinedCases) {
    const scene = source.reviewedVisualScenes.find((item) => item.reelId === reelId && item.ordinal === sceneOrdinal);
    const chunk = source.transcriptChunks.find((item) => item.reelId === reelId && item.ordinal === chunkOrdinal);
    const doc = documents.get(reelId);
    if (!scene || !chunk) throw new Error(`combined evidence missing for ${reelId}`);
    add({
      reelIds: [reelId], bucket: 'COMBINED', answerType: 'MULTIMODAL_FACTS',
      question: `For "${doc.title}", ${query} The frame is at ${scene.startTime} seconds; use the indexed transcript segment at ${chunk.startTime}-${chunk.endTime} seconds.`,
      answer,
      evidenceIds: [scene.id, chunk.id], evidenceTypes: ['VISUAL', 'TRANSCRIPT'],
      reviewNote: `Visible claim reviewed against frame ${scene.id}; spoken claim checked against ${chunk.id}.`,
    });
  }

  for (const reelId of Object.keys(transcriptCases)) {
    const doc = documents.get(reelId);
    const tags = records.get(reelId)?.tags;
    if (!Array.isArray(tags) || !tags.length) throw new Error(`metadata tags missing for ${reelId}`);
    add({
      reelIds: [reelId], bucket: 'METADATA', answerType: 'EXACT_TITLE',
      question: 'What is the exact title of the shared Reel?', answer: doc.title,
      evidenceIds: [doc.id], evidenceTypes: ['METADATA'],
      reviewNote: 'Exact title checked against the current Content record.',
    });
    add({
      reelIds: [reelId], bucket: 'METADATA', answerType: 'TAG_SET',
      question: `Which tags are attached to "${doc.title}"?`, answer: tags.join(', '),
      evidenceIds: [doc.id], evidenceTypes: ['METADATA'],
      reviewNote: 'Tag list checked against the current Content record.',
    });
  }

  for (const reelId of Object.keys(transcriptCases)) {
    const doc = documents.get(reelId);
    const scene = source.reviewedVisualScenes.find((item) => item.reelId === reelId && item.ordinal === 0);
    add({
      reelIds: [reelId], bucket: 'ABSTENTION', answerType: 'ABSTENTION',
      question: `What non-speech sound effect is audible at 13 seconds of "${doc.title}"? I need the audio, not the transcript.`,
      answer: 'The indexed transcript and visual captions do not establish a non-speech sound effect, so I cannot verify one.',
      evidenceIds: [], evidenceTypes: [],
      reviewNote: `Audio is not represented by the transcript or visual evidence for ${doc.title}; abstain without a citation. Frame ${scene.id} cannot establish sound.`,
    });
  }

  const alphaId = '80d7b583-27a6-4379-bdc0-d7192f0bb6a2';
  const alphaDoc = documents.get(alphaId);
  const alphaTextCases = [
    [0, 'What was the speaker\'s constant companion at the orphanage?', 'The speaker says the dream was a constant companion.'],
    [0, 'What did the other children call the speaker?', 'They called the speaker insane, cursed, and broken.'],
    [13, 'Who introduces himself to the speaker?', 'Dante introduces himself.'],
    [13, 'What does Dante say about Darius\'s current whereabouts?', 'Darius is not around right now.'],
  ];
  for (const [ordinal, query, answer] of alphaTextCases) {
    const chunk = source.transcriptChunks.find((item) => item.reelId === alphaId && item.ordinal === ordinal);
    if (!chunk) throw new Error(`Alpha transcript source missing: ${ordinal}`);
    add({
      reelIds: [alphaId], bucket: 'TRANSCRIPT', answerType: 'SEMANTIC_FACTS',
      question: `In "${alphaDoc.title}", ${query} Refer to the indexed transcript segment.`,
      answer,
      evidenceIds: [chunk.id], evidenceTypes: ['TRANSCRIPT'],
      reviewNote: `Reference checked against ${chunk.id}; no character identity is inferred beyond the transcript.`,
    });
  }
  for (const [question, answer, answerType] of [
    ['What is the exact title of the shared Reel?', alphaDoc.title, 'EXACT_TITLE'],
    ['Which episode number appears in the Reel title?', 'Episode 9.', 'EPISODE_NUMBER'],
    ['Which tags are attached to the shared Reel?', records.get(alphaId).tags.join(', '), 'TAG_SET'],
    ['What series name appears before the episode number?', 'Owned by the Alpha: His Human Temptation', 'SERIES_TITLE'],
  ])
    add({
      reelIds: [alphaId], bucket: 'METADATA', answerType,
      question, answer,
      evidenceIds: [alphaDoc.id], evidenceTypes: ['METADATA'],
      reviewNote: 'Title and tags checked against the current Content record.',
    });

  const comparisons = [
    [
      ['233c6609-35da-4d33-b901-1a9f5df80369', 'd839b7ca-2770-4ccc-b423-e161c8462401'],
      [
        ['What promise about war is stated in Episode 1, and what does William say he wants in Episode 2?', 'Episode 1 says there would be no more war after the marriage into the other kingdom. Episode 2 says William wants Lucy as his wife.', 0, 0],
        ['Who does the narrator say betrayed her in Episode 1, and who cast Lucy out in Episode 2?', 'Episode 1: her sister betrayed her. Episode 2: Ben cast Lucy out.', 1, 0],
        ['What does the prince say about the marriage in Episode 1, and what title does William give Lucy in Episode 2?', 'Episode 1 says the marriage was all an act. Episode 2 says Lucy is his countess.', 1, 0],
        ['How does the narrator describe her rejection in Episode 1, and what does William say will happen to anyone who slights Lucy in Episode 2?', 'Episode 1 says her kingdom does not want her and her love abandoned her. Episode 2 says anyone who slights Lucy makes an enemy of William.', 1, 0],
      ],
    ],
    [
      ['62393976-fc6a-4082-b112-662ed08eec14', 'a5946e98-0518-430c-9029-c2013f6a3692'],
      [
        ['Compare what William says he wants in Episode 4 with what he reveals in Episode 5 about the woman he cannot forget.', 'Episode 4: he says he wants her heart, not obedience. Episode 5: he reveals that the woman he cannot forget has always been Lucy.', 0, 1],
        ['How long have they known each other in Episode 4, and what does Lucy ask about the marriage in Episode 5?', 'Episode 4 says they have known each other for only one day. Episode 5 asks whether he married her to pity or humiliate her.', 0, 1],
        ['What did the Count do with the flowers in Episode 4, and what does the speaker say about the first love in Episode 5?', 'Episode 4 says the Count transplanted the flowers from her homeland just for her. Episode 5 says the one woman in his heart is his first love.', 1, 0],
        ['What does Lucy say she waited for in Episode 4, and what does William finally tell her in Episode 5?', 'Episode 4 says Lucy waited ten years for this day. Episode 5 tells her that the woman he cannot forget has always been her.', 1, 1],
      ],
    ],
    [
      ['da64f40a-de3a-4497-87bb-01fbb6234d5c', 'cf32eb98-9bc5-4fbb-a034-19a171b71e3f'],
      [
        ['What happened to the boy in Episode 7, and what does William remember in Episode 8?', 'Episode 7 says the boy was covered in blood by a stream. Episode 8 says William remembered one glance for ten years.', 0, 0],
        ['How long did she watch over the boy in Episode 7, and what does she say in Episode 8 about her first love?', 'Episode 7 says she watched over him all night. Episode 8 says he was her first love too.', 0, 1],
        ['What is the woman afraid of in Episode 7, and what is William afraid of in Episode 8?', 'Episode 7 says she is afraid he will not believe her. Episode 8 says William feared she only remembered the boy and did not love him.', 0, 1],
        ['What does she say about the boy in Episode 7, and what does William promise in Episode 8?', 'Episode 7 says the boy was the only man she ever loved. Episode 8 says William will guard her for the rest of his life.', 0, 1],
      ],
    ],
    [
      ['b439472b-926d-42c9-98a1-137746b18398', 'f06a9b8f-37b8-4a48-a902-58b286883e0b'],
      [
        ['What does the man say about the jade in Episode 11, and why was food prepared in Episode 14?', 'Episode 11 challenges the claim based on a scrap of jade and says it is used to slander his wife. Episode 14 says the food was prepared because she might not get used to it.', 1, 0],
        ['What does the speaker say about belief in Episode 11, and what does the speaker say about being without her in Episode 14?', 'Episode 11 says, "In this world, I believe only you." Episode 14 says, "Without you, I\'m an empty shell."', 2, 0],
        ['What warning is given to Vivian in Episode 11, and what does the Count say he will do to people who laugh at her in Episode 14?', 'Episode 11 warns that touching her again will make him forget they are family. Episode 14 says he will punish whoever laughs at her.', 2, 0],
        ['What does the Count say he is seeking in Episode 11, and what does the man say about his love in Episode 14?', 'Episode 11 says the Count is looking for his betrothed. Episode 14 says that even if the world opposes it, he wants her.', 1, 0],
      ],
    ],
  ];
  for (const [pair, items] of comparisons) {
    const docA = documents.get(pair[0]);
    const docB = documents.get(pair[1]);
    for (const [question, answer, ordinalA, ordinalB] of items) {
      const chunkA = source.transcriptChunks.find((item) => item.reelId === pair[0] && item.ordinal === ordinalA);
      const chunkB = source.transcriptChunks.find((item) => item.reelId === pair[1] && item.ordinal === ordinalB);
      if (!chunkA || !chunkB) throw new Error('multi-Reel transcript source missing');
      add({
        reelIds: pair, bucket: 'MULTI_REEL', answerType: 'MULTI_SOURCE_FACTS',
        question: `${question} Use the transcript segments in "${docA.title}" and "${docB.title}" respectively.`,
        answer,
        evidenceIds: [chunkA.id, chunkB.id], evidenceTypes: ['TRANSCRIPT', 'TRANSCRIPT'],
        reviewNote: `Each clause was checked against its cited transcript source: ${chunkA.id}; ${chunkB.id}.`,
      });
    }
  }

  const bySplit = Object.fromEntries(
    ['DEVELOPMENT', 'HELD_OUT'].map((split) => [
      split,
      cases.filter((item) => item.metadata.split === split),
    ]),
  );
  if (cases.length !== 136 || bySplit.DEVELOPMENT.length !== 64 || bySplit.HELD_OUT.length !== 72)
    throw new Error(`V8 allocation mismatch: total=${cases.length} dev=${bySplit.DEVELOPMENT.length} heldout=${bySplit.HELD_OUT.length}`);
  const allReelIds = new Set(metadata.keys());
  const splitReelIds = Object.fromEntries(
    ['DEVELOPMENT', 'HELD_OUT'].map((split) => [
      split,
      [...new Set(cases.filter((item) => item.metadata.split === split).flatMap((item) => item.input.reelIds))].sort(),
    ]),
  );
  if (splitReelIds.DEVELOPMENT.some((id) => splitReelIds.HELD_OUT.includes(id)))
    throw new Error('V8 source split contains overlapping Reel IDs');
  if (allReelIds.size !== 9) throw new Error('V8 source source-count mismatch');
  return { cases, bucketCounts, splitReelIds, source, visualReview };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function main() {
  const args = process.argv.slice(2);
  const result = buildDataset();
  if (args.includes('--self-test')) {
    assert.equal(result.cases.length, 136);
    assert.equal(new Set(result.cases.map((item) => item.id)).size, 136);
    assert.equal(result.bucketCounts.VISUAL, 16);
    assert.equal(result.bucketCounts.COMBINED, 16);
    assert.equal(result.bucketCounts.MULTI_REEL, 16);
    assert(result.cases.every((item) => item.metadata.humanApproved === false));
    process.stdout.write('V8 source-disjoint dataset self-check passed (136 rows, 9 accessible sources)\n');
    return;
  }
  const sourceSnapshotSha256 = fingerprint(result.source);
  const visualReviewSha256 = shortHash(
    fs.readFileSync(path.join(sourceDir, 'visual-frame-review-agent-v1.json')),
  );
  for (const item of result.cases) {
    item.metadata.sourceSnapshotSha256 = sourceSnapshotSha256;
    item.metadata.visualReviewSha256 = visualReviewSha256;
  }
  const manifest = {
    schemaVersion: 'rag-v8-source-disjoint-manifest-v1',
    datasetVersion,
    generatedAt: new Date().toISOString(),
    caseCount: result.cases.length,
    datasetSha256: fingerprint(result.cases),
    sourceSnapshotSha256,
    visualReviewSha256,
    sourceReelCount: 9,
    sourceReelIds: [...new Set(result.cases.flatMap((item) => item.input.reelIds))].sort(),
    splitReelIds: result.splitReelIds,
    splitCounts: {
      DEVELOPMENT: result.cases.filter((item) => item.metadata.split === 'DEVELOPMENT').length,
      HELD_OUT: result.cases.filter((item) => item.metadata.split === 'HELD_OUT').length,
    },
    coverageByBucket: result.bucketCounts,
    reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
    humanApproved: false,
    v7SourceOverlap: 0,
  };
  if (fs.existsSync(datasetDir))
    throw new Error(`V8 dataset output already exists: ${datasetDir}`);
  fs.mkdirSync(datasetDir, { mode: 0o700 });
  for (const split of ['DEVELOPMENT', 'HELD_OUT']) {
    const name = split === 'DEVELOPMENT' ? 'development.json' : 'held_out.json';
    writeJson(path.join(datasetDir, name), result.cases.filter((item) => item.metadata.split === split));
  }
  writeJson(path.join(datasetDir, 'cases.json'), result.cases);
  writeJson(path.join(datasetDir, 'manifest.json'), manifest);
  writeJson(path.join(datasetDir, 'source-split.json'), {
    splitReelIds: result.splitReelIds,
    overlap: [],
    generatedAt: manifest.generatedAt,
  });
  process.stdout.write(JSON.stringify({ datasetDir, ...manifest }, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildDataset };
