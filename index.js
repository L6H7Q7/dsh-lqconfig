/**
 * dsh-lqconfig —— 个人配置插件（宿主半侧）
 *
 * 个人设置与系统文件打开：
 *   1. 开关 DeepSeek API 通道（llm-deepseek 这一行）——写 profiles/desktop/cordis.patch.yml，带备份
 *   2. 开关「思维链优先中文」——改写三个 preset 里 persona.suffix（系统提示尾部），带备份
 *   3. 重启应用（确认后由本进程拉起外部脚本：延时 → 结束进程 → 重新启动）
 *
 *   4. 打开资源管理器和程序——状态只写同目录 state.json，默认关闭，不需重启
 *
 * 路由前缀：/dsh-lqconfig/api/*（同源 HTTP，供设置页「LQ配置」使用）
 */
import { promises as fs } from 'node:fs';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as proxy from './proxy.js';

export const name = 'dsh-lqconfig';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-lqconfig';
// 本进程 webServer 的监听端口，超限模式要用它调插件自己的同源路由。
let localPort = 0;
const BLOCK_START = '# >>> dsh-lqconfig: DeepSeek API 通道开关（自动生成，请勿手改）';
const BLOCK_END = '# <<< dsh-lqconfig';
const ROW_ID = 'llm-deepseek';
const ROW_NAME = '@deepseek-ai/dsh-llm-deepseek-api-key';

/**
 * 思维链优先中文 —— 写进三个 preset 的 persona.suffix（系统提示尾部）。
 * 实测依据：persona 是唯一落在系统提示里的注入点，比 AGENTS.md 的会话级指令权重更高。
 */
const ZH_SUFFIX =
  '思考与回答默认简体中文，代码、命令、API 与产品名保留英文；除非没有通用中文译法，不要整句使用英文。';

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

// ── 超限模式（dsh-purge）────────────────────────────────────────────────
// 开：往 profile patch 插 system-prompt 覆盖 + dsh-purge 挂载行，并跑插件 CLI 打宿主补丁。
// 关：跑 CLI 还原宿主补丁，再整段移除挂载行。切换后必须重启 DSH 才生效。
const PURGE_START = '# >>> dsh-lqconfig: 超限模式（dsh-purge，自动生成，请勿手改）';
const PURGE_END = '# <<< dsh-lqconfig: 超限模式结束';

function purgeDir() {
  // 物理合并：插件本体在 lqconfig 目录下的 vendor/dsh-purge。
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'dsh-purge');
}

/** 「开」是两阶段：先挂载插件重启，重启后由本进程调插件自己的 /dsh-purge/apply。 */
function purgePendingFlag() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '.purge-pending');
}

function markPurgePending(on) {
  const flag = purgePendingFlag();
  try {
    if (on) writeFileSync(flag, new Date().toISOString(), 'utf8');
    else if (existsSync(flag)) unlinkSync(flag);
  } catch { /* 标记写失败最多导致多打一次补丁，不会卡死开关 */ }
}

export function hasPurgePending() {
  return existsSync(purgePendingFlag());
}

