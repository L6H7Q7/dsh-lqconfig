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
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export async function openNativePath(value, operations = ['program', 'explorer']) {
  const target = validateNativePath(value);
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
    operations.includes('program')
      ? (statError ? Promise.reject(statError) : launchNativePath(target))
      : Promise.resolve(null),
    operations.includes('explorer')
      ? openExplorerForPath(target, stat, statError)
      : Promise.resolve(null),
  ]);
  const report = { program: null, explorer: null };
  if (operations.includes('program')) {
    report.program = program.status === 'fulfilled'
      ? { ok: true, ...program.value }
      : { ok: false, submitted: Object.prototype.hasOwnProperty.call(program.reason, 'submitted') ? program.reason.submitted : false,
        displayed: null, error: nativeOperationError(program.reason) };
  }
  if (operations.includes('explorer')) {
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
