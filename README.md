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
- **手机上看得见**：DSH Go 有原生「连接器」面板与「N 个已连接」状态条，只列已授权的平台，不需要网页。

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

> 兼容基线：DSH 0.2.1-rc.3 到 0.2.x，Node `^22.19 || >=24`（DSH 自身用到了 `import.meta.main` 和 `zlib` 的 zstd 导出，更老的 Node 会在启动阶段静默退出）。逐项实测见下表。

### 载体兼容矩阵

官方的 npm 发行版只有五种 profile 模板（`acp` / `web` / `headless` / `sdk` / `sdk-minimal`），**桌面客户端不在这五种里**：它是独立分发的 Electron 应用，自带 stable/nightly 更新通道，用 `file://` 加 IPC 提供前端而不启动 `webServer`（`@deepseek-ai/dsh-host-webserver` 的类型注释原文："Electron uses file:// plus IPC"）。插件按服务存在与否分面挂载，每种载体拿到的功能如下：

| 载体 | profile | 工具 `conn_list` / `conn_request` | `connectors` 服务 | `/api/connectors/*` | `/dsh-connectors` 页面 | 设置页 |
| --- | --- | --- | --- | --- | --- | --- |
| 浏览器 | `web` | ✅ 实测 | ✅ 实测 | ✅ 实测 | ✅ 实测 | ✅ |
| 桌面客户端（Electron） | 独立分发 | 预期可用 | 预期可用 | 预期可用（carrier-neutral） | 不存在（无 `webServer`） | ✅（同一套客户端 bundle） |
| DSH Go（Android / iOS） | App 内置引擎 | 预期可用 | 预期可用 | 走 App 的 `/dsh-go/v1` 桥接 | 不渲染（原生界面） | 不渲染（改用原生面板） |
| 编辑器 ACP 客户端 | `acp` | ✅ 实测 | ✅ 实测 | — | — | — |
| 一次性脚本 | `headless` | ✅ 实测 | ✅ 实测 | — | — | — |
| SDK 嵌入 | `sdk` | 配置可合成，运行未实测 | 同左 | — | — | — |
| 极简 SDK | `sdk-minimal` | 不适用（无 `tools`） | 不适用 | — | — | — |

