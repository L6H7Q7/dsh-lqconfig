/**
 * dsh-lqconfig —— 个人配置插件（宿主半侧）
 *
 * 个人设置与系统文件打开：
 *   1. 开关 DeepSeek API 通道（llm-deepseek 这一行）——写 profiles/desktop/cordis.patch.yml，带备份
 *   2. 全局规则——把 GLOBAL-RULES.md 压成单行注入三个 preset 的 persona.prefix（系统提示前段），带备份
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
import * as proxy from './proxy.js';

export const name = 'dsh-lqconfig';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-lqconfig';
const BLOCK_START = '# >>> dsh-lqconfig: DeepSeek API 通道开关（自动生成，请勿手改）';
const BLOCK_END = '# <<< dsh-lqconfig';
const ROW_ID = 'llm-deepseek';
const ROW_NAME = '@deepseek-ai/dsh-llm-deepseek-api-key';

/** 匹配 persona 块里 10 空格缩进的 prefix 行（规则块挂在 prefix 行尾，suffix 保持为空） */
const PERSONA_PREFIX_LINE_RE = /^ {10}prefix: .*$/gm;

/**
 * 全局规则 —— 把插件目录 GLOBAL-RULES.md 的正文压成单行，注入三个 preset 的 persona.prefix。
 * 标记块保证开/关幂等：开 = 清旧块后追加，关 = 只删块。
 */
const RULES_FILE = fileURLToPath(new URL('./GLOBAL-RULES.md', import.meta.url));
const RULES_START = '[[dsh-lqconfig:global-rules]]';
const RULES_END = '[[/dsh-lqconfig:global-rules]]';
/** 单行注入上限：三个 prefix 各一份，超长会明显吃系统提示 */
const RULES_LIMIT = 16000;
const RULES_RE = / ?\[\[dsh-lqconfig:global-rules\]\][\s\S]*?\[\[\/dsh-lqconfig:global-rules\]\]/g;

const AWAKENING_FILE = fileURLToPath(new URL('./AWAKENING-PROMPT.txt', import.meta.url));
const AWAKENING_SNAPSHOT = fileURLToPath(new URL('./awakening-original.json', import.meta.url));
const AWAKENING_MARKER = '# dsh-lqconfig:awakening';
const AWAKENING_PRESETS = ['standard', 'ptc', 'cordis'];

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

/** apply() 时的宿主上下文：强制终止与运行时长接口按需取用 Host 服务（不在 apply 里硬依赖）。 */
let pluginContext = null;

function hostService(name) {
  if (!pluginContext) return undefined;
  try {
    const service = pluginContext.get(name);
    return service || undefined;
  } catch {
    return undefined;
  }
}

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
  const current = await readStateFile();
  current.openNative = enabled;
  await fs.writeFile(nativeStatePath, JSON.stringify(current, null, 2) + '\n', 'utf8');
  return { openNative: enabled };
}

// 原始 state.json 内容（合并写入用，避免两个开关互相清除对方的键）
async function readStateFile() {
  try {
    const text = await fs.readFile(nativeStatePath, 'utf8');
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// 左下角余额徽标开关：默认开启；state.json 里缺键时也视为开启
export async function readBalanceBadge() {
  const value = await readStateFile();
  return typeof value.balanceBadge === 'boolean' ? value.balanceBadge : true;
}

export async function writeBalanceBadge(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  const current = await readStateFile();
  current.balanceBadge = enabled;
  await fs.writeFile(nativeStatePath, JSON.stringify(current, null, 2) + '\n', 'utf8');
  return { balanceBadge: enabled };
}

// 余额轮询间隔（分钟）：1–60；缺键或非法值回落 1 分钟
export async function readBalanceInterval() {
  const value = await readStateFile();
  const minutes = Number(value.balanceIntervalMinutes);
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? Math.round(minutes) : 1;
}

// 会话强制终止开关：默认开启；state.json 里缺键时也视为开启
export async function readForceStopEnabled() {
  const value = await readStateFile();
  return typeof value.forceStop === 'boolean' ? value.forceStop : true;
}

export async function writeForceStopEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  const current = await readStateFile();
  current.forceStop = enabled;
  await fs.writeFile(nativeStatePath, JSON.stringify(current, null, 2) + '\n', 'utf8');
  return { forceStop: enabled };
}

export async function writeBalanceInterval(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 1 || value > 60) {
    throw new Error('间隔必须是 1–60 之间的分钟数');
  }
  const rounded = Math.round(value);
  const current = await readStateFile();
  current.balanceIntervalMinutes = rounded;
  await fs.writeFile(nativeStatePath, JSON.stringify(current, null, 2) + '\n', 'utf8');
  return { balanceIntervalMinutes: rounded };
}

