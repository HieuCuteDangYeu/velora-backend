#!/usr/bin/env node
/**
 * Compute-capacity test for the reel encode step (the CPU-heavy part of the media pipeline).
 *
 * It runs the same ffmpeg command the media worker builds (apps/media-processing-service/src/
 * infrastructure/services/ffmpeg-arguments.ts: portrait source, 360p/540p/720p ladder, x264,
 * 2 s HLS segments, 2 threads per rendition) with N copies at the same time, for N = 1, 2, 3, ...
 * and records, per level:
 *   - wall time of every encode (how long one reel takes while N run together),
 *   - throughput = reels finished per minute,
 *   - CPU utilisation of the whole machine (all cores, sampled every 500 ms),
 *   - CPU-seconds one reel costs.
 * The level where throughput stops growing and CPU sits near 100 % is the hardware ceiling of this
 * machine for encodes. It needs no queue, no database, no Groq: only a clip and ffmpeg.
 *
 *   node scripts/ops/media-encode-capacity.cjs --clip /path/96s-portrait.mp4 \
 *     [--levels 1,2,3,4,6] [--preset veryfast] [--threads 2] [--ffmpeg ffmpeg] [--json out.json]
 *
 * Run it inside a worker container to measure what that worker can really get:
 *   docker cp clip.mp4 <container>:/tmp/clip.mp4 && docker cp this.cjs <container>:/tmp/
 *   docker exec <container> node /tmp/media-encode-capacity.cjs --clip /tmp/clip.mp4
 * CPU% is the whole machine (the Docker VM on the homelab), so other services count against it.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = 'true';
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const LADDER = [
  { w: 360, h: 640, b: 750, max: 950, buf: 1500, ab: 96 },
  { w: 540, h: 960, b: 1400, max: 1800, buf: 2800, ab: 112 },
  { w: 720, h: 1280, b: 2400, max: 3100, buf: 4800, ab: 128 },
];

function buildArgs({ clip, outDir, preset, threads, fps, segment, audio }) {
  const split = LADDER.map((_, i) => `[v${i}src]`).join('');
  const filter = [
    `[0:v:0]split=${LADDER.length}${split}`,
    ...LADDER.map(
      (v, i) =>
        `[v${i}src]scale=${v.w}:${v.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${v.w}:${v.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}]`,
    ),
  ].join(';');
  const gop = fps * segment;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-i',
    clip,
    '-filter_complex',
    filter,
  ];
  LADDER.forEach((_, i) =>
    args.push('-map', `[v${i}]`, ...(audio ? ['-map', '0:a:0'] : [])),
  );
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-vsync',
    '1',
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${segment})`,
  );
  LADDER.forEach((v, i) =>
    args.push(
      `-profile:v:${i}`,
      'main',
      `-level:v:${i}`,
      '4.0',
      `-threads:v:${i}`,
      String(threads),
      `-b:v:${i}`,
      `${v.b}k`,
      `-maxrate:v:${i}`,
      `${v.max}k`,
      `-bufsize:v:${i}`,
      `${v.buf}k`,
    ),
  );
  if (audio) {
    args.push('-c:a', 'aac', '-ar', '48000');
    LADDER.forEach((v, i) => args.push(`-b:a:${i}`, `${v.ab}k`));
  }
  args.push(
    '-map_metadata',
    '-1',
    '-start_number',
    '0',
    '-hls_time',
    String(segment),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'mpegts',
    '-hls_flags',
    'independent_segments+temp_file',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    path.join(outDir, '%v', 'segment_%06d.ts'),
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    LADDER.map((_, i) => (audio ? `v:${i},a:${i}` : `v:${i}`)).join(' '),
    '-f',
    'hls',
    path.join(outDir, '%v', 'stream.m3u8'),
  );
  return args;
}

function cpuTimes() {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    total += all;
    busy += all - t.idle;
  }
  return { busy, total };
}

function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

async function sampleCpu(ms) {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpuTimes();
  return ((b.busy - a.busy) / Math.max(1, b.total - a.total)) * 100;
}

async function runLevel({
  n,
  ffmpeg,
  clip,
  preset,
  threads,
  fps,
  segment,
  audio,
  root,
}) {
  const idlePct = await sampleCpu(3000);
  const samples = [];
  const start = cpuTimes();
  let last = start;
  const timer = setInterval(() => {
    const now = cpuTimes();
    samples.push(
      ((now.busy - last.busy) / Math.max(1, now.total - last.total)) * 100,
    );
    last = now;
  }, 500);
  const t0 = Date.now();
  const jobs = Array.from({ length: n }, (_, i) => {
    const outDir = path.join(root, `n${n}-${i}`);
    for (let r = 0; r < LADDER.length; r += 1)
      fs.mkdirSync(path.join(outDir, String(r)), { recursive: true });
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(
        ffmpeg,
        buildArgs({ clip, outDir, preset, threads, fps, segment, audio }),
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
      });
      child.on('close', (code) =>
        resolve({
          code,
          sec: (Date.now() - started) / 1000,
          err: err.slice(-300),
        }),
      );
    });
  });
  const results = await Promise.all(jobs);
  clearInterval(timer);
  const wall = (Date.now() - t0) / 1000;
  const end = cpuTimes();
  const failed = results.filter((r) => r.code !== 0);
  const cores = os.cpus().length;
  const busyPct =
    ((end.busy - start.busy) / Math.max(1, end.total - start.total)) * 100;
  // CPU-seconds above what the machine was already spending on other work.
  const cpuSeconds = Math.max(0, ((busyPct - idlePct) / 100) * cores * wall);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return {
    n,
    failed: failed.length,
    firstError: failed[0]?.err,
    wallMax: Math.max(...results.map((r) => r.sec)),
    wallMean: results.reduce((s, r) => s + r.sec, 0) / results.length,
    reelsPerMin: failed.length ? null : (n / wall) * 60,
    cpuMean: busyPct,
    cpuP95: samples.length ? percentile(samples, 95) : busyPct,
    cpuPeak: samples.length ? Math.max(...samples) : busyPct,
    cpuIdleBefore: idlePct,
    cpuSecPerReel: cpuSeconds / n,
    coresBusy: (busyPct / 100) * cores,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.clip) {
    console.error(
      'usage: media-encode-capacity.cjs --clip file.mp4 [--levels 1,2,3,4] [--preset veryfast]',
    );
    process.exit(2);
  }
  const ffmpeg = args.ffmpeg || 'ffmpeg';
  const preset = args.preset || 'veryfast';
  const threads = Number(args.threads || 2);
  const levels = (args.levels || '1,2,3,4,6')
    .split(',')
    .map(Number)
    .filter((x) => x > 0);
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,r_frame_rate',
      '-of',
      'json',
      args.clip,
    ],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
  const info = JSON.parse(probe.stdout);
  const audio = info.streams.some((s) => s.codec_type === 'audio');
  const [num, den] = (
    info.streams.find((s) => s.codec_type === 'video')?.r_frame_rate || '25/1'
  )
    .split('/')
    .map(Number);
  const fps = Math.max(24, Math.round(Math.min(30, num / (den || 1))));
  const duration = Number(info.format.duration);
  const root = fs.mkdtempSync(
    path.join(args.tmp || os.tmpdir(), 'enc-capacity-'),
  );
  const v = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' }).stdout.split(
    '\n',
  )[0];
  console.log(
    `${v}\nhost cores=${os.cpus().length}  clip=${duration.toFixed(0)} s  preset=${preset}  threads/rendition=${threads}\n`,
  );
  console.log(
    'N  | per-reel wall s (mean/max) | reels/min | video-sec per sec | CPU % mean/p95/peak | cores busy | CPU-s per reel | other load before',
  );
  const rows = [];
  for (const n of levels) {
    const r = await runLevel({
      n,
      ffmpeg,
      clip: args.clip,
      preset,
      threads,
      fps,
      segment: 2,
      audio,
      root,
    });
    rows.push(r);
    console.log(
      `${String(n).padEnd(2)} | ${r.wallMean.toFixed(1).padStart(6)} / ${r.wallMax.toFixed(1).padStart(6)}         | ${r.reelsPerMin === null ? 'FAILED' : r.reelsPerMin.toFixed(2).padStart(6)}    | ${r.reelsPerMin === null ? '' : ((r.reelsPerMin / 60) * duration).toFixed(1).padStart(6)}            | ${r.cpuMean.toFixed(0).padStart(3)} / ${r.cpuP95.toFixed(0).padStart(3)} / ${r.cpuPeak.toFixed(0).padStart(3)}      | ${r.coresBusy.toFixed(1).padStart(5)}      | ${r.cpuSecPerReel.toFixed(0)}  | ${r.cpuIdleBefore.toFixed(0)} %${r.cpuIdleBefore > 15 ? ' (NOISY: other work was using the CPU, result is pessimistic)' : ''}${r.failed ? `  (${r.failed} failed: ${r.firstError})` : ''}`,
    );
    await new Promise((res) => setTimeout(res, 2000));
  }
  fs.rmSync(root, { recursive: true, force: true });
  const ok = rows.filter((r) => r.reelsPerMin !== null);
  const best = ok.reduce(
    (a, b) => (b.reelsPerMin > a.reelsPerMin ? b : a),
    ok[0],
  );
  const knee = ok.find(
    (r, i) => i > 0 && r.reelsPerMin < ok[i - 1].reelsPerMin * 1.1,
  );
  console.log(
    `\nbest throughput ${best.reelsPerMin.toFixed(2)} reels/min at N=${best.n}${knee ? `; gains dropped below 10 % at N=${knee.n}` : ''}`,
  );
  if (args.json)
    fs.writeFileSync(
      args.json,
      JSON.stringify(
        {
          host: os.hostname(),
          cores: os.cpus().length,
          ffmpeg: v,
          preset,
          clipSeconds: duration,
          rows,
        },
        null,
        2,
      ),
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