/** 调插件自己注册的同源路由——只有进程内调用才能解开 app.asar。 */
async function callPurgeRoute(route) {
  const port = localPort;
  if (!port) return { ok: false, error: 'webServer 端口未就绪' };
  try {
    const res = await fetch('http://127.0.0.1:' + port + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { ok: res.ok && (data ? data.ok !== false : true), status: res.status, data, tail: text.slice(-1200) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function purgeOnBlock() {
  return [
    PURGE_START,
    '- id: system-prompt',
    '  config:',
    '    includeHarnessIdentity: false',
    '    personaPrefix: ""',
    '    personaSuffix: ""',
    '- insert:',
    '    - id: dsh-purge',
    '      name: ./local/dsh-lqconfig/vendor/dsh-purge/lib/index.js',
    '      inject: [systemPrompt, tools]',
    '      config:',
    '        enabled: true',
    '        autoApplyOnStart: true',
    '        autoUpdateOnStart: false',
    '        autoRevertOnMissing: false',
    '        injectOnce: false',
    '        stripMnemon: true',
    '        verbose: false',
    '        postPrompt: ""',
    '        postPromptOrder: 5100',
    '        autoRetry: true',
    '        retryMax: 3',
    '        autoContinue: false',
    '        continueMax: 3',
    '        continueText: "继续"',
    '        capabilityProtocol: true',
    '        hooksDenyBypass: true',
    // 演练台三个子插件：不挂上就没有 POST /redteam/api，面板会拿到 405。
    '    - id: dsh-purge-redteam',
    '      name: ./local/dsh-lqconfig/vendor/dsh-purge/lib/redteam/index.js',
    '    - id: dsh-purge-redteam-store',
    '      name: ./local/dsh-lqconfig/vendor/dsh-purge/lib/redteam/store.js',
    '    - id: dsh-purge-redteam-ui',
    '      name: ./local/dsh-lqconfig/vendor/dsh-purge/lib/redteam/ui.js',
    PURGE_END,
    '',
  ].join('\n');
}

/** 已挂载时，由本进程触发插件补丁；未挂载时返回原因，交给重启后的第二阶段。 */
async function applyPurgeInProcess() {
  return await callPurgeRoute('/dsh-purge/apply');
}

/** 开关本体：on=true 追加挂载块；on=false 整段移除。 */
export async function writePurgeMode(on) {
  const file = patchPath();
  if (!existsSync(file)) throw new Error('找不到 profile patch：' + file);
  const text = await fs.readFile(file, 'utf8');
  const hasBlock = text.includes(PURGE_START);
  let next = text;
  if (hasBlock) {
    const start = text.indexOf(PURGE_START);
    const end = text.indexOf(PURGE_END, start);
    const cut = end >= 0 ? end + PURGE_END.length : text.length;
    // 只删块本身，不碰其它段落之间的空行；结尾收成单换行。
    next = (text.slice(0, start) + text.slice(cut)).replace(/\n+$/, '\n');
  }
  if (on) next = next.replace(/\s*$/, '\n') + '\n' + purgeOnBlock();
  if (next === text) return { changed: false, backup: null };
  const bak = file + '.bak-lqconfig-' + stamp();
  await fs.copyFile(file, bak);
  await fs.writeFile(file, next, 'utf8');
  return { changed: true, backup: bak };
}

// Native opening belongs to this plugin; it does not alter the profile patch.
const nativeStatePath = fileURLToPath(new URL('./state.json', import.meta.url));

export async function readNativeSettings() {
  let text;
  try { text = await fs.readFile(nativeStatePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { openNative: false }; throw error; }
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.openNative !== 'boolean') {
    throw new Error('系统打开设置格式无效：state.json 的 openNative 必须是布尔值');
  }
  return { openNative: value.openNative };
}

export async function writeNativeSettings(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  await fs.writeFile(nativeStatePath, JSON.stringify({ openNative: enabled }, null, 2) + '\n', 'utf8');
  return { openNative: enabled };
}

export function validateNativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\x00-\x1f\x7f"<>|*?]/u.test(value)) {
    throw new Error('路径为空或包含 Windows 路径不允许的字符');
  }
  const drive = /^[A-Za-z]:[\\/]/u.test(value);
  const unc = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value);
  if (!drive && !unc) throw new Error('仅接受 Windows 盘符绝对路径或 UNC 路径');
  if (/^(?:\\\\|\/\/)\.[\\/]/u.test(value)) throw new Error('不接受设备路径');
  if (/#L\d+(?:-L?\d+)?$/iu.test(value)) throw new Error('带行号的链接仅在 Sidebar 中打开');
  return value;
}

// Fixed source only: the target is data in the child environment, never code.
const NATIVE_OPEN_POWERSHELL = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'try {',
  "  $target = [Environment]::GetEnvironmentVariable('DSH_LQ_NATIVE_OPEN_PATH', 'Process')",
  "  if ([string]::IsNullOrEmpty($target)) { throw 'Missing native path' }",
  '  $info = New-Object System.Diagnostics.ProcessStartInfo',
  '  $info.FileName = $target',
  '  $info.UseShellExecute = $true',
  "  $info.Verb = 'open'",
  '  [void][System.Diagnostics.Process]::Start($info)',
  "  [Console]::Out.Write('{\"submitted\":true,\"displayed\":null}')",
  '  exit 0',
  '} catch {',
  '  $problem = $_.Exception',
  '  while ($null -ne $problem.InnerException) { $problem = $problem.InnerException }',
  '  $nativeCode = $null',
  '  if ($problem -is [System.ComponentModel.Win32Exception]) { $nativeCode = $problem.NativeErrorCode }',
  '  $failure = @{ submitted = $false; displayed = $null; code = $nativeCode; error = $problem.Message }',
  '  [Console]::Out.Write(($failure | ConvertTo-Json -Compress))',
  '  exit 1',
  '}',
].join('\n');
const nativeEncodedCommand = Buffer.from(NATIVE_OPEN_POWERSHELL, 'utf16le').toString('base64');

function launchNativePath(target) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let stdout = '', stderr = '', settled = false;
    const env = { ...process.env, DSH_LQ_NATIVE_OPEN_PATH: target };
    // The DSH host runs Electron as Node; inheriting this makes VS Code exit without showing a window.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', nativeEncodedCommand], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error('系统打开请求超时，结果无法确认；请先查看目标程序，避免重复打开');
      error.code = 'native-timeout';
      error.submitted = null;
      finish(error);
    }, 3000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16384); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.on('error', error => { error.submitted = false; finish(error); });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      let result;
      try { result = JSON.parse(stdout.trim()); } catch {}
      if (exitCode === 0 && result?.submitted === true) {
        finish(null, { submitted: true, displayed: null });
        return;
      }
      const association = result?.code === 1155;
      const error = new Error(association
        ? '该文件类型尚无默认应用，请先在 Windows 中选择打开方式'
        : result?.error || stderr.trim() || '系统打开进程未返回可确认的结果');
      error.code = association ? 'association-required' : result?.code ?? 'native-open-failed';
      error.nativeCode = result?.code ?? null;
      error.exitCode = exitCode;
      error.signal = signal;
      error.stderr = stderr.trim();
      error.submitted = result?.submitted === false ? false : null;
      finish(error);
    });
  });
}