// 余额取数：调本插件自带的 scripts/balance.ps1 -Json（与手工排查同源）。
// pwsh 只用 PATH 名，不硬编码 WindowsApps 下带版本号的绝对路径。
const balanceScriptPath = fileURLToPath(new URL('./scripts/balance.ps1', import.meta.url));
const BALANCE_CACHE_MS = 20_000;   // 20 秒内并发去重，降低平台请求频率
const BALANCE_TIMEOUT_MS = 20_000;
let balanceCache = { at: 0, data: null };

export async function readBalance() {
  const now = Date.now();
  if (balanceCache.data && now - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.data;

  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', balanceScriptPath, '-Json'], {
        windowsHide: true,
      });
    } catch (error) {
      return done({ ok: false, error: '无法启动 pwsh：' + error.message });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 尽力而为 */ }
      done({ ok: false, error: '余额脚本超时（' + Math.round(BALANCE_TIMEOUT_MS / 1000) + ' 秒）' });
    }, BALANCE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, error: '无法启动 pwsh：' + error.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).pop() || '';
      try {
        const data = JSON.parse(line);
        if (data && data.ok) balanceCache = { at: Date.now(), data };
        done(data);
      } catch {
        const hint = stderr.trim().split(/\r?\n/u).filter(Boolean).pop() || '余额脚本输出无法解析';
        done({ ok: false, error: hint.slice(0, 300), raw: line.slice(0, 200) });
      }
    });
  });

  return result;
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

// 复用已打开的资源管理器窗口：先查是否已有窗口正显示该路径（目录比同路径，
// 文件比父目录），命中就恢复并置顶，不再新开；未命中才交给 explorer.exe。
// 查询失败、超时或脚本缺失一律按未命中处理，最差退回原来的新开行为。
const focusScriptPath = fileURLToPath(new URL('./scripts/focus-explorer.ps1', import.meta.url));
const FOCUS_TIMEOUT_MS = 4000;

async function focusExistingExplorer(target, mode, select) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', focusScriptPath, '-Target', target, '-Mode', mode];
  if (select) args.push('-Select');
  const env = { ...process.env };
  // 同 launchNativePath：继承它会让孩子进程里的 GUI 程序退化成 Node。
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    let child, stdout = '', settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 尽力而为 */ }
      finish({ focused: false, reason: 'focus-timeout' });
    }, FOCUS_TIMEOUT_MS);
    try {
      child = spawn(executable, args, {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env,
      });
    } catch (error) { finish({ focused: false, reason: error.message }); return; }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16384); });
    child.stderr.on('data', () => { /* 只用于兜底诊断，不解析 */ });
    child.on('error', error => finish({ focused: false, reason: error.message }));
    child.on('close', (exitCode) => {
      // 脚本只输出一行 JSON；前面可能混入 PowerShell 的告警，取最后一行。
      const line = stdout.split(/\r?\n/u).map(item => item.trim()).filter(Boolean).pop() || '';
      let data;
      try { data = JSON.parse(line); } catch { finish({ focused: false, reason: 'focus-unparsable' }); return; }
      if (data?.ok === true && data.found === true) {
        finish({
          focused: true,
          hwnd: data.hwnd ?? null,
          window: data.window ?? target,
          foreground: data.foreground === true,
          selected: data.selected === true,
          scrolled: data.scrolled === true,
        });
        return;
      }
      if (data?.ok === true) { finish({ focused: false, reason: 'missing' }); return; }
      finish({ focused: false, reason: data?.error || 'focus-exit-' + exitCode });
    });
  });
}

