# dsh-connectors

> Connect once, use everywhere. One credential vault for DeepSeek Harness: store a GitHub, GitLab, Gitee, Vercel, Cloudflare or npm token once, and every session, tool and plugin can reuse it.

## Why

Connecting an agent to a platform usually means the same loop: create a token, paste it into an environment variable or a chat message, then paste it again in the next session or on the next device. A second plugin means configuring it all over again.

This plugin collapses that into: **connect once, encrypt locally, let every caller reuse it**.

- Tokens survive restarts, new sessions and profile switches.
- Tokens never travel through chat: DSH records everything in its trajectory, so the only input paths are the settings page, the standalone page, or a terminal.
- Tokens can only be spent at their own platform: the model names a provider and a path, the host is fixed by the preset.
- Other plugins reuse the connection through a `connectors` Cordis service.
- On DSH Go the phone shows a native "Connectors" panel and an "N connected" strip — authorised platforms only, no web page involved.

## Supported platforms

GitHub (with optional device-code sign-in), GitLab, Gitee, Vercel, Cloudflare, Netlify, Railway, npm, Docker Hub, Supabase, Hugging Face, OpenAI, Anthropic, Figma, Notion, Slack.

Add your own through `providers.json` in the vault directory.

## Install

```bash
dsh plugin --profile web add github:giangnam728828-rgb/dsh-connectors
# or a local checkout
dsh plugin --profile web add /absolute/path/dsh-connectors
```

Then restart `dsh web` and open **Settings → Connectors**.

Compatibility: DSH 0.2.1-rc.3 – 0.2.x, Node `^22.19 || >=24`. Verified against DSH 0.2.2-rc.5.

### Carrier matrix

The npm distribution ships five profile templates (`acp` / `web` / `headless` / `sdk` / `sdk-minimal`). **The desktop client is not one of them**: it is a separately distributed Electron app with its own stable/nightly channel, and it serves the frontend over `file://` plus IPC without starting `webServer` — the type comment in `@deepseek-ai/dsh-host-webserver` says exactly that: *"Electron uses file:// plus IPC"*. The plugin attaches each surface only where its service exists.

| Carrier | Profile | `/connectors` command | `conn_list` / `conn_request` | `connectors` service | `/api/connectors/*` | `/dsh-connectors` page | Settings section |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browser | `web` | yes | yes, measured | yes, measured | yes, measured | yes, measured | yes |
| DSHA (full DSH on an Android phone) | `web` (`dsh-web-mobile`) | yes | yes | yes | yes | yes (WebView) | yes (fixed in 0.3.1) |
| Desktop client (Electron) | separate | yes | expected | expected | expected (carrier-neutral) | absent (no `webServer`) | yes (same client bundle) |
| Other WebView shells (Tauri, etc.) | `web` | yes | expected | expected | depends on `webServer` | same | yes (deps completed) |
| DSH Go (Android / iOS) | in-app engine | yes | expected | expected | through the app's `/dsh-go/v1` bridge | not rendered (native UI) | not rendered (native panel instead) |
| Editor ACP client | `acp` | yes | yes, measured | yes, measured | — | — | — |
| One-shot script | `headless` | yes | yes, measured | yes, measured | — | — | — |
| SDK embedding | `sdk` | depends on command palette | config composes, not run | same | — | — | — |
| Minimal SDK | `sdk-minimal` | n/a | n/a (no `tools`) | n/a | — | — | — |

**DSH Go's UI is not a web page.** The app does not render `/dsh-connectors` and does not run plugin frontend code; it reads the `dshGo` manifest in `package.json`, and the host half feeds the slot through `ctx.dshGo`, so the app draws it with its own widgets. Since 0.3.0 the plugin declares one native "Connectors" panel and one status strip — see [DSH Go native panel](#dsh-go-native-panel). The rest of that row says "expected" because this round had no Android device; the protocol layer was checked with dsh-go's own `plugin-kit` checker and test host (`test/dshgo.test.mjs`).

