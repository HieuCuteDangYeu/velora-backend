const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generate, main } = require('./generate-chat-stress-scale-fixtures.cjs');
const { validateManifest } = require('./seed-chat-stress-users.cjs');

test('generates an isolated scale namespace the seed script accepts', () => {
  const manifest = generate({ users: 2000, baseUrl: 'https://velora.test' });
  assert.match(manifest.fixtureNamespace, /^mu-[a-f0-9]{12}$/);
  assert.equal(manifest.fixtureProfile, 'scale');
  assert.equal(manifest.accounts.length, 2000);
  assert.equal(validateManifest(manifest).accounts.length, 2000);
  assert.equal(new Set(manifest.accounts.map(a => a.id)).size, 2000);
  assert.ok(manifest.accounts.every(a => a.password.length >= 24 && a.email.endsWith('@velora-stress.invalid')));
  assert.ok(manifest.accounts[1999].email.includes('.2000@'));
  assert.equal(manifest.stages[0].users, 2000);
});

test('the demo profile keeps its 200-account limit and unknown profiles are refused', () => {
  const manifest = generate({ users: 250, baseUrl: 'https://velora.test' });
  assert.equal(validateManifest(manifest).accounts.length, 250);
  const demo = { ...manifest }; delete demo.fixtureProfile;
  assert.throws(() => validateManifest(demo), /2\.\.200/);
  assert.throws(() => validateManifest({ ...manifest, fixtureProfile: 'huge' }), /profile/);
});

test('refuses bad sizes and non-HTTPS origins', () => {
  assert.throws(() => generate({ users: 7, baseUrl: 'https://velora.test' }), /multiple of 5/);
  assert.throws(() => generate({ users: 5005, baseUrl: 'https://velora.test' }), /between/);
  assert.throws(() => generate({ users: 100, baseUrl: 'http://velora.test' }), /HTTPS/);
});

test('writes a private file and never overwrites an existing manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-scale-'));
  const out = path.join(dir, 'manifest.json');
  const log = console.log; console.log = () => {};
  try {
    main(['--users', '20', '--base-url', 'https://velora.test', '--out', out]);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).accounts.length, 20);
    assert.throws(() => main(['--users', '20', '--base-url', 'https://velora.test', '--out', out]), { code: 'EEXIST' });
  } finally { console.log = log; fs.rmSync(dir, { recursive: true }); }
});
