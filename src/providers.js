/**
 * Provider presets: how to address one platform, how to present its credential,
 * and how to ask it "who is this token for".
 *
 * Everything a request needs is derived from this table, so the agent never
 * chooses a host: it names a provider and a path, and the host is fixed here.
 * That is the difference between "a proxy the model can point anywhere" and
 * "a credential the model can spend only at the platform it belongs to".
 *
 * `auth.kind`:
 *   bearer - `Authorization: Bearer <token>` (most modern APIs)
 *   header - one custom header, optionally with a fixed prefix (`token `, `Bot `)
 *   basic  - HTTP Basic with a username plus the token as password (Docker Hub)
 *
 * `verify` is the cheapest call that proves a token is alive. `pick` projects
 * the account identity out of that response for display; it never returns the
 * token or anything the page should not hold.
 */

const JSON_ACCEPT = 'application/json';

/** Marker used for providers whose API has no cheap identity endpoint. */
const NO_VERIFY = null;

/**
 * @typedef {object} Provider
 * @property {string} id stable identifier, also the vault key
 * @property {string} name display name
 * @property {string} category grouping in the UI
 * @property {string} baseUrl fixed API origin; every request is joined to it
 * @property {{kind: 'bearer'|'header'|'basic', header?: string, prefix?: string, username?: string}} auth
 * @property {Record<string,string>} [defaultHeaders]
 * @property {{path: string, method?: string, body?: unknown, pick?: (data: any) => object, errorOf?: (data: any) => string|undefined}|null} verify
 * @property {string} docs token creation page shown in the UI
 * @property {string} [prefix] expected token prefix, used only as a hint
 * @property {string} [scopes] human-readable note about what to grant
 * @property {boolean} [deviceFlow] supports an OAuth device-code flow
 * @property {string[]} [gitHosts] hosts whose git credentials this provider can answer
 * @property {boolean} [needsUsername] credential also needs an account name
 */

