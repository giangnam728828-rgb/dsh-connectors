/**
 * The dsh-go native surface (stage D-a).
 *
 * dsh-go does not run plugin code and does not render the DSH web page. A
 * plugin declares where it wants to appear in `package.json` → `dshGo`, and the
 * host half feeds that place through `ctx.dshGo`. Everything in this file is a
 * pure projection of `statusReport()`: it never reads the vault, never touches
 * the network and never sees a token.
 *
 * The panel shows only platforms that have a stored credential — "which ones
 * are authorised", which is what the user asked for. The status strip stays
 * hidden until the first one exists, so an unconfigured phone has no chrome.
 */

/** Panel and strip ids; both must match `package.json` → `dshGo.contributes`. */
export const PANEL_ID = 'connectors';
export const STRIP_ID = 'connected';

/**
 * Icon per built-in provider. Every name is in the app's 162-icon set; an
 * unknown id falls back to `link`, which the app also draws.
 */
const ICONS = {
  github: 'fork',
  gitlab: 'fork',
  gitee: 'fork',
  vercel: 'play',
  cloudflare: 'cloud',
  netlify: 'globe',
  railway: 'server',
  npm: 'terminal',
  docker: 'computer',
  supabase: 'storage',
  huggingface: 'robot',
  openai: 'sparkle',
  anthropic: 'sparkle',
  figma: 'palette',
  notion: 'document',
  slack: 'chat',
};

const WORDS = {
  zh: {
    title: '连接器',
    connected: '已连接',
    refresh: '刷新',
    copy: '复制',
    copied: '已复制',
    hint: '只列出已授权的平台。令牌保存在本机加密保险库，不会显示在这里。',
    emptyHint: '还没有授权任何平台。在设置 › 连接器里添加令牌，或在终端运行 dsh-connectors add github；连上之后这里就会出现。',
    copyTitle: '连接器',
    strip: (n) => `${n} 个已连接`,
  },
  en: {
    title: 'Connectors',
    connected: 'Connected',
    refresh: 'Refresh',
    copy: 'Copy',
    copied: 'Copied',
    hint: 'Only authorised platforms are listed. Tokens stay in the encrypted vault on this host and never appear here.',
    emptyHint: 'No platform is authorised yet. Add a token in Settings › Connectors, or run dsh-connectors add github in a terminal; it will show up here once connected.',
    copyTitle: 'Connectors',
    strip: (n) => `${n} connected`,
  },
};

/**
 * Copy for one locale. zh unless the app explicitly asks for English, which is
 * the same rule the rest of the plugin uses.
 *
 * @param locale - the app's locale tag, e.g. `zh-CN` or `en-US`.
 * @returns the word table for that locale.
 */
export function words(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDS.en : WORDS.zh;
}

/**
 * Icon name for a provider id.
 * @param providerId - built-in or custom provider id.
 * @returns an icon name the app knows, or `link`.
 */
export function iconFor(providerId) {
  return ICONS[String(providerId)] ?? 'link';
}

/**
 * One line of account identity, without the secret.
 * @param row - a provider row from `statusReport`.
 * @returns `@login`, else the display name, else an empty string.
 */
function accountOf(row) {
  if (typeof row.login === 'string' && row.login !== '') return `@${row.login}`;
  if (typeof row.accountName === 'string' && row.accountName !== '') return row.accountName;
  if (typeof row.username === 'string' && row.username !== '') return row.username;
  return '';
}

/**
 * The panel's data model: language-neutral rows plus one localised hint.
 *
 * `hint` is the only localised field, because the view binds it into a `text`
 * node; rows carry names, logins and the four-character token tail only.
 *
 * @param report - `statusReport(home)` output.
 * @param locale - the app's locale tag.
 * @returns `{ count, rows, hint }`, every value JSON-safe.
 */
export function panelData(report, locale) {
  const w = words(locale);
  const rows = [];
  for (const row of Array.isArray(report?.providers) ? report.providers : []) {
    if (row?.connected !== true) continue;
    const account = accountOf(row);
    rows.push({
      title: typeof row.name === 'string' && row.name !== '' ? row.name : String(row.id),
      ...(account === '' ? {} : { subtitle: account }),
      ...(typeof row.hint === 'string' && row.hint !== '' ? { trailing: row.hint } : {}),
      icon: iconFor(row.id),
    });
  }
  return {
    count: rows.length,
    rows,
    hint: rows.length === 0 ? w.emptyHint : w.hint,
  };
}

/**
 * A panel payload for the case where the vault could not be read at all.
 * @param locale - the app's locale tag.
 * @returns an empty panel with a short failure note.
 */
export function unavailablePanelData(locale) {
  const w = words(locale);
  return { count: 0, rows: [], hint: w.emptyHint };
}

/**
 * The panel structure. It is fixed: every changing value is a binding into
 * `panelData`, so a reconnect pushes a small patch rather than a new tree.
 *
 * @param caps - the app's capabilities for this view call.
 * @returns a v1 component tree.
 */
export function panelView(caps) {
  const w = words(caps?.locale);
  return {
    type: 'stack',
    title: w.title,
    children: [
      { type: 'metric', label: w.connected, value: { $: 'data.count' } },
      { type: 'list', items: { $: 'data.rows' } },
      { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
      {
        type: 'actions',
        items: [
          { label: w.refresh, icon: 'refresh', action: 'refresh' },
          { label: w.copy, icon: 'copy', action: 'copy' },
        ],
      },
    ],
  };
}

/**
 * The status-strip line, or null to keep the strip hidden.
 * @param data - `panelData` output.
 * @param locale - the app's locale tag.
 * @returns `{ text, icon }` or null.
 */
export function stripData(data, locale) {
  const count = Number(data?.count);
  if (!Number.isInteger(count) || count <= 0) return null;
  return { text: words(locale).strip(count), icon: 'link' };
}

/**
 * Plain-text list for the copy button. Same information as the panel, no
 * secret: the token appears only as the four-character tail the vault already
 * projects for the page.
 *
 * @param data - `panelData` output.
 * @param locale - the app's locale tag.
 * @returns multi-line text, at most 8000 characters.
 */
export function copyText(data, locale) {
  const w = words(locale);
  const lines = [`${w.copyTitle} · ${w.strip(Number(data?.count) || 0)}`];
  for (const row of Array.isArray(data?.rows) ? data.rows : []) {
    const parts = [row.title];
    if (typeof row.subtitle === 'string' && row.subtitle !== '') parts.push(row.subtitle);
    if (typeof row.trailing === 'string' && row.trailing !== '') parts.push(row.trailing);
    lines.push(`- ${parts.join(' · ')}`);
  }
  return lines.join('\n').slice(0, 8000);
}
