#!/usr/bin/env node
'use strict';

// Operator-only: logs in the synthetic viewers of a stress fixture manifest and prints their
// sessions, for `reel-latency-load.cjs --viewers-file`.
//
//   docker exec -i <container-with-node> node mint-viewer-tokens.cjs --base-url http://nginx < manifest.json > viewers.json
//
// Run it on the server host network (a container on the compose network, the local nginx):
// the gateway rate-limits login per client IP from CF-Connecting-IP, and each fixture user
// presents its own benchmark address (198.18.0.0/15) exactly like prepare-chat-stress-rooms.cjs.
// Through the public edge Cloudflare overwrites the header, so this widens nothing there.
// Output is a JSON array of { accessToken, refreshToken } on stdout; progress goes to stderr
// and never contains credentials. Access tokens live 15 minutes.
const fs = require('node:fs');
const { createHash } = require('node:crypto');

function fixtureClientIp(accountId) {
  const n = createHash('sha256').update(String(accountId)).digest().readUInt32BE(0) % 131072;
  return `198.${18 + (n >>> 16)}.${(n >>> 8) & 255}.${n & 255}`;
}

async function mint(baseUrl, account) {
  const response = await fetch(new URL('/auth/mobile/login', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': fixtureClientIp(account.id) },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  const tokens = await response.json();
  if (!tokens.accessToken || !tokens.refreshToken) throw new Error('login returned no tokens');
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

async function main(args = process.argv.slice(2)) {
  const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
  const baseUrl = opt('base-url', 'http://nginx');
  const limit = Number(opt('limit', '0')) || Infinity;
  const concurrency = Math.min(Number(opt('concurrency', '4')) || 4, 8);
  const manifest = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!/^mu-[a-f0-9]{12}$/.test(manifest.fixtureNamespace ?? '') || !Array.isArray(manifest.accounts)) throw new Error('Not a fixture manifest');
  const accounts = manifest.accounts.slice(0, limit);
  const sessions = new Array(accounts.length);
  let next = 0;
  let failures = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < accounts.length) {
      const index = next++;
      try { sessions[index] = await mint(baseUrl, accounts[index]); } catch (error) { failures += 1; console.error(`account ${index + 1}: ${error.message}`); }
    }
  }));
  console.error(`minted ${sessions.filter(Boolean).length}/${accounts.length}, failures ${failures}`);
  if (failures) process.exitCode = 1;
  else process.stdout.write(JSON.stringify(sessions));
}

if (require.main === module) main().catch((error) => { console.error(`[fatal] ${error.message}`); process.exitCode = 2; });
module.exports = { fixtureClientIp };
