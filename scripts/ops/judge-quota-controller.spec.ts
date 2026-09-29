import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JudgeQuotaController } from './judge-quota-controller';

describe('JudgeQuotaController', () => {
  const tempLedger = () => {
    const directory = mkdtempSync(join(tmpdir(), 'velora-judge-'));
    return { directory, path: join(directory, 'ledger.jsonl') };
  };

  afterEach(() => {
    // Tests own these temporary directories; production ledgers are operator-managed.
    for (const directory of directories)
      rmSync(directory, { recursive: true, force: true });
    directories.clear();
  });

  const directories = new Set<string>();

  it('reuses a completed request without invoking the judge twice', async () => {
    const ledger = tempLedger();
    directories.add(ledger.directory);
    const controller = new JudgeQuotaController({
      tpmLimit: 100,
      ledgerPath: ledger.path,
    });
    let calls = 0;
    expect(
      await controller.run('request-1', 10, () => {
        calls += 1;
        return Promise.resolve({ value: 1 });
      }),
    ).toEqual({ value: 1 });
    expect(
      await controller.run('request-1', 10, () => {
        calls += 1;
        return Promise.resolve({ value: 2 });
      }),
    ).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  it('fails closed at the daily budget and does not call the provider', async () => {
    const ledger = tempLedger();
    directories.add(ledger.directory);
    const controller = new JudgeQuotaController({
      tpmLimit: 100,
      tpdLimit: 5,
      ledgerPath: ledger.path,
    });
    const operation = jest.fn().mockResolvedValue(undefined);
    await expect(
      controller.run('request-1', 6, operation),
    ).rejects.toMatchObject({ code: 'JUDGE_TPD_EXHAUSTED' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('retries transient failures only within the configured bound', async () => {
    const ledger = tempLedger();
    directories.add(ledger.directory);
    const sleeps: number[] = [];
    const controller = new JudgeQuotaController({
      tpmLimit: 100,
      ledgerPath: ledger.path,
      maxRetries: 1,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    let calls = 0;
    const result = await controller.run('request-1', 10, () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          Object.assign(new Error('rate limited'), { status: 429 }),
        );
      }
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it('paces reservations against the rolling TPM window', async () => {
    const ledger = tempLedger();
    directories.add(ledger.directory);
    let now = 0;
    const sleeps: number[] = [];
    const controller = new JudgeQuotaController({
      tpmLimit: 10,
      ledgerPath: ledger.path,
      now: () => now,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    });
    await controller.run('request-1', 6, () => Promise.resolve('first'));
    await controller.run('request-2', 6, () => Promise.resolve('second'));
    expect(sleeps[0]).toBe(60_000);
  });
});
