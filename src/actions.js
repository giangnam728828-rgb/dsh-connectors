/**
 * The operations behind both the browser endpoints and the CLI.
 *
 * Keeping them here (instead of inside the Cordis plugin) means the command
 * line and the settings page cannot drift apart: one implementation stores the
 * credential, one verification path decides whether it is alive, and one
 * request path enforces the provider origin.
 */
import { createVault, project } from './vault.js';
import {
  allProviders,
  authHeaders,
  providerById,
  publicProvider,
  RESERVED_HEADERS,
  resolveRequestUrl,
  sanitizeCustomProviders,
  verifyCredential,
} from './providers.js';

const REQUEST_TIMEOUT_MS = 60_000;
/** Bytes read from a platform response before the read is cancelled. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PREVIEW_CHARS = 20_000;
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Read a response body up to a hard byte cap.
 *
 * `await response.text()` allocates whatever the server sends before any size
 * check runs, so one hostile or misconfigured endpoint could hand the harness a
 * multi-gigabyte string. This reads chunk by chunk and cancels the stream the
 * moment the cap is crossed, so peak memory stays bounded by the cap.
 *
 * @param response - the Fetch response.
 * @param maxBytes - cap in bytes.
 * @returns the text read so far and whether the body was cut.
 */
async function readLimitedBody(response, maxBytes) {
  if (response.body === null || response.body === undefined) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { text: Buffer.concat(chunks).toString('utf8'), truncated: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

/** Token shapes worth hiding even when they are not the stored credential. */
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bfigd_[A-Za-z0-9_-]{20,}\b/g,
  /\bntn_[A-Za-z0-9]{20,}\b/g,
];

/**
 * Recursively replace every known secret and every token-shaped substring.
 * @param value - any JSON value.
 * @param secrets - exact strings to hide (the stored credentials).
 * @returns the same shape with secrets replaced.
 */
export function redact(value, secrets) {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[redacted]');
    }
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[redacted]');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redact(item, secrets);
    return out;
  }
  return value;
}

/**
 * Read and validate a user's own provider presets.
 *
 * This is the "and later, more platforms" seam: a JSON array in the connector
 * home, using the same fields as the builtin table, without shipping a new
 * plugin version. Every row passes `sanitizeCustomProviders`, so a row cannot
 * shadow a built-in id or carry a malformed endpoint.
 *
 * @param home - connector home directory.
 * @returns accepted presets plus the rows that were refused and why.
 */
