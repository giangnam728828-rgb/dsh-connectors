/**
 * dsh-connectors - host half.
 *
 * One vault, many platforms. The plugin does three things and stops there:
 *
 *   1. It keeps a credential per platform, encrypted, in the harness state
 *      directory (see src/vault.js), so a token is pasted once instead of once
 *      per session, workspace or device profile.
 *   2. It spends that credential only at the platform it belongs to, through
 *      `conn_request` and the loopback endpoints, never by handing the token to
 *      the model or to the page.
 *   3. It publishes a `connectors` Cordis service, so another plugin can ask
 *      for a credential instead of asking the user for one.
 *
 * The third point is the actual point: "connect once" is only real if the next
 * plugin you install can reuse the connection.
 */
import { createVault, connectorHome, project } from './src/vault.js';
import { allProviders, publicProvider } from './src/providers.js';
import {
  authedRequest,
  connect,
  disconnect,
  loadCustomProviders,
  pollDeviceFlow,
  redact,
  resolveClientId,
  startDeviceFlow,
  statusReport,
} from './src/actions.js';
import { renderPage } from './src/page.js';

export const name = 'dsh-connectors';
export const inject = ['webServer'];

const MAX_BODY_BYTES = 8 * 1024;

const PATHS = {
  page: '/dsh-connectors',
  status: '/dsh-connectors/status',
  connect: '/dsh-connectors/connect',
  disconnect: '/dsh-connectors/disconnect',
  deviceStart: '/dsh-connectors/device/start',
  devicePoll: '/dsh-connectors/device/poll',
  deviceCancel: '/dsh-connectors/device/cancel',
  settings: '/dsh-connectors/settings',
};

/** A failure the client is allowed to see, carried as a stable code. */
class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

/**
 * Read a bounded JSON body.
 * @param request - incoming request.
 * @returns the parsed object.
 */
async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new RequestError('body-too-large', 'Request body is too large.', 413);
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new RequestError('bad-request', 'Request body is not JSON.', 400);
  }
}

/**
 * Build a POST-only, same-origin JSON endpoint.
 * @param webServer - the host web server service.
 * @param handler - body handler resolving the payload.
 * @returns the request handler.
 */
function makeEndpoint(webServer, handler) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const expected = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : undefined;
      const origin = request.headers.origin;
      if (typeof expected === 'string' && typeof origin === 'string' && origin !== expected) {
        sendJson(response, 403, { ok: false, error: 'cross-origin' });
        return;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, { ok: true, ...(await handler(body)) });
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.status, { ok: false, error: error.code, message: error.message });
        return;
      }
      sendJson(response, 500, { ok: false, error: 'internal', message: 'The request could not be completed.' });
    }
  };
}

/**
 * In-memory device-flow state, one flow per provider.
 *
 * Device codes never leave the host; only the short user code is shown. Timers
 * live here rather than in a page, so closing the page does not cancel an
 * authorization the user already approved on their phone.
 *
 * @param home - connector home directory.
 * @returns start, poll, cancel and dispose.
 */
