import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authedRequest, connect, disconnect, loadCustomProviders, redact, statusReport } from '../src/actions.js';
import { createVault } from '../src/vault.js';
import { renderPage } from '../src/page.js';

/** A fetch that answers the provider verification endpoint. */
function verifyingFetch(account = { login: 'octocat' }) {
  return async (url, init) => {
    assert.match(String(url), /api\.github\.com/);
    assert.match(String(init.headers.authorization), /^Bearer /);
    return new Response(JSON.stringify(account), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('connect verifies then stores, and status reports it without the token', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  const token = `ghp_${'c'.repeat(36)}`;
  const result = await connect(home, { provider: 'github', token }, verifyingFetch());
  assert.equal(result.ok, true);
  assert.equal(result.provider.login, 'octocat');

  const report = await statusReport(home);
  const github = report.providers.find((row) => row.id === 'github');
  assert.equal(github.connected, true);
  assert.equal(github.login, 'octocat');
  assert.equal(JSON.stringify(report).includes(token), false);

  const raw = await readFile(createVault(home).vaultFile, 'utf8');
  assert.equal(raw.includes(token), false);
});

test('connect refuses a token the platform rejects', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  const result = await connect(home, { provider: 'github', token: 'ghp_bad' }, async () =>
    new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'verify-failed');
  assert.deepEqual(await createVault(home).ids(), []);
});

test('connect refuses to persist an unreachable platform', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  const result = await connect(home, { provider: 'github', token: 'ghp_x' }, async () => {
    throw new Error('ECONNREFUSED');
  });
  assert.equal(result.error, 'verify-unreachable');
  assert.deepEqual(await createVault(home).ids(), []);
});

test('connect needs a username only where the provider asks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  assert.equal((await connect(home, { provider: 'docker', token: 'x' }, verifyingFetch())).error, 'username-required');
  assert.equal((await connect(home, { provider: 'docker', token: 'x', username: 'me' }, verifyingFetch())).ok, true);
});

test('authed request uses the stored token and hides it in the response', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  const token = `ghp_${'d'.repeat(36)}`;
  await connect(home, { provider: 'github', token }, verifyingFetch());

  let seen = null;
  const result = await authedRequest(home, { provider: 'github', path: '/user/repos', query: { per_page: 1 } }, undefined, async (url, init) => {
    seen = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ echo: token, items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  assert.equal(seen.url, 'https://api.github.com/user/repos?per_page=1');
  assert.equal(seen.headers.authorization, `Bearer ${token}`);
  assert.equal(result.status, 200);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.match(JSON.stringify(result), /\[redacted\]/);
});

test('authed request cannot be redirected to another host or credential header', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  await connect(home, { provider: 'github', token: `ghp_${'e'.repeat(36)}` }, verifyingFetch());

  const escape = await authedRequest(home, { provider: 'github', path: '//evil.example/x' }, undefined, async () => {
    throw new Error('must not fetch');
  });
  assert.equal(escape.error, 'path-must-not-be-protocol-relative');

  let headers = null;
  await authedRequest(
    home,
    { provider: 'github', path: '/user', headers: { Authorization: 'Bearer attacker', 'X-Trace': 'ok' } },
    undefined,
    async (url, init) => {
      headers = init.headers;
      return new Response('{}', { status: 200 });
    },
  );
  assert.match(headers.authorization, /^Bearer ghp_/);
  assert.equal(headers['x-trace'], 'ok');
});

test('authed request explains an unconnected provider and a stale token', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  assert.equal((await authedRequest(home, { provider: 'vercel', path: '/v2/user' })).error, 'not-connected');

  await connect(home, { provider: 'github', token: `ghp_${'f'.repeat(36)}` }, verifyingFetch());
  const stale = await authedRequest(home, { provider: 'github', path: '/user' }, undefined, async () => new Response('{}', { status: 401 }));
  assert.equal(stale.status, 401);
  assert.match(stale.hint, /reconnect/i);
});

test('disconnect forgets a provider', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  await connect(home, { provider: 'github', token: `ghp_${'a'.repeat(36)}` }, verifyingFetch());
  assert.equal(await disconnect(home, 'github'), true);
  assert.equal((await statusReport(home)).connected, 0);
});

test('custom providers can be added without shipping new code', async () => {
  const { writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  await writeFile(
    path.join(home, 'providers.json'),
    JSON.stringify([{ id: 'acme', name: 'Acme', baseUrl: 'https://api.acme.example', auth: { kind: 'bearer' }, verify: { path: '/me' } }]),
  );
  const custom = await loadCustomProviders(home);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].id, 'acme');
  assert.equal((await connect(home, { provider: 'acme', token: 'x' }, async () => new Response('{"ok":true}', { status: 200 }))).ok, true);
  assert.equal((await statusReport(home)).providers.some((row) => row.id === 'acme' && row.custom), true);
});

test('redaction catches the stored token and token-shaped strings', () => {
  const value = { a: 'ghp_abcdefghijklmnopqrstuvwxyz0123', b: ['glpat-abcdefghijklmnopqrst'], c: 42 };
  const out = redact(value, []);
  assert.equal(JSON.stringify(out).includes('ghp_'), false);
  assert.equal(JSON.stringify(out).includes('glpat-'), false);
  assert.equal(out.c, 42);
});

test('the page renders providers and no secret', () => {
  const html = renderPage({
    providers: [{ id: 'github', name: 'GitHub', category: '代码托管', docs: 'https://x', prefix: 'ghp_', scopes: 'repo', deviceFlow: true, needsUsername: false, verifiable: true }],
    clientIds: { github: '' },
  });
  assert.match(html, /\/dsh-connectors\/connect/);
  assert.match(html, /GitHub/);
  assert.equal(html.includes('ghp_abcdef'), false);
});
