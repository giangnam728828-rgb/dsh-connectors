# dsh-connectors

> 一次连接，处处可用。给 DeepSeek Harness 一个统一的凭据保险库：GitHub、GitLab、Gitee、Vercel、Cloudflare、npm 等平台的令牌只存一次，会话、工具、其他插件都能直接复用。

![手机端连接器页面](docs/screenshot-mobile.png)

## 它解决什么问题

在 DSH 里让 Agent 推代码、发版、查 CI，通常要经历同一套重复劳动：去平台建一个 Token，粘到环境变量或对话里，换个会话或换台设备再粘一次；装了第二个插件，又要配一遍。

这个插件把这件事收敛成三步：**连一次 → 加密存在本机 → 所有调用方复用**。

- **不用每次发令牌**：凭据落在 harness 的状态目录，重启、换会话、换 profile 都还在。
- **令牌不进对话记录**：DSH 的轨迹会记录一切，所以令牌只能从设置页、独立页面或终端输入，永远不经过聊天框。
- **只在对的平台使用**：模型只能指定"平台 + 路径"，域名由插件固定；拿 GitHub 的令牌打不到别的地方去。
- **别的插件能接手**：插件注册了 `connectors` 服务，下一个插件不用再问你要 Token。

## 支持的平台

| 类别 | 平台 | 认证方式 |
| --- | --- | --- |
| 代码托管 | GitHub（支持设备码登录）、GitLab、Gitee | Bearer / PRIVATE-TOKEN / token |
| 部署与托管 | Vercel、Cloudflare、Netlify、Railway | Bearer |
| 包与镜像 | npm、Docker Hub | Bearer / Basic |
| 数据库与后端 | Supabase | Bearer |
| 模型与 AI | Hugging Face、OpenAI、Anthropic | Bearer / x-api-key |
| 设计与文档 | Figma、Notion | X-Figma-Token / Bearer |
| 协作与通知 | Slack | Bearer |

