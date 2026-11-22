/**
 * Cross-carrier /connectors command.
 *
 * `commands` is mounted by dsh-base, so it is the one human-visible surface
 * that exists on every client (official web, DSHA, Electron/Tauri shells, ACP,
 * third-party apps). These tests pin three things: the command registers and
 * disposes cleanly, its text is useful in all three invocation modes, and it
 * never leaks a token into a session trajectory.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { connectorsCommandResult, makeConnectorsHandler, COMMAND_NAME } from '../src/commands.js';
import { createVault } from '../src/vault.js';
import { statusReport } from '../src/actions.js';
import * as plugin from '../index.js';

const TOKEN = `ghp_${'c'.repeat(36)}`;

async function freshHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'connectors-cmd-'));
  process.env.DSH_CONNECTORS_HOME = home;
  return home;
}

/** A statusReport-shaped object built from a real vault. */
async function reportWith(home, withGithub = true) {
  if (withGithub) {
    await createVault(home).put('github', { token: TOKEN, login: 'octocat' });
  }
  return statusReport(home);
}

test('command name is a stable slash-command token', () => {
  assert.match(COMMAND_NAME, /^[a-z][a-z0-9_-]*$/);
  assert.equal(COMMAND_NAME, 'connectors');
});

test('bare /connectors reports connected state and never the token', async () => {
  const report = await reportWith(await freshHome());
  const result = connectorsCommandResult('', report);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /1 of \d+ connected/);
  assert.match(result.text, /github .* as octocat/);
  assert.equal(result.text.includes(TOKEN), false, 'no raw token in the trajectory');
  assert.match(result.text, /\/connectors help/);
});

test('/connectors help lists all ways to connect, including the CLI', async () => {
  const report = await reportWith(await freshHome(), false);
  const result = connectorsCommandResult('help', report);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Settings -> Connectors/);
  assert.match(result.text, /npx -y dsh-connectors add/);
  assert.match(result.text, /device[- ]code/i);
  assert.match(result.text, /Never paste a token in chat/);
  assert.equal(result.text.includes(TOKEN), false);
});

test('/connectors <id> gives that platform a concrete connect command', async () => {
  const report = await reportWith(await freshHome(), false);
  const result = connectorsCommandResult('  GITHUB  ', report);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /npx -y dsh-connectors add github/);
  assert.match(result.text, /github\.com\/settings\/tokens|Create a token/i);
  assert.equal(result.text.includes(TOKEN), false);
});

test('/connectors <connected-id> says it is connected without the secret', async () => {
  const report = await reportWith(await freshHome());
  const result = connectorsCommandResult('github', report);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /connected as octocat/);
  assert.match(result.text, /conn_request/);
  assert.equal(result.text.includes(TOKEN), false);
});

test('/connectors <unknown> is an error listing valid ids', async () => {
  const report = await reportWith(await freshHome());
  const result = connectorsCommandResult('nosuch', report);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Unknown connector "nosuch"/);
  assert.match(result.text, /github/);
});

test('the handler reads the live vault on every call', async () => {
  const home = await freshHome();
  const handler = makeConnectorsHandler(home);
  const before = await handler({ rawInput: '' });
  assert.match(before.text, /0 of \d+ connected/);

  await createVault(home).put('github', { token: TOKEN, login: 'octocat' });
  const after = await handler({ rawInput: '' });
  assert.match(after.text, /1 of \d+ connected/);
});

test('apply registers the command when commands exists and disposes on unload', () => {
  const home = process.env.DSH_CONNECTORS_HOME;
  const registered = [];
  let disposed = false;
  const commands = {
    register(def) {
      registered.push(def);
      return () => { disposed = true; };
    },
  };
  const services = { tools: undefined, commands };
  const cleanups = [];
  const ctx = {
    get(name) { return services[name]; },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return d ?? (() => {});
    },
    provide() { return () => {}; },
    inject(deps, cb) {
      if (!deps.every((name) => services[name] !== undefined)) return () => {};
      // Cordis mounts injected services as properties on the injected scope.
      const scope = Object.assign(Object.create(ctx), Object.fromEntries(deps.map((n) => [n, services[n]])));
      return cb(scope) ?? (() => {});
    },
  };

  plugin.apply(ctx);
  assert.equal(registered.length, 1, 'exactly one command registers');
  assert.equal(registered[0].name, COMMAND_NAME);
  assert.equal(typeof registered[0].handler, 'function');
  assert.equal(registered[0].input.hint, '[help|<platform-id>]');

  for (const d of cleanups) d();
  assert.equal(disposed, true, 'the command unregisters on unload');
  assert.ok(home, 'home resolved without throwing');
});

test('a host without commands loads the rest of the plugin untouched', () => {
  const services = { tools: undefined };
  const ctx = {
    get(name) { return services[name]; },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    provide() { return () => {}; },
    inject(deps, cb) {
      return deps.every((name) => services[name] !== undefined) ? cb(ctx) ?? (() => {}) : () => {};
    },
  };
  assert.doesNotThrow(() => plugin.apply(ctx), 'no commands service is not fatal');
});
