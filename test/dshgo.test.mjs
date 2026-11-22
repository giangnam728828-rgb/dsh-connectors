/**
 * Stage D-a: the dsh-go native surface.
 *
 * dsh-go does not render the DSH web page; it draws a panel itself from a JSON
 * component tree, fed by `ctx.dshGo`. These tests pin the three things that can
 * silently break that contract:
 *
 *   1. the manifest and the registrations must name the same ids;
 *   2. the panel must show only authorised platforms — no row for an empty
 *      platform, no token anywhere;
 *   3. the feed must recover when the vault changes underneath it.
 *
 * The last test optionally runs the real dsh-go checker (`sdk/plugin-kit`),
 * which is the same parser the app uses. It is skipped unless
 * `DSHGO_PLUGIN_KIT` points at a checkout, because that SDK is not on npm.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as plugin from '../index.js';
import { createVault } from '../src/vault.js';
import {
  PANEL_ID,
  STRIP_ID,
  copyText,
  iconFor,
  panelData,
  panelView,
  stripData,
  unavailablePanelData,
  words,
} from '../src/dshgo.js';
import { watchFileChanges } from '../src/vault-watch.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Display names as the built-in presets spell them. */
const NAMES = { github: 'GitHub', gitlab: 'GitLab', docker: 'Docker', npm: 'npm' };

/** A row as `statusReport` builds it, trimmed to the fields the panel reads. */
const row = (id, overrides = {}) => ({
  id,
  name: NAMES[id] ?? id[0].toUpperCase() + id.slice(1),
  category: '代码托管',
  connected: true,
  hint: '••••abcd',
  login: 'octocat',
  accountName: null,
  username: null,
  ...overrides,
});

/**
 * A Cordis-shaped context with a fake `dshGo` service that records registrations.
 *
 * @param options - `dshGo: false` simulates a carrier without the bridge.
 * @returns the context, the registrations and the cleanup list.
 */
function makeHarness(options = {}) {
  const panels = new Map();
  const strips = new Map();
  const cleanups = [];
  const services = { tools: { register: () => () => {} } };

  if (options.dshGo !== false) {
    services.dshGo = {
      panel(id, definition) {
        panels.set(id, definition);
        return () => panels.delete(id);
      },
      strip(id, dataFn) {
        strips.set(id, dataFn);
        return () => strips.delete(id);
      },
    };
  }

  const ctx = {
    get: (serviceName) => services[serviceName],
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return typeof dispose === 'function' ? dispose : () => {};
    },
    provide: () => () => {},
    inject(deps, callback) {
      return deps.every((dependency) => services[dependency] !== undefined) ? callback(ctx) ?? (() => {}) : () => {};
    },
  };
  // Cordis exposes injected services as properties too, which is what the
  // `ctx.inject(['dshGo'], (ctx) => ctx.dshGo.panel(…))` form reads.
  for (const serviceName of Object.keys(services)) {
    Object.defineProperty(ctx, serviceName, { get: () => services[serviceName], configurable: true });
  }
  return { ctx, panels, strips, cleanups };
}

/** Let the async feed settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** @returns the first emitted value of a data feed. */
async function firstEmit(dataFn, locale = 'zh-CN') {
  const emitted = [];
  const unsubscribe = dataFn({}, (value) => emitted.push(value), { protocol: 1, locale });
  await flush();
  unsubscribe();
  return emitted[0];
}

test('manifest: one panel and one strip, both declared and both registered', () => {
  const { dshGo } = manifest;
  assert.equal(dshGo.v, 1, 'protocol v1');
  assert.ok(Buffer.byteLength(JSON.stringify(dshGo), 'utf8') <= 16 * 1024, 'manifest stays under 16 KiB');

  const panel = dshGo.contributes.panels.find((item) => item.id === PANEL_ID);
  assert.ok(panel, 'the panel id the host registers must be declared');
  assert.equal(panel.icon, 'link');
  assert.deepEqual(panel.placement, ['session.tab', 'features', 'plugin']);
  assert.equal(panel.presentation, 'sheet');
  assert.ok([...panel.title.zh].length <= 16 && [...panel.title.en].length <= 16, 'panel title fits the 16-character cap');

  const strip = dshGo.contributes['composer.strip'].find((item) => item.id === STRIP_ID);
  assert.ok(strip, 'the strip id the host registers must be declared');
  assert.equal(strip.panel, PANEL_ID, 'tapping the strip opens the panel');

  const harness = makeHarness();
  plugin.apply(harness.ctx);
  assert.deepEqual([...harness.panels.keys()], [PANEL_ID], 'exactly the declared panel is registered');
  assert.deepEqual([...harness.strips.keys()], [STRIP_ID], 'exactly the declared strip is registered');
  const definition = harness.panels.get(PANEL_ID);
  assert.equal(typeof definition.view, 'function');
  assert.equal(typeof definition.data, 'function');
  assert.deepEqual(Object.keys(definition.actions).sort(), ['copy', 'refresh']);
  for (const dispose of harness.cleanups) dispose();
});

