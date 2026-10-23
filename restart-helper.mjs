/**
 * dsh-lqconfig 重启助手（独立进程）
 *
 * 为什么要有这个文件：
 *   面板里的「重启」原来让 wscript 起 cmd，cmd 再 start exe。cmd 继承了宿主进程的
 *   环境，而宿主是 ELECTRON_RUN_AS_NODE=1 起的纯 Node 进程；EXE 拿到这个变量就
 *   以 Node 模式启动 —— 没有窗口、立刻退出，表现为「只关闭不打开」。
 *   这里先把环境洗干净（删 ELECTRON_RUN_AS_NODE、补 DSH_PROFILE），再拉 EXE。
 *
 * 为什么按 PID 杀、不用 taskkill /f /im：
 *   本助手自己是 process.execPath（= DeepSeek Harness.exe）以 Node 模式跑的，
 *   镜像名同样是 "DeepSeek Harness.exe"。用 taskkill /f /im 会连助手自己一起杀掉，
 *   后面的 spawn 永远走不到 —— 依旧「只关闭不重启」（旧版就是这么坏的）。
 *   所以改成：先 tasklist 枚举 PID，排除本进程，再按 PID 逐个 kill。
 *
 * 换包（--swap-asar）：
 *   超限模式（dsh-purge）把补丁写进 resources\app，但官方包仍从 resources\app.asar
 *   加载，必须先用退出状态把 app.asar 挪成 app.asar.bak，下次才加载 resources\app。
 *   命名沿用 purge 自己的约定（app.asar.bak）。挪之前先校验解包树完整，起不来就
 *   把 .bak 改回原名再拉一次，保证不会出现「换包后打不开」。
 *
 * 参数：
 *   argv[2]             = exe 路径
 *   --swap-asar=<asar>  = 需要换包时传，换失败或起不来会自动回滚
 *   环境 LQC_DRY=1       = 只写日志不真的杀/起，用于自检
 *   --self-test-swap     = 用临时目录自检换包/回滚逻辑（不动真实安装）
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rawArgs = process.argv.slice(2);
let exe = '';
let swapAsar = '';
let selfTestSwap = false;
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--self-test-swap') selfTestSwap = true;
  else if (arg === '--swap-asar') swapAsar = rawArgs[i + 1] || '';
  else if (arg.startsWith('--swap-asar=')) swapAsar = arg.slice('--swap-asar='.length);
  else if (!exe && !arg.startsWith('--')) exe = arg;
}
const dry = process.env.LQC_DRY === '1';
const logPath = path.join(process.env.TEMP || os.tmpdir(), 'dsh-lqconfig-restart.log');

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  try { fs.appendFileSync(logPath, line + '\n'); } catch { /* ignore */ }
  if (selfTestSwap) console.log(line);
}

function shorten(error) {
  const text = String(error && error.message ? error.message : error);
  return text.split(/\r?\n/)[0].slice(0, 160);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper === 'ELECTRON_RUN_AS_NODE') continue;
    if (upper === 'DSH_PERMISSION_MODE') continue;
    if (upper === 'LQC_DRY') continue;
    env[key] = value;
  }
  if (!env.DSH_PROFILE) env.DSH_PROFILE = 'desktop';
  return env;
}

/** 按镜像名取 PID 列表，永远排除本进程（本进程镜像名就是 DeepSeek Harness.exe）。 */
function listPids(image) {
  try {
    // spawnSync 而不是 execFileSync：没有匹配进程时 tasklist 返回 1，execFileSync 会抛异常
    const out = spawnSync('tasklist', ['/fi', 'imagename eq ' + image, '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    }).stdout || '';
    const pids = [];
    for (const raw of out.split(/\r?\n/)) {
      const match = /^"([^"]+)","(\d+)"/.exec(raw.trim());
      if (!match) continue;
      if (match[1].toLowerCase() !== image.toLowerCase()) continue;
      const pid = Number(match[2]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.push(pid);
    }
    return pids;
  } catch (error) {
    log('list failed: ' + image + ' (' + shorten(error) + ')');
    return [];
  }
}

function killPids(image) {
  const pids = listPids(image);
  if (pids.length === 0) {
    log('kill skipped: ' + image + ' (no pid besides self ' + process.pid + ')');
    return [];
  }
  log('kill ' + image + ' pids=' + pids.join(',') + ' (skip self ' + process.pid + ')');
  const killed = [];
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/f', '/pid', String(pid)], { stdio: 'ignore', windowsHide: true });
      killed.push(pid);
      log('kill ok: pid ' + pid);
    } catch (error) {
      log('kill failed: pid ' + pid + ' (' + shorten(error) + ')');
    }
  }
  return killed;
}

