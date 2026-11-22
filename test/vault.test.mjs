import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createVault, project } from '../src/vault.js';

test('vault round-trips a credential and lists it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  const vault = createVault(home);
  const token = `ghp_${'a'.repeat(36)}`;
  const stored = await vault.put('github', { token, login: 'octocat', scopes: ['repo'] });

  assert.equal(stored.connected, true);
  assert.equal(stored.hint, '••••aaaa');
  assert.equal(stored.login, 'octocat');
  assert.deepEqual(await vault.ids(), ['github']);

  const credential = await vault.get('github');
  assert.equal(credential.token, token);
  assert.equal(credential.login, 'octocat');
});

test('vault file never contains the plaintext token', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  const vault = createVault(home);
  const token = `ghp_${'b'.repeat(36)}`;
  await vault.put('github', { token });

  const raw = await readFile(vault.vaultFile, 'utf8');
  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes('ghp_'), false);

  const keyInfo = await stat(path.join(home, 'key'));
  const vaultInfo = await stat(vault.vaultFile);
  assert.equal(keyInfo.mode & 0o777, 0o600);
  assert.equal(vaultInfo.mode & 0o777, 0o600);
  assert.notEqual((await readFile(path.join(home, 'key'))).toString('base64'), '');
});

test('vault rejects an empty token and forgets on remove', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  const vault = createVault(home);
  await assert.rejects(() => vault.put('github', { token: '   ' }), /token-required/);
  await vault.put('github', { token: 'ghp_1234567890' });
  assert.equal(await vault.remove('github'), true);
  assert.equal(await vault.remove('github'), false);
  assert.equal(await vault.get('github'), null);
});

test('each record is bound to its provider id', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-'));
  const vault = createVault(home);
  await vault.put('github', { token: 'ghp_abcdefgh' });

  // Copy the ciphertext under another provider key: GCM should refuse it.
  const envelope = JSON.parse(await readFile(vault.vaultFile, 'utf8'));
  envelope.records.gitlab = envelope.records.github;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(vault.vaultFile, JSON.stringify(envelope), { mode: 0o600 });

  assert.equal(await vault.get('gitlab'), null);
  assert.notEqual(await vault.get('github'), null);
});

test('projection hides the secret', () => {
  const projection = project('github', { token: 'ghp_1234567890', login: 'octocat' });
  assert.equal('token' in projection, false);
  assert.equal(JSON.stringify(projection).includes('ghp_1234567890'), false);
});