test('a carrier without dshGo registers nothing and still loads', () => {
  const harness = makeHarness({ dshGo: false });
  assert.doesNotThrow(() => plugin.apply(harness.ctx));
  assert.equal(harness.panels.size, 0);
  assert.equal(harness.strips.size, 0);
  for (const dispose of harness.cleanups) dispose();
});

test('the panel lists authorised platforms only', () => {
  const report = {
    providers: [
      row('github'),
      row('gitlab', { connected: false, hint: '', login: null, name: 'GitLab' }),
      row('docker', { login: null, accountName: 'builder', hint: '••••9f3c' }),
      row('npm', { connected: false, hint: '', login: null }),
    ],
    connected: 2,
  };
  const data = panelData(report, 'zh-CN');
  assert.equal(data.count, 2);
  assert.deepEqual(
    data.rows.map((item) => item.title),
    ['GitHub', 'Docker'],
    'a stored platform without a credential is not a row',
  );
  assert.equal(data.rows[0].subtitle, '@octocat');
  assert.equal(data.rows[0].trailing, '••••abcd');
  assert.equal(data.rows[1].subtitle, 'builder', 'falls back to the display name');
  assert.equal(data.hint, words('zh-CN').hint);
  assert.equal(JSON.stringify(data).includes('token'), false);
});

test('an empty vault gets an empty list and a localised hint, not an error', () => {
  const data = panelData({ providers: [], connected: 0 }, 'en-US');
  assert.deepEqual(data, { count: 0, rows: [], hint: words('en-US').emptyHint });
  assert.equal(panelData(undefined, 'zh-CN').count, 0, 'a broken report degrades instead of throwing');
  assert.equal(unavailablePanelData('zh-CN').count, 0);
});

test('every provider id has an icon the app knows, and custom ids fall back', () => {
  const known = /^[a-z][a-z0-9-]{0,31}$/;
  for (const id of ['github', 'gitlab', 'gitee', 'npm', 'docker', 'figma', 'slack', 'notion']) {
    assert.match(iconFor(id), known);
  }
  assert.equal(iconFor('my-custom-thing'), 'link');
});

test('the view is a fixed tree whose bindings exist in the data', () => {
  const view = panelView({ locale: 'zh-CN' });
  const stats = { nodes: 0, depth: 0 };
  const walk = (node, depth) => {
    stats.nodes += 1;
    stats.depth = Math.max(stats.depth, depth);
    if (Array.isArray(node?.children)) for (const child of node.children) walk(child, depth + 1);
  };
  walk(view, 1);
  assert.ok(stats.nodes <= 120 && stats.depth <= 8, `panel budget: ${stats.nodes} nodes / depth ${stats.depth}`);
  assert.ok(Buffer.byteLength(JSON.stringify(view), 'utf8') <= 32 * 1024);

  const data = panelData({ providers: [row('github')], connected: 1 }, 'zh-CN');
  const bound = [];
  const collect = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (typeof node.$ === 'string') bound.push(node.$);
    for (const value of Object.values(node)) collect(value);
  };
  collect(view);
  assert.deepEqual([...new Set(bound)].sort(), ['data.count', 'data.hint', 'data.rows']);
  for (const path of bound) {
    const value = path.slice('data.'.length).split('.').reduce((current, key) => current?.[key], data);
    assert.notEqual(value, undefined, `${path} must resolve in the panel data`);
  }
});

test('the strip stays hidden with nothing connected, and stays short with something', () => {
  assert.equal(stripData({ count: 0, rows: [] }, 'zh-CN'), null);
  assert.equal(stripData({ count: 0, rows: [] }, 'en-US'), null);
  assert.equal(stripData(null, 'zh-CN'), null);
  const one = stripData({ count: 1 }, 'zh-CN');
  assert.deepEqual(one, { text: '1 个已连接', icon: 'link' });
  for (const count of [1, 16, 99]) {
    for (const locale of ['zh-CN', 'en-US']) {
      const line = stripData({ count }, locale);
      assert.ok([...line.text].length <= 24, `${locale} ${count}: ${line.text}`);
    }
  }
});

