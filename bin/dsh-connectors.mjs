#!/usr/bin/env node
/**
 * Command line for the same vault the plugin uses.
 *
 * It exists because a token should be typed somewhere it will not be logged:
 * a terminal, not a chat box. On a phone, `npx -y dsh-connectors add github`
 * is often the only comfortably reachable input.
 *
 * Commands: list, add, remove, env, git-credential, path, help.
 */
import { createInterface } from 'node:readline';
import { createVault, connectorHome } from '../src/vault.js';
import { allProviders, providerById } from '../src/providers.js';
import { connect, disconnect, loadCustomProviders, statusReport } from '../src/actions.js';

/** Environment variable a platform's official tooling usually reads. */
const ENV_NAMES = {
  github: ['GITHUB_TOKEN'],
  gitlab: ['GITLAB_TOKEN', 'CI_JOB_TOKEN'],
  gitee: ['GITEE_TOKEN'],
  vercel: ['VERCEL_TOKEN'],
  cloudflare: ['CLOUDFLARE_API_TOKEN'],
  netlify: ['NETLIFY_AUTH_TOKEN'],
  railway: ['RAILWAY_TOKEN'],
  npm: ['NPM_TOKEN'],
  supabase: ['SUPABASE_ACCESS_TOKEN'],
  huggingface: ['HF_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  figma: ['FIGMA_TOKEN'],
  notion: ['NOTION_TOKEN'],
  slack: ['SLACK_TOKEN'],
};

/** Per-host git username conventions; the token itself is the password. */
const GIT_USERNAMES = {
  github: 'x-access-token',
  gitlab: 'oauth2',
  gitee: 'oauth2',
};

function usage() {
  return [
    '用法: dsh-connectors <命令> [参数]',
    '',
    '  list                       列出平台与连接状态',
    '  add <平台> [--username 名字] [--skip-verify]',
    '                             粘贴令牌并保存（从标准输入读取时不会进终端历史）',
    '  remove <平台>              删除本机凭据',
    '  env <平台>                 输出该平台常用的环境变量写法',
    '  git-credential <get|store|erase>',
    '                            给 git 用的凭据助手（见 README）',
    '  path                       显示凭据目录',
    '  allow-raw [on|off]         允许/禁止其他插件读取原始令牌（默认禁止）',
    '  service                    查看插件间服务权限的当前状态',
    '  help                       显示这段说明',
    '',
    '环境变量: DSH_CONNECTORS_HOME 指定凭据目录；DSH_HOME 指定 harness 主目录。',
  ].join('\n');
}

/**
 * Parse `--flag value` and positional arguments.
 * @param argv - process arguments after the command.
 * @returns positionals and flags.
 */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const name = item.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(item);
    }
  }
  return { positionals, flags };
}

/**
 * Read one line from stdin, hiding typed characters when it is a terminal.
 * @param prompt - text to show first.
 * @returns the line without its newline.
 */