async function openExplorerForPath(target, stat, statError) {
  const missing = statError?.code === 'ENOENT' || statError?.code === 'ENOTDIR';
  if (stat?.isDirectory()) {
    const existing = await focusExistingExplorer(target, 'directory', false);
    if (existing.focused) return { status: 'focused', submitted: false, displayed: true, reused: true, ...existing };
    return { ...(await revealNativeLocation(target, target, false)), reused: false };
  }
  const parent = path.win32.dirname(target);
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) {
    const error = new Error('父路径不是目录：' + parent);
    error.code = 'ENOTDIR';
    throw error;
  }
  // This is the independent Explorer intent, not recovery from an app failure.
  const existing = await focusExistingExplorer(target, 'file', !missing);
  if (existing.focused) return { status: 'focused', submitted: false, displayed: true, reused: true, ...existing };
  return { ...(await revealNativeLocation(target, parent, !missing)), reused: false };
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


/* ---------------- 当前 Turn 运行时长 + 强制终止（Host 侧） ---------------- */

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

const turnClockCache = new Map();
const TURN_CLOCK_CACHE_MS = 3000;
/** 运行中读事件找 turn 起点较重：同一轮内 30 秒才重读一次，其余时间复用上次起点。 */
const TURN_START_REFRESH_MS = 30000;

function lastTurnStart(events) {
  if (!Array.isArray(events)) return 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'turn/start') continue;
    const time = Number(event.time);
    return Number.isFinite(time) && time > 0 ? time : 0;
  }
  return 0;
}