function createDeviceFlows(home) {
  /** @type {Map<string, {generation: number, status: string, userCode?: string, verificationUri?: string, expiresAt: number, intervalMs: number, deviceCode?: string, clientId?: string, error?: string, timer?: NodeJS.Timeout}>} */
  const flows = new Map();
  const generations = new Map();
  let disposed = false;

  function generationOf(providerId) {
    return generations.get(providerId) ?? 0;
  }

  function clearTimer(flow) {
    if (flow?.timer !== undefined) clearTimeout(flow.timer);
  }

  function invalidate(providerId) {
    generations.set(providerId, generationOf(providerId) + 1);
    const flow = flows.get(providerId);
    clearTimer(flow);
    flows.delete(providerId);
  }

  function publicFlow(providerId) {
    const flow = flows.get(providerId);
    if (flow === undefined) return null;
    return {
      provider: providerId,
      status: flow.status,
      userCode: flow.userCode ?? null,
      verificationUri: flow.verificationUri ?? null,
      expiresAt: flow.expiresAt,
      ...(flow.error === undefined ? {} : { error: flow.error }),
    };
  }

  function schedule(providerId, flow, generation) {
    if (disposed || generationOf(providerId) !== generation || flows.get(providerId) !== flow) return;
    const remaining = flow.expiresAt - Date.now();
    if (remaining <= 0) {
      flow.status = 'expired';
      return;
    }
    flow.timer = setTimeout(() => {
      flow.timer = undefined;
      void tick(providerId, flow, generation);
    }, Math.min(flow.intervalMs, remaining));
    flow.timer.unref?.();
  }

  async function tick(providerId, flow, generation) {
    if (disposed || generationOf(providerId) !== generation || flows.get(providerId) !== flow) return;
    if (Date.now() >= flow.expiresAt) {
      flow.status = 'expired';
      return;
    }
    try {
      const result = await pollDeviceFlow(flow.clientId, flow.deviceCode);
      if (generationOf(providerId) !== generation || flows.get(providerId) !== flow) return;
      if (result.status === 'authorized') {
        const stored = await connect(home, { provider: providerId, token: result.token, kind: 'oauth' });
        if (!stored.ok) {
          flow.status = 'error';
          flow.error = stored.error ?? 'verify-failed';
          return;
        }
        flows.delete(providerId);
        return;
      }
      if (result.status === 'expired' || result.status === 'denied') {
        flow.status = result.status;
        return;
      }
      if (result.status === 'slow-down') flow.intervalMs += 5_000;
      schedule(providerId, flow, generation);
    } catch (error) {
      const code = String(error?.message ?? 'network');
      flow.status = 'error';
      flow.error = ['device-flow-disabled', 'client-id-rejected'].includes(code) ? code : 'network';
    }
  }

  return {
    publicFlow,
    async start(providerId) {
      invalidate(providerId);
      const generation = generationOf(providerId);
      const vault = createVault(home);
      const settings = await vault.readSettings();
      const clientId = resolveClientId(settings, providerId);
      if (clientId === '') throw new RequestError('client-id-missing', 'No OAuth App client id is configured for this provider.', 400);
      const scope = typeof settings[`${providerId}:scope`] === 'string' ? settings[`${providerId}:scope`] : 'repo read:user';
      let details;
      try {
        details = await startDeviceFlow(clientId, scope);
      } catch (error) {
        const code = String(error?.message ?? 'device-start-failed');
        throw new RequestError(['device-flow-disabled', 'client-id-rejected'].includes(code) ? code : 'device-start-failed', 'The provider refused to start a device flow.', 502);
      }
      if (disposed || generationOf(providerId) !== generation) throw new RequestError('flow-superseded', 'The flow was replaced.', 409);
      const flow = {
        status: 'pending',
        clientId,
        deviceCode: details.deviceCode,
        userCode: details.userCode,
        verificationUri: details.verificationUri,
        expiresAt: Date.now() + Math.max(1, details.expiresIn) * 1000,
        intervalMs: Math.max(5, details.interval) * 1000,
      };
      flows.set(providerId, flow);
      schedule(providerId, flow, generation);
      return publicFlow(providerId);
    },
    cancel(providerId) {
      invalidate(providerId);
    },
    dispose() {
      disposed = true;
      for (const [providerId] of flows) invalidate(providerId);
    },
  };
}

/** Model-facing definition of `conn_list`. */
const LIST_TOOL = {
  name: 'conn_list',
  description:
    'List the platforms connected to this harness and what each connection is for. Call this before asking the user for a token: if a connection exists, use conn_request instead. Tokens are never shown; each row only reports the account and a masked hint.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render(args, value) {
      const rows = Array.isArray(value?.providers) ? value.providers : [];
      if (rows.length === 0) return [{ type: 'text', text: 'No connectors are available.' }];
      const lines = rows.map((row) => {
        const state = row.connected === true ? `connected${row.login ? ` as ${row.login}` : ''}` : 'not connected';
        return `- ${row.id} (${row.name}) — ${state}`;
      });
      return [
        {
          type: 'text',
          text: `${Number(value?.connected ?? 0)} of ${rows.length} connected.\n${lines.join('\n')}`,
        },
      ];
    },
  },
  async execute() {
    const home = connectorHome();
    const report = await statusReport(home);
    return {
      home: report.home,
      connected: report.connected,
      total: report.total,
      providers: report.providers.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        connected: row.connected,
        login: row.login,
        hint: row.hint,
        scopes: row.scopes,
        docs: row.docs,
        deviceFlow: row.deviceFlow,
        needsUsername: row.needsUsername,
      })),
      connectHint:
        'A human connects a platform in Settings → Connectors, or with the dsh-connectors CLI. Never ask for a token in chat: it would be written to the session trajectory.',
    };
  },
};

