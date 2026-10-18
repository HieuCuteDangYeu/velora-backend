const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  checkDockerfile,
  checkPrismaClients,
  checkRepository,
  checkRuntimeImports,
  checkSharedDependencyStages,
} = require('./check-production-images.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const packageJson = { dependencies: { prisma: '5.22.0' }, devDependencies: {} };

const goodDockerfile = `FROM node:20-alpine AS base
RUN corepack enable

FROM base AS deps
RUN pnpm install --prod --frozen-lockfile \\
  --ignore-scripts

FROM base AS builder
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS production
COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/node_modules/@prisma/auth-client ./node_modules/@prisma/auth-client
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist
CMD ["node", "dist/main.js"]
`;

test('the repository passes every production image check', () => {
  assert.deepEqual(checkRepository(repoRoot), []);
});

test('accepts a production-only dependency stage', () => {
  assert.deepEqual(checkDockerfile('svc', goodDockerfile, packageJson), []);
});

test('rejects copying the full builder node_modules into production', () => {
  const dockerfile = goodDockerfile.replace(
    'COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules',
    'COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules',
  );
  assert.match(
    checkDockerfile('svc', dockerfile, packageJson).join('\n'),
    /copies node_modules from "builder"/,
  );
});

test('rejects a deps stage that installs devDependencies', () => {
  const dockerfile = goodDockerfile.replace('install --prod', 'install');
  assert.match(
    checkDockerfile('svc', dockerfile, packageJson).join('\n'),
    /copies node_modules from "deps"/,
  );
});

test('rejects installs without a frozen lockfile', () => {
  const dockerfile = goodDockerfile.replace(
    'RUN pnpm install --frozen-lockfile\n',
    'RUN pnpm install\n',
  );
  assert.match(
    checkDockerfile('svc', dockerfile, packageJson).join('\n'),
    /without --frozen-lockfile/,
  );
});

test('rejects unexpected node_modules paths in production', () => {
  const dockerfile = goodDockerfile.replace(
    '/usr/src/app/dist ./dist',
    '/usr/src/app/dist ./dist\nCOPY --from=builder /usr/src/app/node_modules/typescript ./node_modules/typescript',
  );
  assert.match(
    checkDockerfile('svc', dockerfile, packageJson).join('\n'),
    /unexpected node_modules path/,
  );
});

test('requires prisma in dependencies when the image runs the prisma CLI', () => {
  const dockerfile = goodDockerfile.replace(
    'CMD ["node", "dist/main.js"]',
    'CMD ["/bin/sh", "-c", "node_modules/.bin/prisma migrate deploy"]',
  );
  assert.match(
    checkDockerfile('svc', dockerfile, {
      dependencies: {},
      devDependencies: { prisma: '5' },
    }).join('\n'),
    /prisma is not in package.json dependencies/,
  );
  assert.deepEqual(checkDockerfile('svc', dockerfile, packageJson), []);
});

test('requires services on one base image to share the deps stage', () => {
  const variant = goodDockerfile.replace(
    '--ignore-scripts',
    '--ignore-scripts --offline',
  );
  assert.deepEqual(
    checkSharedDependencyStages([
      ['a', goodDockerfile],
      ['b', goodDockerfile],
    ]),
    [],
  );
  assert.match(
    checkSharedDependencyStages([
      ['a', goodDockerfile],
      ['b', variant],
    ]).join('\n'),
    /must share one base and deps stage/,
  );
});

test('flags runtime imports of devDependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-check-'));
  try {
    fs.mkdirSync(path.join(root, 'libs', 'common'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'libs', 'common', 'seed.ts'),
      "import 'dotenv/config';\nimport { join } from 'node:path';\nimport { Request } from 'express';\n",
    );
    fs.writeFileSync(
      path.join(root, 'libs', 'common', 'seed.spec.ts'),
      "import 'jest-extended';\n",
    );
    const pkg = {
      dependencies: {},
      devDependencies: { dotenv: '1', 'jest-extended': '1' },
    };
    assert.deepEqual(checkRuntimeImports(root, pkg), [
      'dotenv is a devDependency but runtime code imports it (libs/common/seed.ts); move it to dependencies',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires each image to ship the prisma clients its code imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-check-'));
  try {
    fs.mkdirSync(path.join(root, 'apps', 'svc', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'apps', 'svc', 'src', 'prisma.service.ts'),
      "import { PrismaClient } from '@prisma/svc-client';\n",
    );
    assert.deepEqual(checkPrismaClients(root, 'svc', goodDockerfile), [
      'svc: code imports @prisma/svc-client but the image does not ship it',
      'svc: image ships @prisma/auth-client but the code never imports it',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