The desktop row says "expected", not "measured": this repository has no desktop binary to run in CI. The code no longer hard-depends on `webServer`, and `/api` routes go through the carrier-neutral fetch registry, so an IPC carrier should dispatch them too; confirming that needs one install of the desktop client and a `dsh plugin --profile <name> list` to learn its profile name. **The desktop client has no standalone page** — its entry point is the settings section.

`—` means the carrier has no `connection` or `webServer` service at all, not that the plugin is missing. `inject` hard-depends on `tools` only (the agent core service, always present via `dsh-base`); `connection` and `webServer` are mounted on demand, so a shell without an HTTP layer keeps the tools and the service and simply has no page.

### Universal entry point: the `/connectors` command

**This is the "installed, therefore visible" fallback.** The settings section needs `@deepseek-ai/dsh-client-ui-slots`, the standalone page needs `webServer`, and the mobile panel needs `dsh-go-bridge` — any of these may be absent in the client you happen to use. But the `commands` service is mounted by `dsh-base`, so every client that can chat has it. Just type into the composer:

```
/connectors              # what is connected now, and as whom
/connectors help         # the full guide to all connect methods
/connectors github       # how to connect one platform, with a copy-paste command
```

The command is read-only: it reports state and tells you where to connect. It never writes a token into the conversation. The actual connect still happens in the settings page or the terminal. So even on a client that renders no web panel at all, there is always one visible, actionable entry point.

> 0.3.1 fixed a real "installed and activated but nothing showed up" defect: the client bundle's `dsh.client.inject` declared only `dsh-client-ui-settings-general`, while the settings section actually needs `dsh-client-ui-slots` and `dsh-client-locale`. With the wrong declaration the slots service was never loaded first and the section silently failed to register — the plugin looked enabled but offered no UI. It now declares the same service set as DSHA's own visible plugins (see `test/client-manifest.test.mjs`).

## Connect

1. **Settings → Connectors** for the desktop, DSHA and WebView clients.
2. **The `/connectors` command** — type `/connectors help` in any client that can chat and follow the guide. The guaranteed fallback.
3. **`http://<harness>/dsh-connectors`** for a narrow-screen page that works from a phone browser or a tunnel. It shares the app's session: an unauthenticated request gets **401**, so open the harness first.
4. **DSH Go's native panel**, once the dsh-go bridge is installed: All features, the plugin detail page and a chat's Plugins tab show "Connectors" with the platforms that are already authorised. Authorising still happens in the settings page or the terminal.
5. **Terminal**, when there is no comfortable browser:

```bash
npx -y dsh-connectors add github          # hidden input
echo "$TOKEN" | npx -y dsh-connectors add vercel
npx -y dsh-connectors list
```

Each token is verified against the platform's identity endpoint before it is stored. Verify failures are reported immediately, and a network failure never silently discards the token.

### DSH Go native panel

DSH Go does not run plugin frontend code and never opens `/dsh-connectors`. At install time it reads the `dshGo` manifest from `package.json`; the host half pushes the panel through `ctx.dshGo.panel()`, and the app draws it with native widgets, sending taps back as JSON actions. The plugin declares two surfaces:

| Surface | When it appears | What it shows |
| --- | --- | --- |
| `panels` → "Connectors" | All features, plugin detail, chat details › Plugins | Authorised platforms: name, account, last four characters of the token; the connected count on top |
| `composer.strip` | Above the composer, **only when at least one platform is connected** | "3 connected"; tapping opens the same panel |

Five boundaries, all deliberate:

