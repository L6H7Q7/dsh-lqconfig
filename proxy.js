/**
 * dsh-lqconfig —— 代理模块（宿主侧）
 *
 * 官方 mihomo 内核 + 机场订阅，给 DSH 一个「按需启动」的本地代理：
 *   - 订阅由本模块拉取解析，节点写到 proxy-data/providers/zhuiyun.yaml
 *   - 偏好是有序地区数组，如 ["日本","新加坡"]：先在日本里挑延迟最低的，
 *     日本全挂才去新加坡；数组为空时在全部节点里挑最低延迟
 *   - 内核懒启动，只在 ensure 时拉起，stop 时杀掉
 *
 * 文件：
 *   bin/mihomo.exe              官方内核
 *   proxy-data/config.yaml      生成的 mihomo 配置
 *   proxy-data/providers/…      订阅解析后的节点（yaml 块列表）
 *   proxy.json                  链接、开关、偏好、端口
 */
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, 'bin', 'mihomo.exe');
const DATA = path.join(HERE, 'proxy-data');
const CONFIG = path.join(DATA, 'config.yaml');
const PROVIDER = path.join(DATA, 'providers', 'zhuiyun.yaml');
const PID_FILE = path.join(DATA, 'mihomo.pid');
const SETTINGS = path.join(HERE, 'proxy.json');

