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

/*
 * No hard dependency on `webServer`.
 *
 * The browser shell mounts one, but the desktop shell serves the same bundle
 * from `file://` over IPC and never binds a port. Declaring `webServer` as a
 * hard dependency would leave the plugin permanently pending there — no tools,
 * no service, no settings page. Each surface is attached where its own service
 * exists instead.
 */
export const inject = [];

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Every management endpoint lives under the harness `/api` surface, so it
 * inherits the Host/Origin fence, the `SameSite=Strict` session cookie and the
 * owner-principal check. The page keeps its own path because a browser needs a
 * document, not JSON.
 */
const API_PREFIX = '/api/connectors';
const API_PATHS = {
  status: `${API_PREFIX}/status`,
  connect: `${API_PREFIX}/connect`,
  disconnect: `${API_PREFIX}/disconnect`,
  deviceStart: `${API_PREFIX}/device/start`,
  devicePoll: `${API_PREFIX}/device/poll`,
  deviceCancel: `${API_PREFIX}/device/cancel`,
  settings: `${API_PREFIX}/settings`,
};
const PAGE_PATH = '/dsh-connectors';

/** A failure the client is allowed to see, carried as a stable code. */
class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Write JSON over the Node response, for the page route. */
function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

/** One Fetch response for an `/api` route. */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Read a bounded JSON body from a Fetch request.
 *
 * The route is registered as `streaming`, so the harness hands over a live
 * stream rather than buffering it first. Exceeding the cap cancels the reader
 * mid-stream instead of growing a buffer: a caller cannot make this endpoint
 * allocate more than `MAX_BODY_BYTES`.
 *
 * @param request - the Fetch request.
 * @returns the parsed object.
 */