function explorerTarget(windowsPath) {
  // Match dsh-native-command: preserve URI escaping and disambiguate the
  // comma/equals characters used by Explorer's own argument grammar.
  return pathToFileURL(windowsPath, { windows: true }).href
    .replace(/(?:%[89A-F][0-9A-F])+/gi, escaped => decodeURIComponent(escaped))
    .replaceAll(',', '%2C').replaceAll('=', '%3D');
}

function revealNativeLocation(target, directory, select) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  const requestPath = select ? target : directory;
  const uri = explorerTarget(requestPath);
  const args = select ? ['/select,', uri] : [uri];
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, spawned = false, stderr = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        error.requestPath = requestPath;
        error.submitted = spawned;
        error.status ||= spawned ? 'unconfirmed' : null;
        error.stderr = stderr.trim();
        reject(error);
      } else resolve(result);
    };
    // Each parallel operation gets its own 3-second acknowledgement budget.
    // Completion does not prove Explorer-window visibility.
    timer = setTimeout(() => {
      const error = new Error(spawned
        ? '定位进程未在 3 秒内返回委托结果；窗口是否出现未知，未终止资源管理器'
        : '定位进程未在 3 秒内确认启动；结果未知');
      error.code = spawned ? 'reveal-confirm-timeout' : 'reveal-start-timeout';
      error.status = 'unconfirmed';
      error.exitCode = null;
      // Stop retaining this waiter and its pipes, not the GUI process.
      child?.unref();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      finish(error);
    }, 3000);
    try {
      child = spawn(executable, args, {
        shell: false, windowsHide: false, detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { finish(error); return; }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.once('spawn', () => { spawned = true; });
    child.once('error', error => { finish(error); });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      if (exitCode === 0 || exitCode === 1) {
        finish(null, {
          status: 'delegated', submitted: true,
          path: requestPath, displayed: null,
          exitCode: exitCode, stderr: stderr.trim(),
        });
        return;
      }
      const error = new Error('定位进程未完成委托' + (stderr.trim() ? '：' + stderr.trim() : ''));
      error.code = 'reveal-exit-failed';
      error.exitCode = exitCode;
      error.signal = signal;
      // A completed non-handoff exit is a known failure, not an unknown wait.
      error.status = 'failed';
      finish(error);
    });
  });
}


