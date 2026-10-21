/**
 * visible-shell —— 用「弹窗版」pwsh 工具替换内置 tool-pwsh。
 *
 * 开关在设置区「命令窗口」里，即时生效（state.json，无需重启）：
 *   true  —— 每条命令在可见终端窗口中执行，结束后窗口自动关闭；
 *   false —— 隐藏执行，行为与内置 pwsh 一致。
 *
 * 路由前缀：/visible-shell/api/*
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVisibleCommand, runHiddenCommand, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './runner.js';

export const name = 'visible-shell';
export const inject = ['tools', 'workingDirectory'];

const ROUTE_PREFIX = '/visible-shell';
const STATE_PATH = fileURLToPath(new URL('./state.json', import.meta.url));

let cache = { visible: true, at: 0 };

async function readState() {
  try {
    const text = await fs.readFile(STATE_PATH, 'utf8');
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (value && typeof value.visible === 'boolean') return value.visible;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return true;
}

async function writeState(visible) {
  if (typeof visible !== 'boolean') throw new Error('visible 必须是布尔值');
  await fs.writeFile(STATE_PATH, JSON.stringify({ visible }, null, 2) + '\n', 'utf8');
  cache = { visible, at: Date.now() };
  return visible;
}

async function isVisible() {
  if (Date.now() - cache.at < 500) return cache.visible;
  const visible = await readState();
  cache = { visible, at: Date.now() };
  return visible;
}

function clampTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'description'],
  properties: {
    command: { type: 'string', description: 'The PowerShell command to execute.' },
    description: { type: 'string', description: 'Clear, concise description of what this command does in active voice, 5-10 words.' },
    timeoutMs: { type: 'number', description: 'Timeout in milliseconds; capped at 600000.' },
    workdir: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
    run_in_background: { type: 'boolean', description: 'Accepted for schema compatibility; the visible-shell tool always waits for the command.' },
    sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'Accepted for schema compatibility; confinement is unchanged.' },
    justification: { type: 'string', description: 'Required with sandbox_permissions by the built-in tool; unused here.' },
  },
};

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string' },
      truncated: { type: 'boolean' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

export function apply(ctx) {
  ctx.tools.register({
    name: 'pwsh',
    description:
      'Execute PowerShell commands. visible-shell replacement: when the "命令窗口" switch is on, every command runs in a visible terminal window that closes when the command finishes; the captured output comes back from a log file. When the switch is off, commands run hidden like the built-in tool. Background execution is not supported: run_in_background is ignored and the call always waits.',
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args, exec) {
      let base = process.cwd();
      try {
        if (exec && exec.agent) base = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      } catch { /* fall back to process.cwd() */ }
      const cwd = args.workdir ? path.resolve(base, args.workdir) : base;
      const timeoutMs = clampTimeout(args.timeoutMs);
      const visible = await isVisible();
      const signal = exec && exec.signal;
      const result = visible
        ? await runVisibleCommand({ command: args.command, cwd, timeoutMs, signal, title: args.description })
        : await runHiddenCommand({ command: args.command, cwd, timeoutMs, signal });

      let text = result.stdout || '';
      if (result.stderr && result.stderr.trim().length > 0) {
        if (text.length > 0 && !text.endsWith('\n')) text += '\n';
        text += '[stderr]\n' + result.stderr;
      }
      if (result.timedOut) text += (text.length > 0 && !text.endsWith('\n') ? '\n' : '') + '[timed out after ' + timeoutMs + 'ms]';
      if (result.aborted) text += (text.length > 0 && !text.endsWith('\n') ? '\n' : '') + '[aborted]';
      else if (typeof result.code === 'number' && result.code !== 0) {
        text += (text.length > 0 && !text.endsWith('\n') ? '\n' : '') + '[exit code: ' + result.code + ']';
      }
      if (text.length === 0) text = '(no output)';
      return { text };
    },
  });

  ctx.inject(['webServer'], (inner) => inner.effect(
    () =>
      inner.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const send = (status, obj) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(obj));
          };
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            const route = url.pathname.replace(ROUTE_PREFIX, '') || '/';
            if (req.method === 'GET' && route === '/api/state') {
              return send(200, { ok: true, visible: await readState() });
            }
            if (req.method === 'POST' && route === '/api/visible') {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              let body = {};
              try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* empty */ }
              if (typeof body.visible !== 'boolean') return send(400, { ok: false, error: 'visible 必须是布尔值' });
              const visible = await writeState(body.visible);
              return send(200, { ok: true, visible });
            }
            return send(404, { ok: false, error: 'not found' });
          } catch (error) {
            return send(500, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    'visible-shell: settings route',
  ));
}
