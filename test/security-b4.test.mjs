/**
 * B4 — concurrency, bounded reads, device-flow races, cleanup.
 *
 * The vault tests include a real multi-process case: the in-process queue only
 * proves half the fix, and the lock file only matters when two processes write.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { authedRequest } from '../src/actions.js';
import { createVault } from '../src/vault.js';
import { createDeviceFlows } from '../index.js';

const VAULT_URL = pathToFileURL(path.resolve('src/vault.js')).href;

test('two vault instances writing at once keep every record', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b4-'));
  const a = createVault(home);
  const b = createVault(home);

  await Promise.all([
    ...Array.from({ length: 6 }, (_, index) => a.put(`alpha${index}`, { token: `npm_alpha_${index}_${'a'.repeat(20)}` })),
    ...Array.from({ length: 6 }, (_, index) => b.put(`beta${index}`, { token: `npm_beta_${index}_${'b'.repeat(20)}` })),
  ]);

  const ids = await createVault(home).ids();
  assert.equal(ids.length, 12, `expected 12 records, got ${ids.length}: ${ids.join(',')}`);
});

test('concurrent writes to the same id leave one complete record', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b4-'));
  const a = createVault(home);
  const b = createVault(home);

  await Promise.all([
    a.put('github', { token: `ghp_${'a'.repeat(36)}`, login: 'first' }),
    b.put('github', { token: `ghp_${'b'.repeat(36)}`, login: 'second' }),
  ]);

  const credential = await createVault(home).get('github');
  assert.ok(credential, 'the record must decrypt');
  assert.ok(['first', 'second'].includes(credential.login));
  assert.equal(credential.token.length, 40);
});

test('separate processes serialize through the lock file', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b4-'));
  const script = path.join(home, 'writer.mjs');
  await writeFile(
    script,
    [
      `import { createVault } from ${JSON.stringify(VAULT_URL)};`,
      'const [home, id] = process.argv.slice(2);',
      `await createVault(home).put(id, { token: 'npm_' + id + '${'x'.repeat(24)}' });`,
    ].join('\n'),
  );

  const children = Array.from({ length: 8 }, (_, index) => {
    const id = `proc${index}`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, home, id], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(id) : reject(new Error(`writer ${id} exited ${code}`))));
    });
  });

  const done = await Promise.all(children);
  const ids = await createVault(home).ids();
  assert.equal(ids.length, 8, `expected 8 records, got ${ids.length}; writers: ${done.join(',')}`);
});

test('a large platform response is cut at the cap, not buffered whole', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b4-'));
  await createVault(home).put('github', { token: `ghp_${'d'.repeat(36)}` });

  const body = 'x'.repeat(8 * 1024 * 1024);
  const fakeFetch = async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

  const result = await authedRequest(home, { provider: 'github', path: '/user' }, undefined, fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(result.data.truncated, true);
  assert.ok(result.data.preview.length <= 20_000, 'preview stays bounded');
  assert.match(result.note, /exceeded/);
});

test('a device flow that authorizes is stored', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b4-'));
  await createVault(home).patchSettings({ 'github:clientId': 'Iv1.test', 'gitlab:clientId': 'Iv2.test' });
  const flows = createDeviceFlows(home, {
    intervalScale: 0.0001,
    startDeviceFlow: async () => ({ deviceCode: 'd', userCode: 'U-1', verificationUri: 'https://x', expiresIn: 900, interval: 5 }),
    pollDeviceFlow: async () => ({ status: 'authorized', token: `ghp_${'e'.repeat(36)}` }),
    connect: async (dir, input) => {
      await createVault(dir).put(input.provider, { token: input.token });
      return { ok: true };
    },
  });

  await flows.start('github');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(await createVault(home).ids(), ['github']);
  flows.dispose();
});

test('cancelling a flow stops an authorization that lands afterwards', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b4-'));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let stored = 0;
  await createVault(home).patchSettings({ 'github:clientId': 'Iv1.test', 'gitlab:clientId': 'Iv2.test' });
  const flows = createDeviceFlows(home, {
    intervalScale: 0.0001,
    startDeviceFlow: async () => ({ deviceCode: 'd', userCode: 'U-2', verificationUri: 'https://x', expiresIn: 900, interval: 5 }),
    pollDeviceFlow: async () => {
      await gate;
      return { status: 'authorized', token: `ghp_${'f'.repeat(36)}` };
    },
    connect: async () => {
      stored += 1;
      return { ok: true };
    },
  });

  await flows.start('github');
  await new Promise((resolve) => setTimeout(resolve, 20));
  flows.cancel('github');
  release();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(stored, 0, 'a superseded flow must not commit');
  flows.dispose();
});

test('two providers poll independently', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b4-'));
  const seen = [];
  await createVault(home).patchSettings({ 'github:clientId': 'Iv1.test', 'gitlab:clientId': 'Iv2.test' });
  const flows = createDeviceFlows(home, {
    intervalScale: 0.0001,
    startDeviceFlow: async () => ({ deviceCode: 'd', userCode: 'U-3', verificationUri: 'https://x', expiresIn: 900, interval: 5 }),
    pollDeviceFlow: async (clientId, deviceCode) => {
      seen.push(deviceCode);
      return { status: 'authorized', token: `ghp_${'g'.repeat(36)}` };
    },
    connect: async (dir, input) => {
      await createVault(dir).put(input.provider, { token: input.token });
      return { ok: true };
    },
  });

  await flows.start('github');
  await flows.start('gitlab');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const ids = await createVault(home).ids();
  assert.deepEqual(ids.sort(), ['github', 'gitlab']);
  assert.ok(seen.length >= 2);
  flows.dispose();
});

test('dispose stops polling and cancels in-flight work', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-b4-'));
  let polls = 0;
  let aborted = false;
  await createVault(home).patchSettings({ 'github:clientId': 'Iv1.test', 'gitlab:clientId': 'Iv2.test' });
  const flows = createDeviceFlows(home, {
    intervalScale: 0.0001,
    startDeviceFlow: async () => ({ deviceCode: 'd', userCode: 'U-4', verificationUri: 'https://x', expiresIn: 900, interval: 5 }),
    pollDeviceFlow: async (clientId, deviceCode, fetchImpl, signal) => {
      polls += 1;
      signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return { status: 'pending' };
    },
  });

  await flows.start('github');
  await new Promise((resolve) => setTimeout(resolve, 30));
  flows.dispose();
  const after = polls;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(polls, after, 'no poll after dispose');
  assert.equal(aborted, true, 'the in-flight signal was aborted');
});
