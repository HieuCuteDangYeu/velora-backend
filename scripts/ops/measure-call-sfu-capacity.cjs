#!/usr/bin/env node
'use strict';

/**
 * Measures how many concurrent calls one mediasoup worker (one CPU core) can
 * forward, using synthetic SRTP/RTP traffic over PlainTransports.
 *
 *   node scripts/ops/measure-call-sfu-capacity.cjs \
 *     --profile video1to1|voice1to1|group8 --steps 10,25,50,100 \
 *     [--workers 1] [--seconds 10] [--senders 3]
 *
 * What it covers: per-packet routing, RTP/RTCP handling and SRTP
 * encrypt/decrypt in the worker, with the router codecs of the call service
 * (Opus + VP8). What it does not cover: ICE/DTLS, transport-cc bandwidth
 * estimation, NACK/PLI feedback, and real network behaviour. Treat the result
 * as an optimistic ceiling and confirm with real clients before trusting it.
 */

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const os = require('node:os');
const { execFileSync, fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const SUITE = 'AES_CM_128_HMAC_SHA1_80';
const AUDIO_PT = 100;
const VIDEO_PT = 101;
const AUDIO_INTERVAL_MS = 20;
const VIDEO_FRAME_INTERVAL_MS = 1000 / 30;
const VIDEO_INTER_FRAME_BYTES = 3000; // ~720 kbps at 30 fps
const VIDEO_KEY_FRAME_BYTES = 14000;
const VIDEO_KEY_FRAME_EVERY_FRAMES = 60;
const VIDEO_MTU_PAYLOAD = 1150;
const AUDIO_PAYLOAD_BYTES = 80; // ~32 kbps Opus

const PROFILES = {
  video1to1: { participants: 2, video: true, fanout: 1 },
  voice1to1: { participants: 2, video: false, fanout: 1 },
  group8: { participants: 8, video: false, fanout: 7 },
};

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

// ---------------------------------------------------------------- SRTP --

function deriveSrtpKeys(master) {
  const masterKey = master.subarray(0, 16);
  const masterSalt = master.subarray(16, 30);
  const derive = (label, length) => {
    const x = Buffer.from(masterSalt);
    x[7] ^= label; // key_id = label || 48-bit zero index, right-aligned
    const iv = Buffer.concat([x, Buffer.alloc(2)]);
    return crypto
      .createCipheriv('aes-128-ctr', masterKey, iv)
      .update(Buffer.alloc(length));
  };
  return { encKey: derive(0, 16), authKey: derive(1, 20), salt: derive(2, 14) };
}

class SrtpSender {
  constructor(master) {
    const keys = deriveSrtpKeys(master);
    this.authKey = keys.authKey;
    this.salt = keys.salt;
    this.ecb = crypto.createCipheriv('aes-128-ecb', keys.encKey, null);
    this.ecb.setAutoPadding(false);
    this.iv = Buffer.alloc(16);
    this.roc = Buffer.alloc(4);
  }

  /**
   * Encrypts only the first `encryptBytes` payload bytes (enough for the VP8
   * descriptor the worker parses) and appends a valid auth tag. The rest of
   * the payload decrypts to noise, which costs the worker the same.
   */
  protect(packet, ssrc, rocValue, seq, headerLength, encryptBytes) {
    this.salt.copy(this.iv);
    this.iv.writeUInt32BE((this.iv.readUInt32BE(4) ^ ssrc) >>> 0, 4);
    this.iv.writeUInt32BE((this.iv.readUInt32BE(8) ^ rocValue) >>> 0, 8);
    this.iv.writeUInt16BE(this.iv.readUInt16BE(12) ^ seq, 12);
    const keystream = this.ecb.update(this.iv);
    for (let i = 0; i < encryptBytes; i += 1) {
      packet[headerLength + i] ^= keystream[i];
    }
    this.roc.writeUInt32BE(rocValue, 0);
    const tag = crypto
      .createHmac('sha1', this.authKey)
      .update(packet)
      .update(this.roc)
      .digest();
    return Buffer.concat([packet, tag.subarray(0, 10)]);
  }
}

// -------------------------------------------------------------- child --

function runChild() {
  const participants = [];
  let sentAudio = 0;
  let sentVideo = 0;
  let maxLagMs = 0;
  const TICK_MS = 5;

  const rtpHeader = (pt, marker, seq, ts, ssrc) => {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = (marker ? 0x80 : 0) | pt;
    header.writeUInt16BE(seq, 2);
    header.writeUInt32BE(ts >>> 0, 4);
    header.writeUInt32BE(ssrc, 8);
    return header;
  };

  const createStream = (srtp, socket, port, ssrc, kind, now) => ({
    srtp,
    socket,
    port,
    ssrc,
    kind,
    seq: Math.floor(Math.random() * 60000),
    roc: 0,
    ts: Math.floor(Math.random() * 1e9),
    frame: 0,
    nextAt: now + Math.random() * (kind === 'audio' ? AUDIO_INTERVAL_MS : VIDEO_FRAME_INTERVAL_MS),
  });

  const nextSeq = (stream) => {
    const seq = stream.seq;
    stream.seq = (stream.seq + 1) & 0xffff;
    if (stream.seq === 0) stream.roc += 1;
    return { seq, roc: stream.roc };
  };

  const send = (stream, packet) => stream.socket.send(packet, stream.port, '127.0.0.1');

  const sendAudio = (stream) => {
    const { seq, roc } = nextSeq(stream);
    const packet = Buffer.concat([
      rtpHeader(AUDIO_PT, false, seq, stream.ts, stream.ssrc),
      Buffer.alloc(AUDIO_PAYLOAD_BYTES, 0x55),
    ]);
    stream.ts += 960;
    send(stream, stream.srtp.protect(packet, stream.ssrc, roc, seq, 12, 0));
    sentAudio += 1;
  };

  const sendVideoFrame = (stream) => {
    const isKey = stream.frame % VIDEO_KEY_FRAME_EVERY_FRAMES === 0;
    let remaining = isKey ? VIDEO_KEY_FRAME_BYTES : VIDEO_INTER_FRAME_BYTES;
    let first = true;
    while (remaining > 0) {
      const size = Math.min(remaining, VIDEO_MTU_PAYLOAD);
      remaining -= size;
      const { seq, roc } = nextSeq(stream);
      const payload = Buffer.alloc(size, 0x55);
      // VP8 payload descriptor (S bit on the first packet) + payload header
      // whose P bit is 0 for key frames; both are decrypted by the worker.
      payload[0] = first ? 0x10 : 0x00;
      payload[1] = isKey ? 0x00 : 0x01;
      const packet = Buffer.concat([
        rtpHeader(VIDEO_PT, remaining === 0, seq, stream.ts, stream.ssrc),
        payload,
      ]);
      send(stream, stream.srtp.protect(packet, stream.ssrc, roc, seq, 12, 2));
      sentVideo += 1;
      first = false;
    }
    stream.ts += 3000;
    stream.frame += 1;
  };

  process.on('message', (message) => {
    if (message.type === 'add') {
      const now = performance.now();
      for (const config of message.participants) {
        const socket = dgram.createSocket('udp4');
        const srtp = new SrtpSender(Buffer.from(config.keyBase64, 'base64'));
        participants.push(
          createStream(srtp, socket, config.port, config.audioSsrc, 'audio', now),
        );
        if (config.videoSsrc) {
          participants.push(
            createStream(srtp, socket, config.port, config.videoSsrc, 'video', now),
          );
        }
      }
    } else if (message.type === 'stop') {
      process.exit(0);
    }
  });

  setInterval(() => {
    const now = performance.now();
    for (const stream of participants) {
      if (stream.nextAt > now) continue;
      maxLagMs = Math.max(maxLagMs, now - stream.nextAt);
      while (stream.nextAt <= now) {
        if (stream.kind === 'audio') {
          sendAudio(stream);
          stream.nextAt += AUDIO_INTERVAL_MS;
        } else {
          sendVideoFrame(stream);
          stream.nextAt += VIDEO_FRAME_INTERVAL_MS;
        }
      }
    }
  }, TICK_MS);

  setInterval(() => {
    process.send({ type: 'stats', sentAudio, sentVideo, maxLagMs });
    maxLagMs = 0;
  }, 1000);
}

// ------------------------------------------------------------- parent --

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workerCpuMs = async (worker) => {
  const usage = await worker.getResourceUsage();
  return usage.ru_utime + usage.ru_stime; // already milliseconds (verified against ps)
};

const rssMb = (pid) => {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString()) / 1024;
  } catch {
    return NaN;
  }
};

