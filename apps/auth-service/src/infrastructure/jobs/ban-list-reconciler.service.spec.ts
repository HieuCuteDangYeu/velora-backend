import { Logger } from '@nestjs/common';
import { BanListReconciler } from './ban-list-reconciler.service';

describe('BanListReconciler', () => {
  afterEach(() => jest.restoreAllMocks());

  it('restores only the bans Redis has lost', async () => {
    const banList = {
      ensureBanned: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    };
    const users = { listBannedIds: jest.fn().mockResolvedValue(['a', 'b']) };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    await new BanListReconciler(banList as never, users as never).reconcile();
    expect(banList.ensureBanned).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Restored 1'));
  });

  it('keeps running when the user service is unavailable', async () => {
    const banList = { ensureBanned: jest.fn() };
    const users = {
      listBannedIds: jest.fn().mockRejectedValue(new Error('down')),
    };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    await expect(
      new BanListReconciler(banList as never, users as never).reconcile(),
    ).resolves.toBeUndefined();
    expect(banList.ensureBanned).not.toHaveBeenCalled();
  });
});
