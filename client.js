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

    /* ---------------- 代理状态：侧边栏徽标与设置卡片共用 ---------------- */
    let proxySnapshot = {
      state: null, error: '', at: 0,
      popover: false, busy: '', message: '', tone: 'note',
    };
    const proxySubscribers = new Set();
    function publishProxy(patch) {
      proxySnapshot = { ...proxySnapshot, ...patch };
      for (const listener of [...proxySubscribers]) listener();
    }
    function useProxyStatus() {
      return React.useSyncExternalStore(
        React.useCallback((listener) => { proxySubscribers.add(listener); return () => proxySubscribers.delete(listener); }, []),
        () => proxySnapshot,
      );
    }
    let proxyRequestId = 0;
    async function refreshProxyStatus() {
      const id = ++proxyRequestId;
      try {
        const response = await fetch(API + '/proxy/state', { cache: 'no-store' });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || 'HTTP ' + response.status);
        if (id === proxyRequestId) publishProxy({ state: data, error: '', at: Date.now() });
      } catch (error) {
        if (id === proxyRequestId) publishProxy({ error: String(error && error.message ? error.message : error) });
      }
    }
    /** 多个挂载点共用同一份轮询，最后一个卸下时停表 */
    let proxyPollTimer = null;
    let proxyPollUsers = 0;
    function acquireProxyPolling() {
      proxyPollUsers += 1;
      if (proxyPollTimer === null) {
        void refreshProxyStatus();
        proxyPollTimer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          if (proxySnapshot.busy) return;
          void refreshProxyStatus();
        }, 20000);
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onProxyVisibility);
        }
      }
      return () => {
        proxyPollUsers -= 1;
        if (proxyPollUsers > 0 || proxyPollTimer === null) return;
        clearInterval(proxyPollTimer);
        proxyPollTimer = null;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onProxyVisibility);
      };
    }
    function onProxyVisibility() {
      if (typeof document !== 'undefined' && !document.hidden) void refreshProxyStatus();
    }

    /* ---------------- 余额徽标：左下角、代理上方，间隔可配（默认 1 分钟） ---------------- */
    let balanceSnapshot = { data: null, error: '', at: 0, enabled: true, intervalMinutes: 1 };
    const balanceSubscribers = new Set();
    function publishBalance(patch) {
      balanceSnapshot = { ...balanceSnapshot, ...patch };
      for (const listener of [...balanceSubscribers]) listener();
    }
    function useBalance() {
      return React.useSyncExternalStore(
        React.useCallback((listener) => { balanceSubscribers.add(listener); return () => balanceSubscribers.delete(listener); }, []),
        () => balanceSnapshot,
      );
    }
    let balanceRequestId = 0;
    /** 失败后 15 秒内重试一次，避免首次失败要干等 5 分钟轮询周期 */
    let balanceRetryTimer = null;
    function scheduleBalanceRetry() {
      if (balanceRetryTimer !== null) return;
      balanceRetryTimer = setTimeout(() => {
        balanceRetryTimer = null;
        void refreshBalance();
      }, 15000);
    }
    function clearBalanceRetry() {
      if (balanceRetryTimer === null) return;
      clearTimeout(balanceRetryTimer);
      balanceRetryTimer = null;
    }
    async function refreshBalance(force) {
      if (!balanceSnapshot.enabled && !force) return;
      const id = ++balanceRequestId;
      try {
        const response = await fetch(API + '/balance', { cache: 'no-store' });
        const data = await response.json();
        if (id !== balanceRequestId) return;
        if (data && data.ok) {
          clearBalanceRetry();
          publishBalance({ data, error: '', at: Date.now() });
        } else {
          publishBalance({ error: String((data && data.error) || ('HTTP ' + response.status)) });
          scheduleBalanceRetry();
        }
      } catch (error) {
        if (id === balanceRequestId) {
          publishBalance({ error: String(error && error.message ? error.message : error) });
          scheduleBalanceRetry();
        }
      }
    }
    let balancePollTimer = null;
    let balancePollUsers = 0;
    function balanceTick() {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshBalance();
    }
    /** 间隔以分钟计；重建定时器让新值立刻生效，不必等旧周期走完 */
    function applyBalanceInterval(minutes) {
      const parsed = Number(minutes);
      const clamped = Math.min(60, Math.max(1, Number.isFinite(parsed) ? Math.round(parsed) : 1));
      publishBalance({ intervalMinutes: clamped });
      if (balancePollTimer !== null) {
        clearInterval(balancePollTimer);
        balancePollTimer = setInterval(balanceTick, clamped * 60000);
      }
      return clamped;
    }
    function onBalanceVisibility() {
      if (typeof document !== 'undefined' && !document.hidden) void refreshBalance();
    }
    function acquireBalancePolling() {
      balancePollUsers += 1;
      if (balancePollTimer === null) {
        void refreshBalance();
        balancePollTimer = setInterval(balanceTick, (balanceSnapshot.intervalMinutes || 1) * 60000);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onBalanceVisibility);
      }
      return () => {
        balancePollUsers -= 1;
        if (balancePollUsers > 0 || balancePollTimer === null) return;
        clearInterval(balancePollTimer);
        balancePollTimer = null;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onBalanceVisibility);
      };
    }
    /** 从宿主读一次开关与间隔初值；读不到时保持默认（开启 / 1 分钟） */
    async function loadBalanceSettings() {
      try {
        const response = await fetch(API + '/state', { cache: 'no-store' });
        const data = await response.json();
        if (data && typeof data.balanceBadge === 'boolean') publishBalance({ enabled: data.balanceBadge });
        if (data && Number.isFinite(Number(data.balanceIntervalMinutes))) {
          publishBalance({ intervalMinutes: Number(data.balanceIntervalMinutes) });
        }
      } catch { /* 保持默认 */ }
    }
    /** 间隔落盘；失败按宿主给的提示回滚 */
    async function saveBalanceInterval(minutes) {
      try {
        const response = await fetch(API + '/balance-interval', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes }),
        });
        const data = await response.json();
        if (!data || !data.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
        return { ok: true, minutes: applyBalanceInterval(data.balanceIntervalMinutes) };
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    }
    /** 开关落盘；失败时回滚界面状态，避免「看起来关了其实还在轮询」 */
    async function saveBalanceBadge(enabled) {
      publishBalance({ enabled });
      try {
        const response = await fetch(API + '/balance-enabled', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
        });
        const data = await response.json();
        if (!data || !data.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
        publishBalance({ enabled: data.balanceBadge === true });
        if (enabled) void refreshBalance();
      } catch (error) {
        publishBalance({
          enabled: !enabled,
          error: '保存余额开关失败：' + (error && error.message ? error.message : error),
        });
      }
    }


    /**
     * 打开「设置 → LQ配置」。宿主没有对外暴露「打开设置 / 选中分区」的接口，
     * 只能在 DOM 层点：侧边栏设置按钮（_triggerRow 里的 aria-haspopup=dialog 按钮），
     * 再点设置导航里文案为「LQ配置」的 _navCell。
     */
    function openLqSettings() {
      const trigger = document.querySelector('[class*="_triggerRow"] button[aria-haspopup="dialog"]')
        || [...document.querySelectorAll('button[aria-haspopup="dialog"][aria-label]')]
          .find((btn) => /设置|settings?/i.test((btn.getAttribute('aria-label') || '').trim()));
      if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      let attempt = 0;
      const pickSection = () => {
        const nav = [...document.querySelectorAll('button[class*="_navCell"]')]
          .find((btn) => (btn.textContent || '').trim() === 'LQ配置');
        if (nav) { nav.click(); return; }
        attempt += 1;
        if (attempt < 25) setTimeout(pickSection, 60);
      };
      setTimeout(pickSection, 60);
      return Boolean(trigger);
    }

    function timeAgo(ms) {
      if (!ms) return '无记录';
      const diff = Math.max(0, Date.now() - ms);
      if (diff < 60000) return '刚刚';
      const minutes = Math.floor(diff / 60000);
      if (minutes < 60) return minutes + ' 分钟前';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + ' 小时前';
      return Math.floor(hours / 24) + ' 天前';
    }
    function durationText(ms) {
      if (!ms || ms < 0) return '—';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return '不到 1 分钟';
      if (minutes < 60) return minutes + ' 分钟';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + ' 小时 ' + (minutes % 60) + ' 分';
      return Math.floor(hours / 24) + ' 天 ' + (hours % 24) + ' 小时';
    }

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

      useEffect(() => {
        void load();
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void load();
        }, 20000);
        return () => clearInterval(timer);
      }, []);

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
            setMessage('已允许 DSH 按需使用代理。内核不会现在启动，等真正需要时或点「测试延迟并刷新节点」才拉起。');
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
        setMessage('刷新订阅并测速中，最多十几秒…');
        try {
          const result = await call('/proxy/ensure', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ force: true }),
          });
          setTone('ok');
          setMessage((result.refreshed ? '订阅已刷新 · ' : '') + '连通：' + result.region + ' / ' + result.node + '（' + result.delay + 'ms，共 ' + result.nodes + ' 个节点）');
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
        el('div', { style: S.desc }, '开启后，DSH 可以在需要时通过本插件自动切换代理、使用代理；关闭后禁止使用。开关只是授权，不会立刻启动内核——真正需要时（或点下方「测试延迟并刷新节点」）才拉起。开关需要先填好机场链接。'),
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
          '状态：' + (state.running ? '运行中' : '未运行')
          + (state.running && state.current ? ' · ' + state.current : '')
          + (state.delay ? ' · ' + state.delay + ' ms' : '')
          + (state.version ? ' · 内核 ' + state.version : '')
          + (state.port ? ' · 端口 ' + state.port : '')
          + (state.running && state.startedAt ? ' · 已运行 ' + durationText(Date.now() - state.startedAt) : '')
          + (busy ? ' · 处理中…' : '')),
        el('div', { style: S.mono },
          '订阅更新：' + (state.providerUpdatedAt ? timeAgo(state.providerUpdatedAt) : '未拉取')
          + ' · 上次选节点：' + (state.lastPick ? timeAgo(state.lastPick.at) + '（' + state.lastPick.node + '）' : '无记录')),
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
            el('button', { style: S.btn, onClick: () => { void test(); } }, '测试延迟并刷新节点'))) : null,
        message ? el('div', { style: tone === 'warn' ? S.warn : tone === 'ok' ? S.ok : S.note }, message) : null,
        el('div', { style: S.mono }, '偏好：' + (regions.length ? regions.join(' → ') : '未设置（全部节点里选最低）')));
    }

    /** 设置页卡片：左下角余额徽标的开关与现状 */
    function BalanceCard() {
      const store = useBalance();
      const [busy, setBusy] = useState(false);
      const [refreshing, setRefreshing] = useState(false);
      const [intervalInput, setIntervalInput] = useState(String(store.intervalMinutes || 1));
      const [intervalMsg, setIntervalMsg] = useState('');
      const [intervalTone, setIntervalTone] = useState('note');
      const data = store.data;

      useEffect(() => {
        setIntervalInput(String(store.intervalMinutes || 1));
      }, [store.intervalMinutes]);

      async function onToggle(next) {
        setBusy(true);
        await saveBalanceBadge(next);
        setBusy(false);
      }
      async function refreshNow() {
        setRefreshing(true);
        await refreshBalance(true);
        setRefreshing(false);
      }
      async function onSaveInterval() {
        const result = await saveBalanceInterval(intervalInput);
        if (result.ok) {
          setIntervalInput(String(result.minutes));
          setIntervalMsg('已保存：每 ' + result.minutes + ' 分钟刷新，立即生效，无需重启。');
          setIntervalTone('ok');
        } else {
          setIntervalMsg('保存失败：' + result.error);
          setIntervalTone('warn');
        }
      }

      return el('div', { style: S.card },
        el('div', { style: S.head },
          el('div', { style: S.title }, '左下角余额徽标'),
          el(Switch, {
            checked: store.enabled,
            disabled: busy,
            label: '左下角余额徽标',
            onChange: (event) => { void onToggle(event.target.checked); },
          })),
        el('div', { style: S.desc }, '开启后，在侧边栏左下角、代理状态正上方常驻显示账号余额与峰谷档位；窗口重新变为可见时立即刷新一次。关掉后停止全部请求，不残留后台轮询。数据源与手动排查的 balance.ps1 -Json 完全一致。'),
        el('div', { style: S.status }, '当前：' + (!store.enabled ? '已关闭（停止轮询）'
          : data ? (String(data.text || '') + ' ' + String(data.tierText || '') + ' · 更新于 ' + String(data.checkedAt || '—'))
            : '尚未取到（等待首次刷新）')),
        store.error ? el('div', { style: S.warn }, '取数失败：' + store.error) : null,
        el('div', { style: S.note }, '颜色口径与代理徽标一致：绿色＝正常（低谷价），红色＝异常或高峰价，灰色＝尚未取到。'),
        el('div', { style: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' } },
          el('span', { style: { fontSize: 12, opacity: 0.7 } }, '轮询间隔（分钟，1–60）'),
          el('input', {
            type: 'number', min: 1, max: 60, value: intervalInput,
            onChange: (event) => setIntervalInput(event.target.value),
            style: { width: 80, padding: '5px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: 13 },
          }),
          el('button', { style: S.btn, disabled: busy, onClick: () => { void onSaveInterval(); } }, '保存间隔'),
          el('button', {
            style: S.btn,
            disabled: refreshing,
            onClick: () => { void refreshNow(); },
          }, refreshing ? '刷新中…' : '立即刷新')),
        intervalMsg ? el('div', { style: intervalTone === 'warn' ? S.warn : S.ok }, intervalMsg) : null,
        el('div', { style: S.mono }, '当前间隔：每 ' + String(store.intervalMinutes || 1) + ' 分钟（默认 1 分钟；1 分钟约 1440 次/天）'));
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

      const [purge, setPurge] = useState(false);
      const [purgeSaving, setPurgeSaving] = useState(false);
      const [purgeMessage, setPurgeMessage] = useState('');
      const [purgeTone, setPurgeTone] = useState('note');

      useEffect(() => { void load(); }, []);

      async function load() {
        try {
          const res = await fetch(API + '/state', { cache: 'no-store' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '读取失败');
          setHidden(!data.enabled);
          setChainZh(Boolean(data.chainZh));
          setPurge(Boolean(data.purge));
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

      async function persistPurge(next) {
        setPurgeSaving(true);
        setPurgeMessage('');
        try {
          const res = await fetch(API + '/purge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ on: next }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error((data.error || '保存失败') + (data.tail ? '：' + String(data.tail).slice(-400) : ''));
          setPurge(Boolean(data.purge));
          if (data.changed) {
            if (data.note) { setPurgeMessage(data.note); setPurgeTone('note'); }
            await restartAt('purge');
            return;
          }
          setPurgeMessage('没有变化，无需重启。');
          setPurgeTone('note');
          setPurgeSaving(false);
        } catch (error) {
          setPurge(!next);
          setPurgeMessage('失败：' + String(error && error.message ? error.message : error));
          setPurgeTone('warn');
          setPurgeSaving(false);
        }
      }

      function onTogglePurge(event) {
        const next = event.target.checked;
        setPurge(next);
        void persistPurge(next);
      }

      /** which: 'api' | 'chain' —— 重启状态显示在触发它的那张卡片上 */
      async function restartAt(which) {
        const isChain = which === 'chain';
        const isPurge = which === 'purge';
        const setS = isPurge ? setPurgeSaving : isChain ? setChainSaving : setSaving;
        const setM = isPurge ? setPurgeMessage : isChain ? setChainMessage : setMessage;
        const setT = isPurge ? setPurgeTone : isChain ? setChainTone : setTone;
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
          el('div', { style: S.desc }, '开启后，把「思考用简体中文，仅术语保留英文」追加到三个 Agent 预设的 persona.prefix（系统提示前段，比尾部更抗长上下文稀释）；关闭后从 prefix 里删掉。改动写进 profile 补丁，拨动开关即自动重启生效。'),
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
        el(BalanceCard, {}),
        el('div', { style: S.card },
          el('div', { style: S.title }, '说明'),
          el('div', { style: S.desc }, '这是个人插件 dsh-lqconfig。每次改动都会先备份原补丁（.bak-lqconfig-时间戳）；「隐藏 API」与「思维链优先中文」保存后仍按原逻辑自动重启；「打开资源管理器和程序」只保存 state.json，立即生效，不触发重启。以后要加别的个人开关，往这里加卡片即可。')));
    }

    /**
     * 侧边栏底部常驻代理状态徽标：圆点 + 简短状态，点击弹出详情。
     * 余额行渲染在同一列内的正上方——slot 容器是横向 flex，独立注册会被排成左右并排，
     * 所以这里让代理组件自己竖排两行，代理保持左对齐。
     */
    function ProxyStatusBadge(props) {
      const wide = props.wide !== false;
      const store = useProxyStatus();
      const state = store.state;
      const balance = useBalance();

      useEffect(() => acquireProxyPolling(), []);
      useEffect(() => {
        if (!balance.enabled) return undefined;
        return acquireBalancePolling();
      }, [balance.enabled]);

      const running = Boolean(state && state.running);
      const enabled = Boolean(state && state.enabled);
      const color = store.error ? '#c0392b' : running ? '#1e8449' : enabled ? '#c28b30' : 'rgba(128,128,128,0.6)';
      const label = store.error ? '代理状态未知'
        : !state ? '读取中…'
          : running ? (state.current || '代理运行中')
            : enabled ? '内核未启动'
              : '代理已关闭';
      const detail = '代理：' + label
        + (state && state.delay ? '（' + state.delay + 'ms）' : '')
        + (state && state.port ? '（端口 ' + state.port + '）' : '');

      const bData = balance.data;
      const bPeak = Boolean(bData && bData.tier === 'peak');
      const bColor = balance.error ? '#c0392b' : bData ? (bPeak ? '#c0392b' : '#1e8449') : 'rgba(128,128,128,0.6)';
      const bLabel = balance.error ? '余额未知'
        : !bData ? '余额读取中…'
          : String(bData.text || '—') + ' ' + String(bData.tierText || '');
      const bDetail = '余额：' + bLabel
        + (balance.error ? '（' + balance.error + '）' : '')
        + (bData && bData.checkedAt ? '（更新于 ' + bData.checkedAt + '）' : '');

      return el('div', {
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2,
          flex: '1 1 auto', minWidth: 0, width: wide ? '100%' : 'auto',
        },
      },
        balance.enabled ? el('div', {
          title: bDetail,
          'aria-label': bDetail,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
            padding: wide ? '6px 10px' : '6px', fontSize: 12,
            textAlign: 'left', justifyContent: wide ? 'flex-start' : 'center',
          },
        },
          el('span', {
            'aria-hidden': 'true',
            style: {
              width: 8, height: 8, flex: '0 0 auto', borderRadius: 4, background: bColor,
              boxShadow: bData && !balance.error && !bPeak ? '0 0 0 3px rgba(30,132,73,0.16)' : 'none',
              transition: 'background .2s',
            },
          }),
          wide ? el('span', {
            style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 },
          }, bLabel) : null) : null,
        el('button', {
          type: 'button',
          title: detail + '，点击查看详情',
          'aria-expanded': store.popover ? 'true' : 'false',
          onClick: (event) => {
            event.stopPropagation();
            void refreshProxyStatus();
            publishProxy({ popover: !proxySnapshot.popover, message: '', tone: 'note' });
          },
          style: {
            display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 auto',
            minWidth: 0, width: wide ? '100%' : 'auto', padding: wide ? '6px 10px' : '6px', margin: 0,
            background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer',
            color: 'inherit', fontSize: 12, textAlign: 'left', justifyContent: wide ? 'flex-start' : 'center',
          },
        },
          el('span', {
            'aria-hidden': 'true',
            style: {
              width: 8, height: 8, flex: '0 0 auto', borderRadius: 4, background: color,
              boxShadow: running ? '0 0 0 3px rgba(30,132,73,0.16)' : 'none',
              transition: 'background .2s',
            },
          }),
          wide ? el('span', {
            style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 },
          }, label) : null));
    }

    /** 徽标弹层：状态明细 + 测试延迟并刷新节点 / 停止内核；渲染在 shell.overlay 里 */
    function ProxyStatusPopover() {
      const store = useProxyStatus();
      if (!store.popover) return null;
      const state = store.state;
      const running = Boolean(state && state.running);
      const close = () => publishProxy({ popover: false, message: '', tone: 'note' });

      async function act(routePath) {
        const isEnsure = routePath === '/proxy/ensure';
        publishProxy({
          busy: routePath,
          message: isEnsure ? '刷新订阅并测速中，最多十几秒…' : '正在停止内核…',
          tone: 'note',
        });
        try {
          const response = await fetch(API + routePath, isEnsure
            ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) }
            : { method: 'POST' });
          const data = await response.json();
          if (!data.ok) throw new Error(data.error || 'HTTP ' + response.status);
          if (isEnsure) {
            publishProxy({
              message: (data.refreshed ? '订阅已刷新 · ' : '') + '连通：' + data.region + ' / ' + data.node + '（' + data.delay + 'ms，共 ' + data.nodes + ' 个节点）',
              tone: 'ok',
            });
          } else {
            publishProxy({ message: '已停止内核', tone: 'note' });
          }
        } catch (error) {
          publishProxy({ message: '操作失败：' + (error && error.message ? error.message : error), tone: 'warn' });
        }
        publishProxy({ busy: '' });
        await refreshProxyStatus();
      }

      const rows = [
        ['开关', state ? (state.enabled ? '已授权' : '已关闭') : '读取中…'],
        ['内核', running ? '运行中' + (state.version ? ' · v' + state.version : '') : '未运行'],
        ['端口', state && state.port ? String(state.port) : '—'],
        ['当前节点', state && state.current ? state.current : '—'],
        ['延迟', state && state.delay ? state.delay + ' ms' : '—'],
        ['已运行', running && state.startedAt ? durationText(Date.now() - state.startedAt) : '—'],
        ['偏好', state && state.regions && state.regions.length ? state.regions.join(' → ') : '未设置（全部节点取最低）'],
        ['订阅更新', state && state.providerUpdatedAt ? timeAgo(state.providerUpdatedAt) : '未拉取'],
        ['上次选节点', state && state.lastPick ? timeAgo(state.lastPick.at) + ' · ' + state.lastPick.node : '无记录'],
      ];

      return el('div', { style: { position: 'absolute', inset: 0 } },
        el('div', { onClick: close, style: { position: 'absolute', inset: 0 } }),
        el('div', {
          role: 'dialog',
          'aria-label': '代理状态',
          onClick: (event) => event.stopPropagation(),
          style: {
            position: 'absolute', left: 12, bottom: 12, width: 320, maxWidth: 'calc(100vw - 24px)',
            background: 'var(--dsw-alias-background-primary, #fff)', color: 'var(--dsw-alias-label-primary, #222)',
            border: '1px solid rgba(128,128,128,0.3)', borderRadius: 12, padding: 14, fontSize: 13,
            boxShadow: '0 10px 36px rgba(0,0,0,0.24)',
          },
        },
          el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            el('strong', { style: { fontSize: 13 } }, '代理状态'),
            el('button', { type: 'button', style: { ...S.btn, padding: '3px 8px', fontSize: 12 }, onClick: close }, '关闭')),
          el('div', { style: { marginTop: 10, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px' } },
            rows.flatMap(([label, value]) => [
              el('span', { key: 'l-' + label, style: { opacity: 0.6, whiteSpace: 'nowrap' } }, label),
              el('span', { key: 'v-' + label, style: { wordBreak: 'break-all' } }, value),
            ])),
          store.error ? el('div', { style: { ...S.warn, marginTop: 8 } }, '读取失败：' + store.error) : null,
          store.message ? el('div', {
            style: {
              marginTop: 8, fontSize: 12,
              color: store.tone === 'warn' ? '#c0392b' : store.tone === 'ok' ? '#1e8449' : 'inherit',
              opacity: store.tone === 'note' ? 0.7 : 1,
            },
          }, store.message) : null,
          el('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
            el('button', { type: 'button', style: S.btn, disabled: Boolean(store.busy) || !(state && state.enabled),
              onClick: () => { void act('/proxy/ensure'); } }, store.busy === '/proxy/ensure' ? '刷新中…' : '测试延迟并刷新节点'),
            el('button', { type: 'button', style: S.btn, disabled: Boolean(store.busy) || !running,
              onClick: () => { void act('/proxy/stop'); } }, '停止内核'),
            el('button', { type: 'button', style: S.btn, disabled: Boolean(store.busy),
              onClick: () => { void refreshProxyStatus(); } }, '刷新')),
          el('div', { style: { ...S.note, marginTop: 8 } }, '每 20 秒自动刷新；完整设置在「设置 → LQ配置 → 自动代理工具」。')));
    }

    /** 输入框下方统计行里的代理状态胶囊（🟢 代理中 / 🟡 未代理 / 🔴 故障），点击打开 LQ配置 */
    function ProxyDockPill() {
      const store = useProxyStatus();
      const [hover, setHover] = useState(false);
      useEffect(() => acquireProxyPolling(), []);
      const state = store.state;
      // 首次读数还没到就先不占位，避免闪一下「未代理」
      if (!state && !store.error) return null;
      const running = Boolean(state && state.running);
      const enabled = Boolean(state && state.enabled);
      const failed = Boolean(store.error) || (running && !state.current);
      const dot = failed ? '🔴' : running ? '🟢' : '🟡';
      const text = failed ? '故障' : running ? '代理中' : '未代理';
      const detail = failed
        ? (store.error || '内核在跑，但没读到当前节点')
        : running
          ? '节点 ' + (state.current || '—')
            + (state.delay ? ' · ' + state.delay + ' ms' : '')
            + (state.port ? ' · 端口 ' + state.port : '')
          : enabled ? '开关已授权，内核还没启动（按需拉起）' : '代理开关已关闭';

      return el('button', {
        type: 'button',
        'data-composer-stat': 'proxy',
        title: text + '：' + detail + '｜点击打开 设置 → LQ配置',
        'aria-label': '代理状态：' + text + '，点击打开 LQ配置',
        onClick: () => { openLqSettings(); },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
          lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
          color: hover ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          border: 'none', borderRadius: 'var(--dsw-radius-sm, 6px)',
          padding: '1px 8px', cursor: 'pointer', whiteSpace: 'nowrap',
          fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
        },
      },
        el('span', { 'aria-hidden': 'true', style: { fontSize: 11, lineHeight: '14px' } }, dot),
        el('span', null, text));
    }

    function apply(ctx) {
      void loadBalanceSettings();
      ctx.effect(() => installNativeOpening(ctx), 'dsh-lqconfig: native opening');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'dsh-lqconfig.native-open-notice', order: 90,
      }, NativeOpenNotice));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'dsh-lqconfig.proxy-status', order: 91,
      }, ProxyStatusPopover));
      // 余额行由 ProxyStatusBadge 内部渲染在代理上方（slot 本身是横向 flex，独立注册会并排）
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'dsh-lqconfig.proxy-badge', order: 90,
      }, ProxyStatusBadge));
      // 统计行里的「🟢 代理中」胶囊已按用户要求移除；ProxyDockPill 函数保留未用。
      // 需要恢复时解除下面三行注释：
      // ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      //   name: 'conversation.composer.dock', id: 'dsh-lqconfig.proxy-pill', order: 2,
      // }, ProxyDockPill));
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