export async function loadCustomProvidersDetailed(home) {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  let text;
  try {
    text = await readFile(path.join(home, 'providers.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { accepted: [], rejected: [] };
    return { accepted: [], rejected: [{ id: null, reason: 'providers-unreadable' }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { accepted: [], rejected: [{ id: null, reason: 'providers-not-json' }] };
  }
  return sanitizeCustomProviders(parsed);
}

/**
 * The accepted custom presets.
 * @param home - connector home directory.
 * @returns validated presets; refused rows are dropped.
 */
export async function loadCustomProviders(home) {
  return (await loadCustomProvidersDetailed(home)).accepted;
}

/**
 * Build the status the page and the `conn_list` tool both render.
 * @param home - connector home directory.
 * @returns provider rows, counts and the vault location.
 */
export async function statusReport(home) {
  const vault = createVault(home);
  const custom = await loadCustomProvidersDetailed(home);
  const settings = await vault.readSettings();
  const ids = new Set(await vault.ids());
  const rows = [];
  for (const provider of allProviders(custom.accepted)) {
    const stored = ids.has(provider.id) ? project(provider.id, await vault.get(provider.id)) : null;
    rows.push({
      ...publicProvider(provider),
      webUrl: provider.baseUrl,
      connected: stored?.connected === true,
      hint: stored?.hint ?? '',
      login: stored?.login ?? null,
      accountName: stored?.name ?? null,
      avatarUrl: stored?.avatarUrl ?? null,
      username: stored?.username ?? null,
      grantedScopes: stored?.scopes ?? [],
      connectedAt: stored?.connectedAt ?? null,
      custom: provider.custom === true,
      clientId: provider.deviceFlow ? resolveClientId(settings, provider.id) !== '' : false,
    });
  }
  return {
    home,
    vaultFile: vault.vaultFile,
    providers: rows,
    rejectedProviders: custom.rejected,
    connected: rows.filter((row) => row.connected).length,
    total: rows.length,
  };
}

/**
 * The OAuth client id configured for a device-flow provider.
 * @param settings - non-secret settings.
 * @param providerId - provider id.
 * @returns the client id, or an empty string.
 */
export function resolveClientId(settings, providerId) {
  const upper = String(providerId).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const fromEnv = process.env[`DSH_CONNECTORS_${upper}_CLIENT_ID`];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const fromSettings = settings?.[`${providerId}:clientId`];
  return typeof fromSettings === 'string' ? fromSettings.trim() : '';
}

/**
 * Store a token after asking the platform whether it works.
 *
 * Verification is not decoration: a typo saved silently turns into a confusing
 * 401 three turns later, in a different conversation, with no memory of where
 * the token came from.
 *
 * @param home - connector home directory.
 * @param input - provider id, token, optional username, note and skipVerify.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns ok plus the stored projection, or a failure with a short code.
 */
export async function connect(home, input, fetchImpl = fetch) {
  const custom = await loadCustomProviders(home);
  const provider = providerById(input?.provider, custom);
  if (!provider) return { ok: false, error: 'unknown-provider' };
  const token = typeof input?.token === 'string' ? input.token.trim() : '';
  if (token === '') return { ok: false, error: 'token-required' };
  if (token.length > 4096) return { ok: false, error: 'token-too-long' };
  const username = typeof input?.username === 'string' ? input.username.trim() : '';
  if (provider.needsUsername === true && username === '') return { ok: false, error: 'username-required' };

  let account = null;
  if (input?.skipVerify !== true && provider.verify) {
    try {
      const check = await verifyCredential(provider, { token, username }, fetchImpl);
      if (!check.ok) {
        return {
          ok: false,
          error: 'verify-failed',
          status: check.status ?? null,
          message: redact(check.error ?? 'the platform rejected this token', [token]),
        };
      }
      account = check.account;
    } catch (error) {
      // A network failure is not proof the token is wrong; say so instead of
      // discarding a credential the user may have typed correctly.
      return { ok: false, error: 'verify-unreachable', message: redact(String(error?.message ?? error), [token]).slice(0, 200) };
    }
  }

  const vault = createVault(home);
  const stored = await vault.put(provider.id, {
    token,
    username: username === '' ? undefined : username,
    login: account?.login,
    name: account?.name,
    avatarUrl: account?.avatarUrl,
    connectedAt: Date.now(),
    note: typeof input?.note === 'string' ? input.note.slice(0, 200) : undefined,
  });
  // Keep the preset's display fields and graft the credential's public fields
  // on top, without letting the account name overwrite the platform name.
  return {
    ok: true,
    provider: {
      ...publicProvider(provider),
      connected: stored.connected,
      hint: stored.hint,
      login: stored.login,
      accountName: stored.name ?? null,
      avatarUrl: stored.avatarUrl ?? null,
      username: stored.username,
      connectedAt: stored.connectedAt,
    },
  };
}

/**
 * Forget one credential.
 * @param home - connector home directory.
 * @param providerId - provider id.
 * @returns whether something was removed.
 */
export async function disconnect(home, providerId) {
  const vault = createVault(home);
  return vault.remove(providerId);
}

/**
 * Spend a stored credential on one request against its own provider.
 *
 * Path, origin, header names and body size are all constrained here rather
 * than by the caller, so a model that has been tricked into "call this URL with
 * my token" can only reach the platform the human connected.
 *
 * @param home - connector home directory.
 * @param input - provider, method, path, query, body, headers.
 * @param signal - optional caller cancellation.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns status plus redacted data, or a failure code.
 */
export async function authedRequest(home, input, signal = undefined, fetchImpl = fetch) {
  const custom = await loadCustomProviders(home);
  const provider = providerById(input?.provider, custom);
  if (!provider) return { ok: false, error: 'unknown-provider' };
  const vault = createVault(home);
  const credential = await vault.get(provider.id);
  if (!credential) return { ok: false, error: 'not-connected', provider: provider.id };

  const method = String(input?.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { ok: false, error: 'method-not-allowed' };

  let url;
  try {
    url = resolveRequestUrl(provider, input?.path ?? '/', input?.query);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? 'bad-path') };
  }

  const headers = { ...(provider.defaultHeaders ?? {}), ...authHeaders(provider, credential) };
  if (input?.headers !== null && typeof input?.headers === 'object' && !Array.isArray(input.headers)) {
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = String(name).toLowerCase();
      if (RESERVED_HEADERS.has(lower)) continue;
      if (typeof value !== 'string') continue;
      headers[lower] = value.slice(0, 2_000);
    }
  }

  let body;
  if (input?.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    const text = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { ok: false, error: 'body-too-large' };
    body = text;
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  }

  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (signal !== undefined) signals.push(signal);
  let response;
  try {
    const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];
    response = await fetchImpl(url, { method, headers, body, signal: combined });
  } catch (error) {
    return { ok: false, error: 'network', message: redact(String(error?.message ?? error), [credential.token]).slice(0, 200) };
  }

  const secrets = [credential.token];
  const { text, truncated } = await readLimitedBody(response, MAX_RESPONSE_BYTES);
  let data = null;
  if (!truncated) {
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const shaped = truncated
    ? { truncated: true, preview: redact(text.slice(0, MAX_PREVIEW_CHARS), secrets) }
    : redact(data, secrets);

  return {
    ok: response.ok,
    status: response.status,
    provider: provider.id,
    data: shaped,
    ...(truncated ? { note: `response exceeded ${MAX_RESPONSE_BYTES} bytes` } : {}),
    ...(response.status === 401 || response.status === 403 ? { hint: 'the platform rejected this credential; reconnect it in Settings → Connectors' } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * GitHub device flow
 *
 * A phone has no comfortable way to receive a loopback redirect, and a
 * pasted token is the thing this plugin exists to avoid. Device flow asks
 * GitHub for a short human code, the user approves it in any browser they
 * already have, and the host polls until the token appears. It needs only a
 * public client id: no secret, no redirect URI, no callback server.
 * ------------------------------------------------------------------ */

/** A timeout that also honours a caller's cancellation. */
function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal === undefined || signal === null) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, signal]) : timeout;
}

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * Ask GitHub for a device code.
 * @param clientId - public OAuth App client id.
 * @param scope - requested scopes.
 * @param fetchImpl - fetch implementation.
 * @returns the codes and polling cadence.
 */
export async function startDeviceFlow(clientId, scope = 'repo read:user', fetchImpl = fetch, signal = undefined) {
  const response = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }),
    signal: combineSignals(signal, 15_000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (response.status === 404) throw new Error('client-id-rejected');
  if (typeof data?.device_code !== 'string' || typeof data?.user_code !== 'string') {
    if (typeof data?.error === 'string') throw new Error(data.error);
    throw new Error('device-start-failed');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: typeof data.verification_uri === 'string' ? data.verification_uri : 'https://github.com/login/device',
    expiresIn: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  };
}

/**
 * Exchange a device code for a token, once.
 * @param clientId - the client id that opened the flow.
 * @param deviceCode - the code from @see startDeviceFlow.
 * @param fetchImpl - fetch implementation.
 * @returns one of pending / slow-down / expired / denied / authorized.
 */
export async function pollDeviceFlow(clientId, deviceCode, fetchImpl = fetch, signal = undefined) {
  const response = await fetchImpl(GITHUB_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    signal: combineSignals(signal, 15_000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const error = typeof data?.error === 'string' ? data.error : null;
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow-down' };
  if (error === 'expired_token') return { status: 'expired' };
  if (error === 'access_denied') return { status: 'denied' };
  if (error === 'device_flow_disabled') throw new Error('device-flow-disabled');
  if (error !== null) throw new Error(`device-exchange-failed:${error}`);
  if (typeof data?.access_token !== 'string' || data.access_token === '') throw new Error('device-exchange-failed');
  return { status: 'authorized', token: data.access_token };
}