async function readSecret(prompt) {
  if (process.stdin.isTTY !== true) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Mute the echo: the token is not a password manager, but a terminal is
    // still a shared surface (screen recording, over-shoulder).
    const mutable = rl;
    mutable._writeToOutput = () => {};
    rl.question('', (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Render the provider table.
 * @param home - connector home directory.
 * @param asJson - print machine-readable output.
 */
async function listProviders(home, asJson = false) {
  const report = await statusReport(home);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [`${report.connected} / ${report.total} 已连接    ${report.home}`, ''];
  for (const row of report.providers) {
    const mark = row.connected ? '*' : ' ';
    const who = row.connected ? `  ${row.login ?? row.username ?? ''}` : '';
    lines.push(`${mark} ${row.id.padEnd(14)} ${row.name}${who}`);
  }
  lines.push('', '* = 已连接。连接：dsh-connectors add <平台>');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Map a git host to a provider id.
 * @param home - connector home directory.
 * @param host - hostname from git.
 * @returns the provider, or undefined.
 */
async function providerForHost(home, host) {
  const custom = await loadCustomProviders(home);
  const normalized = String(host).toLowerCase();
  for (const provider of allProviders(custom)) {
    const hosts = provider.gitHosts ?? [];
    if (hosts.includes(normalized)) return provider;
  }
  return undefined;
}

/**
 * Implement git's credential helper protocol.
 * @param home - connector home directory.
 * @param action - get, store or erase.
 */
async function gitCredential(home, action) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const fields = {};
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  if (action === 'store' || action === 'erase') return;
  const host = fields.host ?? '';
  if (host === '') return;
  const provider = await providerForHost(home, host);
  if (provider === undefined) return;
  const credential = await createVault(home).get(provider.id);
  if (credential === null) return;
  const username = credential.username || credential.login || GIT_USERNAMES[provider.id] || 'x-access-token';
  process.stdout.write(`username=${username}\npassword=${credential.token}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);
  const home = typeof flags.home === 'string' ? flags.home : connectorHome();

  if (command === undefined || command === 'help' || flags.help === true) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'path') {
    process.stdout.write(`${home}\n`);
    return;
  }

  if (command === 'list' || command === 'status') {
    await listProviders(home, flags.json === true);
    return;
  }

  if (command === 'add') {
    const id = positionals[0];
    if (id === undefined) {
      process.stderr.write('用法: dsh-connectors add <平台>\n');
      process.exitCode = 2;
      return;
    }
    const custom = await loadCustomProviders(home);
    const provider = providerById(id, custom);
    if (provider === undefined) {
      process.stderr.write(`未知平台: ${id}\n可用平台: ${allProviders(custom).map((item) => item.id).join(', ')}\n`);
      process.exitCode = 2;
      return;
    }
    const username = typeof flags.username === 'string' ? flags.username : '';
    if (provider.needsUsername === true && username === '') {
      process.stderr.write(`${provider.name} 还需要 --username\n`);
      process.exitCode = 2;
      return;
    }
    const token = await readSecret(`${provider.name} 令牌（输入不回显）: `);
    if (token === '') {
      process.stderr.write('没有读到令牌。\n');
      process.exitCode = 1;
      return;
    }
    const result = await connect(home, { provider: provider.id, token, username, skipVerify: flags['skip-verify'] === true });
    if (!result.ok) {
      process.stderr.write(`保存失败: ${result.error}${result.message ? ` - ${result.message}` : ''}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${provider.name} 已连接${result.provider.login ? `：${result.provider.login}` : ''}\n`);
    return;
  }

  if (command === 'remove') {
    const id = positionals[0];
    if (id === undefined) {
      process.stderr.write('用法: dsh-connectors remove <平台>\n');
      process.exitCode = 2;
      return;
    }
    const removed = await disconnect(home, id);
    process.stdout.write(removed ? `已删除 ${id} 的本机凭据\n` : `${id} 本来就没有凭据\n`);
    return;
  }

  if (command === 'env') {
    const id = positionals[0];
    if (id === undefined) {
      process.stderr.write('用法: dsh-connectors env <平台>\n');
      process.exitCode = 2;
      return;
    }
    const credential = await createVault(home).get(id);
    if (credential === null) {
      process.stderr.write(`${id} 还没有连接。\n`);
      process.exitCode = 1;
      return;
    }
    const names = ENV_NAMES[id] ?? [`${id.toUpperCase()}_TOKEN`];
    const lines = names.map((name) => `export ${name}='${credential.token}'`);
    if (credential.username) lines.push(`export ${id.toUpperCase()}_USERNAME='${credential.username}'`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (command === 'allow-raw') {
    const value = positionals[0] ?? 'on';
    if (value !== 'on' && value !== 'off') {
      process.stderr.write('用法: dsh-connectors allow-raw [on|off]\n');
      process.exitCode = 2;
      return;
    }
    await createVault(home).patchSettings({ 'service:allowRawCredentials': value === 'on' ? true : undefined });
    process.stdout.write(
      value === 'on'
        ? '已允许其他插件读取原始令牌。用完建议立即执行 allow-raw off。\n'
        : '已禁止其他插件读取原始令牌。\n',
    );
    return;
  }

  if (command === 'service') {
    const settings = await createVault(home).readSettings();
    const granted = settings['service:allowRawCredentials'] === true;
    process.stdout.write(
      [
        `原始令牌读取: ${granted ? '已允许（allow-raw on）' : '已禁止（默认）'}`,
        '受限平台请求 request(): 始终可用',
        '连接状态 list()/status(): 始终可用',
      ].join('\n') + '\n',
    );
    return;
  }

  if (command === 'git-credential') {
    await gitCredential(home, positionals[0] ?? 'get');
    return;
  }

  process.stderr.write(`未知命令: ${command}\n\n${usage()}\n`);
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`出错了: ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
