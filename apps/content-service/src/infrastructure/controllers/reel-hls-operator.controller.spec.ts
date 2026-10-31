import { ConfigService } from '@nestjs/config';
import { ReelHlsOperatorController } from './reel-hls-operator.controller';

describe('internal HLS replacement gate', () => {
  it('is disabled by default and rejects malformed commands before use-case or storage work', async () => {
    const execute = jest.fn();
    const config = new ConfigService({});
    config.skipProcessEnv = true;
    const controller = new ReelHlsOperatorController(
      config,
      { execute } as never,
      { execute } as never,
    );
    await expect(controller.execute({ action: 'APPLY' })).rejects.toThrow(
      'disabled',
    );
    config.set('REEL_HLS_REPLACEMENT_ENABLED', 'true');
    await expect(controller.execute({ action: 'APPLY' })).rejects.toThrow(
      'Invalid',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