/** 读当前会话的「是否在运行 + 本 turn 起点」：列表定运行态，事件定起点，结果缓存 3 秒。 */
export async function readTurnClock(sessionId) {
  const now = Date.now();
  const cached = turnClockCache.get(sessionId);
  if (cached && now - cached.at < TURN_CLOCK_CACHE_MS) {
    return { ...cached.value, cached: true, serverNow: now };
  }

  const report = { running: false, startedAt: 0, source: 'none' };
  const controller = hostService('sessionController');
  if (!controller) {
    report.source = 'unavailable';
    turnClockCache.set(sessionId, { at: now, value: report, inspectedAt: 0 });
    return { ...report, cached: false, serverNow: now };
  }

  try {
    const signal = new AbortController().signal;
    const listed = await controller.list({}, signal);
    const items = listed && Array.isArray(listed.items) ? listed.items : [];
    const summary = items.find((item) => item && item.sessionId === sessionId);
    report.running = Boolean(summary && summary.running === true);
    report.source = 'list';
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  let inspectedAt = cached ? cached.inspectedAt : 0;
  let startedAt = cached ? cached.value.startedAt : 0;

  if (report.running) {
    const stale = !startedAt || now - inspectedAt >= TURN_START_REFRESH_MS;
    if (stale) {
      try {
        const inspection = await controller.inspect(sessionId);
        startedAt = lastTurnStart(inspection && inspection.events);
        inspectedAt = now;
        report.source = 'inspect';
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        startedAt = 0;
      }
    }
    if (!startedAt) startedAt = now;
    report.startedAt = startedAt;
  }

  turnClockCache.set(sessionId, { at: now, value: report, inspectedAt });
  return { ...report, cached: false, serverNow: now };
}

/** 终端服务可能只挂在 Agent 作用域（预设内提供）：先取根，再按 Agent 取作用域。 */
function resolveTerminals(agent) {
  const root = hostService('terminals');
  if (root) return { terminals: root, source: 'root' };
  if (!agent) return { terminals: undefined, source: '' };
  const presets = hostService('agentPresets');
  if (presets && typeof presets.serviceFor === 'function') {
    try {
      const scoped = presets.serviceFor(agent, 'terminals');
      if (scoped) return { terminals: scoped, source: 'agent-scope' };
    } catch { /* 作用域不提供 terminals */ }
  }
  return { terminals: undefined, source: '' };
}

/**
 * 强制终止：先发官方中止信号，再把可能拖着不放的三层一起收掉——
 * 后台任务（jobs.kill）、终端进程（terminals.kill）、子代理（subagents.interrupt）。
 * 每层独立 try/catch：服务缺失或某层拒绝只记录，不影响其余步骤。
 */
export async function forceStopSession(sessionId) {
  const steps = [];
  const pushStep = (name, detail, ok) => { steps.push({ name, ok: ok === true, detail }); };

  const controller = hostService('sessionController');
  if (!controller) {
    pushStep('cancel', 'sessionController 不可用', false);
  } else {
    try {
      const value = controller.cancel({ sessionId });
      const accepted = Boolean(value && value.accepted === true);
      pushStep('cancel', accepted ? '已发出中止信号' : '中止请求未被接受', accepted);
    } catch (error) {
      pushStep('cancel', error instanceof Error ? error.message : String(error), false);
    }
  }

  const jobs = hostService('jobs');
  if (!jobs) {
    pushStep('jobs', 'jobs 服务不可用', false);
  } else {
    try {
      const views = jobs.list(sessionId) || [];
      let requested = 0;
      for (const view of views) {
        const id = view && (view.id ?? view.jobId);
        if (!id) continue;
        try {
          if (jobs.kill(id, sessionId, 'force-stop') === 'requested') requested += 1;
        } catch { /* 单个任务失败不影响其余 */ }
      }
      pushStep('jobs', '后台任务 ' + views.length + ' 个，已请求终止 ' + requested + ' 个', true);
    } catch (error) {
      pushStep('jobs', error instanceof Error ? error.message : String(error), false);
    }
  }

  const agents = hostService('agents');
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;

  if (!agent) {
    pushStep('terminals', '该会话没有常驻 Agent，跳过', true);
  } else {
    const resolved = resolveTerminals(agent);
    if (resolved.terminals) {
      try {
        const sessions = resolved.terminals.list(agent) || [];
        let killed = 0;
        for (const item of sessions) {
          const id = item && (item.id ?? item.terminalId ?? item.sessionId);
          if (!id) continue;
          try {
            await resolved.terminals.kill(agent, id, 'force-stop');
            killed += 1;
          } catch { /* 单个终端失败不影响其余 */ }
        }
        pushStep('terminals', '终端 ' + sessions.length + ' 个，已终止 ' + killed + ' 个（来源 ' + resolved.source + '）', true);
      } catch (error) {
        pushStep('terminals', error instanceof Error ? error.message : String(error), false);
      }
    } else {
      // 最后兜底：Web 终端控制器（侧边栏终端），不是模型 shell，但能关掉界面上的终端会话
      const controller = hostService('terminalController');
      if (!controller || typeof controller.list !== 'function' || typeof controller.close !== 'function') {
        pushStep('terminals', 'terminals 服务不可用（根、Agent 作用域、控制器都没有）', false);
      } else {
        try {
          const list = controller.list(sessionId) || [];
          let closed = 0;
          for (const item of list) {
            const id = item && (item.id ?? item.terminalId);
            if (!id) continue;
            try { await controller.close(agent, id); closed += 1; } catch { /* 单个失败忽略 */ }
          }
          pushStep('terminals', '终端控制器关闭 ' + closed + '/' + list.length + ' 个（来源 terminalController）', true);
        } catch (error) {
          pushStep('terminals', error instanceof Error ? error.message : String(error), false);
        }
      }
    }
  }

  const subagents = hostService('subagents');
  if (!subagents) {
    pushStep('subagents', 'subagents 服务不可用', false);
  } else {
    try {
      const children = (await subagents.listChildren(sessionId)) || [];
      let interrupted = 0;
      for (const child of children) {
        const id = child && child.id;
        if (!id) continue;
        try {
          subagents.interrupt(id, { kind: 'user', parentSessionId: sessionId });
          interrupted += 1;
        } catch { /* 单个子代理失败不影响其余 */ }
      }
      pushStep('subagents', '子代理 ' + children.length + ' 个，已中断 ' + interrupted + ' 个', true);
    } catch (error) {
      pushStep('subagents', error instanceof Error ? error.message : String(error), false);
    }
  }

  turnClockCache.delete(sessionId);
  return { steps };
}

export async function readState() {
  const file = patchPath();
  const exists = existsSync(file);
  const text = exists ? await fs.readFile(file, 'utf8') : '';
  return {
    enabled: !text.includes(BLOCK_START),
    globalRules: text.includes(RULES_START),
    awakening: text.includes(AWAKENING_MARKER),
    awakeningPath: AWAKENING_FILE,
    rulesPath: RULES_FILE,
    ...(await readNativeSettings()),
    balanceBadge: await readBalanceBadge(),
    balanceIntervalMinutes: await readBalanceInterval(),
    forceStop: await readForceStopEnabled(),
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
 * 读规则源文件并压成单行：去 BOM、逐行 trim、丢空行、空格连接、压掉连续空白。
 * persona.prefix 是单引号 YAML 标量，不能带换行，所以只能单行化。
 */
export async function readRulesText() {
  const raw = await fs.readFile(RULES_FILE, 'utf8');
  const oneLine = raw
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/[ \t]+/g, ' ');
  return oneLine.length > RULES_LIMIT ? oneLine.slice(0, RULES_LIMIT) : oneLine;
}

/** 规则源的元信息（设置页卡片用），文件缺失不抛错 */
export async function readRulesInfo() {
  try {
    const raw = await fs.readFile(RULES_FILE, 'utf8');
    const text = await readRulesText();
    return {
      path: RULES_FILE,
      exists: true,
      sourceBytes: Buffer.byteLength(raw, 'utf8'),
      sourceLines: raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim()).length,
      injectedChars: text.length,
      truncated: text.length >= RULES_LIMIT,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: RULES_FILE, exists: false, sourceBytes: 0, sourceLines: 0, injectedChars: 0, truncated: false };
    }
    throw error;
  }
}

