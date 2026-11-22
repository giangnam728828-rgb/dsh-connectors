/**
 * Regression: the settings section was invisible on DSHA and some shells.
 *
 * `dsh.client.inject` is not decoration — the client module loader treats it
 * as the set of package rows whose factories must be materialized before this
 * bundle runs (see @deepseek-ai/dsh-client-modules). client.js uses `ctx.slots`
 * and `ctx.locale`, which come from @deepseek-ai/dsh-client-ui-slots and
 * @deepseek-ai/dsh-client-locale. The old manifest declared only
 * dsh-client-ui-settings-general, so on hosts where slots was not already
 * loaded the section silently failed to register: the plugin looked installed
 * and active but showed nothing to connect with.
 *
 * DSHA's own visible plugins declare the same service set we now require.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** The services client.js actually reads through its injected ctx. */
const REQUIRED_CLIENT_SERVICES = [
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-slots',
];

test('client bundle declares the slots and locale services it injects', () => {
  const inject = pkg.dsh?.client?.inject ?? [];
  for (const service of REQUIRED_CLIENT_SERVICES) {
    assert.ok(inject.includes(service), `dsh.client.inject must include ${service}, or the settings section never registers`);
  }
});

test('client bundle is web platform and eagerly loaded', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh?.client?.immediately, true);
});

test('client bundle exports ./client so the loader can serve it', () => {
  assert.equal(pkg.exports?.['./client'], './client.js');
  assert.ok(pkg.files.includes('client.js'), 'client.js must be shipped');
});