/** resources\app 是否是一份能启动的解包树；不完整就不换包，免得换完打不开。 */
function unpackedTreeLookRunnable(asar) {
  const appDir = path.join(path.dirname(asar), 'app');
  const needed = [
    path.join(appDir, 'package.json'),
    path.join(appDir, 'lib', 'main.js'),
    path.join(appDir, 'dsh', 'package.json'),
  ];
  const missing = needed.filter((fp) => {
    try { return !fs.statSync(fp).isFile(); } catch { return true; }
  });
  // app.asar.unpacked 里可能有 asar 解出来时没带的原生件；缺了就别换包，
  // 免得宿主换到 resources\app 后加载不了 native addon。
  const nativeMarker = path.join(appDir, 'dsh', 'node_modules', 'node-addon-require-builtin-win32-x64-msvc',
    'prebuilt', 'win32-x64-msvc-napi-v9.node');
  const unpackedRoot = asar + '.unpacked';
  let unpackedHasNative = false;
  try { unpackedHasNative = fs.statSync(path.join(unpackedRoot, 'dsh')).isDirectory(); } catch { unpackedHasNative = false; }
  let markerThere = false;
  try { markerThere = fs.statSync(nativeMarker).isFile(); } catch { markerThere = false; }
  if (unpackedHasNative && !markerThere) {
    return { ok: false, appDir, missing: [nativeMarker] };
  }
  return { ok: missing.length === 0, appDir, missing };
}

async function swapAsarAside(asar) {
  if (!asar) return { done: false, reason: 'no-asar' };
  let exists = false;
  try { exists = fs.statSync(asar).isFile(); } catch { exists = false; }
  if (!exists) return { done: false, reason: 'asar-missing' };
  const tree = unpackedTreeLookRunnable(asar);
  if (!tree.ok) {
    return { done: false, reason: 'unpacked-tree-incomplete', missing: tree.missing };
  }
  const bak = asar + '.bak';
  try { if (fs.existsSync(bak)) fs.rmSync(bak, { force: true }); } catch { /* 旧备份删不掉就再试 */ }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fs.renameSync(asar, bak);
      log('swap ok: ' + asar + ' -> ' + bak);
      return { done: true, asar, bak };
    } catch (error) {
      if (attempt === 39) {
        log('swap failed: ' + shorten(error));
        return { done: false, reason: 'locked' };
      }
      await sleep(250);
    }
  }
  return { done: false, reason: 'unknown' };
}

function restoreAsar(swapped) {
  if (!swapped || !swapped.done) return false;
  try {
    if (!fs.existsSync(swapped.asar) && fs.existsSync(swapped.bak)) {
      fs.renameSync(swapped.bak, swapped.asar);
      log('swap rollback: asar restored from ' + swapped.bak);
      return true;
    }
  } catch (error) {
    log('swap rollback failed: ' + shorten(error));
  }
  return false;
}

function launchViaSpawn() {
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: cleanEnv(),
    cwd: path.dirname(exe),
  });
  child.unref();
  log('spawn ok pid=' + child.pid);
}

function launchViaShell() {
  // cmd.exe 不是 DSH 镜像名，且拿的是洗过的 env，不会重演「只关闭不打开」
  spawn('cmd.exe', ['/c', 'start "" "' + exe + '"'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: cleanEnv(),
    cwd: path.dirname(exe),
  }).unref();
  log('fallback: cmd /c start');
}