/** 开关「全局规则」：开 = 三个 prefix 行尾挂标记块，关 = 精确移除标记块，其余字符不动。 */
export async function writeGlobalRules(enabled) {
  const file = patchPath();
  if (!existsSync(file)) throw new Error('找不到 profile patch：' + file);

  const text = await fs.readFile(file, 'utf8');
  if (text.includes(AWAKENING_MARKER)) throw new Error('请先关闭觉醒模式，再修改全局规则');
  const withoutBlock = text.replace(RULES_RE, '');
  let next = withoutBlock;

  if (enabled) {
    const body = await readRulesText();
    if (!body) throw new Error('规则源文件为空：' + RULES_FILE);
    const block = ' ' + RULES_START + ' ' + body + ' ' + RULES_END;
    let hit = 0;
    next = withoutBlock.replace(PERSONA_PREFIX_LINE_RE, (line) => {
      hit += 1;
      return line + block;
    });
    if (hit === 0) throw new Error('补丁里没找到 persona 的 prefix 行，未做任何改动');
  }

  if (next === text) return { changed: false, backup: null, injectedPrefixes: enabled ? 3 : 0 };

  const bak = file + '.bak-lqconfig-' + stamp();
  await fs.copyFile(file, bak);
  await fs.writeFile(file, next, 'utf8');
  return { changed: true, backup: bak, injectedPrefixes: enabled ? 3 : 0 };
}

function awakeningRanges(text, active) {
  const found = [];
  const starts = [...text.matchAll(/^- id: preset-(standard|ptc|cordis)\r?$/gm)];
  for (const preset of AWAKENING_PRESETS) {
    const start = starts.find(match => match[1] === preset);
    if (!start) throw new Error('补丁缺少 Agent 预设：' + preset);
    const next = text.indexOf('\n- id:', start.index + start[0].length);
    const end = next < 0 ? text.length : next + 1;
    const section = text.slice(start.index, end);
    const expression = active
      ? /^ {10}prefix: \|- # dsh-lqconfig:awakening\r?\n(?: {12}[^\r\n]*(?:\r?\n|$))*/gm
      : /^ {10}prefix: [^\r\n]*(?:\r?\n|$)/gm;
    const matches = [...section.matchAll(expression)];
    if (matches.length !== 1) throw new Error('预设 ' + preset + ' 的 persona.prefix 状态异常，未做任何改动');
    found.push({ preset, start: start.index + matches[0].index, end: start.index + matches[0].index + matches[0][0].length, original: matches[0][0] });
  }
  return found;
}