没有内置的平台可以自己加，见[自定义平台](#自定义平台)。

## 安装

```bash
# 从 GitHub 安装（推荐，DSH 内置解析）
dsh plugin --profile web add github:giangnam728828-rgb/dsh-connectors

# 本地目录开发
dsh plugin --profile web add /绝对路径/dsh-connectors

# 从 npm 安装（npm 发布之后可用）
dsh plugin --profile web add dsh-connectors
```

安装后重启 `dsh web`，打开 **设置 → 连接器**。

> 兼容基线：DSH 0.2.1-rc.3 到 0.2.x，Node `^22.19 || >=24`（DSH 自身用到了 `import.meta.main`，更老的 Node 会在启动阶段静默退出）。已在 DSH 0.2.2-rc.5 上验证：插件可加载、配置行可合成、页面与接口可用。

## 连接一个平台

三种入口，按你手边有什么选：

1. **设置页**：`设置 → 连接器`，点"连接"，粘贴令牌。适合电脑端。
2. **独立页面**：浏览器打开 `http://<你的 DSH 地址>/dsh-connectors`。这是为手机准备的，布局按窄屏做的，DSH Go 里也能直接访问。
3. **终端**：手机或服务器上没有顺手的浏览器时用这个。

```bash
# 交互式，输入不回显
npx -y dsh-connectors add github

# 从管道读，不进 shell 历史
echo "$TOKEN" | npx -y dsh-connectors add vercel

# 需要用户名的平台
npx -y dsh-connectors add docker --username 你的DockerID

# 查看 / 删除
npx -y dsh-connectors list
npx -y dsh-connectors remove github
```

保存前会调用平台的身份接口校验一次。令牌写错会当场报错，而不是三轮对话之后突然 401。校验通不了网络时不会强行保存。

### GitHub 设备码登录（可选，免粘贴）

设备码流程不需要回调地址，对手机最友好：页面给你一个八位码，你在任意浏览器里批准，主机自己轮询拿令牌。

它需要一个 GitHub OAuth App 的 **Client ID**（公开信息，不需要 Client Secret）：

1. 打开 <https://github.com/settings/developers> → New OAuth App
2. 勾选 **Enable Device Flow**，回调地址随便填（流程不用它）
3. 把 Client ID 填到独立页面的"设备码登录"里，或设置环境变量：

```bash
export DSH_CONNECTORS_GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
```

## 在对话里怎么用

插件给了 Agent 两个工具，`README` 里写清楚是为了让你能预判它会做什么：

| 工具 | 作用 |
| --- | --- |
| `conn_list` | 列出平台与连接状态。Agent 在向你要令牌之前应该先调它。 |
| `conn_request` | 以已连接账号的身份调用该平台 API。只能传路径，域名由插件补。 |

```text
你：帮我在 GitHub 上建一个私有仓库，把这几个文件推上去
Agent：→ conn_list                 （发现 github 已连接）
       → conn_request POST /user/repos
       → conn_request GET /repos/me/demo/git/ref/heads/main
       → conn_request POST /repos/me/demo/git/blobs …
```

```json
{
  "provider": "github",
  "method": "POST",
  "path": "/repos/octocat/demo/issues",
  "body": { "title": "Build failed on main" }
}
```

返回体里的令牌会被替换成 `[redacted]`；超过 200 KB 的响应只回预览，避免把上下文撑爆。

## 给其他插件复用

这是"连接一次"最关键的一层。任何 host 侧插件都可以直接拿凭据，不必再让用户配一遍：

```js
// 在你的插件里
export const inject = ['connectors'];

export function apply(ctx) {
  ctx.effect(() => {
    const connectors = ctx.get('connectors');
    if (connectors === undefined) return () => {};
    // 需要令牌时
    const token = await connectors.token('github');
    // 或者让 broker 代发请求（推荐，域名与请求头都被约束）
    const result = await connectors.request({ provider: 'github', path: '/user' });
    return () => {};
  });
}
```

服务还提供 `list()`、`credential(id)`、`status(id)` 和 `redact(value, secrets)`。约定只有一条：**令牌值不许进 prompt、不许进工具返回值**。

## git push 不再贴令牌

插件自带一个 git 凭据助手，HTTPS 推送时由它从保险库取令牌：

```bash
# 插件已装在 profile 里时，用 profile 的 bin（最稳，不联网）
git config --global credential.https://github.com.helper \
  '!/绝对路径/profiles/web/node_modules/.bin/dsh-connectors git-credential'

# 或者用 npm 上的包
git config --global credential.https://github.com.helper \
  '!npx --yes dsh-connectors git-credential'

# 验证
git push   # 不再询问用户名密码
```

`git-credential` 只在标准输出写 `username=` / `password=` 两行，日志一律走 stderr，不会破坏 git 的凭据协议。

支持 `github.com`、`gitlab.com`、`gitee.com`。SSH 方式不需要这个。

## 安全模型

说清楚边界，比堆形容词有用：

- **加密落盘**：每条凭据用 AES-256-GCM 单独加密，AAD 绑定平台 id，密文挪到别的平台名下也解不开。主密钥是独立文件，与保险库分开存放。
- **权限**：目录 `0700`，密钥与保险库 `0600`，写入走临时文件 + rename，崩溃不会留下半截文件。
- **位置**：`$DSH_HOME/state/connectors`（或 `$DSH_CONNECTORS_HOME`），不在工作区里，Agent 的沙箱读不到。
- **出站约束**：域名来自平台预设，路径必须以 `/` 开头，`//host` 和绝对 URL 一律拒绝；`authorization`、`cookie`、`x-api-key` 等敏感头不允许调用方覆盖。
- **输入面**：本机回环上的 POST 接口，校验同源 `Origin`，请求体上限 8 KB，页面带 CSP；令牌永远不会回传给浏览器。
- **失败处理**：401/403 只在结果里提示"凭据失效，请重新连接"，不会自动删除一条可能只是权限不足的令牌。
- **断开**：只删除本机凭据，不撤销平台授权。要彻底撤销请去平台设置页。

## 自定义平台

不想等插件更新，就在凭据目录放一个 `providers.json`：

```json
[
  {
    "id": "acme",
    "name": "Acme Cloud",
    "category": "部署与托管",
    "baseUrl": "https://api.acme.example",
    "auth": { "kind": "bearer" },
    "verify": { "path": "/v1/me" },
    "docs": "https://acme.example/tokens",
    "gitHosts": ["git.acme.example"]
  }
]
```

`auth.kind` 支持 `bearer`、`header`（配 `header` / `prefix`）、`basic`（配 `username`）。`baseUrl` 必须是 HTTPS。`verify` 省略则跳过校验。

## 移动端说明

- **DSH Go / 手机本机跑**：设置页可能不可用，用 `http://127.0.0.1:3080/dsh-connectors` 或终端命令；设备码登录比粘贴更适合手机。
- **手机连电脑**：走 DSH Mobile / ds-harness-remote 时，独立页面同样可用，凭据保存在电脑那台机器上。
- **两边都要用**：两个 harness 各自保存一份。想共用一个目录，把 `DSH_CONNECTORS_HOME` 指到同步盘（注意同步盘的权限与备份策略）。

## 已知限制

- GitHub 设备码登录需要你自备 OAuth App Client ID；插件不内置别人的应用凭据。
- 目前只支持长期令牌，不做 OAuth 刷新令牌轮换。
- `conn_request` 是通用 REST 通道，不封装各平台的特殊协议（GraphQL 平台按原样 POST 即可）。
- DSH 还在开发者预览期，升级大版本前请先看 `engines.dsh` 是否仍然匹配。

## 开发

```bash
npm test        # 22 个单元测试：保险库、加密边界、URL 约束、脱敏、接口
npm run check   # 语法检查
```

目录：

```
index.js          主机侧：接口、工具、connectors 服务
src/providers.js  平台预设与出站约束
src/vault.js      AES-256-GCM 保险库
src/actions.js    连接、校验、代发请求、设备码
src/page.js       独立页面（内联 CSS/JS，无外部依赖）
client.js         设置页分区
bin/              命令行与 git 凭据助手
```

## 发布到插件市场

1. 仓库加 topic `dsh-plugin`
2. `package.json` 已声明 `dsh.bundle`，`files` 里包含 `cordis.patch.yml`
3. README 里保留安装命令、权限说明、兼容版本
4. 建议在 README 顶部写清"令牌如何存储、会发往哪些域名"

## License

MIT