/** Model-facing definition of `conn_request`. */
const REQUEST_TOOL = {
  name: 'conn_request',
  description:
    'Call a connected platform API as the account the human connected. The host is fixed by the connector, so pass only a path such as "/repos/{owner}/{repo}" or "/user". Use conn_list first to see which providers are connected. This is the way to create repositories, push files, trigger deployments, query issues and so on without any token in the conversation. A 401 or 403 means the credential is stale: tell the user to reconnect it instead of guessing.',
  parameters: {
    type: 'object',
    properties: {
      provider: {
        type: 'string',
        description: 'Connector id from conn_list, for example "github", "gitlab", "vercel" or "npm".',
      },
      method: {
        type: 'string',
        description: 'HTTP method. Defaults to GET.',
        enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      },
      path: {
        type: 'string',
        description: 'API path beginning with "/". The platform host is added by the connector; absolute URLs are rejected.',
      },
      query: {
        type: 'object',
        description: 'Query parameters as a flat object of strings or arrays of strings.',
        additionalProperties: true,
      },
      body: {
        type: 'object',
        description: 'JSON request body for methods that take one.',
        additionalProperties: true,
      },
      headers: {
        type: 'object',
        description: 'Extra headers, except authorization, cookie, host and other credential-bearing names, which are ignored.',
        additionalProperties: true,
      },
    },
    required: ['provider', 'path'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render(args, value) {
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return [{ type: 'text', text: text.length > 24_000 ? `${text.slice(0, 24_000)}\n…(truncated)` : text }];
    },
  },
  async execute(args, exec) {
    const input = args !== null && typeof args === 'object' ? args : {};
    const result = await authedRequest(connectorHome(), input, exec?.signal);
    return result;
  },
};

/**
 * Register endpoints, the settings page, the tools and the service.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  const home = connectorHome();

  ctx.effect(() => {
    const flows = createDeviceFlows(home);
    const endpoint = (path, handler) => ctx.webServer.register({ kind: 'exact', path, handler: makeEndpoint(ctx.webServer, handler) });

    const pageHandler = async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return;
      }
      const custom = await loadCustomProviders(home);
      const providers = allProviders(custom).map(publicProvider);
      const settings = await createVault(home).readSettings();
      const html = renderPage({
        providers,
        clientIds: Object.fromEntries(providers.filter((provider) => provider.deviceFlow).map((provider) => [provider.id, resolveClientId(settings, provider.id)])),
      });
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src https: data:; base-uri 'none'; form-action 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : html);
    };

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: PATHS.page, handler: pageHandler }),
      endpoint(PATHS.status, async () => {
        const report = await statusReport(home);
        return {
          home: report.home,
          connected: report.connected,
          total: report.total,
          providers: report.providers,
        };
      }),
      endpoint(PATHS.connect, async (body) => {
        const result = await connect(home, {
          provider: body.provider,
          token: body.token,
          username: body.username,
          note: body.note,
          skipVerify: body.skipVerify === true,
        });
        if (!result.ok) {
          const status = result.error === 'verify-failed' ? 422 : 400;
          throw new RequestError(result.error, result.message ?? 'The credential could not be stored.', status);
        }
        const report = await statusReport(home);
        return { provider: result.provider, home: report.home, connected: report.connected, total: report.total, providers: report.providers };
      }),
      endpoint(PATHS.disconnect, async (body) => {
        const removed = await disconnect(home, String(body.provider ?? ''));
        const report = await statusReport(home);
        return { removed, home: report.home, providers: report.providers, connected: report.connected, total: report.total };
      }),
      endpoint(PATHS.deviceStart, async (body) => ({
        flow: await flows.start(String(body.provider ?? 'github')),
      })),
      endpoint(PATHS.devicePoll, async (body) => ({ flow: flows.publicFlow(String(body.provider ?? 'github')) })),
      endpoint(PATHS.deviceCancel, async (body) => {
        flows.cancel(String(body.provider ?? 'github'));
        return { flow: null };
      }),
      endpoint(PATHS.settings, async (body) => {
        const providerId = String(body.provider ?? 'github');
        const raw = typeof body.clientId === 'string' ? body.clientId.trim() : '';
        if (raw !== '' && !/^[A-Za-z0-9._-]{6,64}$/.test(raw)) {
          throw new RequestError('bad-client-id', 'A client id looks like "Iv1.0123456789abcdef".', 400);
        }
        const scope = typeof body.scope === 'string' ? body.scope.trim().slice(0, 200) : undefined;
        await createVault(home).patchSettings({
          [`${providerId}:clientId`]: raw === '' ? undefined : raw,
          ...(scope === undefined ? {} : { [`${providerId}:scope`]: scope === '' ? undefined : scope }),
        });
        const report = await statusReport(home);
        return { providers: report.providers };
      }),
    ];

    return () => {
      flows.dispose();
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose();
      }
    };
  });

  ctx.effect(() => {
    const tools = ctx.get('tools');
    if (tools === undefined) return () => {};
    const disposers = [tools.register(LIST_TOOL), tools.register(REQUEST_TOOL)];
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose();
    };
  });

  // The seam other plugins use: ask the broker, not the human.
  ctx.effect(() =>
    ctx.provide('connectors', {
      home,
      /** @returns ids with a stored credential. */
      async list() {
        return createVault(home).ids();
      },
      /**
       * The credential for one provider, for host-side code only.
       * Never pass this value into a model prompt or a tool result.
       * @param providerId - provider id.
       * @returns the credential, or null.
       */
      async credential(providerId) {
        const credential = await createVault(home).get(providerId);
        return credential === null ? null : { ...credential };
      },
      /**
       * The token alone, for code that already knows which provider it needs.
       * @param providerId - provider id.
       * @returns the token, or null.
       */
      async token(providerId) {
        const credential = await createVault(home).get(providerId);
        return typeof credential?.token === 'string' ? credential.token : null;
      },
      /**
       * Spend a credential on a request inside the provider origin.
       * @param input - provider, method, path, query, body.
       * @returns status plus redacted data.
       */
      async request(input) {
        return authedRequest(home, input);
      },
      /** Public shape of one stored credential, no secret. */
      async status(providerId) {
        const credential = await createVault(home).get(providerId);
        return credential === null ? null : project(providerId, credential);
      },
      redact,
    }),
  );
}
