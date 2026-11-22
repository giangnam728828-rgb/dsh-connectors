/**
 * B3 — a plugin that only wants to use a connection must not be able to copy
 * the secret behind it.
 *
 * The service is exercised as another plugin would see it: `ctx.get('connectors')`
 * then call a method. No harness is started.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createVault } from '../src/vault.js';

const TOKEN = `ghp_${'c'.repeat(36)}`;

/**
 * Load the plugin against a fresh home and return the recorded service.
 * @returns the home directory and the service object another plugin would get.
 */
async function loadService() {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b3-'));
  process.env.DSH_CONNECTORS_HOME = home;
  await createVault(home).put('github', { token: TOKEN, login: 'octocat' });

  const { apply } = await import('../index.js');
  const provided = {};
  const ctx = {
    effect(fn) {
      fn();
      return () => {};
    },
    get() {
      return undefined;
    },
    provide(name, impl) {
      provided[name] = impl;
    },
    inject() {},
    connection: undefined,
    webServer: undefined,
  };
  apply(ctx);
  assert.ok(provided.connectors, 'the service must still be provided');
  return { home, service: provided.connectors };
}

test('raw credential reads are refused by default', async () => {
  const { service } = await loadService();

  assert.equal((await service.capabilities()).rawCredentials, false);

  await assert.rejects(service.token('github'), (error) => error.code === 'raw-credentials-not-granted');
  await assert.rejects(service.credential('github'), (error) => error.code === 'raw-credentials-not-granted');
});

test('status and list stay available and carry no secret', async () => {
  const { service } = await loadService();

  assert.deepEqual(await service.list(), ['github']);
  const status = await service.status('github');
  assert.equal(status.connected, true);
  assert.equal(status.login, 'octocat');
  assert.equal(status.hint, '••••cccc');
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
});

test('request stays available without the raw grant', async () => {
  const { service } = await loadService();
  // No credential is stored for npm, so this resolves locally without network.
  const result = await service.request({ provider: 'npm', path: '/-/whoami' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not-connected');
});

test('the grant is opt-in, explicit, and reversible', async () => {
  const { home, service } = await loadService();

  await createVault(home).patchSettings({ 'service:allowRawCredentials': true });
  assert.equal((await service.capabilities()).rawCredentials, true);
  assert.equal(await service.token('github'), TOKEN);
  assert.equal((await service.credential('github')).token, TOKEN);

  await createVault(home).patchSettings({ 'service:allowRawCredentials': undefined });
  await assert.rejects(service.token('github'), (error) => error.code === 'raw-credentials-not-granted');
});

test('a non-boolean value does not grant anything', async () => {
  const { home, service } = await loadService();
  await createVault(home).patchSettings({ 'service:allowRawCredentials': 'yes' });
  assert.equal((await service.capabilities()).rawCredentials, false);
  await assert.rejects(service.credential('github'), (error) => error.code === 'raw-credentials-not-granted');
});

test('the refusal message points at the supported path', async () => {
  const { service } = await loadService();
  await assert.rejects(service.token('github'), /request\(\)/);
});
