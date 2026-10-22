/**
 * dsh-lqconfig 重启助手（独立进程）
 *
 * 为什么要有这个文件：
 *   面板里的「重启」原来让 wscript 起 cmd，cmd 再 start exe。cmd 继承了宿主进程的
 *   环境，而宿主是 ELECTRON_RUN_AS_NODE=1 起的纯 Node 进程；EXE 拿到这个变量就
 *   以 Node 模式启动 —— 没有窗口、立刻退出，表现为「只关闭不打开」。
 *   这里先把环境洗干净（删 ELECTRON_RUN_AS_NODE、补 DSH_PROFILE），再拉 EXE。
 *
 * 参数：argv[2] = exe 路径
 * 环境：LQC_DRY=1 只写日志不真的杀/起，用于自检。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.argv[2] || '';
const dry = process.env.LQC_DRY === '1';
const logPath = path.join(process.env.TEMP || os.tmpdir(), 'dsh-lqconfig-restart.log');

function log(msg) {
  try { fs.appendFileSync(logPath, new Date().toISOString() + ' ' + msg + '\n'); } catch { /* ignore */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue;
    if (key.toUpperCase() === 'DSH_PERMISSION_MODE') continue;
    if (key.toUpperCase() === 'LQC_DRY') continue;
    env[key] = value;
  }
  if (!env.DSH_PROFILE) env.DSH_PROFILE = 'desktop';
  return env;
}

async function killAll(image) {
  try {
    execFileSync('taskkill', ['/f', '/im', image], { stdio: 'ignore', windowsHide: true });
    log('kill ok: ' + image);
  } catch (error) {
    log('kill skipped: ' + image + ' (' + String(error && error.message ? error.message : error).slice(0, 120) + ')');
  }
}

async function main() {
  log('helper start exe=' + exe + ' dry=' + dry);
  await sleep(2000);
  if (!exe || !fs.existsSync(exe)) {
    log('ERROR exe missing: ' + exe);
    return;
  }
  if (dry) {
    const env = cleanEnv();
    log('DRY would kill mihomo + DeepSeek Harness.exe, then launch with ELECTRON_RUN_AS_NODE=' +
      (env.ELECTRON_RUN_AS_NODE === undefined ? 'removed' : 'STILL SET') + ' DSH_PROFILE=' + env.DSH_PROFILE + ' cwd=' + path.dirname(exe));
    return;
  }
  await killAll('mihomo.exe');
  await killAll('DeepSeek Harness.exe');
  await sleep(600);
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false, env: cleanEnv(), cwd: path.dirname(exe) });
    child.unref();
    log('spawn ok pid=' + child.pid);
  } catch (error) {
    log('ERROR spawn: ' + String(error && error.message ? error.message : error));
  }
}

await main();
