import assert from 'node:assert/strict';
import test from 'node:test';

import { authHeaders, providerById, resolveRequestUrl, verifyCredential, RESERVED_HEADERS } from '../src/providers.js';

test('urls stay inside the provider origin', () => {
  const github = providerById('github');
  assert.equal(resolveRequestUrl(github, '/user').toString(), 'https://api.github.com/user');
  assert.equal(
    resolveRequestUrl(github, '/repos/o/r/issues', { state: 'open', label: ['bug', 'help'] }).toString(),
    'https://api.github.com/repos/o/r/issues?state=open&label=bug&label=help',
  );
  assert.throws(() => resolveRequestUrl(github, 'user'), /path-must-start-with-slash/);
  assert.throws(() => resolveRequestUrl(github, '//evil.example/steal'), /protocol-relative/);
  assert.throws(() => resolveRequestUrl(github, 'https://evil.example'), /path-must-start-with-slash/);
});

test('auth headers follow each provider convention', () => {
  assert.deepEqual(authHeaders(providerById('github'), { token: 't' }), { authorization: 'Bearer t' });
  assert.deepEqual(authHeaders(providerById('gitlab'), { token: 't' }), { 'private-token': 't' });
  assert.deepEqual(authHeaders(providerById('gitee'), { token: 't' }), { authorization: 'token t' });
  assert.deepEqual(authHeaders(providerById('figma'), { token: 't' }), { 'x-figma-token': 't' });
  const docker = authHeaders(providerById('docker'), { token: 't', username: 'me' });
  assert.equal(docker.authorization, `Basic ${Buffer.from('me:t').toString('base64')}`);
  assert.throws(() => authHeaders(providerById('github'), {}), /missing-token/);
});

test('reserved headers cannot be overridden by a caller', () => {
  for (const name of ['authorization', 'cookie', 'host', 'x-api-key', 'private-token']) {
    assert.equal(RESERVED_HEADERS.has(name), true);
  }
});

test('verification projects an account without the token', async () => {
  const github = providerById('github');
  const fakeFetch = async (url, init) => {
    assert.equal(url.toString(), 'https://api.github.com/user');
    assert.equal(init.headers.authorization, 'Bearer secret');
    return new Response(JSON.stringify({ login: 'octocat', name: 'The Octocat', avatar_url: 'https://x/y.png' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await verifyCredential(github, { token: 'secret' }, fakeFetch);
  assert.equal(result.ok, true);
  assert.deepEqual(result.account, { login: 'octocat', name: 'The Octocat', avatarUrl: 'https://x/y.png' });
});

test('verification reports a rejected token', async () => {
  const github = providerById('github');
  const fakeFetch = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  const result = await verifyCredential(github, { token: 'nope' }, fakeFetch);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /Bad credentials/);
});

test('providers without a verify endpoint are accepted as-is', async () => {
  const docker = providerById('docker');
  const result = await verifyCredential(docker, { token: 't', username: 'me' }, async () => {
    throw new Error('should not be called');
  });
  assert.equal(result.ok, true);
});