async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RequestError('body-too-large', 'Request body is too large.', 413);
  }
  if (request.body === null) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RequestError('body-too-large', 'Request body is too large.', 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
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
 * Build one POST-only JSON route on the harness `/api` surface.
 *
 * Trust and identity are decided before this handler runs: the `/api` bridge
 * applies the Host/Origin fence, verifies the signed session cookie and admits
 * only an owner principal. This function therefore never inspects `Origin` —
 * doing so was what broke every reverse-proxied phone in 0.1.0.
 *
 * @param handler - body handler resolving the payload.
 * @returns the Fetch handler.
 */
function makeApiRoute(handler) {
  return async (request) => {
    try {
      if (request.method !== 'POST') {
        return jsonResponse(405, { ok: false, error: 'method-not-allowed' });
      }
      const body = await readJsonBody(request);
      const payload = await handler(body);
      return jsonResponse(200, { ok: true, ...payload });
    } catch (error) {
      if (error instanceof RequestError) {
        return jsonResponse(error.status, { ok: false, error: error.code, message: error.message });
      }
      return jsonResponse(500, { ok: false, error: 'internal', message: 'The request could not be completed.' });
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
export function createDeviceFlows(home, deps = {}) {
  /** @type {Map<string, {generation: number, status: string, userCode?: string, verificationUri?: string, expiresAt: number, intervalMs: number, deviceCode?: string, clientId?: string, error?: string, timer?: NodeJS.Timeout}>} */
  const flows = new Map();
  const generations = new Map();
  /** Cancels in-flight polls when the plugin unloads. */
  const inFlight = new AbortController();
  const pollFn = deps.pollDeviceFlow ?? pollDeviceFlow;
  const startFn = deps.startDeviceFlow ?? startDeviceFlow;
  const connectFn = deps.connect ?? connect;
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
    const wait = Math.min(flow.intervalMs, remaining);
    const scaled = typeof deps.intervalScale === 'number' ? Math.max(1, Math.round(wait * deps.intervalScale)) : wait;
    flow.timer = setTimeout(() => {
      flow.timer = undefined;
      void tick(providerId, flow, generation);
    }, scaled);
    flow.timer.unref?.();
  }

  async function tick(providerId, flow, generation) {
    if (disposed || generationOf(providerId) !== generation || flows.get(providerId) !== flow) return;
    if (Date.now() >= flow.expiresAt) {
      flow.status = 'expired';
      return;
    }
    try {
      const result = await pollFn(flow.clientId, flow.deviceCode, fetch, inFlight.signal);
      if (generationOf(providerId) !== generation || flows.get(providerId) !== flow) return;
      if (result.status === 'authorized') {
        const stored = await connectFn(home, { provider: providerId, token: result.token, kind: 'oauth' });
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
        details = await startFn(clientId, scope, fetch, inFlight.signal);
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
      inFlight.abort();
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
/** Settings key a user flips to let other plugins read raw secrets. */
const RAW_CREDENTIALS_KEY = 'service:allowRawCredentials';

/**
 * Whether the user has granted raw-secret reads to other plugins.
 * @param home - connector home directory.
 * @returns true only for an explicit boolean true.
 */
async function rawCredentialsGranted(home) {
  const settings = await createVault(home).readSettings();
  return settings[RAW_CREDENTIALS_KEY] === true;
}

/**
 * Refuse a raw read unless the user granted it.
 * @param home - connector home directory.
 */
async function assertRawCredentials(home) {
  if (await rawCredentialsGranted(home)) return;
  const error = new Error(
    'Raw credentials are not granted to plugins. Use request(), or have the user enable service:allowRawCredentials.',
  );
  error.code = 'raw-credentials-not-granted';
  throw error;
}

/**
 * Register the tools, the service, the management routes and the page.
 *
 * Each surface attaches only where its service exists: tools and the Cordis
 * service need nothing, the JSON routes need `connection`, and the HTML page
 * needs `connection` plus `webServer`. A shell missing one of them loses that
 * surface, not the whole plugin.
 *
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  const home = connectorHome();

  ctx.effect(() => {
    const tools = ctx.get('tools');
    if (tools === undefined) return () => {};
    const disposers = [tools.register(LIST_TOOL), tools.register(REQUEST_TOOL)];
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose();
    };
  });

  // The seam other plugins use: ask the broker, not the human.
  //
  // Default posture is least privilege. A plugin may read connection state and
  // spend a credential through `request()` — that path fixes the host and never
  // returns the token. Reading the raw secret is a separate capability that the
  // user has to grant explicitly (`service:allowRawCredentials`), because one
  // plugin with a token is one plugin that can copy it anywhere.
  ctx.effect(() =>
    ctx.provide('connectors', {
      home,
      /** What this service currently permits. Probes without throwing. */
      async capabilities() {
        return { version: 1, rawCredentials: await rawCredentialsGranted(home), request: true, status: true };
      },
      /** @returns ids with a stored credential. */
      async list() {
        return createVault(home).ids();
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
      /**
       * The credential for one provider, including the secret.
       * Requires the raw-credential grant; never pass the value into a prompt
       * or a tool result.
       * @param providerId - provider id.
       * @returns the credential, or null when absent.
       */
      async credential(providerId) {
        await assertRawCredentials(home);
        const credential = await createVault(home).get(providerId);
        return credential === null ? null : { ...credential };
      },
      /**
       * The token alone. Same grant as `credential()`.
       * @param providerId - provider id.
       * @returns the token, or null when absent.
       */
      async token(providerId) {
        await assertRawCredentials(home);
        const credential = await createVault(home).get(providerId);
        return typeof credential?.token === 'string' ? credential.token : null;
      },
    }),
  );

  // Management routes: trust and identity are the harness's, not ours.
  ctx.inject(['connection'], (apiCtx) => {
    apiCtx.effect(() => {
      const flows = createDeviceFlows(home);
      /**
       * @param path - absolute path below /api.
       * @param handler - body handler.
       */
      const route = (path, handler) =>
        apiCtx.connection.fetch.register({
          path,
          methods: ['POST'],
          requestBody: 'streaming',
          fetch: makeApiRoute(handler),
        });

      const disposers = [
        route(API_PATHS.status, async () => {
          const report = await statusReport(home);
          return {
            home: report.home,
            connected: report.connected,
            total: report.total,
            providers: report.providers,
            rejectedProviders: report.rejectedProviders,
          };
        }),
        route(API_PATHS.connect, async (body) => {
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
        route(API_PATHS.disconnect, async (body) => {
          const removed = await disconnect(home, String(body.provider ?? ''));
          const report = await statusReport(home);
          return { removed, home: report.home, providers: report.providers, connected: report.connected, total: report.total };
        }),
        route(API_PATHS.deviceStart, async (body) => ({
          flow: await flows.start(String(body.provider ?? 'github')),
        })),
        route(API_PATHS.devicePoll, async (body) => ({ flow: flows.publicFlow(String(body.provider ?? 'github')) })),
        route(API_PATHS.deviceCancel, async (body) => {
          flows.cancel(String(body.provider ?? 'github'));
          return { flow: null };
        }),
        route(API_PATHS.settings, async (body) => {
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
  });

  // The standalone page: one document, no secrets, same session as the app.
  ctx.inject(['connection', 'webServer'], (uiCtx) => {
    uiCtx.effect(() => {
      const pageHandler = async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD' });
          response.end();
          return;
        }
        // A document is as sensitive as the API behind it: it lists accounts
        // and offers forms that spend credentials. The harness decides who may
        // read it; a request that does not come from a signed-in owner gets the
        // same answer the API would give.
        const rejection = uiCtx.connection.requestRejection(request);
        if (rejection !== undefined) {
          const body = '<!doctype html><meta charset="utf-8"><title>Connectors</title><p>Open DeepSeek Harness and sign in first, then reload this page.';
          response.writeHead(rejection, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          response.end(request.method === 'HEAD' ? undefined : body);
          return;
        }
        const custom = await loadCustomProviders(home);
        const providers = allProviders(custom).map(publicProvider);
        const settings = await createVault(home).readSettings();
        const html = renderPage({
          providers,
          clientIds: Object.fromEntries(
            providers.filter((provider) => provider.deviceFlow).map((provider) => [provider.id, resolveClientId(settings, provider.id)]),
          ),
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

      const disposer = uiCtx.webServer.register({ kind: 'exact', path: PAGE_PATH, handler: pageHandler });
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    });
  });
}