const UA = 'clash-verge/v2.5.5';
const GROUP = '代理';
const DEFAULTS = {
  enabled: false,
  url: '',
  regions: [],
  port: 7910,
  apiPort: 9099,
  secret: 'dsh-lqconfig',
  refreshMinutes: 360,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(value) {
  const input = value && typeof value === 'object' ? value : {};
  const regions = Array.isArray(input.regions)
    ? input.regions.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
    : [];
  return {
    enabled: input.enabled === true,
    url: typeof input.url === 'string' ? input.url.trim() : '',
    regions: [...new Set(regions)],
    port: Number.isInteger(input.port) && input.port > 0 ? input.port : DEFAULTS.port,
    apiPort: Number.isInteger(input.apiPort) && input.apiPort > 0 ? input.apiPort : DEFAULTS.apiPort,
    secret: typeof input.secret === 'string' && input.secret ? input.secret : DEFAULTS.secret,
    refreshMinutes: Number.isInteger(input.refreshMinutes) && input.refreshMinutes > 0
      ? input.refreshMinutes : DEFAULTS.refreshMinutes,
  };
}

export async function readSettings() {
  try {
    const text = await fs.readFile(SETTINGS, 'utf8');
    return normalize(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULTS };
    throw error;
  }
}

export async function writeSettings(patch) {
  const current = await readSettings();
  const next = normalize({ ...current, ...patch });
  if (next.enabled && !next.url) throw new Error('机场链接为空，无法开启代理');
  await fs.mkdir(path.dirname(SETTINGS), { recursive: true });
  await fs.writeFile(SETTINGS, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/* ---------------- 订阅拉取与解析 ---------------- */

async function fetchSubscription(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('订阅拉取失败：HTTP ' + response.status);
  return await response.text();
}

/** 从 proxies: 之后的 "[" 起做括号配对，返回 JSON 文本（跳过字符串内的括号） */
function extractJsonArray(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function yamlScalar(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(value);
}

function blockFromObject(item) {
  const entries = Object.entries(item);
  const lines = [];
  entries.forEach(([key, value], index) => {
    lines.push((index === 0 ? '  - ' : '    ') + key + ': ' + yamlScalar(value));
  });
  return lines;
}

/** 块里的 name，兼容 "  - name: x" 与 "    name: x" 两种首行 */
function nameOfBlock(block) {
  const hit = block.find((line) => /^\s*(?:-\s+)?name:\s*/.test(line));
  if (!hit) return '';
  const quoted = hit.match(/name:\s*"([^"]*)"/);
  if (quoted) return quoted[1].trim();
  const plain = hit.match(/name:\s*([^"\n]+)/);
  return plain ? plain[1].trim() : '';
}

/** 返回 [{ name, lines }]，支持行内 JSON 数组和 yaml 块列表两种订阅格式 */
export function parseProxyEntries(text) {
  const marker = text.search(/^proxies:\s*/m);
  if (marker < 0) return [];
  const afterMarker = text.indexOf(':', marker) + 1;
  const rest = text.slice(afterMarker);
  const bracket = rest.indexOf('[');

  if (bracket >= 0 && rest.slice(0, bracket).trim() === '') {
    const json = extractJsonArray(text, afterMarker + bracket);
    if (!json) return [];
    let list;
    try { list = JSON.parse(json); } catch { return []; }
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && typeof item === 'object' && typeof item.name === 'string')
      .map((item) => ({ name: item.name, lines: blockFromObject(item) }));
  }

  // yaml 块列表
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^proxies:\s*$/.test(line.trim()));
  if (start < 0) return [];
  const blocks = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z_]/.test(line)) break;
    if (/^\s*- /.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks
    .map((block) => block.filter((line) => line.trim() !== ''))
    .filter((block) => block.length > 0)
    .map((block) => ({ name: nameOfBlock(block), lines: block }));
}

/** 流量/到期这类信息条目不是节点 */
export function isInfoNode(name) {
  if (!name) return true;
  if (/[:：]/.test(name)) return true;
  return /(剩余|到期|流量|套餐|重置|官网|防失联|客服|公告|邀请|购买)/.test(name);
}

/** 地区名：日本01【vip1】[A] → 日本；新加坡 03【vip1】 → 新加坡 */
export function regionOf(name) {
  const cleaned = name
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
  const head = cleaned.split(/\s+/)[0] || cleaned;
  return head.replace(/\d+$/, '').replace(/[^\u4e00-\u9fa5A-Za-z]/g, '');
}

async function writeProvider(entries) {
  await fs.mkdir(path.dirname(PROVIDER), { recursive: true });
  const body = ['proxies:', ...entries.map((entry) => entry.lines.join('\n'))].join('\n') + '\n';
  await fs.writeFile(PROVIDER, body, 'utf8');
}

async function readProvider() {
  if (!existsSync(PROVIDER)) return [];
  const text = await fs.readFile(PROVIDER, 'utf8');
  return parseProxyEntries(text).filter((entry) => !isInfoNode(entry.name));
}

export async function refreshProvider(settings, force) {
  if (!settings.url) throw new Error('机场链接为空');
  if (!force && existsSync(PROVIDER)) {
    const stat = await fs.stat(PROVIDER);
    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMinutes < settings.refreshMinutes) {
      const cached = await readProvider();
      if (cached.length > 0) return { refreshed: false, entries: cached };
    }
  }
  const text = await fetchSubscription(settings.url);
  const entries = parseProxyEntries(text).filter((entry) => !isInfoNode(entry.name));
  if (entries.length === 0) throw new Error('订阅里没解析出节点，链接可能失效');
  await writeProvider(entries);
  return { refreshed: true, entries };
}

/* ---------------- 内核配置与进程 ---------------- */

function configYaml(settings) {
  return [
    'mixed-port: ' + settings.port,
    'allow-lan: false',
    "bind-address: '*'",
    'mode: rule',
    'log-level: warning',
    'ipv6: false',
    'unified-delay: true',
    'tcp-concurrent: true',
    'external-controller: 127.0.0.1:' + settings.apiPort,
    'secret: ' + settings.secret,
    'proxy-providers:',
    '  zhuiyun:',
    '    type: file',
    '    path: ./providers/zhuiyun.yaml',
    '    health-check:',
    '      enable: true',
    '      url: http://www.gstatic.com/generate_204',
    '      interval: 300',
    'proxy-groups:',
    "  - name: '" + GROUP + "'",
    '    type: select',
    '    use: [zhuiyun]',
    'rules:',
    '  - MATCH,' + GROUP,
    '',
  ].join('\n');
}

async function portOpen(port) {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(600);
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
  });
}

async function api(settings, route, init) {
  return fetch('http://127.0.0.1:' + settings.apiPort + route, {
    ...init,
    headers: { authorization: 'Bearer ' + settings.secret, ...((init && init.headers) || {}) },
  });
}

async function killByPidFile() {
  try {
    const pid = Number((await fs.readFile(PID_FILE, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid); } catch { /* 已退出 */ }
    }
  } catch { /* 无 PID 文件 */ }
  await fs.rm(PID_FILE, { force: true });
}

export async function stop() {
  const settings = await readSettings();
  await killByPidFile();
  for (let i = 0; i < 20; i += 1) {
    if (!(await portOpen(settings.port)) && !(await portOpen(settings.apiPort))) return { running: false };
    await sleep(150);
  }
  return { running: await portOpen(settings.port) };
}

