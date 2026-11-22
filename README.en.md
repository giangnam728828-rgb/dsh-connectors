# dsh-connectors

> Connect once, use everywhere. One credential vault for DeepSeek Harness: store a GitHub, GitLab, Gitee, Vercel, Cloudflare or npm token once, and every session, tool and plugin can reuse it.

## Why

Connecting an agent to a platform usually means the same loop: create a token, paste it into an environment variable or a chat message, then paste it again in the next session or on the next device. A second plugin means configuring it all over again.

This plugin collapses that into: **connect once, encrypt locally, let every caller reuse it**.

- Tokens survive restarts, new sessions and profile switches.
- Tokens never travel through chat: DSH records everything in its trajectory, so the only input paths are the settings page, the standalone page, or a terminal.
- Tokens can only be spent at their own platform: the model names a provider and a path, the host is fixed by the preset.
- Other plugins reuse the connection through a `connectors` Cordis service.

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

## Connect

1. **Settings → Connectors** for the desktop UI.
2. **`http://<harness>/dsh-connectors`** for a mobile-friendly page that also works from DSH Go and remote hosts.
3. **Terminal**, when there is no comfortable browser:

```bash
npx -y dsh-connectors add github          # hidden input
echo "$TOKEN" | npx -y dsh-connectors add vercel
npx -y dsh-connectors list
```

Each token is verified against the platform's identity endpoint before it is stored. Verify failures are reported immediately, and a network failure never silently discards the token.

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
  // Or, for host-side code that needs the value itself:
  const token = await connectors.token('github');
}
```

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
- Loopback POST endpoints only, same-origin checked, 8 KB body cap, CSP on the page; the token is never returned to the browser.
- Disconnecting deletes the local credential only; revoke the authorization on the platform if you want it gone everywhere.

## Limitations

- Device sign-in needs your own GitHub OAuth App client id.
- Long-lived tokens only; no refresh-token rotation.
- `conn_request` is a generic REST channel, not a per-platform SDK.
- DSH is in developer preview; check `engines.dsh` before a major upgrade.

## License

MIT
