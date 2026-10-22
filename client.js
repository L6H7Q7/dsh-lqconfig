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
        error.program = data.program;
        error.explorer = data.explorer;
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
    async function requestNativeOpen(target, retryId, operations) {
      if (nativeDisposed || !nativeSnapshot.openNative) return;
      const id = ++nativeNoticeSequence;
      if (retryId !== undefined && nativeSnapshot.notice?.id === retryId) {
        publishNative({ notice: { ...nativeSnapshot.notice, id, busy: true } });
      }
      try {
        await nativeJson('/native-open', { path: target, ...(operations ? { operations } : {}) });
        if (!nativeDisposed && id === nativeNoticeSequence) {
          publishNative({ message: '打开请求已提交；窗口是否出现尚未核实。', notice: null });
        }
      } catch (error) {
        if (!nativeDisposed && id === nativeNoticeSequence) {
          const results = [
            { key: 'program', label: '系统程序', result: error.program },
            { key: 'explorer', label: '资源管理器', result: error.explorer },
          ].filter(item => item.result);
          const retryOperations = results.length ? results.filter(item => !item.result.ok).map(item => item.key) : operations || ['program', 'explorer'];
          publishNative({ notice: {
            id, path: target, busy: false,
            message: results.length ? '打开请求结果' : error.message,
            detail: results.map(item => item.label + '：' + (item.result.ok
              ? '请求已提交，窗口是否出现尚未核实'
              : item.result.error.message + '（' + item.result.error.code + '）')).join('\n'),
            location: error.explorer?.path,
            code: results.length ? undefined : error.code,
            unknown: results.some(item => item.result.submitted === null || item.result.status === 'unconfirmed'),
            retryOperations,
            retryLabel: retryOperations.length === 1
              ? retryOperations[0] === 'program' ? '仅重试系统程序' : '仅重试资源管理器'
              : '重试未完成的请求',
          } });
        }
      }
    }
    function dismissNativeNotice(id) {
      if (nativeDisposed || nativeSnapshot.notice?.id !== id) return;
      ++nativeNoticeSequence;
      publishNative({ notice: null });
    }
    function NativeOpenNotice() {
      const state = useNativeState();
      const notice = state.notice;
      const [remaining, setRemaining] = useState(3);
      useEffect(() => {
        setRemaining(3);
        if (!notice || notice.busy) return;
        const id = notice.id;
        const deadline = Date.now() + 3000;
        const timer = setInterval(() => {
          if (nativeDisposed || nativeSnapshot.notice?.id !== id || nativeSnapshot.notice.busy) {
            clearInterval(timer);
            return;
          }
          const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
          setRemaining(seconds);
          if (seconds === 0) {
            clearInterval(timer);
            dismissNativeNotice(id);
          }
        }, 1000);
        return () => clearInterval(timer);
      }, [notice?.id, notice?.busy]);
      if (!notice) return null;
      return el('div', { role: 'alert', style: {
        position: 'fixed', right: 20, bottom: 24, zIndex: 10000, maxWidth: 430,
        background: 'var(--dsw-alias-background-primary, #fff)', color: 'var(--dsw-alias-label-primary, #222)',
        border: '1px solid #c28b30', borderRadius: 10, padding: 16, boxShadow: '0 4px 24px #0003', fontSize: 14,
      } },
        el('strong', null, notice.unknown ? '系统打开结果无法确认' : '系统打开未完成'),
        el('div', { style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, notice.message),
        notice.detail ? el('div', { style: { marginTop: 6, opacity: .8, whiteSpace: 'pre-wrap' } }, notice.detail) : null,
        notice.code !== undefined ? el('div', { style: { marginTop: 6, opacity: .8 } }, '错误码：' + notice.code) : null,
        notice.location ? el('div', { style: { marginTop: 6, wordBreak: 'break-all', opacity: .8 } }, '请求定位：' + notice.location) : null,
        el('div', { style: { marginTop: 6, wordBreak: 'break-all', opacity: .75 } }, notice.path),
        el('div', { style: { marginTop: 8, opacity: .75 } }, 'Sidebar 原有预览不受影响。'),
        el('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          state.openNative && notice.retryOperations?.length ? el('button', { type: 'button', style: S.btn, disabled: notice.busy,
            onClick: () => { void requestNativeOpen(notice.path, notice.id, notice.retryOperations); },
          }, notice.busy ? '请求中…' : notice.retryLabel) : null,
          el('button', { type: 'button', style: S.btn, onClick: () => {
            dismissNativeNotice(notice.id);
          } }, notice.busy ? '关闭' : '关闭（' + remaining + 's）')));
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
            const openFile = React.useCallback((target, options) => {
              const nativePath = nativePathOf(target, options);
              if (!nativeDisposed && nativeSnapshot.openNative && nativePath !== null) void requestNativeOpen(nativePath);
              return props.openFile(target, options);
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


    function VisibleShellCard() {
      const [visible, setVisible] = useState(true);
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState('');
      const [tone, setTone] = useState('note');

      useEffect(() => {
        let disposed = false;
        (async () => {
          try {
            const res = await fetch('/visible-shell/api/state', { cache: 'no-store' });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || '读取失败');
            if (!disposed) setVisible(data.visible !== false);
          } catch (error) {
            if (!disposed) {
              setTone('warn');
              setMessage('读取失败：' + String(error && error.message ? error.message : error));
            }
          }
        })();
        return () => { disposed = true; };
      }, []);

      async function persist(next) {
        setVisible(next);
        setSaving(true);
        setMessage('');
        try {
          const res = await fetch('/visible-shell/api/visible', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ visible: next }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          setVisible(data.visible !== false);
          setTone('ok');
          setMessage('已保存，即时生效，无需重启。');
        } catch (error) {
          setVisible(!next);
          setTone('warn');
          setMessage('保存失败：' + String(error && error.message ? error.message : error));
        } finally {
          setSaving(false);
        }
      }

      return el('div', { style: S.card },
        el('div', { style: S.head },
          el('div', { style: S.title }, '命令窗口'),
          el(Switch, {
            checked: visible,
            disabled: saving,
            label: '命令窗口',
            onChange: event => { void persist(event.target.checked); },
          })),
        el('div', { style: S.desc }, '开启后，DSH 执行每条命令都会弹出一个真实的终端窗口，命令跑完窗口自动关闭，输出经日志回传对话；关闭后恢复隐藏执行（与官方内置一致）。开关由 visible-shell 插件提供，读写它的 state.json，即时生效、不重启。'),
        el('div', { style: S.status }, '当前：' + (visible ? '每条命令弹窗' : '隐藏执行') + (saving ? ' · 保存中…' : '')),
        message ? el('div', { style: tone === 'warn' ? S.warn : tone === 'ok' ? S.ok : S.note }, message) : null);
    }

    function ProxyCard() {
      const [state, setState] = useState({ hasUrl: false, enabled: false, running: false, current: '', version: '', port: 0, host: '' });
      const [urlInput, setUrlInput] = useState('');
      const [portInput, setPortInput] = useState('');
      const [refreshInput, setRefreshInput] = useState('');
      const [regions, setRegions] = useState([]);
      const [available, setAvailable] = useState([]);
      const [busy, setBusy] = useState('');
      const [message, setMessage] = useState('');
      const [tone, setTone] = useState('note');

      useEffect(() => { void load(); }, []);

      async function call(path, init) {
        const res = await fetch(API + path, init || {});
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '请求失败');
        return data;
      }

      async function load() {
        try {
          const data = await call('/proxy/state');
          setState(data);
          setRegions(Array.isArray(data.regions) ? data.regions : []);
          setPortInput(data.port ? String(data.port) : '');
          setRefreshInput(data.refreshMinutes ? String(data.refreshMinutes) : '');
        } catch (error) {
          setTone('warn');
          setMessage('读取失败：' + String(error && error.message ? error.message : error));
        }
      }

      async function loadRegions() {
        setBusy('regions');
        setMessage('');
        try {
          const data = await call('/proxy/regions');
          setAvailable(data.regions || []);
          if (data.regions && data.regions.length) {
            setTone('ok');
            setMessage('从订阅读到 ' + data.regions.length + ' 个地区');
          } else {
            setTone('warn');
            setMessage('订阅里没读到地区，请检查链接');
          }
        } catch (error) {
          setTone('warn');
          setMessage('读取地区失败：' + String(error && error.message ? error.message : error));
        }
        setBusy('');
      }

      async function saveUrl() {
        if (!urlInput.trim()) { setTone('warn'); setMessage('请先填入机场链接'); return; }
        setBusy('url');
        setMessage('');
        try {
          await call('/proxy/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: urlInput.trim() }) });
          setUrlInput('');
          await load();
          await loadRegions();
          setTone('ok');
          setMessage('链接已保存，现在可以打开开关');
        } catch (error) {
          setTone('warn');
          setMessage('保存链接失败：' + String(error && error.message ? error.message : error));
        }
        setBusy('');
      }

      async function toggle(next) {
        if (next && !state.hasUrl) { setTone('warn'); setMessage('请先填写机场链接'); return; }
        setBusy('toggle');
        setMessage('');
        try {
          await call('/proxy/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
          if (next) {
            setTone('ok');
            setMessage('已允许 DSH 按需使用代理。内核不会现在启动，等真正需要时或点「测试并选节点」才拉起。');
          } else {
            setTone('note');
            setMessage('已禁止使用代理，已停止内核');
          }
          await load();
        } catch (error) {
          setTone('warn');
          setMessage('操作失败：' + String(error && error.message ? error.message : error));
          await load();
        }
        setBusy('');
      }

      function toggleRegion(name) {
        setRegions((prev) => (prev.indexOf(name) >= 0 ? prev.filter((item) => item !== name) : prev.concat([name])));
      }

      async function saveRegions() {
        setBusy('regions-save');
        setMessage('');
        try {
          await call('/proxy/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ regions }) });
          setTone('ok');
          setMessage(regions.length ? '偏好已保存：' + regions.join(' → ') : '偏好已清空，将在全部节点里选最低延迟');
          await load();
        } catch (error) {
          setTone('warn');
          setMessage('保存偏好失败：' + String(error && error.message ? error.message : error));
        }
        setBusy('');
      }

      async function saveTuning() {
        const port = Number(portInput);
        const refresh = Number(refreshInput);
        if (!Number.isInteger(port) || port < 1 || port > 65535) { setTone('warn'); setMessage('端口需在 1–65535 之间'); return; }
        if (!Number.isInteger(refresh) || refresh < 1) { setTone('warn'); setMessage('订阅刷新需为正整数（分钟）'); return; }
        setBusy('tuning');
        setMessage('');
        try {
          await call('/proxy/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port, refreshMinutes: refresh }) });
          setTone('ok');
          setMessage('已保存：端口 ' + port + '，订阅刷新 ' + refresh + ' 分钟');
          await load();
        } catch (error) {
          setTone('warn');
          setMessage('保存失败：' + String(error && error.message ? error.message : error));
        }
        setBusy('');
      }

      async function test() {
        setBusy('test');
        setMessage('测速中，最多十秒…');
        try {
          const result = await call('/proxy/ensure', { method: 'POST' });
          setTone('ok');
          setMessage('连通：' + result.region + ' / ' + result.node + '（' + result.delay + 'ms，共 ' + result.nodes + ' 个节点）');
          await load();
        } catch (error) {
          setTone('warn');
          setMessage('测试失败：' + String(error && error.message ? error.message : error));
          await load();
        }
        setBusy('');
      }

      return el('div', { style: S.card },
        el('div', { style: S.head },
          el('div', { style: S.title }, '自动代理工具'),
          el(Switch, {
            checked: state.enabled,
            disabled: busy !== '' || !state.hasUrl,
            label: '自动代理',
            onChange: (event) => { void toggle(event.target.checked); },
          })),
        el('div', { style: S.desc }, '开启后，DSH 可以在需要时通过本插件自动切换代理、使用代理；关闭后禁止使用。开关只是授权，不会立刻启动内核——真正需要时（或点下方「测试并选节点」）才拉起。开关需要先填好机场链接。'),
        el('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          el('input', {
            type: 'text',
            value: urlInput,
            placeholder: state.hasUrl ? ('已保存：' + state.host + '（重新填写可替换）') : 'https://…/api/v1/client/…?token=…',
            onChange: (event) => setUrlInput(event.target.value),
            style: { flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: 13 },
          }),
          el('button', { style: S.btn, onClick: () => { void saveUrl(); } }, '保存链接')),
        el('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' } },
          el('span', { style: { fontSize: 12, opacity: 0.7 } }, '端口'),
          el('input', {
            type: 'number', value: portInput, min: 1, max: 65535,
            onChange: (event) => setPortInput(event.target.value),
            style: { width: 80, padding: '5px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: 13 },
          }),
          el('span', { style: { fontSize: 12, opacity: 0.7, marginLeft: 6 } }, '订阅刷新（分钟）'),
          el('input', {
            type: 'number', value: refreshInput, min: 1,
            onChange: (event) => setRefreshInput(event.target.value),
            style: { width: 80, padding: '5px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: 13 },
          }),
          el('button', { style: S.btn, onClick: () => { void saveTuning(); } }, '保存'),
          el('span', { style: S.note }, '改端口要关开关重开才生效；刷新时间下次拉订阅时生效')),
        el('div', { style: S.status },
          '状态：' + (state.running ? '运行中 · ' + state.current : '未运行')
          + (state.version ? ' · 内核 ' + state.version : '')
          + (state.port ? ' · 端口 ' + state.port : '')
          + (busy ? ' · 处理中…' : '')),
        state.enabled ? el('div', { style: { marginTop: 14 } },
          el('div', { style: { fontSize: 13, fontWeight: 600 } }, '节点偏好（点击顺序即优先级）'),
          el('div', { style: S.note }, '不选则全部节点挑最低延迟；选多个则依次尝试，前一个地区全挂才用下一个。地区来自订阅实际内容。'),
          el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 } },
            available.length === 0
              ? el('span', { style: S.note }, '点「读取地区」从订阅取真实地区')
              : available.map((item) => {
                  const index = regions.indexOf(item.name);
                  return el('button', {
                    key: item.name,
                    style: index >= 0 ? { ...S.btn, ...S.primary } : S.btn,
                    onClick: () => toggleRegion(item.name),
                  }, (index >= 0 ? (index + 1) + '. ' : '') + item.name + '（' + item.count + '）');
                })),
          el('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
            el('button', { style: S.btn, onClick: () => { void loadRegions(); } }, '读取地区'),
            el('button', { style: S.btn, onClick: () => { void saveRegions(); } }, '保存偏好'),
            el('button', { style: S.btn, onClick: () => { void test(); } }, '测试并选节点'))) : null,
        message ? el('div', { style: tone === 'warn' ? S.warn : tone === 'ok' ? S.ok : S.note }, message) : null,
        el('div', { style: S.mono }, '偏好：' + (regions.length ? regions.join(' → ') : '未设置（全部节点里选最低）')));
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
            el('div', { style: S.title }, '打开资源管理器和程序'),
            el(Switch, { checked: native.openNative, disabled: native.saving, label: '打开资源管理器和程序',
              onChange: event => { void saveNativeSettings(event.target.checked); } })),
          el('div', { style: S.desc }, '开启后，点击聊天里的本地绝对路径链接，会保留 Sidebar 原有预览，同时请求资源管理器和默认程序打开该路径。资源管理器会选中文件或打开目录；两路分别报告结果。行号链接、相对路径和网页链接保持原有行为。'),
          el('div', { style: S.status }, '当前：' + (native.openNative ? '已开启' : '未开启') + (native.saving ? ' · 保存中…' : '') + ' · 保存即时生效'),
          native.message ? el('div', { style: S.note }, native.message) : null,
          native.error ? el('div', { style: S.warn }, native.error) : null,
          native.compatibility ? el('div', { style: S.warn }, native.compatibility) : null),
        el(VisibleShellCard, {}),
        el(ProxyCard, {}),
        el('div', { style: S.card },
          el('div', { style: S.title }, '说明'),
          el('div', { style: S.desc }, '这是个人插件 dsh-lqconfig。每次改动都会先备份原补丁（.bak-lqconfig-时间戳）；「隐藏 API」与「思维链优先中文」保存后仍按原逻辑自动重启；「打开资源管理器和程序」只保存 state.json，立即生效，不触发重启。以后要加别的个人开关，往这里加卡片即可。')));
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
