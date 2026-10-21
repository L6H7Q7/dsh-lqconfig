/**
 * visible-shell runner —— 零依赖的命令执行核心。
 *
 * visible=true：命令被写进临时脚本，由 Start-Process 放进一个可见的终端窗口执行，
 * 输出经 Tee-Object 落到日志文件，窗口关闭后由本模块读回（窗口里的 stdout
 * 无法直接回传，日志是唯一的回传通道）。
 * visible=false：与内置 pwsh 工具一致，隐藏进程直接执行。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 600000;

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* best effort */ }
}

/** Spawn one pwsh child, collect both streams, kill the whole tree on timeout/abort. */
export function runProcess(file, args, options = {}) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, Math.max(1, timeoutMs));
    const onAbort = () => { aborted = true; killTree(child.pid); };
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal && signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, timedOut, aborted, code: child.exitCode, ...extra });
    };
    if (signal) {
      if (signal.aborted) { finish(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout && child.stdout.setEncoding('utf8');
    child.stderr && child.stderr.setEncoding('utf8');
    child.stdout && child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr && child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += String((error && error.message) || error); finish(); });
    child.on('close', (code) => { finish({ code }); });
  });
}

/** Hidden execution: the switch is off, mirror the built-in executor's shape. */
export function runHiddenCommand({ command, cwd, timeoutMs, signal }) {
  return runProcess('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { cwd, timeoutMs, signal });
}

/** Visible execution: one console window, output tee'd to a log we read back. */
export async function runVisibleCommand({ command, cwd, timeoutMs, signal, title }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-visible-'));
  const logPath = path.join(dir, 'out.log');
  const codePath = path.join(dir, 'code.txt');
  const runPath = path.join(dir, 'run.ps1');
  const launchPath = path.join(dir, 'launch.ps1');
  try {
    const body = [
      "$ErrorActionPreference = 'Continue'",
      '$ProgressPreference = "SilentlyContinue"',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      '$Host.UI.RawUI.WindowTitle = ' + psQuote(title || 'DSH command'),
      '& {',
      command,
      '} *>&1 | Tee-Object -FilePath ' + psQuote(logPath) + ' | Out-Host',
      '$code = $global:LASTEXITCODE',
      'if ($null -eq $code) { $code = 0 }',
      'Set-Content -LiteralPath ' + psQuote(codePath) + ' -Value $code -Encoding ascii -NoNewline',
      'exit $code',
    ].join('\n');
    await writeFile(runPath, '\uFEFF' + body + '\n', 'utf8');
    const launch = [
      '$p = Start-Process -FilePath "pwsh" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ' +
        psQuote(runPath) + ') -WindowStyle Normal -Wait -PassThru',
      'exit $p.ExitCode',
    ].join('\n');
    await writeFile(launchPath, '\uFEFF' + launch + '\n', 'utf8');

    const settled = await runProcess('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchPath], {
      cwd, timeoutMs, signal,
    });

    let text = '';
    try { text = await readFile(logPath, 'utf8'); } catch { /* no output */ }
    let code = settled.code;
    try {
      const raw = (await readFile(codePath, 'utf8')).trim();
      if (raw !== '' && Number.isFinite(Number(raw))) code = Number(raw);
    } catch { /* keep spawned exit code */ }
    return { stdout: text, stderr: settled.stderr, code, timedOut: settled.timedOut, aborted: settled.aborted };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