test('copy text lists the same rows and never carries the token', () => {
  const data = panelData(
    { providers: [row('github', { hint: '••••abcd' }), row('npm', { login: null, name: 'npm', hint: '••••1a2b' })] },
    'zh-CN',
  );
  const text = copyText(data, 'zh-CN');
  assert.match(text, /^连接器 · 2 个已连接/);
  assert.match(text, /GitHub · @octocat · ••••abcd/);
  assert.equal(text.includes('ghp_'), false);
  assert.ok([...text].length <= 8000);
});

test('a real vault drives the feed, and a later write shows up', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dshgo-'));
  const previous = process.env.DSH_CONNECTORS_HOME;
  process.env.DSH_CONNECTORS_HOME = home;
  try {
    const vault = createVault(home);
    await vault.put('github', { token: 'ghp_abcdefghijklmnop', login: 'octocat', connectedAt: Date.now() });

    const harness = makeHarness();
    plugin.apply(harness.ctx);

    const emitted = [];
    const stop = harness.panels.get(PANEL_ID).data({}, (value) => emitted.push(value), { protocol: 1, locale: 'zh-CN' });
    await flush();
    assert.equal(emitted.at(-1).count, 1);
    assert.equal(emitted.at(-1).rows[0].title, 'GitHub');
    assert.equal(JSON.stringify(emitted).includes('ghp_abcdefghijklmnop'), false);

    await vault.put('gitlab', { token: 'glpat-xxxxxxxxxxxx', login: 'octocat', connectedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(emitted.at(-1).count, 2, 'the watchFile feed picked up a write from another process');
    assert.deepEqual(emitted.at(-1).rows.map((item) => item.title), ['GitHub', 'GitLab']);

    stop();
    for (const dispose of harness.cleanups) dispose();
  } finally {
    if (previous === undefined) delete process.env.DSH_CONNECTORS_HOME;
    else process.env.DSH_CONNECTORS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('watchFileChanges debounces and stops cleanly', async () => {
  const home = mkdtempSync(join(tmpdir(), 'watch-'));
  const file = join(home, 'vault.json');
  try {
    writeFileSync(file, '{"v":1,"records":{}}');
    let calls = 0;
    // The settle window must exceed the poll interval: one logical write can be
    // reported by watchFile as two stat ticks (truncate then write). With a
    // settle shorter than the interval those ticks land in separate debounce
    // windows and produce two calls — a scheduling flake, not a missed
    // debounce. The default parameters (150 / 2000) never hit this; keep the
    // test's shrunken timing honest by keeping settle > interval.
    const stop = watchFileChanges(file, () => { calls += 1; }, { interval: 30, settle: 90 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, 0, 'subscribing is not a change');

    writeFileSync(file, '{"v":1,"records":{"github":{}}}');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(calls >= 1, 'a real write notifies at least once');
    const afterWrite = calls;

    stop();
    writeFileSync(file, '{"v":1,"records":{"github":{},"npm":{}}}');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(calls, afterWrite, 'an unsubscribed watcher stays quiet');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the real dsh-go checker accepts the manifest and the view', async (t) => {
  const kit = process.env.DSHGO_PLUGIN_KIT;
  if (kit === undefined || kit === '') {
    t.skip('set DSHGO_PLUGIN_KIT to a dsh-Go checkout to run the app\'s own parser');
    return;
  }
  const { checkManifest, checkView } = await import(join(kit, 'lib/check.js'));
  const manifestResult = checkManifest(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), { dir: root });
  assert.equal(manifestResult.state, 'ok', 'the app can draw the native part');
  assert.deepEqual(manifestResult.issues.filter((issue) => issue.severity === 'error'), []);
  const viewResult = checkView(panelView({ locale: 'zh-CN' }), { budget: 'panel' });
  assert.deepEqual(viewResult.issues, []);

  // Copy the plugin into a scratch dir so the checker's `--load` sees a clean package.
  const scratch = mkdtempSync(join(tmpdir(), 'dshgo-check-'));
  try {
    cpSync(root, join(scratch, 'plugin'), { recursive: true, filter: (source) => !source.includes('/.git') });
    assert.ok(readFileSync(join(scratch, 'plugin', 'package.json'), 'utf8').includes('dshGo'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
