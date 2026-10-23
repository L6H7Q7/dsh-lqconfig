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
import { existsSync, writeFileSync, unlinkSync, appendFileSync, readFileSync, statSync } from 'node:fs';
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

/** 匹配 persona 块里 10 空格缩进的 prefix 行（中文约束挂在 prefix 上，不重复写 suffix） */
const PERSONA_PREFIX_LINE_RE = /^ {10}prefix: .*$/gm;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function patchPath() {
  return path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');
}

function exePath() {
  return process.env.DSH_DESKTOP_EXE || 'D:\\AI\\Agent\\DeepSeek Harness\\DeepSeek Harness.exe';
}

/** 官方桌面包的密封归档。它在的时候宿主加载的是它，而不是 resources\app。 */
function asarPath() {
  return path.join(path.dirname(exePath()), 'resources', 'app.asar');
}

/** 桌面宿主才做「杀进程 + 拉 exe」，网页/无头宿主没有这条链路。 */
function desktopRestartAvailable() {
  return process.platform === 'win32' && existsSync(exePath());
}

const DIAG_LOG = path.join(process.env.TEMP || os.tmpdir(), 'dsh-lqconfig-diag.log');

/** 重启决策写盘：出问题直接看这一行，不用猜。 */
function diag(event, data) {
  try {
    const payload = data === undefined ? '' : ' ' + JSON.stringify(data);
    appendFileSync(DIAG_LOG, new Date().toISOString() + ' ' + event + payload + '\n');
  } catch { /* 日志写不进去不该影响重启 */ }
}

/** 自动重启的防循环戳：同一份 app.asar 十分钟内只自动重启一次。 */
function autoRestartStampPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '.auto-restart.json');
}

function asarIdentity() {
  try {
    const stat = statSync(asarPath());
    return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  } catch { return null; }
}

