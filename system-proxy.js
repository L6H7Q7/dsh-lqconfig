/**
 * dsh-lqconfig — 系统代理（Windows 注册表）读写 + 看门狗进程管理
 *
 * 设计原则：
 *   - 本模块只负责「系统代理开关」和「看门狗生命周期」
 *   - 不碰 mihomo 内核本身（内核由 proxy.js 管，跟着 DSH 走）
 *   - 看门狗只做「内核消失 → 还原系统代理 → 2 秒后退出」，永不主动开启
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.join(HERE, 'scripts');
const SYS_PROXY_PS = path.join(SCRIPT_DIR, 'system-proxy.ps1');
const WATCH_PS = path.join(SCRIPT_DIR, 'watch-proxy.ps1');
const DATA_DIR = path.join(HERE, 'proxy-data');
const WATCH_PID = path.join(DATA_DIR, 'watch.pid');
const WATCH_STOP = path.join(DATA_DIR, 'watch.stop');

const PWSH = (() => {
  const abs = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  return existsSync(abs) ? abs : 'pwsh';
})();

function runPs(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PWSH, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
    ], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error((err || out).trim() || ('exit code ' + code)));
    });
  });
}

function runPwshCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error((err || out).trim() || ('exit code ' + code)));
    });
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readWatchPid() {
  try {
    const raw = await fs.readFile(WATCH_PID, 'utf8');
    const pid = Number(String(raw).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/** 内存缓存：避免前端每次轮询都起一次 PowerShell */
let cachedStatus = null;

/** 系统代理当前状态（实时查） */
export async function systemProxyStatus() {
  try {
    const text = await runPs(SYS_PROXY_PS, ['-Action', 'status']);
    const parsed = JSON.parse(text);
    cachedStatus = parsed;
    return parsed;
  } catch {
    return cachedStatus;
  }
}

/** 最近一次已知状态（不产生子进程），给 /proxy/state 用 */
export function getCachedSystemProxy() {
  return cachedStatus;
}

/** 打开系统代理开关，指向 127.0.0.1:<port> */
export async function enableSystemProxy(port = 7910) {
  const result = await runPs(SYS_PROXY_PS, ['-Action', 'enable', '-Port', String(port)]);
  cachedStatus = { ProxyEnable: 1, ProxyServer: '127.0.0.1:' + port, enabled: true };
  return result;
}

/** 还原系统代理（恢复到备份值） */
export async function disableSystemProxy() {
  const result = await runPs(SYS_PROXY_PS, ['-Action', 'disable']);
  cachedStatus = { enabled: false };
  return result;
}

/** 同步版还原：只在插件销毁 / 进程退出这种必须「做完再走」的场合使用 */
export function disableSystemProxySync() {
  try {
    execFileSync(PWSH, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SYS_PROXY_PS, '-Action', 'disable',
    ], { windowsHide: true, timeout: 8000 });
    cachedStatus = { enabled: false };
    return true;
  } catch {
    return false;
  }
}

/** 看门狗是否在跑 */
export async function isWatchdogRunning() {
  const pid = await readWatchPid();
  return Boolean(pid && isAlive(pid));
}

/**
 * 启动看门狗（独立进程，DSH 退出后仍存活）
 * 注意：Windows 上 detached:true 会让 pwsh 立刻以 code 0 退出（实测），
 *       所以必须用 Start-Process 派生，再让它脱离父进程。
 */
export async function startWatchdog() {
  if (await isWatchdogRunning()) return 'already-running';
  try { await fs.unlink(WATCH_STOP); } catch { /* 不存在 */ }
  const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const argList = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WATCH_PS].map(quote).join(',');
  const command = '$p = Start-Process -FilePath ' + quote(PWSH)
    + ' -ArgumentList ' + argList
    + ' -WindowStyle Hidden -PassThru; if ($null -eq $p) { exit 1 } else { $p.Id }';
  await runPwshCommand(command);
  return 'started';
}

/** 让看门狗在下一次循环时退出 */
export async function stopWatchdog() {
  try {
    await fs.writeFile(WATCH_STOP, 'stop', 'utf8');
    return 'signaled';
  } catch (error) {
    return 'failed: ' + (error && error.message ? error.message : error);
  }
}

/**
 * 同步系统代理到「内核是否在跑」：内核在 → 开，内核不在 → 关。
 * 手动开关按钮也走这里（内核没死时不会被误还原）。
 */
export async function syncSystemProxyToKernel(running, port = 7910) {
  if (running) return enableSystemProxy(port);
  return disableSystemProxy();
}
