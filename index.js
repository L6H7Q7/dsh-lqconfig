/**
 * dsh-lqconfig —— 个人配置插件（宿主半侧）
 *
 * 只做三件事：
 *   1. 开关 DeepSeek API 通道（llm-deepseek 这一行）——写 profiles/desktop/cordis.patch.yml，带备份
 *   2. 开关「思维链优先中文」——改写三个 preset 里 persona.suffix（系统提示尾部），带备份
 *   3. 重启应用（确认后由本进程拉起外部脚本：延时 → 结束进程 → 重新启动）
 *
 * 路由前缀：/dsh-lqconfig/api/*（同源 HTTP，供设置页「LQ配置」使用）
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const name = 'dsh-lqconfig';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-lqconfig';
const BLOCK_START = '# >>> dsh-lqconfig: DeepSeek API 通道开关（自动生成，请勿手改）';
const BLOCK_END = '# <<< dsh-lqconfig';
const ROW_ID = 'llm-deepseek';
const ROW_NAME = '@deepseek-ai/dsh-llm-deepseek-api-key';

/**
 * 思维链优先中文 —— 写进三个 preset 的 persona.suffix（系统提示尾部）。
 * 实测依据：persona 是唯一落在系统提示里的注入点，比 AGENTS.md 的会话级指令权重更高。
 */
const ZH_SUFFIX =
  '内部思考过程默认使用简体中文表达；技术术语、代码标识符、API 与产品专有名词保留原文英文；除非没有通行中文译法，否则不要整句使用英文。';

/** 只匹配 persona 块里 10 空格缩进的 suffix: ''，不碰别的 suffix */
const PLAIN_SUFFIX_RE = /(\n {10}suffix: )''(?=\n)/g;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function patchPath() {
  return path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');
}

function exePath() {
  return process.env.DSH_DESKTOP_EXE || 'D:\\AI\\Agent\\DeepSeek Harness\\DeepSeek Harness.exe';
}

function disabledBlock() {
  return [
    BLOCK_START,
    '- id: ' + ROW_ID,
    "  name: '" + ROW_NAME + "'",
    '  disabled: true',
    BLOCK_END,
    '',
  ].join('\n');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + ms;
}

export async function readState() {
  const file = patchPath();
  const exists = existsSync(file);
  const text = exists ? await fs.readFile(file, 'utf8') : '';
  return {
    enabled: !text.includes(BLOCK_START),
    chainZh: text.includes("suffix: '" + ZH_SUFFIX + "'"),
    exists,
    patchPath: file,
    exe: exePath(),
  };
}

export async function writeEnabled(enabled) {
  const file = patchPath();
  if (!existsSync(file)) throw new Error('找不到 profile patch：' + file);

  const text = await fs.readFile(file, 'utf8');
  const hasBlock = text.includes(BLOCK_START);
  let next = text;

  if (enabled) {
    const start = text.indexOf(BLOCK_START);
    if (start >= 0) {
      const end = text.indexOf(BLOCK_END, start);
      const cut = end >= 0 ? end + BLOCK_END.length : text.length;
      const before = text.slice(0, start).replace(/\s+$/, '\n');
      const after = text.slice(cut).replace(/^\s+/, '');
      next = before + after;
    }
  } else if (!hasBlock) {
    next = text.replace(/\s*$/, '\n\n') + disabledBlock();
  }

  if (next === text) return { changed: false, backup: null };

  const bak = file + '.bak-lqconfig-' + stamp();
  await fs.copyFile(file, bak);
  await fs.writeFile(file, next, 'utf8');
  return { changed: true, backup: bak };
}

/**
 * 开关「思维链优先中文」：只改 persona 的 suffix 一行，其余字符一律不动。
 * 打开 = suffix: '' → suffix: '<ZH_SUFFIX>'；关闭 = 反向还原成 ''。
 */
export async function writeChainZh(enabled) {
  const file = patchPath();
  if (!existsSync(file)) throw new Error('找不到 profile patch：' + file);

  const text = await fs.readFile(file, 'utf8');
  const next = enabled
    ? text.replace(PLAIN_SUFFIX_RE, (_match, head) => head + "'" + ZH_SUFFIX + "'")
    : text.split("suffix: '" + ZH_SUFFIX + "'").join("suffix: ''");

  if (next === text) return { changed: false, backup: null };
  if (enabled && !next.includes(ZH_SUFFIX)) {
    throw new Error('补丁里没找到 persona 的 suffix，未做任何改动');
  }

  const bak = file + '.bak-lqconfig-' + stamp();
  await fs.copyFile(file, bak);
  await fs.writeFile(file, next, 'utf8');
  return { changed: true, backup: bak };
}

async function restartApp() {
  const exe = exePath();
  if (!existsSync(exe)) throw new Error('找不到应用可执行文件：' + exe);

  // 用 VBS 以窗口样式 0 执行：计划任务拉起 wscript，cmd 全程隐藏；
  // 任务本身不受 DSH 进程树（Job Object）影响，主进程被杀也不会连坐。
  const vbs = path.join(os.tmpdir(), 'dsh-lqconfig-restart.vbs');
  const lines = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "cmd /c timeout /t 2 /nobreak >nul & taskkill /f /im ""DeepSeek Harness.exe"" >nul 2>nul & start """" ""' +
      exe +
      '""", 0, False',
    '',
  ];
  await fs.writeFile(vbs, lines.join('\r\n'), 'utf8');

  const task = 'dsh-lqconfig-restart';
  const { execFile } = await import('node:child_process');
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile('schtasks', args, { windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || stdout || error.message).trim()));
        else resolve((stdout || '').trim());
      });
    });

  await run(['/create', '/f', '/tn', task, '/tr', 'wscript.exe //B ' + vbs, '/sc', 'once', '/st', '23:59']);
  await run(['/run', '/tn', task]);
  return { exe, task, vbs };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const route = url.pathname.replace(ROUTE_PREFIX, '') || '/';
          try {
            if (req.method === 'GET' && route === '/api/state') {
              return sendJson(res, 200, { ok: true, ...(await readState()) });
            }
            if (req.method === 'POST' && route === '/api/set') {
              const body = await readBody(req);
              if (typeof body.enabled !== 'boolean') {
                return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
              }
              const result = await writeEnabled(body.enabled);
              return sendJson(res, 200, { ok: true, ...result, ...(await readState()) });
            }
            if (req.method === 'POST' && route === '/api/chain-zh') {
              const body = await readBody(req);
              if (typeof body.enabled !== 'boolean') {
                return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
              }
              const result = await writeChainZh(body.enabled);
              return sendJson(res, 200, { ok: true, ...result, ...(await readState()) });
            }
            if (req.method === 'POST' && route === '/api/restart') {
              return sendJson(res, 200, { ok: true, ...(await restartApp()) });
            }
            return sendJson(res, 404, { ok: false, error: 'not found' });
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    'dsh-lqconfig: routes',
  );
}
