import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function productionTypescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypescriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

describe('semantic pipeline clean architecture', () => {
  const applicationRoots = [
    join(root, 'apps/ai-service/src/application'),
    join(root, 'apps/reel-indexing-service/src/application'),
  ];

  it('keeps infrastructure and ConfigService out of application source', () => {
    const violations = applicationRoots.flatMap((directory) =>
      productionTypescriptFiles(directory).flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('/infrastructure') ||
          source.includes('@nestjs/config') ||
          source.includes('ConfigService')
          ? [file]
          : [];
      }),
    );
    expect(violations).toEqual([]);
  });

  it('keeps provider model IDs out of semantic application use cases', () => {
    const legacyWorkersAiPrefix = ['@', 'cf/'].join('');
    const violations = applicationRoots.flatMap((directory) =>
      productionTypescriptFiles(directory).filter((file) =>
        readFileSync(file, 'utf8').includes(legacyWorkersAiPrefix),
      ),
    );
    expect(violations).toEqual([]);
  });
});