async function selfTest() {
  const root = path.join(os.tmpdir(), 'lqc-swap-selftest-' + process.pid);
  const asar = path.join(root, 'app.asar');
  try {
    fs.mkdirSync(path.join(root, 'app', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'app', 'dsh'), { recursive: true });
    fs.writeFileSync(asar, 'fake-asar');
    fs.writeFileSync(path.join(root, 'app', 'package.json'), '{"main":"lib/main.js"}');
    fs.writeFileSync(path.join(root, 'app', 'lib', 'main.js'), '// fake');
    fs.writeFileSync(path.join(root, 'app', 'dsh', 'package.json'), '{}');
    const swapped = await swapAsarAside(asar);
    const movedOut = swapped.done && !fs.existsSync(asar) && fs.existsSync(asar + '.bak');
    const restored = restoreAsar(swapped) && fs.existsSync(asar) && !fs.existsSync(asar + '.bak');
    log('self-test swap: movedOut=' + movedOut + ' restored=' + restored + ' reason=' + (swapped.reason || 'ok'));
    return movedOut && restored;
  } catch (error) {
    log('self-test error: ' + shorten(error));
    return false;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结果 */ }
  }
}

async function main() {
  if (selfTestSwap) {
    const ok = await selfTest();
    process.exit(ok ? 0 : 1);
  }
  log('helper start exe=' + exe + ' dry=' + dry + ' swapAsar=' + (swapAsar || '-') + ' self=' + process.pid);
  await sleep(2000);
  if (!exe || !fs.existsSync(exe)) {
    log('ERROR exe missing: ' + exe);
    return;
  }
  if (dry) {
    const env = cleanEnv();
    const tree = swapAsar ? unpackedTreeLookRunnable(swapAsar) : null;
    log('DRY would kill mihomo pids=[' + listPids('mihomo.exe').join(',') + ']' +
      ' dsh pids=[' + listPids('DeepSeek Harness.exe').join(',') + '] (skip self ' + process.pid + '),' +
      ' swap=' + (swapAsar ? (fs.existsSync(swapAsar) ? 'yes' : 'asar-missing') + ' treeOk=' + (tree && tree.ok) : 'no') +
      ', launch with ELECTRON_RUN_AS_NODE=' +
      (env.ELECTRON_RUN_AS_NODE === undefined ? 'removed' : 'STILL SET') +
      ' DSH_PROFILE=' + env.DSH_PROFILE + ' cwd=' + path.dirname(exe));
    return;
  }

  killPids('mihomo.exe');
  killPids('DeepSeek Harness.exe');
  await sleep(1500);

  let swapped = { done: false };
  if (swapAsar) {
    swapped = await swapAsarAside(swapAsar);
    if (!swapped.done) log('swap skipped: ' + (swapped.reason || 'unknown'));
  }

  try { launchViaSpawn(); } catch (error) { log('ERROR spawn: ' + shorten(error)); }
  await sleep(3000);

  let alive = listPids('DeepSeek Harness.exe');
  // 换包后多看一眼：新树要能站住才算成功，秒退也算失败，回滚到 asar 再起。
  if (alive.length > 0 && swapped.done) {
    await sleep(4000);
    const still = listPids('DeepSeek Harness.exe');
    if (still.length === 0) {
      log('verify: 换包后的新实例 4s 内退出，判定失败');
      alive = []; 
    } else {
      alive = still;
    }
  }
  if (alive.length === 0 && swapped.done) {
    log('verify failed after swap; rolling asar back');
    restoreAsar(swapped);
    try { launchViaSpawn(); } catch (error) { log('ERROR respawn after rollback: ' + shorten(error)); }
    await sleep(3000);
    alive = listPids('DeepSeek Harness.exe');
  }
  if (alive.length === 0) {
    log('verify: 没有存活实例，走 cmd start 兜底');
    try { launchViaShell(); } catch (error) { log('ERROR fallback: ' + shorten(error)); }
    await sleep(4000);
    alive = listPids('DeepSeek Harness.exe');
  }
  log(alive.length > 0
    ? 'verify ok: dsh pids=' + alive.join(',')
    : 'verify FAILED: 没有存活实例，请手动点 restart-dsh.vbs');
}

await main();