- **Read-only.** The panel makes no requests and changes no credential; *Refresh* re-reads the local vault, *Copy* puts the same list on the clipboard. Adding and removing credentials stays in the settings page, the standalone page or the terminal.
- **No token in sight.** The data comes from the `project()` projection only: login, display name, `••••` plus the last four characters. The full secret never enters a view, a log or a conversation.
- **Follows changes within 2 s.** While the panel is open it watches `vault.json`: `add` a platform in a terminal and the list updates without reopening the app.
- **Disappears without the bridge.** The `ctx.inject(['dshGo'])` callback runs only where the dsh-go bridge is installed; the browser, desktop, ACP and headless carriers are unchanged.
- **No app code.** The `dshGo` manifest only applies to the app; the web build keeps using the settings page.

How it was checked: the manifest, the view and the host registrations were run through dsh-go's own `sdk/plugin-kit` checker and test host (`node sdk/plugin-kit/bin/check.mjs <plugin dir> --load` reports one displayable strip and one displayable panel, and all six placement × locale combinations pass). **A physical device has not been tested**: this round had no Android device, so rendering details and app-version differences remain to be confirmed on hardware; the protocol layer is aligned with v1.

### GitHub device flow

Set a public OAuth App client id (no client secret, no callback URL):

```bash
export DSH_CONNECTORS_GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
```

Enable **Device Flow** on the OAuth App, then use "Sign in with device code" on the standalone page. This is the most comfortable path on a phone.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `conn_list` | Lists providers and connection state. The agent calls this before asking for a token. |
| `conn_request` | Calls a platform API as the connected account. Path only; the host comes from the preset. |

Responses are scanned for the stored token and for token-shaped strings, which are replaced with `[redacted]`. Responses over 200 KB are truncated to a preview.

## Reuse from another plugin

```js
export const inject = ['connectors'];

export function apply(ctx) {
  const connectors = ctx.get('connectors');
  // Recommended: the broker enforces origin and headers.
  const result = await connectors.request({ provider: 'github', path: '/user' });
}
```

The service has three tiers:

| Capability | Methods | Default |
| --- | --- | --- |
| Connection state | `list()`, `status(id)`, `capabilities()` | allowed, no secret |
| Constrained request | `request({ provider, method, path, query, body })` | allowed, token never returned |
| Raw credential | `credential(id)`, `token(id)` | **refused** with `raw-credentials-not-granted` |

A plugin that genuinely needs the secret must be granted it by the user:
`npx -y dsh-connectors allow-raw on`, then `allow-raw off` when done.

One rule: a token value must never enter a prompt or a tool result.

## git push without a token

```bash
git config --global credential.https://github.com.helper \
  '!npx -y dsh-connectors git-credential'
```

Supports `github.com`, `gitlab.com` and `gitee.com`.

## Security model

- AES-256-GCM per record, AAD bound to the provider id; separate 0600 key file.
- Vault directory `0700`, files `0600`, atomic writes.
- Stored outside the workspace: `$DSH_HOME/state/connectors` or `$DSH_CONNECTORS_HOME`.
- Outbound requests are pinned to the preset origin; `//host`, absolute URLs and reserved credential headers are rejected.
- Management routes live under the harness `/api/connectors/*` surface and inherit its Host/Origin fence, `SameSite=Strict` signed session cookie and owner-principal check. Unauthenticated requests get 401, cross-site requests get 403. The plugin no longer compares `Origin` itself, so reverse-proxied access is not misjudged; a proxy authority must be declared with `--trusted-host` on the harness side.
- POST only, streamed 8 KB request-body cap, CSP on the page; the token is never returned to the browser.
- Other plugins never receive the raw token by default.
- Encryption covers backups, stray `cat` and other OS users. It does **not** stop a hostile program running as your account: the key and the ciphertext share one machine and one user.
- Disconnecting deletes the local credential only; revoke the authorization on the platform if you want it gone everywhere.

## Limitations

- Device sign-in needs your own GitHub OAuth App client id.
- Long-lived tokens only; no refresh-token rotation.
- `conn_request` is a generic REST channel, not a per-platform SDK.
- DSH is in developer preview; check `engines.dsh` before a major upgrade.

## License

MIT