export async function status() {
  const settings = await readSettings();
  const running = (await portOpen(settings.port)) && (await portOpen(settings.apiPort));
  let current = null;
  let version = null;
  if (running) {
    try {
      const data = await (await api(settings, '/proxies')).json();
      current = data.proxies && data.proxies[GROUP] ? data.proxies[GROUP].now : null;
      const info = await (await api(settings, '/version')).json();
      version = info.version || null;
    } catch { /* 内核启动中或正在退出 */ }
  }
  return {
    enabled: settings.enabled,
    running,
    port: settings.port,
    proxy: 'http://127.0.0.1:' + settings.port,
    regions: settings.regions,
    hasUrl: Boolean(settings.url),
    current,
    version,
  };
}

/* ---------------- 启动与选节点 ---------------- */

export async function listRegions(settingsOverride) {
  const settings = settingsOverride || await readSettings();
  if (!settings.url) throw new Error('机场链接为空');
  const { entries } = await refreshProvider(settings, false);
  const counts = new Map();
  for (const entry of entries) {
    const region = regionOf(entry.name);
    if (!region) continue;
    counts.set(region, (counts.get(region) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

const DELAY_TARGET = 'http://www.gstatic.com/generate_204';

/** provider 内节点不在 /proxies 字典里，只能从 /providers/proxies 读 alive 与 history 延迟 */
async function providerNodes(settings) {
  const data = await (await api(settings, '/providers/proxies/zhuiyun')).json();
  return (data.proxies || [])
    .map((item) => ({
      name: item.name,
      alive: item.alive === true,
      delay: Array.isArray(item.history) && item.history.length ? item.history[0].delay : null,
    }))
    .filter((item) => !isInfoNode(item.name));
}

async function triggerHealthCheck(settings) {
  try {
    await api(settings, '/providers/proxies/zhuiyun/healthcheck?url=' + encodeURIComponent(DELAY_TARGET) + '&timeout=4000');
  } catch { /* 单点失败不影响后续读取 */ }
}

export async function pickAndSwitch(settingsOverride) {
  const settings = settingsOverride || await readSettings();
  const order = settings.regions.length > 0 ? settings.regions : [null];

  let nodes = [];
  for (let attempt = 0; attempt < 3 && nodes.length === 0; attempt += 1) {
    if (attempt > 0) await sleep(1200);
    nodes = await providerNodes(settings);
  }
  await triggerHealthCheck(settings);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(1200);
    nodes = await providerNodes(settings);
    if (nodes.some((node) => node.alive && typeof node.delay === 'number' && node.delay > 0)) break;
  }

  const usable = nodes.filter((node) => node.alive && typeof node.delay === 'number' && node.delay > 0);
  if (usable.length === 0) throw new Error('健康检查后没有可用节点');

  for (const region of order) {
    const pool = region ? usable.filter((node) => regionOf(node.name) === region) : usable;
    if (pool.length === 0) continue;
    pool.sort((a, b) => a.delay - b.delay);
    const best = pool[0];
    const response = await api(settings, '/proxies/' + encodeURIComponent(GROUP), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: best.name }),
    });
    if (!response.ok) throw new Error('切换节点失败：HTTP ' + response.status);
    return { region: region || '全部', node: best.name, delay: best.delay };
  }
  throw new Error('偏好地区内没有可用节点' + (settings.regions.length ? '（偏好：' + settings.regions.join('、') + '）' : ''));
}

export async function ensure() {
  const settings = await readSettings();
  if (!settings.enabled) throw new Error('代理开关未开启');
  if (!settings.url) throw new Error('机场链接为空');
  if (!existsSync(BIN)) throw new Error('找不到内核：' + BIN);

  const { refreshed, entries } = await refreshProvider(settings, false);
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(path.dirname(PROVIDER), { recursive: true });
  await fs.writeFile(CONFIG, configYaml(settings), 'utf8');

  const already = (await portOpen(settings.port)) && (await portOpen(settings.apiPort));
  if (!already) {
    await killByPidFile();
    const child = spawn(BIN, ['-d', DATA, '-f', CONFIG], {
      cwd: HERE,
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    await fs.writeFile(PID_FILE, String(child.pid), 'utf8');
    let ready = false;
    for (let i = 0; i < 50; i += 1) {
      if (await portOpen(settings.apiPort)) { ready = true; break; }
      await sleep(200);
    }
    if (!ready) throw new Error('内核未在 10 秒内就绪');
  }

  const picked = await pickAndSwitch(settings);
  return { proxy: 'http://127.0.0.1:' + settings.port, refreshed, nodes: entries.length, ...picked };
}