async function openExplorerForPath(target, stat, statError) {
  if (stat?.isDirectory()) return revealNativeLocation(target, target, false);
  const parent = path.win32.dirname(target);
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) {
    const error = new Error('父路径不是目录：' + parent);
    error.code = 'ENOTDIR';
    throw error;
  }
  const missing = statError?.code === 'ENOENT' || statError?.code === 'ENOTDIR';
  // This is the independent Explorer intent, not recovery from an app failure.
  return revealNativeLocation(target, parent, !missing);
}

function nativeOperationError(error) {
  return {
    code: error.code || 'native-open-failed',
    nativeCode: error.nativeCode ?? null,
    message: error.message || String(error),
    exitCode: error.exitCode ?? null,
    stderr: error.stderr || '',
  };
}

const EXECUTABLE_EXT_RE = /\.(?:exe|com|bat|cmd|vbs|vbe|ps1|msi|lnk|scr)$/iu;

export async function openNativePath(value, operations = ['program', 'explorer']) {
  const target = validateNativePath(value);
  // 执行型文件只启动程序本身；再弹一个资源管理器定位没有任何意义。
  const effective = EXECUTABLE_EXT_RE.test(target) && operations.includes('program')
    ? ['program']
    : operations;
  let stat, statError;
  try {
    stat = await fs.stat(target);
    if (!stat.isFile() && !stat.isDirectory()) {
      statError = Object.assign(new Error('仅支持普通文件或目录'), { code: 'not-regular-path', submitted: false });
    }
  } catch (cause) {
    statError = new Error(cause.code === 'ENOENT' || cause.code === 'ENOTDIR'
      ? '路径不存在：' + target : '无法访问路径：' + cause.message);
    statError.code = cause.code || 'path-unavailable';
    statError.submitted = false;
  }
  // Start both intentions now. Neither launch waits for the other to fail.
  // Explicit retries can request only the operation that did not complete.
  const [program, explorer] = await Promise.allSettled([
    effective.includes('program')
      ? (statError ? Promise.reject(statError) : launchNativePath(target))
      : Promise.resolve(null),
    effective.includes('explorer')
      ? openExplorerForPath(target, stat, statError)
      : Promise.resolve(null),
  ]);
  const report = { program: null, explorer: null };
  if (effective.includes('program')) {
    report.program = program.status === 'fulfilled'
      ? { ok: true, ...program.value }
      : { ok: false, submitted: Object.prototype.hasOwnProperty.call(program.reason, 'submitted') ? program.reason.submitted : false,
        displayed: null, error: nativeOperationError(program.reason) };
  }
  if (effective.includes('explorer')) {
    report.explorer = explorer.status === 'fulfilled'
      ? { ok: true, ...explorer.value }
      : { ok: false, status: explorer.reason.status || 'failed', submitted: explorer.reason.submitted ?? false,
        path: explorer.reason.requestPath || target, displayed: null, error: nativeOperationError(explorer.reason) };
  }
  const ok = [report.program, report.explorer].filter(Boolean).every(result => result.ok);
  return { ok, ...report, ...(ok ? {} : { error: { code: 'open-operations-incomplete', message: '部分打开请求未完成' } }) };
}


