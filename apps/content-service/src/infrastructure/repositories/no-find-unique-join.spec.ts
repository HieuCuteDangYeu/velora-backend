import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Prisma 5.22 relationJoins: concurrent findUnique calls (the engine batches them into one
// query) made the query engine panic with "called Option::unwrap() on a None value", which
// surfaced as HTTP 500 on reel detail and reel context for about 5% of requests at 6-10
// concurrent viewers (2026-11-18). findMany and findFirst with relationLoadStrategy: 'join'
// ran thousands of requests without a failure, so only findUnique/findUniqueOrThrow are banned.
describe('relationLoadStrategy join', () => {
  const dir = __dirname;
  const sources = readdirSync(dir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  );

  it.each(sources)('is not used on a findUnique call in %s', (name) => {
    const text = readFileSync(join(dir, name), 'utf8');
    const call = /\.(findUnique|findUniqueOrThrow)\(\s*\{/g;
    const offenders: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = call.exec(text)) !== null) {
      let depth = 0;
      let index = match.index + match[0].length - 1;
      for (; index < text.length; index += 1) {
        if (text[index] === '{') depth += 1;
        if (text[index] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const body = text.slice(match.index, index + 1);
      if (body.includes('relationLoadStrategy')) {
        offenders.push(text.slice(0, match.index).split('\n').length);
      }
    }
    expect(offenders).toEqual([]);
  });
});
