/**
 * The standalone connector page.
 *
 * It exists because a phone is not always inside the settings UI: DSH Go, a
 * remote host, or a plain browser tab can all reach `/dsh-connectors` and get
 * the same list. The page is one file with inline CSS and JS on purpose - no
 * build step, no CDN, nothing that a sandboxed phone browser has to fetch
 * before it can show a token field.
 */

/**
 * Render the page.
 * @param options - providers and per-provider OAuth client ids.
 * @returns a complete HTML document.
 */
export function renderPage({ providers, clientIds }) {
  const data = JSON.stringify({ providers, clientIds }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>DSH 连接器</title>
<style>
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #14161a;
  --muted: #6b7280;
  --line: #e5e7eb;
  --accent: #2f6fed;
  --accent-soft: rgba(47, 111, 237, 0.1);
  --ok: #17a673;
  --warn: #c2410c;
  --radius: 16px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1014;
    --panel: #171a20;
    --text: #e8eaee;
    --muted: #9aa3b2;
    --line: #262b34;
    --accent: #5b8dff;
    --accent-soft: rgba(91, 141, 255, 0.16);
    --ok: #34d399;
    --warn: #fb923c;
  }
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body {
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  padding: 0 16px calc(48px + env(safe-area-inset-bottom));
}
header {
  position: sticky; top: 0; z-index: 5;
  margin: 0 -16px; padding: calc(14px + env(safe-area-inset-top)) 16px 12px;
  background: var(--bg);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: saturate(140%) blur(12px);
  border-bottom: 1px solid var(--line);
}
h1 { margin: 0; font-size: 19px; letter-spacing: -0.01em; }
header p { margin: 4px 0 0; color: var(--muted); font-size: 12.5px; }
.summary { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }
.pill.dim { background: transparent; color: var(--muted); border: 1px solid var(--line); }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 26px 0 10px; }
.grid { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 620px) { .grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0;
}
.card-top { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.avatar {
  width: 38px; height: 38px; border-radius: 11px; flex: 0 0 auto;
  display: grid; place-items: center; font-weight: 650; font-size: 15px;
  background: var(--accent-soft); color: var(--accent); overflow: hidden;
}
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.names { min-width: 0; flex: 1; }
.names b { display: block; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.names span { display: block; color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; flex: 0 0 auto; }
.state.on { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button {
  font: inherit; font-size: 13.5px; padding: 9px 14px; border-radius: 11px; cursor: pointer;
  border: 1px solid var(--line); background: transparent; color: var(--text);
  min-height: 40px;
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.ghost { color: var(--muted); }
button.danger { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
button:disabled { opacity: 0.5; }
.hint { color: var(--muted); font-size: 12px; }
a { color: var(--accent); text-decoration: none; }
.sheet-wrap {
  position: fixed; inset: 0; z-index: 20; display: none;
  background: rgba(8, 10, 14, 0.55); backdrop-filter: blur(3px);
  align-items: flex-end; justify-content: center; padding: 0;
}
.sheet-wrap.open { display: flex; }
.sheet {
  width: 100%; max-width: 520px; background: var(--panel); border-radius: 20px 20px 0 0;
  padding: 18px 18px calc(20px + env(safe-area-inset-bottom));
  max-height: 90vh; overflow: auto;
  animation: rise 180ms ease-out;
}
@media (min-width: 620px) {
  .sheet-wrap { align-items: center; padding: 24px; }
  .sheet { border-radius: 20px; }
}
@keyframes rise { from { transform: translateY(16px); opacity: 0.6; } to { transform: none; opacity: 1; } }
.sheet h3 { margin: 0 0 4px; font-size: 17px; }
.sheet .sub { color: var(--muted); font-size: 12.5px; margin: 0 0 16px; }
label { display: block; font-size: 12.5px; color: var(--muted); margin: 12px 0 6px; }
input {
  width: 100%; font: inherit; font-size: 16px; padding: 11px 12px; border-radius: 11px;
  border: 1px solid var(--line); background: var(--bg); color: var(--text);
  -webkit-appearance: none;
}
input:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
.sheet .row { margin-top: 18px; }
.error { color: var(--warn); font-size: 13px; margin-top: 12px; white-space: pre-wrap; }
.okline { color: var(--ok); font-size: 13px; margin-top: 12px; }
.device { margin-top: 14px; padding: 14px; border: 1px dashed var(--line); border-radius: 12px; }
.code {
  font: 600 26px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.12em;
  margin: 8px 0; user-select: all;
}
footer { margin-top: 32px; color: var(--muted); font-size: 11.5px; line-height: 1.7; }
footer code { font-size: 11px; background: var(--accent-soft); padding: 1px 5px; border-radius: 5px; }
.toast {
  position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%);
  background: var(--text); color: var(--bg); font-size: 13px; padding: 9px 16px; border-radius: 999px;
  opacity: 0; transition: opacity 160ms; pointer-events: none; z-index: 40; max-width: 86vw;
}
.toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1>连接器</h1>
  <p>一次连接，之后每个会话、每个插件都能直接用。</p>
  <div class="summary" id="summary"></div>
</header>
<main id="app"><p class="hint" style="margin-top:24px">正在读取连接状态…</p></main>
<footer>
  凭据以 AES-256-GCM 加密保存在本机 <code>state/connectors</code>，权限 0600。
  令牌只在主机进程内使用，页面和对话记录都看不到它。断开连接只删除本机凭据，不会撤销平台上的授权。
</footer>
<div class="sheet-wrap" id="sheetWrap" aria-hidden="true">
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <h3 id="sheetTitle"></h3>
    <p class="sub" id="sheetSub"></p>
    <div id="sheetBody"></div>
    <div class="error" id="sheetError" hidden></div>
    <div class="row">
      <button class="primary" id="sheetSubmit">保存</button>
      <button class="ghost" id="sheetCancel">取消</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(function () {
  'use strict';
  var BOOT = ${data};
  var state = { providers: BOOT.providers, clientIds: BOOT.clientIds, status: null, active: null, flow: null, timer: null };

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'bad-response' }; });
    });
  }
  function toast(message) {
    var node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    setTimeout(function () { node.classList.remove('show'); }, 2200);
  }
  function formatDate(value) {
    if (!value) return '';
    try { return new Date(value).toLocaleDateString(); } catch (e) { return ''; }
  }
  function providerOf(id) {
    for (var i = 0; i < state.providers.length; i++) if (state.providers[i].id === id) return state.providers[i];
    return null;
  }

  function render() {
    var rows = state.status && state.status.providers ? state.status.providers : state.providers.map(function (p) {
      return Object.assign({}, p, { connected: false });
    });
    var connected = rows.filter(function (row) { return row.connected; }).length;
    $('summary').innerHTML =
      '<span class="pill">' + connected + ' / ' + rows.length + ' 已连接</span>' +
      '<span class="pill dim">凭据不出本机</span>';

    var categories = [];
    rows.forEach(function (row) {
      if (categories.indexOf(row.category) === -1) categories.push(row.category);
    });
    var html = categories.map(function (category) {
      var cards = rows.filter(function (row) { return row.category === category; }).map(card);
      return '<h2>' + esc(category) + '</h2><div class="grid">' + cards.join('') + '</div>';
    }).join('');
    $('app').innerHTML = html || '<p class="hint">没有可用的平台。</p>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (node) {
      node.addEventListener('click', function () {
        var action = node.getAttribute('data-action');
        var id = node.getAttribute('data-provider');
        if (action === 'connect') openConnect(id);
        if (action === 'device') openDevice(id);
        if (action === 'disconnect') doDisconnect(id);
      });
    });
  }

  function card(row) {
    var initial = (row.name || row.id || '?').slice(0, 1).toUpperCase();
    var avatar = row.avatarUrl
      ? '<img src="' + esc(row.avatarUrl) + '" alt="">'
      : esc(initial);
    var who = row.connected
      ? (row.login ? '@' + esc(row.login) : (row.username ? esc(row.username) : '已连接'))
      : (row.scopes ? esc(row.scopes) : '未连接');
    var when = row.connected && row.connectedAt ? ' · ' + formatDate(row.connectedAt) : '';
    return '' +
      '<div class="card">' +
        '<div class="card-top">' +
          '<div class="avatar">' + avatar + '</div>' +
          '<div class="names"><b>' + esc(row.name) + '</b><span>' + who + when + '</span></div>' +
          '<span class="state' + (row.connected ? ' on' : '') + '">' + (row.connected ? '已连接' : '未连接') + '</span>' +
        '</div>' +
        '<div class="row">' +
          '<button class="' + (row.connected ? '' : 'primary') + '" data-action="connect" data-provider="' + esc(row.id) + '">' +
            (row.connected ? '更换令牌' : '连接') +
          '</button>' +
          (row.deviceFlow ? '<button data-action="device" data-provider="' + esc(row.id) + '">设备码登录</button>' : '') +
          (row.connected ? '<button class="danger" data-action="disconnect" data-provider="' + esc(row.id) + '">断开</button>' : '') +
        '</div>' +
        (row.docs ? '<div class="hint">令牌在 <a href="' + esc(row.docs) + '" target="_blank" rel="noreferrer">平台设置</a> 创建' + (row.prefix ? '，通常以 ' + esc(row.prefix) + ' 开头' : '') + '。</div>' : '') +
      '</div>';
  }

  function openSheet(title, sub, bodyHtml) {
    $('sheetTitle').textContent = title;
    $('sheetSub').textContent = sub;
    $('sheetBody').innerHTML = bodyHtml;
    $('sheetSubmit').hidden = false;
    $('sheetSubmit').disabled = false;
    $('sheetSubmit').textContent = '保存';
    $('sheetError').hidden = true;
    $('sheetError').textContent = '';
    $('sheetWrap').classList.add('open');
    $('sheetWrap').setAttribute('aria-hidden', 'false');
  }
  function closeSheet() {
    $('sheetWrap').classList.remove('open');
    $('sheetWrap').setAttribute('aria-hidden', 'true');
    state.active = null;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function openConnect(id) {
    var row = providerOf(id);
    if (!row) return;
    state.active = id;
    var extra = row.needsUsername
      ? '<label for="username">用户名（Docker ID）</label><input id="username" autocomplete="username" autocapitalize="off" spellcheck="false">'
      : '';
    openSheet(
      (row.connected ? '更换 ' : '连接 ') + row.name,
      '把令牌粘贴到这里。它只写入本机加密库，不会进入对话记录。',
      extra +
      '<label for="token">访问令牌</label>' +
      '<input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(row.prefix || 'token') + '">' +
      (row.scopes ? '<div class="hint" style="margin-top:8px">建议权限：' + esc(row.scopes) + '</div>' : '') +
      (row.deviceFlow && !state.clientIds[id] ? '<div class="hint" style="margin-top:8px">想免令牌登录？先在这个页面填入 OAuth App Client ID（可在 <a href="' + esc(row.docs) + '" target="_blank" rel="noreferrer">平台设置</a> 创建）。</div>' : '')
    );
    $('sheetSubmit').onclick = function () { submitToken(id); };
    setTimeout(function () {
      var input = $('token');
      if (input) input.focus();
    }, 60);
  }

  function submitToken(id) {
    var row = providerOf(id);
    var tokenInput = $('token');
    var token = tokenInput ? tokenInput.value.trim() : '';
    if (token === '') { showError('请先粘贴令牌。'); return; }
    var usernameInput = $('username');
    var payload = { provider: id, token: token };
    if (usernameInput && usernameInput.value.trim() !== '') payload.username = usernameInput.value.trim();
    var button = $('sheetSubmit');
    button.disabled = true;
    button.textContent = '校验中…';
    post('/dsh-connectors/connect', payload).then(function (result) {
      button.disabled = false;
      button.textContent = '保存';
      if (!result.ok) {
        showError(describeError(result));
        if (result.error === 'verify-failed' && row && row.verifiable) offerSkip(payload);
        return;
      }
      toast(row.name + ' 已连接');
      closeSheet();
      refresh();
    });
    function offerSkip(base) {
      var node = $('sheetError');
      var button = document.createElement('button');
      button.className = 'ghost';
      button.style.marginTop = '10px';
      button.textContent = '仍然保存（稍后自行验证）';
      button.onclick = function () {
        post('/dsh-connectors/connect', Object.assign({}, base, { skipVerify: true })).then(function (result) {
          if (result.ok) { toast('已保存，但平台未确认这个令牌'); closeSheet(); refresh(); }
          else showError(describeError(result));
        });
      };
      node.appendChild(button);
    }
  }

  function openDevice(id) {
    var row = providerOf(id);
    if (!row) return;
    if (!state.clientIds[id]) { openClientId(id); return; }
    state.active = id;
    openSheet('用 GitHub 登录', '在手机浏览器里打开下面的地址，输入代码即可。这个页面会自动完成连接。', '<div class="device"><div class="hint">待批准</div><div class="code" id="userCode">…</div></div>');
    $('sheetSubmit').hidden = true;
    post('/dsh-connectors/device/start', { provider: id }).then(function (result) {
      if (!result.ok || !result.flow) { showError(describeError(result)); return; }
      state.flow = result.flow;
      renderFlow(result.flow);
      state.timer = setInterval(pollFlow, 3000);
      pollFlow();
    });
  }

  function renderFlow(flow) {
    var codeNode = $('userCode');
    if (!codeNode || !flow) return;
    codeNode.textContent = flow.userCode || '…';
    var link = '<div style="margin-top:10px"><a href="' + esc(flow.verificationUri || 'https://github.com/login/device') + '" target="_blank" rel="noreferrer">打开授权页面</a></div>';
    var statusText = {
      pending: '等待你在浏览器里批准…',
      expired: '代码已过期，请重新开始。',
      denied: '你取消了授权。',
      error: '授权失败，请改用令牌方式。'
    }[flow.status] || flow.status;
    $('sheetSub').innerHTML = esc(statusText) + link;
  }

  function pollFlow() {
    if (!state.active) return;
    post('/dsh-connectors/device/poll', { provider: state.active }).then(function (result) {
      if (!result.ok) return;
      if (!result.flow) {
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
        toast('已通过 GitHub 登录');
        closeSheet();
        refresh();
        return;
      }
      renderFlow(result.flow);
    });
  }

  function openClientId(id) {
    var row = providerOf(id);
    state.active = id;
    openSheet('OAuth App Client ID', '设备码登录只需要一个公开的 Client ID，不需要 Client Secret。', '<label for="clientId">Client ID</label><input id="clientId" autocapitalize="off" spellcheck="false" placeholder="Iv1.0123456789abcdef">');
    $('sheetSubmit').onclick = function () {
      var value = ($('clientId').value || '').trim();
      post('/dsh-connectors/settings', { provider: id, clientId: value }).then(function (result) {
        if (!result.ok) { showError(describeError(result)); return; }
        state.clientIds[id] = value;
        toast('已保存 Client ID');
        closeSheet();
        refresh();
      });
    };
  }

  function doDisconnect(id) {
    var row = providerOf(id);
    if (!row) return;
    if (!window.confirm('断开 ' + row.name + '？本机凭据会被删除，平台上的授权仍然保留。')) return;
    post('/dsh-connectors/disconnect', { provider: id }).then(function (result) {
      if (!result.ok) { toast(describeError(result)); return; }
      toast('已断开 ' + row.name);
      refresh();
    });
  }

  function describeError(result) {
    var map = {
      'token-required': '请先粘贴令牌。',
      'username-required': '这个平台还需要用户名。',
      'unknown-provider': '未知的平台。',
      'verify-failed': '平台拒绝了这个令牌：' + (result.message || '请检查权限和是否复制完整。'),
      'verify-unreachable': '连不上平台，令牌没有保存。检查网络后重试。',
      'client-id-missing': '还没有配置 Client ID。',
      'client-id-rejected': '平台不认识这个 Client ID。',
      'device-flow-disabled': '这个 OAuth App 没有开启设备码登录。',
      'network': '网络异常，请重试。',
      'cross-origin': '请求来源不被信任。',
      'internal': '插件内部错误，请看 DSH 日志。'
    };
    if (map[result.error]) return map[result.error];
    return result.message || result.error || '操作失败。';
  }

  function showError(message) {
    var node = $('sheetError');
    node.hidden = false;
    node.textContent = message;
  }

  function refresh() {
    return post('/dsh-connectors/status', {}).then(function (result) {
      if (result.ok) state.status = result;
      render();
    });
  }

  $('sheetCancel').onclick = closeSheet;
  $('sheetWrap').addEventListener('click', function (event) {
    if (event.target === $('sheetWrap')) closeSheet();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeSheet();
  });

  render();
  refresh();
})();
</script>
</body>
</html>`;
}