/** @type {Provider[]} */
export const PROVIDERS = [
  {
    id: 'github',
    name: 'GitHub',
    category: '代码托管',
    baseUrl: 'https://api.github.com',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-connectors' },
    verify: {
      path: '/user',
      pick: (data) => ({
        login: typeof data?.login === 'string' ? data.login : undefined,
        name: typeof data?.name === 'string' ? data.name : undefined,
        avatarUrl: typeof data?.avatar_url === 'string' ? data.avatar_url : undefined,
      }),
    },
    docs: 'https://github.com/settings/tokens',
    prefix: 'ghp_ / github_pat_',
    scopes: 'repo, workflow, read:user',
    deviceFlow: true,
    gitHosts: ['github.com'],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    category: '代码托管',
    baseUrl: 'https://gitlab.com/api/v4',
    auth: { kind: 'header', header: 'PRIVATE-TOKEN' },
    defaultHeaders: { accept: JSON_ACCEPT, 'user-agent': 'dsh-connectors' },
    verify: {
      path: '/user',
      pick: (data) => ({
        login: typeof data?.username === 'string' ? data.username : undefined,
        name: typeof data?.name === 'string' ? data.name : undefined,
        avatarUrl: typeof data?.avatar_url === 'string' ? data.avatar_url : undefined,
      }),
    },
    docs: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    prefix: 'glpat-',
    scopes: 'api, read_repository, write_repository',
    gitHosts: ['gitlab.com'],
  },
  {
    id: 'gitee',
    name: 'Gitee 码云',
    category: '代码托管',
    baseUrl: 'https://gitee.com/api/v5',
    auth: { kind: 'header', header: 'Authorization', prefix: 'token ' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/user',
      pick: (data) => ({
        login: typeof data?.login === 'string' ? data.login : undefined,
        name: typeof data?.name === 'string' ? data.name : undefined,
        avatarUrl: typeof data?.avatar_url === 'string' ? data.avatar_url : undefined,
      }),
    },
    docs: 'https://gitee.com/profile/personal_access_tokens',
    scopes: 'projects, pull_requests, issues',
    gitHosts: ['gitee.com'],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: '部署与托管',
    baseUrl: 'https://api.vercel.com',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/v2/user',
      pick: (data) => ({
        login: typeof data?.user?.username === 'string' ? data.user.username : undefined,
        name: typeof data?.user?.name === 'string' ? data.user.name : undefined,
        avatarUrl: typeof data?.user?.avatar === 'string' ? data.user.avatar : undefined,
      }),
    },
    docs: 'https://vercel.com/account/tokens',
    scopes: 'full account (scope the token to one team when possible)',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: '部署与托管',
    baseUrl: 'https://api.cloudflare.com/client/v4',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/user/tokens/verify',
      pick: (data) => ({
        login: data?.result?.status === 'active' ? 'active token' : 'token',
        name: Array.isArray(data?.result?.policies) ? `${data.result.policies.length} policies` : undefined,
      }),
    },
    docs: 'https://dash.cloudflare.com/profile/api-tokens',
    scopes: 'Workers, Pages, DNS as needed',
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: '部署与托管',
    baseUrl: 'https://api.netlify.com/api/v1',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/user',
      pick: (data) => ({
        login: typeof data?.email === 'string' ? data.email : undefined,
        name: typeof data?.full_name === 'string' ? data.full_name : undefined,
        avatarUrl: typeof data?.avatar_url === 'string' ? data.avatar_url : undefined,
      }),
    },
    docs: 'https://app.netlify.com/user/applications#personal-access-tokens',
  },
  {
    id: 'railway',
    name: 'Railway',
    category: '部署与托管',
    baseUrl: 'https://backboard.railway.app',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/graphql/v2',
      method: 'POST',
      body: { query: 'query { me { name email } }' },
      pick: (data) => ({
        login: typeof data?.data?.me?.email === 'string' ? data.data.me.email : undefined,
        name: typeof data?.data?.me?.name === 'string' ? data.data.me.name : undefined,
      }),
    },
    docs: 'https://railway.app/account/tokens',
  },
  {
    id: 'npm',
    name: 'npm',
    category: '包与镜像',
    baseUrl: 'https://registry.npmjs.org',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/-/whoami',
      pick: (data) => ({ login: typeof data?.username === 'string' ? data.username : undefined }),
    },
    docs: 'https://www.npmjs.com/settings/~/tokens',
    prefix: 'npm_',
    scopes: 'Automation token for publishing',
  },
  {
    id: 'docker',
    name: 'Docker Hub',
    category: '包与镜像',
    baseUrl: 'https://hub.docker.com/v2',
    auth: { kind: 'basic', username: 'x-access-token' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: NO_VERIFY,
    needsUsername: true,
    docs: 'https://hub.docker.com/settings/security',
    scopes: 'Read & Write; username is your Docker ID',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: '数据库与后端',
    baseUrl: 'https://api.supabase.com/v1',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/projects',
      pick: (data) => ({
        login: Array.isArray(data) ? `${data.length} project${data.length === 1 ? '' : 's'}` : 'account',
      }),
    },
    docs: 'https://supabase.com/dashboard/account/tokens',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    category: '模型与 AI',
    baseUrl: 'https://huggingface.co/api',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/whoami-v2',
      pick: (data) => ({
        login: typeof data?.name === 'string' ? data.name : undefined,
        name: typeof data?.fullname === 'string' ? data.fullname : undefined,
        avatarUrl: typeof data?.avatarUrl === 'string' ? data.avatarUrl : undefined,
      }),
    },
    docs: 'https://huggingface.co/settings/tokens',
    prefix: 'hf_',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: '模型与 AI',
    baseUrl: 'https://api.openai.com/v1',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/models',
      pick: (data) => ({
        login: Array.isArray(data?.data) ? `${data.data.length} models` : 'API key',
      }),
    },
    docs: 'https://platform.openai.com/api-keys',
    prefix: 'sk-',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: '模型与 AI',
    baseUrl: 'https://api.anthropic.com/v1',
    auth: { kind: 'header', header: 'x-api-key' },
    defaultHeaders: { accept: JSON_ACCEPT, 'anthropic-version': '2023-06-01' },
    verify: {
      path: '/models',
      pick: (data) => ({
        login: Array.isArray(data?.data) ? `${data.data.length} models` : 'API key',
      }),
    },
    docs: 'https://console.anthropic.com/settings/keys',
    prefix: 'sk-ant-',
  },
  {
    id: 'figma',
    name: 'Figma',
    category: '设计与文档',
    baseUrl: 'https://api.figma.com',
    auth: { kind: 'header', header: 'X-Figma-Token' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/v1/me',
      pick: (data) => ({
        login: typeof data?.handle === 'string' ? data.handle : undefined,
        name: typeof data?.email === 'string' ? data.email : undefined,
        avatarUrl: typeof data?.img_url === 'string' ? data.img_url : undefined,
      }),
    },
    docs: 'https://www.figma.com/settings',
    prefix: 'figd_',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: '设计与文档',
    baseUrl: 'https://api.notion.com/v1',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT, 'notion-version': '2022-06-28' },
    verify: {
      path: '/users/me',
      pick: (data) => ({
        login: typeof data?.name === 'string' ? data.name : undefined,
        avatarUrl: typeof data?.avatar_url === 'string' ? data.avatar_url : undefined,
      }),
    },
    docs: 'https://www.notion.so/my-integrations',
    prefix: 'ntn_ / secret_',
    scopes: 'Share the target pages with the integration',
  },
  {
    id: 'slack',
    name: 'Slack',
    category: '协作与通知',
    baseUrl: 'https://slack.com/api',
    auth: { kind: 'bearer' },
    defaultHeaders: { accept: JSON_ACCEPT },
    verify: {
      path: '/auth.test',
      method: 'POST',
      errorOf: (data) => (typeof data?.error === 'string' ? data.error : undefined),
      pick: (data) => ({
        login: typeof data?.user === 'string' ? data.user : undefined,
        name: typeof data?.team === 'string' ? data.team : undefined,
      }),
    },
    docs: 'https://api.slack.com/apps',
    prefix: 'xoxb- / xoxp-',
    scopes: 'chat:write, channels:read',
  },
];