export async function readState() {
  const file = patchPath();
  const exists = existsSync(file);
  const text = exists ? await fs.readFile(file, 'utf8') : '';
  return {
    enabled: !text.includes(BLOCK_START),
    chainZh: text.includes("suffix: '" + ZH_SUFFIX + "'"),
    purge: text.includes(PURGE_START),
    ...(await readNativeSettings()),
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

  // 旧写法（wscript → cmd → start exe）在宿主里必然把 EXE 起成纯 Node：
  // 宿主自己是 ELECTRON_RUN_AS_NODE=1 跑的，cmd 和 start 全继承这个变量，
  // 新实例没有窗口、立刻退出 —— 表现就是「只关闭不打开」。
  // 手动点 restart-dsh.vbs 正常，是因为它由 explorer 拉起，环境干净。
  // 现在交给独立助手进程：它自己以 Node 模式跑，拉起 EXE 前把变量洗掉。
  const helper = fileURLToPath(new URL('./restart-helper.mjs', import.meta.url));
  const child = spawn(process.execPath, [helper, exe], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(helper),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  return { exe, helper, pid: child.pid };
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

let exitHookInstalled = false;

/** 启动后多久预热代理（毫秒）。延迟避开 DSH 启动高峰，失败不影响启动。 */
const WARMUP_DELAY_MS = 8000;

export function apply(ctx) {
  // 插件卸载时停掉内核，避免遗留孤儿进程
  ctx.effect(() => () => { proxy.stopSync(); }, 'dsh-lqconfig: proxy cleanup');

  try { localPort = Number(ctx.webServer?.port) || 0; } catch { localPort = 0; }

  // 超限模式第二阶段：开关是把「挂载」写进 profile 的，插件要重启后才在进程里，
  // 所以补丁只能在这次启动后由这里调它自己的 /dsh-purge/apply。带重试，成功后清标记。
  if (hasPurgePending()) {
    const timer = setTimeout(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await callPurgeRoute('/dsh-purge/apply');
        if (result.ok) {
          markPurgePending(false);
          try { ctx.logger?.info?.('[dsh-lqconfig] 超限模式补丁已应用'); } catch { /* 忽略 */ }
          return;
        }
        await new Promise((resolve) => { const t = setTimeout(resolve, 3000); t.unref?.(); });
      }
      try { ctx.logger?.warn?.('[dsh-lqconfig] 超限模式补丁应用失败：插件路由一直没就绪'); } catch { /* 忽略 */ }
    }, 6000);
    timer.unref?.();
    ctx.effect(() => () => clearTimeout(timer), 'dsh-lqconfig: purge apply');
  }

  // 开关打开时，启动后自动预热内核；不阻塞 apply，失败只记日志
  let warmupTimer = setTimeout(() => {
    warmupTimer = null;
    void proxy.readSettings()
      .then((settings) => {
        if (!settings.enabled || !settings.url) return undefined;
        return proxy.ensure();
      })
      .catch((error) => {
        try { ctx.logger?.warn?.('[dsh-lqconfig] 代理预热失败：' + (error && error.message ? error.message : error)); } catch { /* 忽略 */ }
      });
  }, WARMUP_DELAY_MS);
  ctx.effect(() => () => { if (warmupTimer !== null) { clearTimeout(warmupTimer); warmupTimer = null; } }, 'dsh-lqconfig: proxy warmup');
  // 关窗口/退应用时即使插件 Dispose 没跑到，Node 退出也会同步收尾
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => { try { proxy.stopSync(); } catch { /* 尽力而为 */ } });
  }
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
            if (req.method === 'POST' && route === '/api/purge') {
              const body = await readBody(req);
              if (typeof body.on !== 'boolean') {
                return sendJson(res, 400, { ok: false, error: 'on 必须是布尔值' });
              }
              if (body.on) {
                // 开：先挂载（重启后插件才在进程里），打补丁交给重启后的第二阶段。
                const result = await writePurgeMode(true);
                markPurgePending(true);
                return sendJson(res, 200, {
                  ok: true, ...result, pending: true,
                  note: '已写入挂载，重启后由插件自行解开 app.asar 并打补丁（可能再自动重启一次）。',
                  ...(await readState()),
                });
              }
              // 关：此刻插件还挂在进程里，先让它原地还原宿主补丁，再摘挂载。
              const revert = await callPurgeRoute('/dsh-purge/revert');
              markPurgePending(false);
              const result = await writePurgeMode(false);
              return sendJson(res, 200, { ok: true, ...result, revert, ...(await readState()) });
            }
            if (req.method === 'POST' && (route === '/api/native-setting' || route === '/api/native-open')) {
              if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
                return sendJson(res, 415, { ok: false, error: '此接口需要 application/json' });
              }
              const body = await readBody(req);
              if (route === '/api/native-setting') {
                if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
                return sendJson(res, 200, { ok: true, ...(await writeNativeSettings(body.enabled)) });
              }
              if (!(await readNativeSettings()).openNative) {
                return sendJson(res, 409, { ok: false, code: 'native-disabled', submitted: false, displayed: null, error: '系统打开开关已关闭' });
              }
              try { validateNativePath(body.path); }
              catch (error) { return sendJson(res, 400, { ok: false, submitted: false, displayed: null, error: error.message }); }
              const operations = body.operations ?? ['program', 'explorer'];
              if (!Array.isArray(operations) || operations.length === 0 || operations.length > 2 ||
                  new Set(operations).size !== operations.length || operations.some(value => value !== 'program' && value !== 'explorer')) {
                return sendJson(res, 400, { ok: false, error: 'operations 仅接受 program、explorer' });
              }
              const result = await openNativePath(body.path, operations);
              return sendJson(res, result.ok ? 200 : 500, result);
            }
            if (route.startsWith('/api/proxy/')) {
              const action = route.slice('/api/proxy/'.length);
              if (req.method === 'GET' && action === 'state') {
                const settings = await proxy.readSettings();
                let host = '';
                try { host = settings.url ? new URL(settings.url).host : ''; } catch { host = ''; }
                return sendJson(res, 200, {
                  ok: true,
                  ...(await proxy.status()),
                  hasUrl: Boolean(settings.url),
                  host,
                  url: settings.url ? host + '（已保存）' : '',
                });
              }
              if (req.method === 'GET' && action === 'regions') {
                return sendJson(res, 200, { ok: true, regions: await proxy.listRegions() });
              }
              if (req.method === 'GET' && action === 'nodes') {
                const settings = await proxy.readSettings();
                const { entries } = await proxy.refreshProvider(settings, false);
                return sendJson(res, 200, {
                  ok: true,
                  nodes: entries.map((entry) => ({ name: entry.name, region: proxy.regionOf(entry.name) })),
                });
              }
              if (req.method === 'POST' && action === 'set') {
                const body = await readBody(req);
                const patch = {};
                if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
                if (typeof body.url === 'string') patch.url = body.url;
                if (Array.isArray(body.regions)) patch.regions = body.regions;
                if (typeof body.port === 'number') patch.port = body.port;
                if (typeof body.refreshMinutes === 'number') patch.refreshMinutes = body.refreshMinutes;
                const settings = await proxy.writeSettings(patch);
                if (settings.enabled === false) await proxy.stop();
                return sendJson(res, 200, { ok: true, ...(await proxy.status()) });
              }
              if (req.method === 'POST' && action === 'ensure') {
                const body = await readBody(req);
                return sendJson(res, 200, { ok: true, ...(await proxy.ensure(body && body.force === true)) });
              }
              if (req.method === 'POST' && action === 'stop') {
                return sendJson(res, 200, { ok: true, ...(await proxy.stop()) });
              }
              return sendJson(res, 404, { ok: false, error: 'not found' });
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
