/**
 * B1 — built-in provider ids are a locked namespace.
 *
 * These tests drive the seam a hostile or mistaken providers.json reaches:
 * the loader and the two lookup functions. They assert both halves of the
 * contract — a built-in id never resolves to a custom endpoint, and a
 * legitimate custom entry still works.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { allProviders, BUILTIN_IDS, normalizeProviderId, providerById, sanitizeCustomProviders } from '../src/providers.js';
import { loadCustomProviders, loadCustomProvidersDetailed, statusReport } from '../src/actions.js';
import { createVault } from '../src/vault.js';

const GITHUB_API = 'https://api.github.com';

/** A valid custom preset that does not collide with anything. */
function goodCustom(overrides = {}) {
  return {
    id: 'acme',
    name: 'Acme',
    baseUrl: 'https://api.acme.example',
    auth: { kind: 'bearer' },
    verify: { path: '/me' },
    ...overrides,
  };
}

test('every built-in id resolves to its built-in endpoint', () => {
  for (const id of BUILTIN_IDS) {
    const provider = providerById(id, []);
    assert.ok(provider, `${id} should resolve`);
    assert.equal(provider.custom, undefined, `${id} must not be custom`);
  }
  assert.equal(providerById('github', []).baseUrl, GITHUB_API);
});

test('a valid custom provider is accepted and appended', () => {
  const { accepted, rejected } = sanitizeCustomProviders([goodCustom()]);
  assert.deepEqual(rejected, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, 'acme');
  assert.equal(allProviders(accepted).length, BUILTIN_IDS.length + 1);
  assert.equal(providerById('acme', accepted).baseUrl, 'https://api.acme.example');
});

test('a custom provider cannot take a built-in id', () => {
  const { accepted, rejected } = sanitizeCustomProviders([
    goodCustom({ id: 'github', baseUrl: 'https://collector.evil.example' }),
  ]);
  assert.deepEqual(accepted, []);
  assert.deepEqual(rejected, [{ id: 'github', reason: 'id-reserved' }]);
});

test('case, width, whitespace and zero-width variants cannot escape the lock', () => {
  const variants = ['GitHub', 'GITHUB', ' github ', 'git\u200bhub', 'ｇｉｔｈｕｂ', 'Git\u00a0Hub'];
  for (const id of variants) {
    assert.equal(normalizeProviderId(id), 'github', `${JSON.stringify(id)} should normalize to github`);
    const { accepted, rejected } = sanitizeCustomProviders([goodCustom({ id, baseUrl: 'https://collector.evil.example' })]);
    assert.equal(accepted.length, 0, `${JSON.stringify(id)} must be refused`);
    assert.equal(rejected[0].reason, 'id-reserved');
  }
});

test('the lock holds even when a caller bypasses the loader', () => {
  // This is the P0 probe from the audit: hand providerById and allProviders a
  // raw, unsanitized row that shadows github.
  const hostile = [{ id: 'github', baseUrl: 'https://collector.evil.example', auth: { kind: 'bearer' } }];
  assert.equal(providerById('github', hostile).baseUrl, GITHUB_API);
  assert.equal(allProviders(hostile).length, BUILTIN_IDS.length);
  assert.equal(providerById('GitHub', hostile).baseUrl, GITHUB_API);
});

test('duplicate custom ids keep the first and refuse the rest', () => {
  const { accepted, rejected } = sanitizeCustomProviders([
    goodCustom({ id: 'acme', name: 'First' }),
    goodCustom({ id: 'ACME', name: 'Second' }),
  ]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].name, 'First');
  assert.deepEqual(rejected, [{ id: 'ACME', reason: 'id-duplicate' }]);
});

test('malformed and hostile base urls are refused', () => {
  const cases = [
    ['http://api.acme.example', 'base-url-insecure'],
    ['https://user:pass@api.acme.example', 'base-url-has-userinfo'],
    ['https://api.acme.example/?next=https://evil.example', 'base-url-has-query'],
    ['not a url', 'base-url-invalid'],
    ['', 'base-url-invalid'],
  ];
  for (const [baseUrl, reason] of cases) {
    const { accepted, rejected } = sanitizeCustomProviders([goodCustom({ baseUrl })]);
    assert.equal(accepted.length, 0, `${baseUrl} must be refused`);
    assert.equal(rejected[0].reason, reason, `${baseUrl} -> ${reason}`);
  }
});

test('a custom provider cannot smuggle reserved headers or a bad verify path', () => {
  const cases = [
    [goodCustom({ defaultHeaders: { authorization: 'Bearer x' } }), 'header-reserved'],
    [goodCustom({ auth: { kind: 'header', header: 'cookie' } }), 'auth-header-invalid'],
    [goodCustom({ verify: { path: '//evil.example/me' } }), 'verify-path-invalid'],
    [goodCustom({ verify: { path: '/me', method: 'DELETE' } }), 'verify-method-invalid'],
    [goodCustom({ id: 'acme/x' }), 'id-invalid'],
    [goodCustom({ id: '<script>' }), 'id-invalid'],
  ];
  for (const [row, reason] of cases) {
    const { accepted, rejected } = sanitizeCustomProviders([row]);
    assert.equal(accepted.length, 0);
    assert.equal(rejected[0].reason, reason);
  }
});

test('providers.json with a github override is refused on load, built-in wins', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b1-'));
  await writeFile(
    path.join(home, 'providers.json'),
    JSON.stringify([
      { id: 'github', baseUrl: 'https://collector.evil.example', auth: { kind: 'bearer' }, verify: { path: '/steal' } },
      goodCustom(),
    ]),
  );

  const detailed = await loadCustomProvidersDetailed(home);
  assert.deepEqual(detailed.rejected, [{ id: 'github', reason: 'id-reserved' }]);
  assert.equal(detailed.accepted.length, 1);
  assert.deepEqual(
    (await loadCustomProviders(home)).map((provider) => provider.id),
    ['acme'],
  );

  const report = await statusReport(home);
  assert.deepEqual(report.rejectedProviders, [{ id: 'github', reason: 'id-reserved' }]);
  const github = report.providers.find((row) => row.id === 'github');
  assert.equal(github.webUrl, GITHUB_API);
  assert.equal(github.custom, false);
});

test('credentials stored before the fix still load after it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b1-'));
  const token = `ghp_${'b'.repeat(36)}`;
  await createVault(home).put('github', { token, login: 'octocat', connectedAt: 1_700_000_000_000 });

  // A hostile file next to a pre-existing credential must not change which
  // endpoint that credential is spent at, nor make it unreadable.
  await writeFile(
    path.join(home, 'providers.json'),
    JSON.stringify([{ id: 'GitHub', baseUrl: 'https://collector.evil.example', auth: { kind: 'bearer' } }]),
  );

  const report = await statusReport(home);
  const github = report.providers.find((row) => row.id === 'github');
  assert.equal(github.connected, true);
  assert.equal(github.login, 'octocat');
  assert.equal(github.webUrl, GITHUB_API);
  assert.equal((await createVault(home).get('github')).token, token);
});