/** The ids a custom preset may never take. Frozen: a caller cannot widen the lock. */
export const BUILTIN_IDS = Object.freeze(PROVIDERS.map((provider) => provider.id));

/** One custom id: a letter or digit, then letters, digits, dot, dash, underscore. */
const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const MAX_PROVIDER_ID_LENGTH = 32;
const MAX_URL_LENGTH = 2_048;
const MAX_LABEL_LENGTH = 120;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const AUTH_KINDS = new Set(['bearer', 'header', 'basic']);
const VERIFY_METHODS = new Set(['GET', 'HEAD', 'POST']);

/**
 * Fold an id to the form the vault and the lock table compare.
 *
 * NFKC folds full-width and compatibility characters, the control/zero-width
 * strip removes the invisible spellings that would otherwise read as a new id,
 * and lowercasing makes `GitHub` name the same platform as `github`.
 *
 * @param value - raw id from a file, a request or the model.
 * @returns the comparable form; empty string when nothing is left.
 */
export function normalizeProviderId(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s\u200b-\u200f\u2028\u2029\ufeff]/gu, '')
    .toLowerCase();
}

/** @returns a set of built-in ids for O(1) lock checks. */
function builtinIdSet() {
  return new Set(PROVIDERS.map((provider) => provider.id));
}

/** @returns a map from built-in provider id to preset. */
function indexPresets() {
  const map = new Map();
  for (const provider of PROVIDERS) map.set(provider.id, provider);
  return map;
}