**DSH Go 的界面不是网页。** App 不渲染 `/dsh-connectors`，也不运行插件前端；它读 `package.json` 里的 `dshGo` 清单，宿主半侧通过 `ctx.dshGo` 提供视图与数据，App 用自己的组件画。0.3.0 起插件声明一个「连接器」原生面板和一条状态条，见[DSH Go 原生面板](#dsh-go-原生面板)。DSH Go 一行的其余各列标"预期"，因为这一轮没有 Android 设备可跑真机；协议层用 dsh-go 自带的 `plugin-kit` 检查器和测试宿主验证过（见 `test/dshgo.test.mjs`）。

桌面客户端一栏标"预期"而不是"实测"：本仓库没有它的二进制，无法在 CI 里跑。代码层面已经去掉了对 `webServer` 的硬依赖，`/api` 路由走的是 carrier-neutral 的 fetch registry，所以 IPC 载具理论上同样能分发；这一点需要装一次桌面客户端用 `dsh plugin --profile <名> list` 确认 profile 名后才能定论。**桌面端没有独立页面**，管理入口是设置页。

"`—`"表示该载体本身没有 `connection` 或 `webServer` 服务，不是插件缺失。插件的 `inject` 只硬依赖 `tools`（DSH 的 agent 核心服务，`dsh-base` 必带）；`connection` 和 `webServer` 都是按需挂载，所以在没有 HTTP 层的 shell 里，工具和服务照常可用，页面与接口则不存在。

## 连接一个平台

三种入口，按你手边有什么选：

1. **设置页**：`设置 → 连接器`，点"连接"，粘贴令牌。适合电脑端。
2. **独立页面**：浏览器打开 `http://<你的 DSH 地址>/dsh-connectors`。布局按窄屏做的，适合手机浏览器和隧道访问；它和主界面共用同一个登录态，**未登录会返回 401**，需要先打开 DSH 主界面完成登录。
3. **终端**：手机或服务器上没有顺手的浏览器时用这个。
4. **DSH Go 原生面板**：装好 dsh-go bridge 后，App 的「全部功能」、插件详情、对话详情 ›「插件」里会出现「连接器」，只列已授权的平台。授权动作仍在设置页或终端完成。

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

### DSH Go 原生面板

DSH Go 不运行插件前端，也不打开 `/dsh-connectors`。它在安装时读 `package.json` 的 `dshGo` 清单，面板的内容由宿主半侧的 `ctx.dshGo.panel()` 推送；App 用原生组件画，交互以 JSON 动作回传。插件声明了两个位置：

| 位置 | 什么时候出现 | 内容 |
| --- | --- | --- |
| `panels` →「连接器」 | 全部功能、插件详情、对话详情 ›「插件」 | 已授权的平台列表：平台名、账号、令牌尾四位；顶部是已连接数量 |
| `composer.strip` | 输入框上方，**只在至少一个平台已连接时出现** | 「3 个已连接」，点开是同一个面板 |

几条边界，都是刻意的：

- **只读**。面板不发请求、不改凭据；"刷新"重新读一次本机保险库，"复制"把同一份列表放进剪贴板。添加和删除凭据仍在设置页、独立页面或终端完成。
- **看不见令牌**。数据只取自 `project()` 的投影：登录名、显示名、`••••` 加末四位。完整令牌不会进入视图、日志或对话。
- **2 秒内跟随变化**。面板打开时监听 `vault.json`：在终端 `add` 一个平台，列表会自己更新，不用重开 App。
- **没有 bridge 就完全消失**。`ctx.inject(['dshGo'])` 回调只在装有 dsh-go bridge 的主机上执行；浏览器、桌面、ACP、headless 四个载体行为不变。
- **不写 App 代码**。`dshGo` 清单只对 App 生效，网页版继续用设置页。

验证方式：清单、视图与宿主注册用 dsh-go 仓库自带的 `sdk/plugin-kit` 检查器与测试宿主跑过（`node sdk/plugin-kit/bin/check.mjs <插件目录> --load` 输出「原生界面能显示（状态条 1 · 面板 1）」，6 种 placement × locale 组合均「能显示」）。**真机尚未验证**：这一轮没有 Android 设备，App 版本差异与渲染细节以真机为准，协议层已按 v1 对齐。

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

这是"连接一次"最关键的一层。其他插件不需要再问用户要一遍令牌：

```js
export const inject = ['connectors'];

export function apply(ctx) {
  ctx.effect(() => {
    const connectors = ctx.get('connectors');
    if (connectors === undefined) return () => {};
    // 推荐：让 broker 代发请求，域名与请求头都被约束，令牌不出主机
    const result = await connectors.request({ provider: 'github', path: '/user' });
    return () => {};
  });
}
```

服务分三档权限：

| 能力 | 方法 | 默认 |
| --- | --- | --- |
| 连接状态 | `list()`、`status(id)`、`capabilities()` | 可用，无秘密 |
| 受限请求 | `request({ provider, method, path, query, body })` | 可用，令牌不返回 |
| 原始凭据 | `credential(id)`、`token(id)` | **默认拒绝**，抛 `raw-credentials-not-granted` |

需要原始令牌的插件（例如要自己实现 git 协议）必须由用户显式授权：

```bash
npx -y dsh-connectors allow-raw on    # 开启
npx -y dsh-connectors service         # 查看当前状态
npx -y dsh-connectors allow-raw off   # 用完关掉
```

调用方可以先问 `capabilities()` 再决定走哪条路，不会因为未授权而崩溃。约定只有一条：**令牌值不许进 prompt、不许进工具返回值**。

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
- **并发写**：同一目录的写入按目录排队，并用 `vault.lock` 跨进程互斥；两个进程同时保存不会互相覆盖。
- **权限**：目录 `0700`，密钥与保险库 `0600`，写入走临时文件 + rename，崩溃不会留下半截文件。
- **位置**：`$DSH_HOME/state/connectors`（或 `$DSH_CONNECTORS_HOME`），不在工作区里，Agent 的沙箱读不到。
- **出站约束**：域名来自平台预设，路径必须以 `/` 开头，`//host` 和绝对 URL 一律拒绝；`authorization`、`cookie`、`x-api-key` 等敏感头不允许调用方覆盖。
- **入口鉴权**：管理接口挂在 DSH 的 `/api/connectors/*` 上，复用宿主自己的身份校验——Host/Origin 围栏、`SameSite=Strict` 的签名会话 cookie、owner 主体检查。未登录请求返回 401，跨站请求返回 403。插件**不再自己比对 Origin**，所以经反向代理或隧道访问时不会误判；代理域名需要在 DSH 侧用 `--trusted-host` 声明，这是部署者的授权动作，插件不能绕过。
- **请求面**：只接受 POST，请求体流式读取并在 8 KB 处截断，页面带 CSP；令牌永远不会回传给浏览器。
- **插件间**：原始令牌默认不开放给其他插件，`request()` 只放行平台预设里的域名。
- **加密的边界**：密钥与密文在同一台机器、同一个系统账户下。它能挡住备份同步、误 `cat`、别的用户，**挡不住以你的账户运行的恶意程序**。
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

`auth.kind` 支持 `bearer`、`header`（配 `header` / `prefix`）、`basic`（配 `username`）。`baseUrl` 必须是 HTTPS、不能带账号密码或查询串。`verify` 省略则跳过校验。

**内置平台 id 是保留字。** 自定义项不能用 `github`、`gitlab` 这些名字，大小写、全角、零宽空格等变体都不行；想接 GitHub Enterprise 之类，请用一个新 id（例如 `github-enterprise`）。被拒的条目不会静默生效，`status` 接口的 `rejectedProviders` 会给出原因码：`id-reserved`、`id-duplicate`、`base-url-insecure` 等。

## 移动端说明

- **DSH Go / 手机本机跑**：DSH Go 是 Flutter 原生界面，**不会渲染本插件的网页设置页**。0.3.0 起它有自己的原生面板与状态条（见[DSH Go 原生面板](#dsh-go-原生面板)）；独立页面和终端命令仍然可用，设备码登录比粘贴更适合手机。
- **手机连电脑**：走 DSH Mobile / ds-harness-remote 时，经隧道的域名要在 DSH 侧用 `--trusted-host` 声明，否则宿主的 Host 围栏会返回 403；凭据始终保存在电脑那台机器上。
- **两边都要用**：两个 harness 各自保存一份。想共用一个目录，把 `DSH_CONNECTORS_HOME` 指到同步盘（注意同步盘的权限与备份策略）。

## 已知限制

- GitHub 设备码登录需要你自备 OAuth App Client ID；插件不内置别人的应用凭据。
- 目前只支持长期令牌，不做 OAuth 刷新令牌轮换。
- `conn_request` 是通用 REST 通道，不封装各平台的特殊协议（GraphQL 平台按原样 POST 即可）。
- DSH 还在开发者预览期，升级大版本前请先看 `engines.dsh` 是否仍然匹配。

## 开发

```bash
npm test        # 单元测试：保险库、加密边界、URL 约束、脱敏、接口、dsh-go 面板
npm run check   # 语法检查
```

目录：

```
index.js          主机侧：接口、工具、connectors 服务、dsh-go 原生面板
src/providers.js  平台预设与出站约束
src/vault.js      AES-256-GCM 保险库
src/actions.js    连接、校验、代发请求、设备码
src/dshgo.js      dsh-go 面板的视图、数据投影与文案（纯函数）
src/vault-watch.js 保险库变化监听（面板自动刷新）
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
