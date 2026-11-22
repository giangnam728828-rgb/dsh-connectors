/**
 * B2 — the management surface is only reachable through the harness fence.
 *
 * These tests do not start a harness. They drive `apply()` with a fake Cordis
 * context and assert the wiring: every endpoint lives under `/api`, asks for
 * `streaming` bodies, and nothing accepts a request the harness has rejected.
 * The end-to-end behaviour (401 / 403 / 200 against a real listener) was
 * verified separately against DSH 0.2.2-rc.5.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * A minimal Cordis-shaped context.
 * @param options - `rejection` decides what `connection.requestRejection` returns.
 */
function fakeContext({ rejection = () => undefined } = {}) {
  const apiRoutes = [];
  const pageRoutes = [];
  const provided = {};
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get() {
      return undefined;
    },
    provide(name, impl) {
      provided[name] = impl;
    },
    inject(deps, callback) {
      if (deps.includes('webServer') || deps.includes('connection')) callback(ctx);
    },
    connection: {
      fetch: {
        register(route) {
          apiRoutes.push(route);
          return () => {};
        },
      },
      requestRejection(request) {
        return rejection(request);
      },
    },
    webServer: {
      register(route) {
        pageRoutes.push(route);
        return () => {};
      },
    },
  };
  return { ctx, apiRoutes, pageRoutes, provided };
}

/** Minimal Node response recorder. */
function recorder() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      Object.assign(out.headers, headers ?? {});
    },
    end(body) {
      out.body = body === undefined ? '' : String(body);
    },
  };
}

test('every management endpoint is mounted under /api with a streaming body', async () => {
  process.env.DSH_CONNECTORS_HOME = await mkdtemp(path.join(tmpdir(), 'connectors-b2-'));
  const { apply } = await import('../index.js');
  const { ctx, apiRoutes, pageRoutes } = fakeContext();
  apply(ctx);

  const paths = apiRoutes.map((route) => route.path).sort();
  assert.deepEqual(paths, [
    '/api/connectors/connect',
    '/api/connectors/device/cancel',
    '/api/connectors/device/poll',
    '/api/connectors/device/start',
    '/api/connectors/disconnect',
    '/api/connectors/settings',
    '/api/connectors/status',
  ]);
  for (const route of apiRoutes) {
    assert.deepEqual(route.methods, ['POST'], `${route.path} must be POST-only`);
    assert.equal(route.requestBody, 'streaming', `${route.path} must not buffer`);
    assert.equal(typeof route.fetch, 'function');
  }
  assert.deepEqual(pageRoutes.map((route) => route.path), ['/dsh-connectors']);
});

test('no route keeps the 0.1.0 bare path', async () => {
  process.env.DSH_CONNECTORS_HOME = await mkdtemp(path.join(tmpdir(), 'connectors-b2-'));
  const { apply } = await import('../index.js');
  const { ctx, apiRoutes, pageRoutes } = fakeContext();
  apply(ctx);
  const all = [...apiRoutes, ...pageRoutes].map((route) => route.path);
  assert.deepEqual(
    all.filter((routePath) => routePath.startsWith('/dsh-connectors/')),
    [],
    'management paths moved under /api',
  );
});

test('a rejected request never reaches the page', async () => {
  process.env.DSH_CONNECTORS_HOME = await mkdtemp(path.join(tmpdir(), 'connectors-b2-'));
  const { apply } = await import('../index.js');
  const { ctx, pageRoutes } = fakeContext({ rejection: () => 401 });
  apply(ctx);

  const res = recorder();
  await pageRoutes[0].handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.out.status, 401);
  assert.equal(res.out.body.includes('GitHub'), false, 'no platform names leak in the refusal');
  assert.match(res.out.body, /sign in/i);
});

test('an admitted request gets the page and no secret', async () => {
  process.env.DSH_CONNECTORS_HOME = await mkdtemp(path.join(tmpdir(), 'connectors-b2-'));
  const { apply } = await import('../index.js');
  const { ctx, pageRoutes } = fakeContext();
  apply(ctx);

  const res = recorder();
  await pageRoutes[0].handler({ method: 'GET', headers: { cookie: 'dsh-auth-x=y' } }, res);
  assert.equal(res.out.status, 200);
  assert.match(res.out.body, /GitHub/);
  // The page documents the `ghp_` prefix as a hint, so look for a token body,
  // not the bare prefix.
  assert.equal(/gh[pousr]_[A-Za-z0-9]{20,}/.test(res.out.body), false, 'no token material in the page');
  assert.match(res.out.headers['content-security-policy'], /default-src 'none'/);
});

test('an api route refuses a non-POST verb and an oversized body', async () => {
  process.env.DSH_CONNECTORS_HOME = await mkdtemp(path.join(tmpdir(), 'connectors-b2-'));
  const { apply } = await import('../index.js');
  const { ctx, apiRoutes } = fakeContext();
  apply(ctx);
  const status = apiRoutes.find((route) => route.path === '/api/connectors/status');

  const wrongVerb = await status.fetch(new Request('http://local/api/connectors/status', { method: 'GET' }));
  assert.equal(wrongVerb.status, 405);

  const huge = await status.fetch(
    new Request('http://local/api/connectors/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(64 * 1024) }),
    }),
  );
  assert.equal(huge.status, 413);
  assert.deepEqual(await huge.json(), {
    ok: false,
    error: 'body-too-large',
    message: 'Request body is too large.',
  });
});

test('a malformed body is a 400, not a crash', async () => {
  process.env.DSH_CONNECTORS_HOME = await mkdtemp(path.join(tmpdir(), 'connectors-b2-'));
  const { apply } = await import('../index.js');
  const { ctx, apiRoutes } = fakeContext();
  apply(ctx);
  const status = apiRoutes.find((route) => route.path === '/api/connectors/status');
  const response = await status.fetch(
    new Request('http://local/api/connectors/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'bad-request');
});
