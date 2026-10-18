#!/usr/bin/env node
'use strict';

// Static guards for the service images: production images must ship production
// dependencies only, and the dependency layer must stay shareable between
// services. Run with: node scripts/docker/check-production-images.cjs

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const APP_ROOT = '/usr/src/app';
const SKIPPED_SOURCE_DIRS = new Set([
  'node_modules',
  'dist',
  'test',
  '__mocks__',
  'prisma',
]);

// Joins line continuations and drops comments and blank lines.
function parseInstructions(text) {
  const instructions = [];
  let pending = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!pending && (line === '' || line.startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    instructions.push(`${pending}${line}`.trim());
    pending = '';
  }
  return instructions;
}

function parseStages(text) {
  const stages = [];
  for (const instruction of parseInstructions(text)) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(instruction);
    if (from) {
      stages.push({ image: from[1], name: from[2], instructions: [] });
    } else if (stages.length > 0) {
      stages[stages.length - 1].instructions.push(instruction);
    }
  }
  return stages;
}

function pnpmInstalls(stage) {
  return stage.instructions.filter((instruction) =>
    /\bpnpm install\b/.test(instruction),
  );
}

function checkDockerfile(service, text, packageJson) {
  const errors = [];
  const fail = (message) => errors.push(`${service}: ${message}`);
  const stages = parseStages(text);
  const production = stages.find((stage) => stage.name === 'production');
  if (!production) {
    fail('has no "production" stage');
    return errors;
  }

  for (const stage of stages) {
    for (const install of pnpmInstalls(stage)) {
      if (!install.includes('--frozen-lockfile')) {
        fail(
          `stage "${stage.name}" runs pnpm install without --frozen-lockfile`,
        );
      }
    }
  }
  if (pnpmInstalls(production).length > 0) {
    fail('the production stage must not install dependencies itself');
  }

  const productionDependencies = (fromStageName) => {
    const source = stages.find((stage) => stage.name === fromStageName);
    if (!source) return false;
    const installs = pnpmInstalls(source);
    return installs.length > 0 && installs.every((i) => /\s--prod\b/.test(i));
  };

  let copiedNodeModules = false;
  for (const instruction of production.instructions) {
    if (!instruction.startsWith('COPY ')) continue;
    const from = /--from=(\S+)/.exec(instruction);
    if (!from) continue;
    const source = instruction
      .split(/\s+/)
      .filter((part) => !part.startsWith('--'))
      .slice(1, -1)
      .join(' ');
    if (!source.startsWith(`${APP_ROOT}/node_modules`)) continue;

    if (source === `${APP_ROOT}/node_modules`) {
      copiedNodeModules = true;
      if (!productionDependencies(from[1])) {
        fail(
          `the production stage copies node_modules from "${from[1]}", which does not install with --prod`,
        );
      }
    } else if (
      !/^\/usr\/src\/app\/node_modules\/@prisma\/[a-z-]+-client$/.test(source)
    ) {
      fail(
        `the production stage copies unexpected node_modules path ${source}`,
      );
    }
  }
  if (!copiedNodeModules) {
    fail('the production stage never copies the production node_modules tree');
  }

  const usesPrismaCli = production.instructions.some((instruction) =>
    instruction.includes('node_modules/.bin/prisma'),
  );
  if (usesPrismaCli && !packageJson.dependencies?.prisma) {
    fail('runs the prisma CLI but prisma is not in package.json dependencies');
  }
  return errors;
}

// Services with the same base image must build an identical base+deps pair so
// the node_modules layer is byte-identical and stored once.
function checkSharedDependencyStages(dockerfiles) {
  const errors = [];
  const byImage = new Map();
  for (const [service, text] of dockerfiles) {
    const stages = parseStages(text);
    const base = stages.find((stage) => stage.name === 'base');
    const deps = stages.find((stage) => stage.name === 'deps');
    if (!base || !deps) continue;
    const key = JSON.stringify([base, deps]);
    const group = byImage.get(base.image) ?? new Map();
    group.set(key, [...(group.get(key) ?? []), service]);
    byImage.set(base.image, group);
  }
  for (const [image, group] of byImage) {
    if (group.size > 1) {
      const variants = [...group.values()].map((s) => s.join(', ')).join(' | ');
      errors.push(
        `services on ${image} must share one base and deps stage, found: ${variants}`,
      );
    }
  }
  return errors;
}

function* walkSources(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_SOURCE_DIRS.has(entry.name)) yield* walkSources(fullPath);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !/\.(spec|test|e2e-spec)\.ts$/.test(entry.name)
    ) {
      yield fullPath;
    }
  }
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Runtime code must only import packages that production images install.
function checkRuntimeImports(root, packageJson) {
  const devOnly = new Set(
    Object.keys(packageJson.devDependencies ?? {}).filter(
      (name) => !packageJson.dependencies?.[name],
    ),
  );
  const importPattern =
    /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)["']([^"']+)["']/g;
  const offenders = new Map();
  for (const directory of ['apps', 'libs']) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const file of walkSources(absolute)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('node:'))
          continue;
        const name = packageName(specifier);
        if (builtinModules.includes(name) || !devOnly.has(name)) continue;
        const files = offenders.get(name) ?? new Set();
        files.add(path.relative(root, file));
        offenders.set(name, files);
      }
    }
  }
  return [...offenders].map(
    ([name, files]) =>
      `${name} is a devDependency but runtime code imports it (${[...files][0]}${files.size > 1 ? ` and ${files.size - 1} more` : ''}); move it to dependencies`,
  );
}

// A service image ships exactly the generated prisma clients its code imports.
function checkPrismaClients(root, service, text) {
  const production = parseStages(text).find(
    (stage) => stage.name === 'production',
  );
  if (!production) return [];
  const shipped = new Set(
    production.instructions.flatMap((instruction) =>
      [
        ...instruction.matchAll(
          /\/usr\/src\/app\/node_modules\/(@prisma\/[a-z-]+-client)(?:\s|$)/g,
        ),
      ].map((match) => match[1]),
    ),
  );
  const imported = new Set();
  for (const directory of [path.join('apps', service), 'libs']) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const file of walkSources(absolute)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/@prisma\/[a-z-]+-client/g)) {
        imported.add(match[0]);
      }
    }
  }
  const errors = [];
  for (const client of imported) {
    if (!shipped.has(client)) {
      errors.push(
        `${service}: code imports ${client} but the image does not ship it`,
      );
    }
  }
  for (const client of shipped) {
    if (!imported.has(client)) {
      errors.push(
        `${service}: image ships ${client} but the code never imports it`,
      );
    }
  }
  return errors;
}

function checkRepository(root) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  const dockerfiles = fs
    .readdirSync(path.join(root, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [
      entry.name,
      path.join(root, 'apps', entry.name, 'Dockerfile'),
    ])
    .filter(([, file]) => fs.existsSync(file))
    .map(([service, file]) => [service, fs.readFileSync(file, 'utf8')]);

  return [
    ...dockerfiles.flatMap(([service, text]) =>
      checkDockerfile(service, text, packageJson),
    ),
    ...dockerfiles.flatMap(([service, text]) =>
      checkPrismaClients(root, service, text),
    ),
    ...checkSharedDependencyStages(dockerfiles),
    ...checkRuntimeImports(root, packageJson),
  ];
}

module.exports = {
  checkDockerfile,
  checkPrismaClients,
  checkRepository,
  checkRuntimeImports,
  checkSharedDependencyStages,
  parseStages,
};

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  const errors = checkRepository(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR ${error}`);
    process.exit(1);
  }
  console.log('Production image checks passed.');
}
