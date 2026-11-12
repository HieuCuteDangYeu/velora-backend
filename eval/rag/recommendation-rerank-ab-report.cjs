'use strict';
/**
 * Report for the feed neural-rerank A/B (REEL_NEURAL_RERANK_EXPERIMENT_ENABLED).
 * Read-only. Joins ReelRerankExposure (one row per reel the cross-encoder
 * scored in a feed session, logged by both arms) to ReelViewEvent on
 * (userId, feedSessionId, reelId).
 *
 * Labels match recommendation-rerank-benchmark.cjs over non-REPLAY events:
 * positive = completed, or WATCH_END/COMPLETE at >= 70% watched; negative =
 * skipped. An exposure with neither label (or no event) is unlabeled.
 *
 * Two readings, both with 95% CIs from a bootstrap over feed sessions (the
 * unit of randomization; reels inside a session are not independent):
 *  1. Treatment vs control: positive rate and skip rate among labeled
 *     exposures. Unlabeled exposures are scrolled past or never reached, so a
 *     rate is conditional on the reel having been seen.
 *  2. Counterfactual (both arms pooled): AUC of the feature order vs the
 *     reranked order over positive/negative pairs inside the same session.
 *     Cross-arm contrast is free of arm effects but not of position bias: a
 *     reel is only labeled if the served order brought the viewer to it.
 *
 * Run inside the content-service container (Prisma is only reachable there):
 *
 *   docker cp eval/rag/recommendation-rerank-ab-report.cjs <content-service>:/usr/src/app/
 *   docker exec -e SINCE=2026-11-13T00:00:00Z <content-service> node recommendation-rerank-ab-report.cjs
 *   docker exec -u root <content-service> rm /usr/src/app/recommendation-rerank-ab-report.cjs
 *
 * Env: SINCE (ISO time, default: all rows), BOOTSTRAPS (default 2000).
 * With few viewers the intervals will be wide; that is the result, not a bug.
 */

const rng = (seed) => {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
};

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;

const quantile = (sorted, q) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    : NaN;

/** Pairwise AUC of `score` for pos vs neg rows; null without both labels. */
function pairedAuc(rows, score) {
  let wins = 0;
  let pairs = 0;
  for (const p of rows) {
    if (p.label !== 'pos') continue;
    for (const n of rows) {
      if (n.label !== 'neg') continue;
      pairs += 1;
      const a = score(p);
      const b = score(n);
      wins += a > b ? 1 : a === b ? 0.5 : 0;
    }
  }
  return pairs ? { wins, pairs } : null;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

/** Per-session sufficient statistics, so a bootstrap only sums them. */
function sessionStats(exposures) {
  return [...groupBy(exposures, (e) => e.feedSessionId).values()].map(
    (rows) => {
      const base = pairedAuc(rows, (r) => -r.baseRank);
      const reranked = pairedAuc(rows, (r) => -r.rerankedRank);
      return {
        arm: rows[0].arm,
        userId: rows[0].userId,
        exposed: rows.length,
        pos: rows.filter((r) => r.label === 'pos').length,
        neg: rows.filter((r) => r.label === 'neg').length,
        baseWins: base?.wins ?? 0,
        rerankedWins: reranked?.wins ?? 0,
        pairs: base?.pairs ?? 0,
      };
    },
  );
}

const sum = (stats, field) => stats.reduce((a, s) => a + s[field], 0);
const rate = (stats, field) => {
  const labeled = sum(stats, 'pos') + sum(stats, 'neg');
  return labeled ? sum(stats, field) / labeled : NaN;
};
const aucOf = (stats, wins) => {
  const pairs = sum(stats, 'pairs');
  return pairs ? sum(stats, wins) / pairs : NaN;
};

function bootstrap(stats, statistic, runs, random) {
  const draws = [];
  for (let i = 0; i < runs; i += 1) {
    const resample = Array.from(
      { length: stats.length },
      () => stats[Math.floor(random() * stats.length)],
    );
    const value = statistic(resample);
    if (Number.isFinite(value)) draws.push(value);
  }
  draws.sort((a, b) => a - b);
  return [quantile(draws, 0.025), quantile(draws, 0.975)];
}

function interval(point, [low, high]) {
  const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
  return `${f(point)}  95% CI [${f(low)}, ${f(high)}]`;
}

function summarize(exposures, runs = 2000) {
  const random = rng(20261112);
  const stats = sessionStats(exposures);
  const arm = (name) => stats.filter((s) => s.arm === name);
  const treatment = arm('treatment');
  const control = arm('control');
  const lines = [];

  lines.push(
    `sessions: treatment ${treatment.length}, control ${control.length}; ` +
      `viewers: ${new Set(stats.map((s) => s.userId)).size}`,
  );
  for (const [name, group] of [
    ['treatment', treatment],
    ['control', control],
  ]) {
    lines.push(
      `${name}: exposed ${sum(group, 'exposed')}, labeled ` +
        `${sum(group, 'pos') + sum(group, 'neg')} ` +
        `(pos ${sum(group, 'pos')}, neg ${sum(group, 'neg')})`,
    );
  }

  const diff = (field) => (resample) => {
    const t = resample.filter((s) => s.arm === 'treatment');
    const c = resample.filter((s) => s.arm === 'control');
    return rate(t, field) - rate(c, field);
  };
  for (const [label, field] of [
    ['positive rate (treatment - control)', 'pos'],
    ['skip rate (treatment - control)', 'neg'],
  ]) {
    lines.push(
      `${label}: ` +
        interval(
          rate(treatment, field) - rate(control, field),
          bootstrap(stats, diff(field), runs, random),
        ),
    );
  }

  const aucDiff = (resample) =>
    aucOf(resample, 'rerankedWins') - aucOf(resample, 'baseWins');
  lines.push(
    `counterfactual AUC, feature order: ${aucOf(stats, 'baseWins').toFixed(3)}, ` +
      `reranked order: ${aucOf(stats, 'rerankedWins').toFixed(3)}, pairs: ${sum(stats, 'pairs')}`,
  );
  lines.push(
    'counterfactual AUC (reranked - feature): ' +
      interval(aucDiff(stats), bootstrap(stats, aucDiff, runs, random)),
  );
  return lines.join('\n');
}

async function main() {
  const { PrismaClient } = require('@prisma/content-client');
  const prisma = new PrismaClient();
  const since = process.env.SINCE ? new Date(process.env.SINCE) : new Date(0);
  const runs = Number(process.env.BOOTSTRAPS ?? 2000);

  try {
    const rows = await prisma.$queryRaw`
      select x."feedSessionId", x."reelId", x."userId", x.arm,
             x."baseRank", x."rerankedRank",
             case
               when bool_or(e.completed or (e."eventType" in ('WATCH_END','COMPLETE')
                    and coalesce(e."percentageWatched", 0) >= 70)) then 'pos'
               when bool_or(e.skipped or e."eventType" = 'SKIP') then 'neg'
               else 'none'
             end as label
      from "ReelRerankExposure" x
      left join "ReelViewEvent" e
        on e."userId" = x."userId" and e."feedSessionId" = x."feedSessionId"
       and e."reelId" = x."reelId" and e."eventType" <> 'REPLAY'
      where x."createdAt" >= ${since}
      group by 1, 2, 3, 4, 5, 6`;

    if (rows.length === 0) {
      console.log('No exposures since', since.toISOString());
      return;
    }
    console.log(summarize(rows, runs));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { pairedAuc, sessionStats, summarize };
