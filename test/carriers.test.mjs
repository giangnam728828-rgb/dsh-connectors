/**
 * Carrier compatibility: the plugin must attach the same three surfaces in
 * every shell, and must not throw where a service is absent.
 *
 * This file exists because of a real defect: `apply` read `ctx.get('tools')`
 * inside `ctx.effect`, where the context is a fresh scope and the property is
 * not declared. In the web shell `tools` happened to be mounted already, so the
 * read worked; in the headless and ACP shells it returned undefined, the
 * registration was skipped, and the model never saw `conn_list`. Nothing logged
 * a line, because a failed effect is swallowed. The module now declares `tools`
 * in `inject`, which makes ordering the host's job.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as plugin from '../index.js';

const TOOL_NAMES = ['conn_list', 'conn_request'];

/**
 * A minimal Cordis-shaped context, enough for `apply`.
 *
 * @param services - mounted services, by name.
 * @returns the context plus the call log.
 */
function makeCtx(services = {}) {
  const registered = [];
  const disposed = [];
  const provided = new Map();
  const injected = [];
  const cleanups = [];

  const ctx = {
    get(name) {
      return services[name];
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return typeof dispose === 'function' ? dispose : () => {};
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    inject(deps, callback) {
      injected.push(deps);
      const ready = deps.every((name) => services[name] !== undefined);
      return ready ? callback(ctx) ?? (() => {}) : () => {};
    },
  };

  const tools = {
    register(definition) {
      registered.push(definition.name);
      return () => disposed.push(definition.name);
    },
    get() {
      return undefined;
    },
  };

  return {
    ctx,
    tools,
    registered,
    disposed,
    provided,
    injected,
    cleanups,
    services,
  };
}

test('the module declares tools as a dependency, not a lucky load order', () => {
  assert.ok(Array.isArray(plugin.inject), 'inject must be an array');
  assert.ok(plugin.inject.includes('tools'), 'tools must be declared: a bare ctx.get inside effect is not enough');
  assert.equal(plugin.inject.includes('webServer'), false, 'webServer must stay optional; headless and ACP have no listener');
});

test('tools and the service attach where tools exists', () => {
  const harness = makeCtx({ tools: undefined });
  harness.services.tools = harness.tools;

  plugin.apply(harness.ctx);

  assert.deepEqual(harness.registered, TOOL_NAMES, 'both tools must register');
  assert.ok(harness.provided.has('connectors'), 'the connectors service must be provided');
});

test('a shell without tools does not crash the plugin', () => {
  const harness = makeCtx();

  assert.doesNotThrow(() => plugin.apply(harness.ctx));
  assert.deepEqual(harness.registered, [], 'no tools means no registration');
  assert.ok(harness.provided.has('connectors'), 'the service still attaches: other plugins can use it even without a model');
});

test('unloading releases every registered tool', () => {
  const harness = makeCtx({ tools: undefined });
  harness.services.tools = harness.tools;

  const returned = plugin.apply(harness.ctx);
  assert.equal(returned, undefined, 'apply itself returns nothing; the effect tree owns disposal');

  // Cordis runs the collected cleanups when the plugin fiber unloads.
  for (const release of harness.cleanups) release();

  assert.deepEqual(harness.disposed, TOOL_NAMES, 'both tool disposers must run');
  assert.equal(harness.provided.has('connectors'), false, 'the service is withdrawn on unload');
});

test('without connection the HTTP surfaces stay absent, not broken', () => {
  const harness = makeCtx({ tools: undefined });
  harness.services.tools = harness.tools;

  plugin.apply(harness.ctx);

  assert.deepEqual(harness.injected, [['connection'], ['connection', 'webServer']], 'the API and page declare their own carriers');
  assert.equal(harness.registered.length, 2);
});