/** Short, log-safe echo of a rejected value. */
function echoId(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > MAX_PROVIDER_ID_LENGTH ? `${text.slice(0, MAX_PROVIDER_ID_LENGTH)}…` : text;
}

/** Reject one row with a stable reason code. */
function reject(row, reason) {
  return { rejected: { id: echoId(row?.id), reason } };
}

/**
 * Validate one custom header map.
 * @param headers - raw map from the file.
 * @returns the accepted map, or a rejection reason.
 */
function sanitizeHeaders(headers) {
  if (headers === undefined || headers === null) return { value: undefined };
  if (typeof headers !== 'object' || Array.isArray(headers)) return { reason: 'headers-invalid' };
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name)) return { reason: 'header-name-invalid' };
    if (RESERVED_HEADERS.has(lower)) return { reason: 'header-reserved' };
    if (typeof value !== 'string') return { reason: 'header-value-invalid' };
    if (value.length > MAX_LABEL_LENGTH) return { reason: 'header-value-too-long' };
    out[lower] = value;
  }
  return { value: out };
}

/**
 * Validate one custom preset and return the normalized copy.
 *
 * The returned object contains only known fields: a custom preset cannot smuggle
 * extra keys into a request, and cannot name a built-in id.
 *
 * @param row - one entry of providers.json.
 * @param seen - ids already accepted in this batch.
 * @returns `{ provider }` or `{ rejected }`.
 */
function sanitizeCustomProvider(row, seen) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return reject(row, 'row-invalid');

  const id = normalizeProviderId(row.id);
  if (id === '') return reject(row, 'id-required');
  if (id.length > MAX_PROVIDER_ID_LENGTH) return reject(row, 'id-too-long');
  if (!PROVIDER_ID_PATTERN.test(id)) return reject(row, 'id-invalid');
  if (BUILTIN_IDS.includes(id)) return reject(row, 'id-reserved');
  if (seen.has(id)) return reject(row, 'id-duplicate');

  const baseRaw = typeof row.baseUrl === 'string' ? row.baseUrl.trim() : '';
  if (baseRaw === '' || baseRaw.length > MAX_URL_LENGTH) return reject(row, 'base-url-invalid');
  let base;
  try {
    base = new URL(baseRaw);
  } catch {
    return reject(row, 'base-url-invalid');
  }
  if (base.protocol !== 'https:') return reject(row, 'base-url-insecure');
  if (base.username !== '' || base.password !== '') return reject(row, 'base-url-has-userinfo');
  if (base.search !== '' || base.hash !== '') return reject(row, 'base-url-has-query');
  if (base.hostname === '') return reject(row, 'base-url-invalid');

  const auth = row.auth !== null && typeof row.auth === 'object' && !Array.isArray(row.auth) ? row.auth : { kind: 'bearer' };
  const kind = typeof auth.kind === 'string' ? auth.kind : 'bearer';
  if (!AUTH_KINDS.has(kind)) return reject(row, 'auth-kind-invalid');
  if (kind === 'header') {
    const header = String(auth.header ?? '').toLowerCase();
    if (!HEADER_NAME_PATTERN.test(header) || RESERVED_HEADERS.has(header)) return reject(row, 'auth-header-invalid');
  }
  const headers = sanitizeHeaders(row.defaultHeaders);
  if (headers.reason !== undefined) return reject(row, headers.reason);

  let verify = NO_VERIFY;
  if (row.verify !== null && row.verify !== undefined) {
    if (typeof row.verify !== 'object' || Array.isArray(row.verify)) return reject(row, 'verify-invalid');
    const path = typeof row.verify.path === 'string' ? row.verify.path : '';
    if (!path.startsWith('/') || path.startsWith('//')) return reject(row, 'verify-path-invalid');
    const method = typeof row.verify.method === 'string' ? row.verify.method.toUpperCase() : 'GET';
    if (!VERIFY_METHODS.has(method)) return reject(row, 'verify-method-invalid');
    verify = {
      path,
      method,
      ...(typeof row.verify.errorOf === 'function' ? { errorOf: row.verify.errorOf } : {}),
      ...(typeof row.verify.pick === 'function' ? { pick: row.verify.pick } : {}),
    };
  }

  const gitHosts = Array.isArray(row.gitHosts)
    ? row.gitHosts.filter((host) => typeof host === 'string' && HOST_PATTERN.test(host)).map((host) => host.toLowerCase())
    : undefined;

  return {
    provider: {
      id,
      name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim().slice(0, MAX_LABEL_LENGTH) : id,
      category: typeof row.category === 'string' && row.category.trim() !== '' ? row.category.trim().slice(0, MAX_LABEL_LENGTH) : '自定义',
      baseUrl: base.toString().replace(/\/+$/, ''),
      auth: {
        kind,
        ...(kind === 'header' ? { header: String(auth.header).toLowerCase() } : {}),
        ...(typeof auth.prefix === 'string' ? { prefix: auth.prefix.slice(0, 32) } : {}),
        ...(typeof auth.username === 'string' ? { username: auth.username.slice(0, MAX_LABEL_LENGTH) } : {}),
      },
      ...(headers.value === undefined ? {} : { defaultHeaders: headers.value }),
      verify,
      docs: typeof row.docs === 'string' ? row.docs.slice(0, MAX_URL_LENGTH) : '',
      prefix: typeof row.prefix === 'string' ? row.prefix.slice(0, 64) : '',
      scopes: typeof row.scopes === 'string' ? row.scopes.slice(0, 300) : '',
      deviceFlow: row.deviceFlow === true,
      needsUsername: row.needsUsername === true,
      ...(gitHosts === undefined ? {} : { gitHosts }),
      custom: true,
    },
  };
}

