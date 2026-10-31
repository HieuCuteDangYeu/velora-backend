'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareHls, validateLocalHls, legacyCropEdit } = require('./hls.cjs');
const { validateSourceUrl, publicLookup } = require('./stage-source.cjs');
const {
  SelectReelEncodingProfileUseCase,
} = require('../../apps/media-processing-service/src/application/use-cases/select-reel-encoding-profile.use-case.ts');
const {
  buildHlsTranscodeArguments,
} = require('../../apps/media-processing-service/src/infrastructure/services/ffmpeg-arguments.ts');
const {
  resolveReelPixelCrop,
} = require('../../libs/common/src/processing/reel-media-crop.ts');
let workDir;
const config = { get: () => undefined };
before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-hls-test-'));
});
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

test('import profile encodes an adaptive ladder with forced two-second GOPs, including silent sources', () => {
  const profile = new SelectReelEncodingProfileUseCase(config).execute({
    width: 1080,
    height: 1920,
    durationMs: 120193,
    fps: 25,
    hasAudio: false,
  });
  assert.equal(profile.segmentSeconds, 2);
  assert.equal(profile.variants.length, 3);
  const args = buildHlsTranscodeArguments({
    inputPath: 'source.mp4',
    outputDir: '/tmp/hls',
    profile,
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-g') + 1], '50');
  assert.equal(
    args[args.indexOf('-force_key_frames') + 1],
    'expr:gte(t,n_forced*2)',
  );
  assert.ok(!args.includes('copy'));
  assert.ok(!args.includes('0:a:0'));
  assert.equal(args[args.indexOf('-var_stream_map') + 1], 'v:0 v:1 v:2');
});

test('legacy crop keeps the original upright pixel region and rejects undersized input', () => {
  const metadata = { width: 1080, height: 1920 };
  assert.deepEqual(resolveReelPixelCrop(legacyCropEdit(metadata), metadata), {
    x: 50,
    y: 180,
    width: 978,
    height: 1740,
  });
  assert.throws(() => legacyCropEdit({ width: 720, height: 1280 }));
});

test('external staging fails closed on private, credentialed and non-HTTPS sources', async () => {
  for (const url of [
    'http://public.example/a.mp4',
    'https://127.0.0.1/a.mp4',
    'https://[::1]/a.mp4',
    'https://user:password@public.example/a.mp4',
    'https://host.local/a.mp4',
    'https://public.example:8443/a.mp4',
  ])
    assert.throws(() => validateSourceUrl(url));
  assert.equal(
    validateSourceUrl('https://cdn.example/a.mp4').hostname,
    'cdn.example',
  );
  await new Promise((resolve, reject) =>
    publicLookup('localhost', {}, (error) => {
      if (error) resolve();
      else reject(new Error('Private DNS accepted'));
    }),
  );
});

test(
  'real FFmpeg/ffprobe validates Fit, crop, audio, adaptive renditions and partial-output rejection',
  { timeout: 180000 },
  async () => {
    const source = path.join(workDir, 'synthetic.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=green:size=1080x1920:rate=25:duration=4.2,drawbox=x=0:y=0:w=iw:h=178:color=red:t=fill',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=4.2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-threads',
        '2',
        '-g',
        '125',
        '-c:a',
        'aac',
        '-shortest',
        source,
      ],
      { timeout: 60000 },
    );
    const fitDir = path.join(workDir, 'fit');
    const fit = await prepareHls({ source, outputDir: fitDir, config });
    assert.equal(fit.sourceMetadata.hasAudio, true);
    assert.equal(fit.validation.variants.length, 3);
    for (const variant of fit.validation.variants) {
      assert.equal(variant.segments, 3);
      assert.ok(variant.maxKeyframeGapSeconds <= 2.041);
      assert.ok(variant.maxSegmentSeconds <= 2.041);
    }
    const cropped = await prepareHls({
      source,
      outputDir: path.join(workDir, 'crop'),
      crop: true,
      config,
    });
    assert.deepEqual(cropped.profile.crop, {
      x: 50,
      y: 180,
      width: 978,
      height: 1740,
    });
    assert.equal(cropped.validation.variants.length, 3);
    const topPixel = (playlist) =>
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          '1',
          '-i',
          playlist,
          '-vf',
          'crop=2:2:(iw-2)/2:20',
          '-frames:v',
          '1',
          '-threads',
          '1',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        ],
        { timeout: 30000 },
      );
    const fitPixel = topPixel(path.join(fitDir, '0/stream.m3u8'));
    const cropPixel = topPixel(path.join(workDir, 'crop/0/stream.m3u8'));
    assert.ok(
      fitPixel[0] > 150 && fitPixel[1] < 80,
      'Fit keeps the red source border',
    );
    assert.ok(
      cropPixel[1] > 60 && cropPixel[0] < 80,
      'Crop excludes the red border above y=180',
    );
    await assert.rejects(
      prepareHls({ source, outputDir: fitDir, config }),
      /EEXIST/,
    );
    const last = fit.validation.files.find(
      (file) => file.path.startsWith('2/') && file.path.endsWith('.ts'),
    );
    fs.unlinkSync(path.join(fitDir, last.path));
    await assert.rejects(validateLocalHls(fitDir, fit.profile), /ENOENT/);
    const variantPath = path.join(fitDir, '0/stream.m3u8');
    fs.writeFileSync(
      variantPath,
      fs.readFileSync(variantPath, 'utf8').replace('#EXT-X-ENDLIST', ''),
    );
    await assert.rejects(validateLocalHls(fitDir, fit.profile), /Incomplete/);
  },
);
