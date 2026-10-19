/**
 * dsh-lqconfig —— 个人配置插件（浏览器半侧）
 *
 * 设置里的「LQ配置」分区；系统打开开关独立即时生效，不触发重启。
 */
window.__ModuleLoader__.load({
  id: 'dsh-lqconfig',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const { useEffect, useState } = React;
    const { jsx } = require('react/jsx-runtime');

    /** jsx() 只接受 (type, props, key)：多子节点必须走 props.children */
    function el(type, props, ...children) {
      const next = { ...(props || {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return jsx(type, next);
    }

    const API = '/dsh-lqconfig/api';

    const S = {
      page: { padding: '8px 4px', fontSize: 14, lineHeight: 1.6 },
      card: { border: '1px solid rgba(128,128,128,0.28)', borderRadius: 12, padding: '16px 18px', marginBottom: 12 },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 15, fontWeight: 600 },
      desc: { fontSize: 13, opacity: 0.7, marginTop: 10 },
      status: { fontSize: 12, opacity: 0.7, marginTop: 8 },
      notice: {
        marginTop: 12,
        padding: '10px 12px',
        borderRadius: 8,
        background: 'rgba(128,128,128,0.10)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      },
      btn: { border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', borderRadius: 8, padding: '5px 12px', fontSize: 13, cursor: 'pointer', color: 'inherit' },
      primary: { background: '#1a1a1a', color: '#fff', borderColor: '#1a1a1a' },
      note: { fontSize: 12, opacity: 0.65, marginTop: 10 },
      warn: { fontSize: 12, color: '#c0392b', marginTop: 10 },
      ok: { fontSize: 12, color: '#1e8449', marginTop: 10 },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, opacity: 0.6, marginTop: 8, wordBreak: 'break-all' },
    };

    function Switch(props) {
      const checked = props.checked;
      const disabled = props.disabled;
      const onChange = props.onChange;
      return el('span', { style: { position: 'relative', display: 'inline-flex', width: 44, height: 24, flex: '0 0 auto' } },
        el('input', {
          type: 'checkbox',
          checked,
          disabled,
          onChange,
          'aria-label': props.label || '开关',
          style: { position: 'absolute', inset: 0, opacity: 0, margin: 0, zIndex: 1, cursor: disabled ? 'default' : 'pointer' },
        }),
        el('span', { style: { position: 'absolute', inset: 0, borderRadius: 12, background: checked ? '#1a1a1a' : 'rgba(128,128,128,0.35)', transition: 'background .2s' } }),
        el('span', { style: { position: 'absolute', top: 3, left: checked ? 23 : 3, width: 18, height: 18, borderRadius: 9, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .2s' } }));
    }

    // Plugin-lifetime state: closing the settings page does not turn this off.
    let nativeSnapshot = { openNative: false, saving: false, message: '', error: '', compatibility: '', notice: null };
    const nativeSubscribers = new Set();
    let nativeDisposed = true;
    let nativeRevision = 0;
    const publishNative = patch => {
      if (nativeDisposed) return;
      nativeSnapshot = { ...nativeSnapshot, ...patch };
      for (const listener of [...nativeSubscribers]) listener();
    };
    function useNativeState() {
      return React.useSyncExternalStore(
        React.useCallback(listener => { nativeSubscribers.add(listener); return () => nativeSubscribers.delete(listener); }, []),
        () => nativeSnapshot,
      );
    }
    async function nativeJson(route, body) {
      const response = await fetch(API + route, body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const detail = data.error && typeof data.error === 'object' ? data.error : null;
        const error = new Error(detail?.message || data.error || '请求失败（HTTP ' + response.status + '）');
        error.code = detail?.code ?? data.code;
        error.submitted = data.submitted;
        error.fallback = data.fallback;
        error.fallbackError = data.fallbackError;
        throw error;
      }
      return data;
    }
    async function loadNativeSettings() {
      const revision = ++nativeRevision;
      try {
        const data = await nativeJson('/state');
        if (revision === nativeRevision) publishNative({ openNative: data.openNative === true, error: '' });
      } catch (error) {
        if (revision === nativeRevision) publishNative({ openNative: false, error: '读取系统打开设置失败：' + error.message });
      }
    }
    async function saveNativeSettings(enabled) {
      const revision = ++nativeRevision;
      // Disable immediately; enable only after the Host has saved the setting.
      publishNative({ saving: true, ...(enabled ? {} : { openNative: false }), message: '', error: '' });
      try {
        const data = await nativeJson('/native-setting', { enabled });
        if (revision === nativeRevision) publishNative({ openNative: data.openNative === true, saving: false, message: '已保存，即时生效，无需重启。' });
      } catch (error) {
        // Fail closed; an unsaved toggle must never silently activate opening.
        if (revision === nativeRevision) publishNative({ openNative: false, saving: false, error: '保存失败：' + error.message });
      }
    }
    function nativePathOf(value, options) {
      if (typeof value !== 'string' || options?.line !== undefined || /#L\d+(?:-L?\d+)?$/iu.test(value)) return null;
      let target = value;
      if (/^file:/iu.test(value)) {
        let url;
        try { url = new URL(value); } catch { return null; }
        if (url.protocol !== 'file:' || url.search || url.hash || url.username || url.password) return null;
        try { target = decodeURIComponent(url.pathname); } catch { return null; }
        if (url.hostname && url.hostname !== 'localhost') target = '\\\\' + url.hostname + target.replace(/\//g, '\\');
        else target = target.replace(/^\/([A-Za-z]:[\\/])/u, '$1');
      }
      if (/[\x00-\x1f\x7f"<>|*?]/u.test(target) || /#L\d+(?:-L?\d+)?$/iu.test(target)) return null;
      if (/^(?:\\\\|\/\/)\.[\\/]/u.test(target)) return null;
      return /^[A-Za-z]:[\\/]/u.test(target) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(target) ? target : null;
    }
    let nativeNoticeSequence = 0;
    async function requestNativeOpen(target, retryId) {
      if (nativeDisposed || !nativeSnapshot.openNative) return;
      const id = ++nativeNoticeSequence;
      if (retryId !== undefined && nativeSnapshot.notice?.id === retryId) {
        publishNative({ notice: { ...nativeSnapshot.notice, id, busy: true } });
      }
      try {
        await nativeJson('/native-open', { path: target });
        if (!nativeDisposed && id === nativeNoticeSequence) {
          publishNative({ message: '系统已接受打开请求；文件是否显示尚未核实。', notice: null });
        }
      } catch (error) {
        if (!nativeDisposed && id === nativeNoticeSequence) publishNative({ notice: {
          id, path: target, busy: false,
          message: error.fallback === 'revealed'
            ? '文件未能用系统程序打开，已为你打开所在文件夹' : error.message,
          detail: error.fallback === 'revealed' ? error.message : '',
          code: error.code,
          fallbackError: error.fallbackError,
          unknown: error.submitted === null,
        } });
      }
    }
    function NativeOpenNotice() {
      const state = useNativeState();
      const notice = state.notice;
      if (!notice) return null;
      return el('div', { role: 'alert', style: {
        position: 'fixed', right: 20, bottom: 24, zIndex: 10000, maxWidth: 430,
        background: 'var(--dsw-alias-background-primary, #fff)', color: 'var(--dsw-alias-label-primary, #222)',
        border: '1px solid #c28b30', borderRadius: 10, padding: 16, boxShadow: '0 4px 24px #0003', fontSize: 14,
      } },
        el('strong', null, notice.unknown ? '系统打开结果无法确认' : '系统打开未完成'),
        el('div', { style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, notice.message),
        notice.detail ? el('div', { style: { marginTop: 6, opacity: .8 } }, '原始原因：' + notice.detail) : null,
        notice.code !== undefined ? el('div', { style: { marginTop: 6, opacity: .8 } }, '错误码：' + notice.code) : null,
        notice.fallbackError ? el('div', { style: { marginTop: 6, opacity: .8 } }, '打开所在位置也未完成：' + notice.fallbackError.message) : null,
        el('div', { style: { marginTop: 6, wordBreak: 'break-all', opacity: .75 } }, notice.path),
        el('div', { style: { marginTop: 8, opacity: .75 } }, 'Sidebar 原有预览不受影响。'),
        el('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          state.openNative ? el('button', { type: 'button', style: S.btn, disabled: notice.busy,
            onClick: () => { void requestNativeOpen(notice.path, notice.id); },
          }, notice.busy ? '请求中…' : '仅重试系统打开') : null,
          el('button', { type: 'button', style: S.btn, onClick: () => {
            ++nativeNoticeSequence; publishNative({ notice: null });
          } }, '关闭')));
    }
    function installNativeOpening(ctx) {
      nativeDisposed = false;
      publishNative({ openNative: false, saving: false, message: '', error: '', notice: null });
      const wrappers = new Map();
      // Current DSH exposes the original registration through entries(). Keep
      // its children, stores and renderer authorization intact; wrap only Comp.
      // This is version-dependent: unknown ChatView shapes fail closed.
      function reconcile() {
        const entries = ctx.slots.entries('conversation.view');
        for (const [entry, record] of wrappers) {
          if (entries.includes(entry)) continue;
          if (entry.component === record.wrapper) entry.component = record.original;
          wrappers.delete(entry);
        }
        for (const entry of entries) {
          if (entry.options?.id !== 'chat' || wrappers.has(entry)) continue;
          const Original = entry.component;
          if (typeof Original !== 'function' || Original.name !== 'ChatView') continue;
          function NativeOpenChat(props) {
            const openFile = React.useCallback(async (target, options) => {
              const result = await props.openFile(target, options);
              const nativePath = nativePathOf(target, options);
              if (!nativeDisposed && nativeSnapshot.openNative && nativePath !== null) void requestNativeOpen(nativePath);
              return result;
            }, [props.openFile]);
            return el(Original, { ...props, openFile });
          }
          entry.component = NativeOpenChat;
          wrappers.set(entry, { original: Original, wrapper: NativeOpenChat });
        }
        const compatibility = wrappers.size ? '' : '当前聊天组件未匹配，系统双开未接入；请复核 DSH 版本。';
        if (compatibility !== nativeSnapshot.compatibility) publishNative({ compatibility });
      }
      const unsubscribe = ctx.slots.subscribe('conversation.view', reconcile);
      reconcile();
      void loadNativeSettings();
      return () => {
        nativeDisposed = true;
        ++nativeRevision;
        ++nativeNoticeSequence;
        unsubscribe();
        for (const [entry, record] of wrappers) {
          if (entry.component === record.wrapper) entry.component = record.original;
        }
        wrappers.clear();
      };
    }


    function LqSection() {
      const native = useNativeState();
      const [patchPath, setPatchPath] = useState('');
      const [hidden, setHidden] = useState(false);
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState('');
      const [tone, setTone] = useState('note');

      const [chainZh, setChainZh] = useState(false);
      const [chainSaving, setChainSaving] = useState(false);
      const [chainMessage, setChainMessage] = useState('');
      const [chainTone, setChainTone] = useState('note');

      useEffect(() => { void load(); }, []);

      async function load() {
        try {
          const res = await fetch(API + '/state', { cache: 'no-store' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '读取失败');
          setHidden(!data.enabled);
          setChainZh(Boolean(data.chainZh));
          setPatchPath(data.patchPath || '');
        } catch (error) {
          setMessage('读取失败：' + String(error && error.message ? error.message : error));
          setTone('warn');
        }
      }

      /** 拨动开关即视为同意重启：写入成功后直接自动重启，不再弹二次确认 */
      async function persist(nextHidden) {
        setSaving(true);
        setMessage('');
        try {
          const res = await fetch(API + '/set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: !nextHidden }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          setHidden(!data.enabled);
          if (data.changed) {
            await restartAt('api');
            return;
          }
          setMessage('没有变化，无需重启。');
          setTone('note');
          setSaving(false);
        } catch (error) {
          setHidden(!nextHidden);
          setMessage('保存失败：' + String(error && error.message ? error.message : error));
          setTone('warn');
          setSaving(false);
        }
      }

      function onToggle(event) {
        const next = event.target.checked;
        setHidden(next);
        void persist(next);
      }

      async function persistChain(next) {
        setChainSaving(true);
        setChainMessage('');
        try {
          const res = await fetch(API + '/chain-zh', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          setChainZh(Boolean(data.chainZh));
          if (data.changed) {
            await restartAt('chain');
            return;
          }
          setChainMessage('没有变化，无需重启。');
          setChainTone('note');
          setChainSaving(false);
        } catch (error) {
          setChainZh(!next);
          setChainMessage('保存失败：' + String(error && error.message ? error.message : error));
          setChainTone('warn');
          setChainSaving(false);
        }
      }

      function onToggleChain(event) {
        const next = event.target.checked;
        setChainZh(next);
        void persistChain(next);
      }

      /** which: 'api' | 'chain' —— 重启状态显示在触发它的那张卡片上 */
      async function restartAt(which) {
        const isChain = which === 'chain';
        const setS = isChain ? setChainSaving : setSaving;
        const setM = isChain ? setChainMessage : setMessage;
        const setT = isChain ? setChainTone : setTone;
        setS(true);
        setM('正在重启，页面稍后会断开…');
        setT('note');
        try {
          await fetch(API + '/restart', { method: 'POST' });
        } catch (error) {
          setM('重启请求失败：' + String(error && error.message ? error.message : error));
          setT('warn');
          setS(false);
        }
      }

      return el('div', { style: S.page },
        el('div', { style: S.card },
          el('div', { style: S.head },
            el('div', { style: S.title }, '隐藏 API'),
            el(Switch, { checked: hidden, disabled: saving, onChange: onToggle })),
          el('div', { style: S.desc }, '开启后，设置里的「DeepSeek」卡片和模型选择器里的「DeepSeek」分组都会消失；DeepSeek 账号通道不受影响。改动写进 profile 补丁，拨动开关即自动重启生效。'),
          el('div', { style: S.status }, '当前：' + (hidden ? '已隐藏' : '显示中') + (saving ? ' · 处理中…' : '')),
          message ? el('div', { style: tone === 'warn' ? S.warn : tone === 'ok' ? S.ok : S.note }, message) : null,
          patchPath ? el('div', { style: S.mono }, '补丁：' + patchPath) : null),
        el('div', { style: S.card },
          el('div', { style: S.head },
            el('div', { style: S.title }, '思维链优先中文'),
            el(Switch, { checked: chainZh, disabled: chainSaving, label: '思维链优先中文', onChange: onToggleChain })),
          el('div', { style: S.desc }, '开启后，往三个 Agent 预设的 persona.suffix（系统提示尾部）写入「思考用简体中文，仅术语保留英文」；关闭后还原为空。改动写进 profile 补丁，拨动开关即自动重启生效。'),
          el('div', { style: S.status }, '当前：' + (chainZh ? '已开启' : '未开启') + (chainSaving ? ' · 处理中…' : '')),
          chainMessage ? el('div', { style: chainTone === 'warn' ? S.warn : chainTone === 'ok' ? S.ok : S.note }, chainMessage) : null),
        el('div', { style: S.card },
          el('div', { style: S.head },
            el('div', { style: S.title }, '系统软件打开路径/程序'),
            el(Switch, { checked: native.openNative, disabled: native.saving, label: '系统软件打开路径/程序',
              onChange: event => { void saveNativeSettings(event.target.checked); } })),
          el('div', { style: S.desc }, '开启后，点击聊天里的本地绝对路径链接，会保留 Sidebar 原有预览，并用系统默认软件打开文件或目录。系统打开失败时尝试打开所在位置；行号链接、相对路径和网页链接保持原有行为。'),
          el('div', { style: S.status }, '当前：' + (native.openNative ? '已开启' : '未开启') + (native.saving ? ' · 保存中…' : '') + ' · 保存即时生效'),
          native.message ? el('div', { style: S.note }, native.message) : null,
          native.error ? el('div', { style: S.warn }, native.error) : null,
          native.compatibility ? el('div', { style: S.warn }, native.compatibility) : null),
        el('div', { style: S.card },
          el('div', { style: S.title }, '说明'),
          el('div', { style: S.desc }, '这是个人插件 dsh-lqconfig。每次改动都会先备份原补丁（.bak-lqconfig-时间戳）；「隐藏 API」与「思维链优先中文」保存后仍按原逻辑自动重启；「系统软件打开路径/程序」只保存 state.json，立即生效，不触发重启。以后要加别的个人开关，往这里加卡片即可。')));
    }

    function apply(ctx) {
      ctx.effect(() => installNativeOpening(ctx), 'dsh-lqconfig: native opening');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'dsh-lqconfig.native-open-notice', order: 90,
      }, NativeOpenNotice));
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'dsh-lqconfig', order: 40, label: () => 'LQ配置' },
          LqSection,
        );
      });
    }

    module.exports = { apply, inject: ['slots'], name: 'dsh-lqconfig-client' };
    return module.exports;
  },
});