/**
 * Validate a whole custom preset list.
 *
 * This is the single gate every custom preset passes through, whichever caller
 * loaded it. Rows that would shadow a built-in id, repeat an id, or carry a
 * malformed endpoint are dropped with a reason instead of being merged.
 *
 * @param rows - parsed providers.json, or any caller-supplied array.
 * @returns accepted presets plus the rejections, in input order.
 */
export function sanitizeCustomProviders(rows) {
  if (rows === undefined || rows === null) return { accepted: [], rejected: [] };
  if (!Array.isArray(rows)) return { accepted: [], rejected: [{ id: null, reason: 'not-an-array' }] };
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const row of rows) {
    const outcome = sanitizeCustomProvider(row, seen);
    if (outcome.provider !== undefined) {
      accepted.push(outcome.provider);
      seen.add(outcome.provider.id);
    } else {
      rejected.push(outcome.rejected);
    }
  }
  return { accepted, rejected };
}

/**
 * Public projection of one preset: everything the browser page may know.
 * @param provider - a preset.
 * @returns display metadata with no endpoint secrets beyond the documented base.
 */
export function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    category: provider.category,
    docs: provider.docs,
    prefix: provider.prefix ?? '',
    scopes: provider.scopes ?? '',
    deviceFlow: provider.deviceFlow === true,
    needsUsername: provider.needsUsername === true,
    verifiable: provider.verify !== NO_VERIFY,
  };
}

/**
 * Resolve a provider by id. A built-in id always resolves to the built-in
 * preset: a custom entry can add a platform, never redefine one.
 * @param id - provider id, in any casing or width.
 * @param custom - extra presets, sanitized here in case the caller bypassed the loader.
 * @returns the preset, or undefined for an unknown id.
 */
export function providerById(id, custom = []) {
  const key = normalizeProviderId(id);
  if (key === '') return undefined;
  const builtin = indexPresets().get(key);
  if (builtin !== undefined) return builtin;
  return sanitizeCustomProviders(custom).accepted.find((provider) => provider.id === key);
}