async function runParent() {
  const mediasoup = require('mediasoup');
  const profileName = arg('profile', 'video1to1');
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown profile ${profileName}`);
  const steps = String(arg('steps', '10,25,50,100'))
    .split(',')
    .map(Number);
  const windowSeconds = Number(arg('seconds', 10));
  const workerCount = Number(arg('workers', 1));
  const senderCount = Number(arg('senders', Math.max(1, Math.min(4, os.cpus().length - workerCount - 3))));

  const mediasoupVersion = JSON.parse(
    require('node:fs').readFileSync(
      require.resolve('mediasoup').replace(/node\/lib\/.*$|lib\/.*$/, '') + 'package.json',
      'utf8',
    ),
  ).version;
  console.log(
    `host=${os.cpus()[0].model} cores=${os.cpus().length} node=${process.version} mediasoup=${mediasoupVersion}`,
  );
  console.log(
    `profile=${profileName} participants=${profile.participants} video=${profile.video} fanout=${profile.fanout} workers=${workerCount} senders=${senderCount} window=${windowSeconds}s`,
  );

  const workers = [];
  const routers = [];
  for (let i = 0; i < workerCount; i += 1) {
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    workers.push(worker);
    routers.push([]);
  }

  const senderStats = Array.from({ length: senderCount }, () => ({ sentAudio: 0, sentVideo: 0, maxLagMs: 0 }));
  const senders = senderStats.map((stats) => {
    const child = fork(__filename, ['--child']);
    child.on('message', (message) => {
      if (message.type === 'stats') Object.assign(stats, message);
    });
    return child;
  });

  const sink = dgram.createSocket('udp4');
  let received = 0;
  sink.on('message', (packet) => {
    // RTCP packet types 200-204 live in the second byte; our RTP never does.
    if (packet[1] < 192 || packet[1] > 223) received += 1;
  });
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  try {
    sink.setRecvBufferSize(16 * 1024 * 1024);
  } catch {
    // Platform cap; loss, if any, shows up in the delivery ratio.
  }
  const sinkPort = sink.address().port;

  const mediaCodecs = [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      parameters: { useinbandfec: 1, usedtx: 1 },
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: { 'x-google-start-bitrate': 1000 },
    },
  ];

  let ssrcCounter = 1000;
  let callIndex = 0;
  let senderCursor = 0;

  const addCall = async () => {
    const worker = workers[callIndex % workers.length];
    const router = await worker.createRouter({ mediaCodecs });
    callIndex += 1;

    const participants = [];
    for (let p = 0; p < profile.participants; p += 1) {
      const keyBase64 = crypto.randomBytes(30).toString('base64');
      const sendTransport = await router.createPlainTransport({
        listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
        rtcpMux: true,
        comedia: true,
        enableSrtp: true,
        srtpCryptoSuite: SUITE,
      });
      await sendTransport.connect({
        srtpParameters: { cryptoSuite: SUITE, keyBase64 },
      });
      const audioSsrc = ssrcCounter++;
      const audio = await sendTransport.produce({
        kind: 'audio',
        rtpParameters: {
          codecs: [
            {
              mimeType: 'audio/opus',
              payloadType: AUDIO_PT,
              clockRate: 48000,
              channels: 2,
              parameters: { useinbandfec: 1, usedtx: 1 },
            },
          ],
          encodings: [{ ssrc: audioSsrc }],
        },
      });
      let video;
      let videoSsrc;
      if (profile.video) {
        videoSsrc = ssrcCounter++;
        video = await sendTransport.produce({
          kind: 'video',
          rtpParameters: {
            codecs: [
              {
                mimeType: 'video/VP8',
                payloadType: VIDEO_PT,
                clockRate: 90000,
                parameters: { 'x-google-start-bitrate': 1000 },
              },
            ],
            encodings: [{ ssrc: videoSsrc }],
          },
        });
      }
      participants.push({
        sendTransport,
        audio,
        video,
        config: {
          port: sendTransport.tuple.localPort,
          keyBase64,
          audioSsrc,
          videoSsrc,
        },
      });
    }

    for (const listener of participants) {
      const recvTransport = await router.createPlainTransport({
        listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
        rtcpMux: true,
        comedia: false,
        enableSrtp: true,
        srtpCryptoSuite: SUITE,
      });
      await recvTransport.connect({
        ip: '127.0.0.1',
        port: sinkPort,
        srtpParameters: {
          cryptoSuite: SUITE,
          keyBase64: crypto.randomBytes(30).toString('base64'),
        },
      });
      for (const speaker of participants) {
        if (speaker === listener) continue;
        for (const producer of [speaker.audio, speaker.video]) {
          if (!producer) continue;
          await recvTransport.consume({
            producerId: producer.id,
            rtpCapabilities: router.rtpCapabilities,
          });
        }
      }
    }

    senders[senderCursor % senders.length].send({
      type: 'add',
      participants: participants.map((participant) => participant.config),
    });
    senderCursor += 1;
  };

  const totals = () => ({
    audio: senderStats.reduce((sum, s) => sum + s.sentAudio, 0),
    video: senderStats.reduce((sum, s) => sum + s.sentVideo, 0),
  });

  const rows = [];
  let calls = 0;
  console.log(
    '\ncalls  workerCPU%  perCall%  in_pps   out_pps  delivered  genLagMs  workerRSS_MB',
  );
  for (const target of steps) {
    while (calls < target) {
      await addCall();
      calls += 1;
    }
    await sleep(4000); // warm up: consumers sync on the next key frame

    senderStats.forEach((s) => {
      s.maxLagMs = 0;
    });
    const cpuBefore = await Promise.all(workers.map(workerCpuMs));
    const sentBefore = totals();
    const receivedBefore = received;
    const started = performance.now();
    let maxLag = 0;
    for (let tick = 0; tick < windowSeconds; tick += 1) {
      await sleep(1000);
      maxLag = Math.max(maxLag, ...senderStats.map((s) => s.maxLagMs));
    }
    const elapsedMs = performance.now() - started;
    const cpuAfter = await Promise.all(workers.map(workerCpuMs));
    const sentAfter = totals();

    const cpuPerWorker = cpuAfter.map((after, i) => ((after - cpuBefore[i]) / elapsedMs) * 100);
    const cpuTotal = cpuPerWorker.reduce((a, b) => a + b, 0);
    const sentPackets = sentAfter.audio + sentAfter.video - sentBefore.audio - sentBefore.video;
    const outPackets = received - receivedBefore;
    const delivered = outPackets / (sentPackets * profile.fanout);
    const row = {
      calls,
      cpuTotal,
      cpuMax: Math.max(...cpuPerWorker),
      perCall: cpuTotal / calls,
      inPps: sentPackets / (elapsedMs / 1000),
      outPps: outPackets / (elapsedMs / 1000),
      delivered,
      maxLag,
      rss: workers.map((w) => rssMb(w.pid)).reduce((a, b) => a + b, 0),
    };
    rows.push(row);
    console.log(
      `${String(calls).padStart(5)}  ${row.cpuTotal.toFixed(1).padStart(9)}  ${row.perCall.toFixed(2).padStart(8)}  ${row.inPps.toFixed(0).padStart(6)}  ${row.outPps.toFixed(0).padStart(7)}  ${(row.delivered * 100).toFixed(1).padStart(8)}%  ${row.maxLag.toFixed(0).padStart(8)}  ${row.rss.toFixed(0).padStart(11)}`,
    );

    if (row.cpuMax > 95 || row.delivered < 0.97 || row.maxLag > 100) {
      console.log(
        `\nstopping: ${row.cpuMax > 95 ? 'worker saturated' : row.delivered < 0.97 ? 'packet loss' : 'load generator lagging (result invalid beyond this point)'}`,
      );
      break;
    }
  }

  console.log('\nJSON ' + JSON.stringify({ profile: profileName, workers: workerCount, rows }));
  senders.forEach((child) => child.send({ type: 'stop' }));
  sink.close();
  workers.forEach((worker) => worker.close());
  setTimeout(() => process.exit(0), 200);
}

if (process.argv.includes('--child')) {
  runChild();
} else {
  runParent().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