async function fetchPurgeStatus() {
  if (!localPort) return null;
  try {
    const res = await fetch('http://127.0.0.1:' + localPort + '/dsh-purge/status');
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
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
    chainZh: text.includes(ZH_SUFFIX),
    purge: text.includes(PURGE_START),
    ...(await readNativeSettings()),
    balanceBadge: await readBalanceBadge(),
    balanceIntervalMinutes: await readBalanceInterval(),
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
 * 开关「思维链优先中文」：把约束追加到 persona 的 prefix 行尾，其余字符一律不动。
 * 打开 = 三个 preset 的 prefix 行尾追加一句；关闭 = 把那句删掉（兼容旧的 suffix 写法）。
 * 选择 prefix 而不是 suffix：prefix 在提示前段（身份区），suffix 排在 order 10200 的最尾部，
 * 长上下文里尾部约束更容易被稀释。
 */
export async function writeChainZh(enabled) {
  const file = patchPath();
  if (!existsSync(file)) throw new Error('找不到 profile patch：' + file);

  const text = await fs.readFile(file, 'utf8');
  const next = enabled
    ? text.replace(PERSONA_PREFIX_LINE_RE, (match) => (match.includes(ZH_SUFFIX) ? match : match + ' ' + ZH_SUFFIX))
    : text.split(' ' + ZH_SUFFIX).join('').split("'" + ZH_SUFFIX + "'").join("''");

  if (next === text) return { changed: false, backup: null };
  if (enabled && !next.includes(ZH_SUFFIX)) {
    throw new Error('补丁里没找到 persona 的 prefix 行，未做任何改动');
  }

  const bak = file + '.bak-lqconfig-' + stamp();
  await fs.copyFile(file, bak);
  await fs.writeFile(file, next, 'utf8');
  return { changed: true, backup: bak };
}

async function restartApp(options = {}) {
  const exe = exePath();
  if (!existsSync(exe)) throw new Error('找不到应用可执行文件：' + exe);

  // 旧写法（wscript → cmd → start exe）在宿主里必然把 EXE 起成纯 Node：
  // 宿主自己是 ELECTRON_RUN_AS_NODE=1 跑的，cmd 和 start 全继承这个变量，
  // 新实例没有窗口、立刻退出 —— 表现就是「只关闭不打开」。
  // 手动点 restart-dsh.vbs 正常，是因为它由 explorer 拉起，环境干净。
  // 现在交给独立助手进程：它自己以 Node 模式跑，拉起 EXE 前把变量洗掉。
  const helper = fileURLToPath(new URL('./restart-helper.mjs', import.meta.url));
  const args = [helper, exe];
  // 超限模式打完补丁后，补丁在 resources\app，宿主还在读 resources\app.asar：
  // 这一次重启顺手把 asar 挪成 .bak，下次启动加载的就是打过补丁的 resources\app。
  const swapAsar = options.swapAsar === true;
  if (swapAsar) args.push('--swap-asar=' + asarPath());
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(helper),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  return { exe, helper, pid: child.pid, swapAsar };
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

  // 统一重启入口：超限模式（dsh-purge）的「现在重启」也调这里，
  // 不再让 purge 自己那套 wscript / PowerShell / restart-desktop 各玩各的。
  if (desktopRestartAvailable()) {
    try {
      globalThis.__dshLqRestart = (options) => restartApp(options || {});
      ctx.effect(() => () => { try { delete globalThis.__dshLqRestart; } catch { /* 忽略 */ } }, 'dsh-lqconfig: restart hook');
    } catch { /* 没有全局对象也不影响自带面板 */ }
  }

  // 超限模式第二阶段：开关是把「挂载」写进 profile 的，插件要重启后才在进程里，
  // 所以补丁只能在这次启动后由这里调它自己的 /dsh-purge/apply。
  // 打完补丁必须重启才生效——这一次就是「启动时唯一的重启」，顺手把 app.asar 换掉，
  // 不再留着让面板弹「要现在重启吗」补第二次。
  if (hasPurgePending()) {
    const timer = setTimeout(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await callPurgeRoute('/dsh-purge/apply');
        if (result.ok) {
          markPurgePending(false);
          const data = result.data && typeof result.data === 'object' ? result.data : {};
          // complete 会因为 pattern_not_found 这类"不阻断"的失败变成 false（purge 自己
          // 也是这么设计的：promptReady 仍然允许重启）。所以这里只把真正阻断的失败算进去，
          // 否则就会出现「补丁已写盘、却永远不重启」，又退回弹窗让用户手点。
          const failedItems = Array.isArray(data.failed_items) ? data.failed_items : [];
          const blocking = failedItems.filter((item) => item && item.status && item.status !== 'pattern_not_found').length;
          const settled = data.ok !== false && blocking === 0;
          const swapAsar = settled && data.asar_still_sealed === true;
          const wantRestart = settled && (swapAsar || data.restarting === true || data.needs_full_quit === true);
          diag('apply.result', {
            ok: data.ok, complete: data.complete, restarting: data.restarting,
            needs_full_quit: data.needs_full_quit, asar_still_sealed: data.asar_still_sealed,
            applied: data.applied, already: data.already, failed: data.failed,
            blocking, settled, swapAsar, wantRestart,
          });
          if (wantRestart) {
            await new Promise((resolve) => { const t = setTimeout(resolve, 1500); t.unref?.(); });
            diag('apply.restart', { swapAsar });
            try {
              await restartApp({ swapAsar });
            } catch (error) {
              diag('apply.restart.error', { error: String(error && error.message ? error.message : error) });
            }
          }
          return;
        }
        await new Promise((resolve) => { const t = setTimeout(resolve, 3000); t.unref?.(); });
      }
      try { ctx.logger?.warn?.('[dsh-lqconfig] 超限模式补丁应用失败：插件路由一直没就绪'); } catch { /* 忽略 */ }
    }, 6000);
    timer.unref?.();
    ctx.effect(() => () => clearTimeout(timer), 'dsh-lqconfig: purge apply');
  }

  // 兜底自愈：若这次启动后 purge 仍挂着 boot_full_quit（补丁在 resources\app、
  // 但宿主还在读 app.asar），就直接把这一次"换包重启"做掉，不再留给面板弹窗让用户点。
  // 走 purge 自己的 /dsh-purge/restart（它用 ensureRestartReady 把关），而该路由已经
  // 优先转给本插件的 __dshLqRestart，所以执行端始终是同一个 helper。
  // 防循环：同一份 asar 十分钟内只自动重启一次；换包成功后 asar 不在了，条件自然消失。
  // 紧急停用：这个自愈在 asar 状态判断失灵时会变成"每 20 秒重启一次"。
  // 默认关闭，只有显式设了 LQC_AUTO_HEAL=1 才跑。
  const healTimer = process.env.LQC_AUTO_HEAL === '1' ? setTimeout(async () => {
    if (!desktopRestartAvailable() || hasPurgePending()) return;
    try {
      const status = await fetchPurgeStatus();
      if (!status) return;
      // 条件不是只看 boot_full_quit：补丁已经写进 resources\app、asar 还在，
      // 这两种情形都意味着"宿主还在跑旧包"，那就该换包重启一次。
      const sealed = status.asar_still_sealed === true;
      const appliedCount = Number(status.patches_applied) || 0;
      if (!sealed || appliedCount <= 0) {
        diag('heal.skip', { reason: sealed ? 'no-patches' : 'unsealed', appliedCount, bootFullQuit: status.boot_full_quit });
        return;
      }
      const identity = asarIdentity();
      if (!identity) {
        diag('heal.skip', { reason: 'no-asar' });
        return;
      }
      let stamp = null;
      try { stamp = JSON.parse(readFileSync(autoRestartStampPath(), 'utf8')); } catch { stamp = null; }
      const sameAsar = stamp && stamp.size === identity.size && stamp.mtimeMs === identity.mtimeMs;
      if (sameAsar && Date.now() - Number(stamp.at || 0) < 10 * 60 * 1000) {
        diag('heal.skip', { reason: 'recent', identity });
        return;
      }
      writeFileSync(autoRestartStampPath(), JSON.stringify({ at: Date.now(), ...identity }), 'utf8');
      diag('heal.restart', { identity });
      const planned = await callPurgeRoute('/dsh-purge/restart');
      diag('heal.result', planned && planned.data ? planned.data : { ok: planned.ok, error: planned.error });
    } catch (error) {
      diag('heal.error', { error: String(error && error.message ? error.message : error) });
    }
  }, 14000) : null;
  healTimer?.unref?.();
  ctx.effect(() => () => clearTimeout(healTimer), 'dsh-lqconfig: restart self heal');

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
              let stamp = null;
              try { stamp = JSON.parse(readFileSync(autoRestartStampPath(), 'utf8')); } catch { stamp = null; }
              return sendJson(res, 200, {
                ok: true,
                purgePending: hasPurgePending(),
                asar: asarIdentity(),
                desktopRestart: desktopRestartAvailable(),
                unifiedHook: typeof globalThis.__dshLqRestart === 'function',
                lastAutoRestart: stamp,
                diagLog: DIAG_LOG,
              });
            }
            if (req.method === 'POST' && route === '/api/restart') {
              const body = await readBody(req);
              return sendJson(res, 200, { ok: true, ...(await restartApp({ swapAsar: body.swapAsar === true })) });
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

