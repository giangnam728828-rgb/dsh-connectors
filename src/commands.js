/**
 * Cross-carrier human command: /connectors.
 *
 * `commands` is mounted by `dsh-base` (the common baseline of every harness
 * profile), so a slash command is the one surface that survives on every
 * client that has a UI at all — official web, Electron/Tauri shells, the ACP
 * adapters, and third-party clients. A settings section needs a specific
 * client-ui service, the HTML page needs a webServer, the mobile panel needs
 * dsh-go-bridge; none of those are guaranteed. This command is.
 *
 * The handler is strictly read-only: it reports state and tells the human
 * where to connect. It never returns a token, a secret, or anything that could
 * be copied into a session trajectory. Connecting still happens in the
 * settings page or the CLI (see bin/dsh-connectors.mjs), where a token is
 * written straight to the vault instead of passing through chat.
 */
import { statusReport } from './actions.js';
import { connectorHome } from './vault.js';

export const COMMAND_NAME = 'connectors';

const USAGE = 'Usage: /connectors [help|<platform-id>]';

/**
 * The three ways a human can connect, in plain words. Kept in one place so the
 * status view, the help view and the per-platform view never drift apart.
 */
function howToConnect(lines) {
  lines.push('');
  lines.push('How to connect a platform (pick one):');
  lines.push('  1. Settings -> Connectors, click Connect, paste the token. Best on desktop/web.');
  lines.push('  2. Terminal:  npx -y dsh-connectors add <platform-id>');
  lines.push('  3. Device code (no paste): open the full page at /dsh-connectors and use "Sign in with device code".');
  lines.push('Tokens go straight into the encrypted vault. Never paste a token in chat — it would be saved in the session log.');
}

/**
 * Build the text for one invocation. Pure: no I/O, no secrets.
 *
 * @param {string} rawInput - everything after `/connectors`.
 * @param {object} report - the shape returned by statusReport(home).
 * @returns {{kind: 'success'|'error', text: string}}
 */
export function connectorsCommandResult(rawInput, report) {
  const arg = (rawInput ?? '').trim().toLowerCase();

  // `/connectors help` — full instructions, no state needed.
  if (arg === 'help' || arg === '?' || arg === '-h' || arg === '--help') {
    const lines = [
      'Connectors — connect a platform once, reuse it everywhere.',
      USAGE,
      '',
      'Platforms available:',
      ...report.providers.map((p) => `  ${p.id}${p.connected ? ' (connected)' : ''} — ${p.name}`),
    ];
    howToConnect(lines);
    return { kind: 'success', text: lines.join('\n') };
  }

  // `/connectors <id>` — instructions for one platform.
  if (arg.length > 0) {
    const provider = report.providers.find((p) => p.id === arg);
    if (provider === undefined) {
      const ids = report.providers.map((p) => p.id).join(', ');
      return { kind: 'error', text: `Unknown connector "${arg}". Known ids: ${ids}.\n${USAGE}` };
    }
    const lines = [
      `${provider.name} (${provider.id}) — ${provider.connected ? `connected${provider.login ? ` as ${provider.login}` : ''}` : 'not connected'}`,
    ];
    if (provider.connected) {
      lines.push('Already connected. Other plugins and tools can use it through conn_request; the token is never shown.');
    } else {
      lines.push(`Add it with:  npx -y dsh-connectors add ${provider.id}`);
      if (provider.docs) lines.push(`Create a token here: ${provider.docs}`);
      if (provider.deviceFlow) lines.push('This platform also supports device-code sign-in on the full page.');
      lines.push('Or connect it in Settings -> Connectors.');
    }
    howToConnect(lines);
    return { kind: 'success', text: lines.join('\n') };
  }

  // `/connectors` — status overview.
  const connected = report.providers.filter((p) => p.connected);
  const lines = [
    `Connectors: ${connected.length} of ${report.providers.length} connected.`,
    ...connected.map((p) => `  - ${p.id} (${p.name})${p.login ? ` as ${p.login}` : ''}`),
  ];
  if (connected.length === 0) lines.push('  (none yet)');
  lines.push(`Vault: ${report.vaultFile}`);
  lines.push(`Run /connectors help for how to connect. ${USAGE}`);
  return { kind: 'success', text: lines.join('\n') };
}

/**
 * The command handler bound to a home directory. Reads the vault each time so
 * an authorize from the CLI or the settings page shows up immediately.
 *
 * @param {string} home - connector home directory.
 * @returns {(invocation: {rawInput?: string}) => Promise<{kind: string, text: string}>}
 */
export function makeConnectorsHandler(home = connectorHome()) {
  return async (invocation) => {
    try {
      const report = await statusReport(home);
      return connectorsCommandResult(invocation?.rawInput ?? '', report);
    } catch (error) {
      return { kind: 'error', text: `Connectors command failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}