/**
 * Every provider a user can connect, builtins first then custom ones.
 * @param custom - extra presets from the user's own providers file.
 * @returns the merged list; a custom row can never take a built-in id.
 */
export function allProviders(custom = []) {
  const map = indexPresets();
  for (const provider of sanitizeCustomProviders(custom).accepted) {
    if (map.has(provider.id)) continue;
    map.set(provider.id, provider);
  }
  return [...map.values()];
}

/**
 * Build the absolute request URL for one API path.
 *
 * The path must be a path, never a URL: a leading `//` would otherwise read as
 * a protocol-relative URL and move the request to another host, which would
 * hand a stored token to whoever the model named.
 *
 * @param provider - the preset owning the request.
 * @param apiPath - path beginning with `/`.
 * @param query - optional query parameters.
 * @returns the URL to fetch.
 * @throws when the path is not a plain path under the provider origin.
 */
export function resolveRequestUrl(provider, apiPath, query = undefined) {
  const raw = typeof apiPath === 'string' ? apiPath : '/';
  if (!raw.startsWith('/')) throw new Error('path-must-start-with-slash');
  if (raw.startsWith('//')) throw new Error('path-must-not-be-protocol-relative');
  const base = provider.baseUrl.replace(/\/+$/, '');
  const url = new URL(base + raw);
  if (url.origin !== new URL(provider.baseUrl).origin) throw new Error('path-escapes-provider-origin');
  if (query !== undefined && query !== null) {
    if (typeof query !== 'object' || Array.isArray(query)) throw new Error('query-must-be-object');
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

/**
 * The authorization headers for one credential.
 * @param provider - the preset.
 * @param credential - a stored credential holding at least `token`.
 * @returns headers to merge into the request.
 * @throws when the credential has no token.
 */
export function authHeaders(provider, credential) {
  const token = typeof credential?.token === 'string' ? credential.token : '';
  if (token === '') throw new Error('missing-token');
  const auth = provider.auth ?? { kind: 'bearer' };
  if (auth.kind === 'bearer') return { authorization: `Bearer ${token}` };
  if (auth.kind === 'header') {
    const name = String(auth.header ?? '').toLowerCase();
    if (name === '') throw new Error('provider-header-missing');
    return { [name]: `${auth.prefix ?? ''}${token}` };
  }
  if (auth.kind === 'basic') {
    const username = credential.username || auth.username || 'x-access-token';
    return { authorization: `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}` };
  }
  throw new Error('unsupported-auth-kind');
}

/**
 * Header names a caller may never set: they carry the credential or describe
 * the connection, so letting the model write them would defeat the preset.
 */
export const RESERVED_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'proxy-authorization',
  'x-api-key',
  'private-token',
  'x-figma-token',
]);

/**
 * Ask a provider who a credential belongs to.
 * @param provider - the preset.
 * @param credential - the credential to check.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns ok plus the projected account, or a failure with a short reason.
 */
export async function verifyCredential(provider, credential, fetchImpl = fetch) {
  if (!provider.verify) return { ok: true, status: 0, account: null };
  const url = resolveRequestUrl(provider, provider.verify.path);
  const headers = { ...provider.defaultHeaders, ...authHeaders(provider, credential) };
  const init = {
    method: provider.verify.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(15_000),
  };
  if (provider.verify.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(provider.verify.body);
  }
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let data = null;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  const upstreamError = typeof provider.verify.errorOf === 'function' ? provider.verify.errorOf(data) : undefined;
  if (upstreamError) return { ok: false, status: response.status, error: upstreamError };
  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : `HTTP ${response.status}`;
    return { ok: false, status: response.status, error: message };
  }
  const account = typeof provider.verify.pick === 'function' ? provider.verify.pick(data) : null;
  return { ok: true, status: response.status, account: account ?? null };
}
