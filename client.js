/**
 * Client half: one settings section, "Connectors".
 *
 * It renders state and collects a token; it never receives one back. Every
 * request goes to the host endpoints under /dsh-connectors, which own the
 * vault. If this page is closed mid-flow the device-code poll on the host keeps
 * running, so approving on the phone still completes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-connectors',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'connectors';

    const EN = {
      nav: 'Connectors',
      title: 'Connectors',
      description:
        'Connect a platform once and every session, tool and plugin can use it. Tokens are encrypted on this machine and never shown in chat.',
      connectedCount: '{connected} of {total} connected',
      connect: 'Connect',
      replace: 'Replace token',
      disconnect: 'Disconnect',
      disconnectConfirm: 'Disconnect {name}? The local credential is deleted; the authorization stays on the platform.',
      device: 'Sign in with device code',
      tokenLabel: 'Access token',
      usernameLabel: 'Username',
      save: 'Save',
      saving: 'Checking…',
      cancel: 'Cancel',
      openPage: 'Open the full page',
      vaultAt: 'Vault',
      connectedAs: 'Connected as',
      notConnected: 'Not connected',
      docs: 'Create a token in the platform settings',
      scopesHint: 'Suggested scopes: {scopes}',
      errToken: 'Paste a token first.',
      errUsername: 'This platform also needs a username.',
      errVerify: 'The platform rejected this token: {message}',
      errUnreachable: 'Could not reach the platform; nothing was saved.',
      errGeneric: 'Failed: {error}',
      errNetwork: 'Network error. Try again.',
      saveAnyway: 'Save anyway',
      deviceTitle: 'Authorize this device',
      deviceBody: 'Open the page below and enter this code. This panel notices when you approve.',
      deviceOpen: 'Open the authorization page',
      devicePending: 'Waiting for approval…',
      deviceExpired: 'The code expired. Start again.',
      deviceDenied: 'Authorization was cancelled.',
      deviceFailed: 'Authorization failed. Use a token instead.',
      deviceNeedsClientId: 'Set an OAuth App client id on the full page to use device sign-in.',
      privacy:
        'Credentials are stored AES-256-GCM encrypted under the harness state directory with owner-only permissions. The browser never receives the token.',
      refresh: 'Refresh',
      loading: 'Loading…',
    };

    const ZH = {
      nav: '连接器',
      title: '连接器',
      description: '一次连接，之后每个会话、工具和插件都能直接用。令牌加密保存在本机，不会出现在对话里。',
      connectedCount: '已连接 {connected} / {total}',
      connect: '连接',
      replace: '更换令牌',
      disconnect: '断开',
      disconnectConfirm: '断开 {name}？本机凭据会被删除，平台上的授权仍然保留。',
      device: '设备码登录',
      tokenLabel: '访问令牌',
      usernameLabel: '用户名',
      save: '保存',
      saving: '校验中…',
      cancel: '取消',
      openPage: '打开完整页面',
      vaultAt: '凭据目录',
      connectedAs: '已连接',
      notConnected: '未连接',
      docs: '在平台设置里创建令牌',
      scopesHint: '建议权限：{scopes}',
      errToken: '请先粘贴令牌。',
      errUsername: '这个平台还需要用户名。',
      errVerify: '平台拒绝了这个令牌：{message}',
      errUnreachable: '连不上平台，令牌没有保存。',
      errGeneric: '失败：{error}',
      errNetwork: '网络异常，请重试。',
      saveAnyway: '仍然保存',
      deviceTitle: '授权这台设备',
      deviceBody: '打开下面的页面并输入代码，批准后这里会自动完成。',
      deviceOpen: '打开授权页面',
      devicePending: '等待批准…',
      deviceExpired: '代码已过期，请重新开始。',
      deviceDenied: '授权已取消。',
      deviceFailed: '授权失败，请改用令牌。',
      deviceNeedsClientId: '需要先在完整页面里填写 OAuth App Client ID。',
      privacy: '凭据以 AES-256-GCM 加密保存在 harness 状态目录，只有当前用户可读。浏览器永远拿不到令牌本身。',
      refresh: '刷新',
      loading: '读取中…',
    };

    const STYLE = `
      .dshcn-root { display: flex; flex-direction: column; gap: 14px; font-size: 14px; }
      .dshcn-head { display: flex; flex-direction: column; gap: 4px; }
      .dshcn-title { font-size: 15px; font-weight: 600; }
      .dshcn-desc { color: var(--dsh-text-secondary, #6b7280); font-size: 12.5px; line-height: 1.6; }
      .dshcn-meta { display: flex; gap: 8px; flex-wrap: wrap; }
      .dshcn-pill { font-size: 11.5px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--dsh-border, #e5e7eb); color: var(--dsh-text-secondary, #6b7280); }
      .dshcn-group { display: flex; flex-direction: column; gap: 6px; }
      .dshcn-grouplabel { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dsh-text-secondary, #6b7280); margin-top: 6px; }
      .dshcn-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--dsh-border, #e5e7eb); border-radius: 10px; }
      .dshcn-badge { width: 30px; height: 30px; flex: 0 0 auto; border-radius: 9px; display: grid; place-items: center; font-size: 12px; font-weight: 600; background: rgba(47,111,237,.12); color: #2f6fed; overflow: hidden; }
      .dshcn-badge img { width: 100%; height: 100%; object-fit: cover; }
      .dshcn-name { flex: 1; min-width: 0; }
      .dshcn-name b { display: block; font-weight: 500; font-size: 13.5px; }
      .dshcn-name span { display: block; font-size: 11.5px; color: var(--dsh-text-secondary, #6b7280); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dshcn-dot { width: 6px; height: 6px; border-radius: 50%; background: #cbd5e1; display: inline-block; margin-right: 5px; }
      .dshcn-dot.on { background: #17a673; }
      .dshcn-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .dshcn-btn { font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsh-border, #e5e7eb); background: transparent; color: inherit; cursor: pointer; }
      .dshcn-btn.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
      .dshcn-btn.danger { color: #c2410c; border-color: rgba(194,65,12,.35); }
      .dshcn-btn:disabled { opacity: .55; }
      .dshcn-editor { border: 1px solid var(--dsh-border, #e5e7eb); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: rgba(127,127,127,.04); }
      .dshcn-field { display: flex; flex-direction: column; gap: 4px; }
      .dshcn-field label { font-size: 11.5px; color: var(--dsh-text-secondary, #6b7280); }
      .dshcn-field input { font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsh-border, #e5e7eb); background: transparent; color: inherit; }
      .dshcn-hint { font-size: 11.5px; color: var(--dsh-text-secondary, #6b7280); line-height: 1.55; }
      .dshcn-error { font-size: 12px; color: #c2410c; white-space: pre-wrap; }
      .dshcn-link { font-size: 12px; color: #2f6fed; cursor: pointer; text-decoration: none; }
      .dshcn-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 20px; letter-spacing: .12em; font-weight: 600; }
      .dshcn-foot { font-size: 11px; color: var(--dsh-text-secondary, #6b7280); line-height: 1.6; word-break: break-all; }
    `;

    function interpolate(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) => (values && key in values ? String(values[key]) : match));
    }

    /** One POST to the host endpoints, with a tolerant failure shape. */
    async function post(path, body) {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body ?? {}),
        });
        const data = await response.json().catch(() => ({ ok: false, error: 'bad-response' }));
        return data;
      } catch (error) {
        return { ok: false, error: 'network', message: String(error?.message ?? error) };
      }
    }

    function createSection(ctx) {
      const translate = () => ctx.locale.bind(NS);

      return function ConnectorsSection() {
        const [, setLocaleRevision] = useState(0);
        useEffect(() => ctx.locale.subscribe(() => setLocaleRevision((value) => value + 1)), []);
        const t = translate();

        const [report, setReport] = useState(null);
        const [editing, setEditing] = useState(null);
        const [token, setToken] = useState('');
        const [username, setUsername] = useState('');
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);
        const [flow, setFlow] = useState(null);
        const alive = useRef(true);

        useEffect(() => {
          alive.current = true;
          return () => {
            alive.current = false;
          };
        }, []);

        const applyReport = useCallback((result) => {
          if (alive.current && result && result.ok) setReport(result);
        }, []);

        const refresh = useCallback(async () => {
          applyReport(await post('/api/connectors/status'));
        }, [applyReport]);

        useEffect(() => {
          void refresh();
        }, [refresh]);

        // Poll only while a device flow is open, and stop when it resolves.
        useEffect(() => {
          if (flow === null || flow.status !== 'pending') return undefined;
          const provider = editing;
          const timer = setInterval(async () => {
            const result = await post('/api/connectors/device/poll', { provider });
            if (!alive.current) return;
            if (result.ok && result.flow === null) {
              setFlow(null);
              setEditing(null);
              await refresh();
              return;
            }
            if (result.ok && result.flow) setFlow(result.flow);
          }, 3000);
          return () => clearInterval(timer);
        }, [flow, editing, refresh]);

        const describe = useCallback(
          (result) => {
            const messages = {
              'token-required': 'errToken',
              'username-required': 'errUsername',
              'verify-unreachable': 'errUnreachable',
              network: 'errNetwork',
            };
            if (result.error === 'verify-failed') return t('errVerify', { message: result.message ?? '' });
            if (messages[result.error]) return t(messages[result.error]);
            return t('errGeneric', { error: result.message ?? result.error ?? 'unknown' });
          },
          [t],
        );

        const beginConnect = (provider) => {
          setEditing(provider.id);
          setToken('');
          setUsername('');
          setError(null);
          setFlow(null);
        };

        const save = async (skipVerify = false) => {
          if (token.trim() === '') {
            setError(t('errToken'));
            return;
          }
          setBusy(true);
          setError(null);
          const result = await post('/api/connectors/connect', {
            provider: editing,
            token: token.trim(),
            ...(username.trim() === '' ? {} : { username: username.trim() }),
            ...(skipVerify ? { skipVerify: true } : {}),
          });
          setBusy(false);
          if (!result.ok) {
            setError(describe(result));
            return;
          }
          setEditing(null);
          setToken('');
          applyReport(result);
        };

        const beginDevice = async () => {
          setError(null);
          const result = await post('/api/connectors/device/start', { provider: editing });
          if (!result.ok) {
            setError(result.error === 'client-id-missing' ? t('deviceNeedsClientId') : describe(result));
            return;
          }
          setFlow(result.flow);
        };

        const disconnect = async (provider) => {
          const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(interpolate(t('disconnectConfirm'), { name: provider.name }))
            : true;
          if (!confirmed) return;
          const result = await post('/api/connectors/disconnect', { provider: provider.id });
          if (result.ok) applyReport(result);
        };

        const openPage = () => {
          const origin = typeof window !== 'undefined' ? window.location.origin : '';
          if (typeof window !== 'undefined') window.open(`${origin}/dsh-connectors`, '_blank', 'noopener');
        };

        const rows = report?.providers ?? [];
        const categories = [];
        for (const row of rows) if (!categories.includes(row.category)) categories.push(row.category);

        const body = report === null
          ? h('div', { className: 'dshcn-hint' }, t('loading'))
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dshcn-meta' },
                h('span', { className: 'dshcn-pill' }, interpolate(t('connectedCount'), { connected: report.connected, total: report.total })),
                h('a', { className: 'dshcn-link', onClick: refresh }, t('refresh')),
                h('a', { className: 'dshcn-link', onClick: openPage }, t('openPage')),
              ),
              categories.map((category) =>
                h(
                  'div',
                  { className: 'dshcn-group', key: category },
                  h('div', { className: 'dshcn-grouplabel' }, category),
                  rows
                    .filter((row) => row.category === category)
                    .map((row) =>
                      h(
                        React.Fragment,
                        { key: row.id },
                        h(
                          'div',
                          { className: 'dshcn-row' },
                          h(
                            'div',
                            { className: 'dshcn-badge' },
                            row.avatarUrl ? h('img', { src: row.avatarUrl, alt: '' }) : (row.name ?? row.id).slice(0, 1).toUpperCase(),
                          ),
                          h(
                            'div',
                            { className: 'dshcn-name' },
                            h('b', null, row.name),
                            h(
                              'span',
                              null,
                              h('i', { className: `dshcn-dot${row.connected ? ' on' : ''}` }),
                              row.connected ? row.login ?? t('connectedAs') : t('notConnected'),
                            ),
                          ),
                          h(
                            'div',
                            { className: 'dshcn-actions' },
                            h(
                              'button',
                              { className: `dshcn-btn${row.connected ? '' : ' primary'}`, onClick: () => beginConnect(row) },
                              row.connected ? t('replace') : t('connect'),
                            ),
                            row.connected
                              ? h('button', { className: 'dshcn-btn danger', onClick: () => disconnect(row) }, t('disconnect'))
                              : null,
                          ),
                        ),
                        editing === row.id
                          ? h(
                              'div',
                              { className: 'dshcn-editor' },
                              flow !== null
                                ? h(
                                    React.Fragment,
                                    null,
                                    h('div', { className: 'dshcn-hint' }, t('deviceBody')),
                                    h('div', { className: 'dshcn-code' }, flow.userCode ?? '…'),
                                    h(
                                      'a',
                                      { className: 'dshcn-link', href: flow.verificationUri ?? 'https://github.com/login/device', target: '_blank', rel: 'noreferrer' },
                                      t('deviceOpen'),
                                    ),
                                    h(
                                      'div',
                                      { className: 'dshcn-hint' },
                                      flow.status === 'pending' ? t('devicePending') : flow.status === 'expired' ? t('deviceExpired') : flow.status === 'denied' ? t('deviceDenied') : t('deviceFailed'),
                                    ),
                                  )
                                : h(
                                    React.Fragment,
                                    null,
                                    row.needsUsername
                                      ? h(
                                          'div',
                                          { className: 'dshcn-field' },
                                          h('label', null, t('usernameLabel')),
                                          h('input', { value: username, onChange: (event) => setUsername(event.target.value), autoCapitalize: 'off', spellCheck: false }),
                                        )
                                      : null,
                                    h(
                                      'div',
                                      { className: 'dshcn-field' },
                                      h('label', null, t('tokenLabel')),
                                      h('input', {
                                        type: 'password',
                                        value: token,
                                        placeholder: row.prefix || 'token',
                                        autoCapitalize: 'off',
                                        spellCheck: false,
                                        onChange: (event) => setToken(event.target.value),
                                      }),
                                    ),
                                    row.scopes ? h('div', { className: 'dshcn-hint' }, interpolate(t('scopesHint'), { scopes: row.scopes })) : null,
                                    row.docs
                                      ? h(
                                          'a',
                                          { className: 'dshcn-link', href: row.docs, target: '_blank', rel: 'noreferrer' },
                                          t('docs'),
                                        )
                                      : null,
                                    error !== null ? h('div', { className: 'dshcn-error' }, error) : null,
                                    h(
                                      'div',
                                      { className: 'dshcn-actions', style: { justifyContent: 'flex-start' } },
                                      h('button', { className: 'dshcn-btn primary', disabled: busy, onClick: () => void save(false) }, busy ? t('saving') : t('save')),
                                      error !== null ? h('button', { className: 'dshcn-btn', onClick: () => void save(true) }, t('saveAnyway')) : null,
                                      row.deviceFlow ? h('button', { className: 'dshcn-btn', onClick: () => void beginDevice() }, t('device')) : null,
                                      h(
                                        'button',
                                        {
                                          className: 'dshcn-btn',
                                          onClick: () => {
                                            setEditing(null);
                                            setError(null);
                                            setFlow(null);
                                          },
                                        },
                                        t('cancel'),
                                      ),
                                    ),
                                  ),
                            )
                          : null,
                      ),
                    ),
                ),
              ),
              h('div', { className: 'dshcn-foot' }, t('privacy'), h('br'), `${t('vaultAt')}: ${report.home}`),
            );

        return h('div', { className: 'dshcn-root' }, h('style', null, STYLE), h('div', { className: 'dshcn-head' }, h('div', { className: 'dshcn-title' }, t('title')), h('div', { className: 'dshcn-desc' }, t('description'))), body);
      };
    }

    function apply(ctx) {
      const ConnectorsSection = createSection(ctx);
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }));
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'connectors',
            order: 11,
            label: () => ctx.locale.bind(NS)('nav'),
          },
          ConnectorsSection,
        ),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