function replaceAwakeningRanges(text, ranges, replacement) {
  let next = text;
  for (const range of [...ranges].reverse()) {
    next = next.slice(0, range.start) + replacement(range) + next.slice(range.end);
  }
  return next;
}

export async function writeAwakening(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  const file = patchPath();
  if (!existsSync(file)) throw new Error('找不到 profile patch：' + file);
  const text = await fs.readFile(file, 'utf8');
  const active = text.includes(AWAKENING_MARKER);
  if (active === enabled) return { changed: false, backup: null };

  let next;
  if (enabled) {
    const source = (await fs.readFile(AWAKENING_FILE, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd();
    if (!source.trim()) throw new Error('觉醒模式提示词文件为空');
    const ranges = awakeningRanges(text, false);
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const block = '          prefix: |- ' + AWAKENING_MARKER + newline
      + source.split('\n').map(line => '            ' + line).join(newline) + newline;
    next = replaceAwakeningRanges(text, ranges, () => block);
    const snapshot = { version: 1, prefixes: Object.fromEntries(ranges.map(range => [range.preset, range.original])) };
    const bak = file + '.bak-lqconfig-' + stamp();
    await fs.copyFile(file, bak);
    await fs.writeFile(AWAKENING_SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    await fs.writeFile(file, next, 'utf8');
    return { changed: true, backup: bak };
  }

  const snapshot = JSON.parse(await fs.readFile(AWAKENING_SNAPSHOT, 'utf8'));
  if (snapshot.version !== 1 || !snapshot.prefixes || AWAKENING_PRESETS.some(preset => typeof snapshot.prefixes[preset] !== 'string')) {
    throw new Error('觉醒模式原提示词快照无效，未做任何改动');
  }
  const ranges = awakeningRanges(text, true);
  next = replaceAwakeningRanges(text, ranges, range => snapshot.prefixes[range.preset]);
  const bak = file + '.bak-lqconfig-' + stamp();
  await fs.copyFile(file, bak);
  await fs.writeFile(file, next, 'utf8');
  return { changed: true, backup: bak };
}

/**
 * 提示词源文件的「更新入口」：在资源管理器中打开所在目录并选中源文件。
 * target = 'awakening' → AWAKENING-PROMPT.txt；'rules' → GLOBAL-RULES.md。
 * 只做定位，不改任何内容；改完文本后由用户自行拨开关或点「重新注入」。
 */
const REVEAL_TARGETS = { awakening: AWAKENING_FILE, rules: RULES_FILE };

export async function revealPromptSource(target) {
  if (!Object.prototype.hasOwnProperty.call(REVEAL_TARGETS, target)) {
    throw new Error('target 只能是 awakening 或 rules');
  }
  const file = REVEAL_TARGETS[target];
  if (!existsSync(file)) throw new Error('源文件不存在：' + file);
  if (process.platform !== 'win32') throw new Error('当前平台不支持资源管理器定位：' + process.platform);
  // explorer 的 /select 需整段作为一个参数；即使成功也可能返回退出码 1，故不校验退出码
  spawn('explorer.exe', ['/select,' + file], { detached: true, stdio: 'ignore' }).unref();
  return { target, path: file, dir: path.dirname(file) };
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
  const args = [helper, exe];
  const child = spawn(process.execPath, args, {
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
  pluginContext = ctx;
  ctx.effect(() => () => { if (pluginContext === ctx) pluginContext = null; }, 'dsh-lqconfig: host context');
  // 插件卸载时停掉内核，避免遗留孤儿进程
  ctx.effect(() => () => { proxy.stopSync(); }, 'dsh-lqconfig: proxy cleanup');


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
            if (req.method === 'GET' && route === '/api/balance') {
              return sendJson(res, 200, await readBalance());
            }
            if (req.method === 'POST' && route === '/api/balance-enabled') {
              const body = await readBody(req);
              if (typeof body.enabled !== 'boolean') {
                return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
              }
              return sendJson(res, 200, { ok: true, ...(await writeBalanceBadge(body.enabled)) });
            }
            if (req.method === 'POST' && route === '/api/balance-interval') {
              const body = await readBody(req);
              try {
                return sendJson(res, 200, { ok: true, ...(await writeBalanceInterval(body.minutes)) });
              } catch (error) {
                return sendJson(res, 400, {
                  ok: false,
                  error: String(error && error.message ? error.message : error),
                });
              }
            }
            if (req.method === 'POST' && route === '/api/set') {
              const body = await readBody(req);
              if (typeof body.enabled !== 'boolean') {
                return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
              }
              const result = await writeEnabled(body.enabled);
              return sendJson(res, 200, { ok: true, ...result, ...(await readState()) });
            }
            if (req.method === 'GET' && route === '/api/global-rules') {
              const info = await readRulesInfo();
              const text = await fs.readFile(patchPath(), 'utf8');
              return sendJson(res, 200, { ok: true, ...info, enabled: text.includes(RULES_START) });
            }
            if (req.method === 'POST' && route === '/api/global-rules') {
              const body = await readBody(req);
              if (typeof body.enabled !== 'boolean') {
                return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
              }
              const result = await writeGlobalRules(body.enabled);
              return sendJson(res, 200, { ok: true, ...result, ...(await readState()) });
            }
            if (req.method === 'POST' && route === '/api/global-rules/sync') {
              const result = await writeGlobalRules(true);
              return sendJson(res, 200, { ok: true, ...result, ...(await readState()) });
            }
            if (req.method === 'POST' && route === '/api/awakening') {
              const body = await readBody(req);
              if (typeof body.enabled !== 'boolean') {
                return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
              }
              const result = await writeAwakening(body.enabled);
              return sendJson(res, 200, { ok: true, ...result, ...(await readState()) });
            }
            if (req.method === 'POST' && route === '/api/reveal') {
              const body = await readBody(req);
              try {
                return sendJson(res, 200, { ok: true, ...(await revealPromptSource(body.target)) });
              } catch (error) {
                return sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
              }
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
            if (req.method === 'GET' && route === '/api/diag') {
              const names = ['sessionController', 'jobs', 'terminals', 'agents', 'subagents', 'agentPresets', 'terminalController', 'approval'];
              const services = {};
              for (const name of names) services[name] = Boolean(hostService(name));
              const sessionId = url.searchParams.get('sessionId') || '';
              let scope = null;
              if (isSessionId(sessionId)) {
                const agents = hostService('agents');
                const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
                scope = { agent: Boolean(agent), terminalsSource: agent ? resolveTerminals(agent).source : '' };
              }
              return sendJson(res, 200, { ok: true, services, scope });
            }
            if (req.method === 'GET' && route === '/api/turn-clock') {
              const sessionId = url.searchParams.get('sessionId') || '';
              if (!isSessionId(sessionId)) return sendJson(res, 400, { ok: false, error: 'sessionId 无效' });
              return sendJson(res, 200, { ok: true, ...(await readTurnClock(sessionId)) });
            }
            if (req.method === 'POST' && route === '/api/force-stop') {
              const body = await readBody(req);
              if (!isSessionId(body.sessionId)) return sendJson(res, 400, { ok: false, error: 'sessionId 无效' });
              const result = await forceStopSession(body.sessionId);
              return sendJson(res, 200, { ok: true, sessionId: body.sessionId, ...result });
            }
            if (req.method === 'POST' && route === '/api/force-stop-setting') {
              const body = await readBody(req);
              if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
              return sendJson(res, 200, { ok: true, ...(await writeForceStopEnabled(body.enabled)), ...(await readState()) });
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

