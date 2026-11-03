import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FfmpegService, MediaProcessError } from './ffmpeg.service';

describe('FfmpegService.extractThumbnail', () => {
  let dir: string;
  let outputPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'velora-thumb-'));
    outputPath = join(dir, 'thumbnail.jpg');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { force: true, recursive: true });
  });

  const createService = (writesAt: (seekSeconds: number) => boolean) => {
    const service = new FfmpegService(
      new ConfigService({ FFMPEG_PATH: '/bin/sh', FFPROBE_PATH: '/bin/sh' }),
    );
    const seeks: number[] = [];
    jest.spyOn(service as never, 'runProcess').mockImplementation(((
      _name: string,
      _path: string,
      args: string[],
    ) => {
      const seek = Number(args[args.indexOf('-ss') + 1]);
      seeks.push(seek);
      if (writesAt(seek)) {
        writeFileSync(outputPath, 'jpg');
      }
      return { stdout: '', stderr: '' };
    }) as never);

    return { service, seeks };
  };

  it('keeps the requested timestamp when ffmpeg writes a frame', async () => {
    const { service, seeks } = createService(() => true);

    await service.extractThumbnail('in.mp4', outputPath, 1.08);

    expect(seeks).toEqual([1.08]);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('retries from the first frame when the seek lands after the last frame', async () => {
    const { service, seeks } = createService((seek) => seek === 0);

    await service.extractThumbnail('in.mp4', outputPath, 1.08);

    expect(seeks).toEqual([1.08, 0]);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('fails with a clear error when no frame can be written at all', async () => {
    const { service } = createService(() => false);

    await expect(
      service.extractThumbnail('in.mp4', outputPath, 1.08),
    ).rejects.toBeInstanceOf(MediaProcessError);
  });
});
