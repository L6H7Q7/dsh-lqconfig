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

    /** 提示词正文字符数的展示后缀：读不到就不显示（不做假数据） */
    function charsSuffix(n) {
      const v = Number(n);
      return Number.isFinite(v) && v > 0 ? ' / ' + (v / 1000).toFixed(1) + 'K' : '';
    }

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
    /* ---------------- 觉醒模式徽标：左下角最上方，正常 / 进化 / 觉醒 三态 ---------------- */
    let awakeningSnapshot = { loaded: false, awakening: false, variant: 'lite', error: '' };
    const awakeningSubscribers = new Set();
    function publishAwakening(patch) {
      awakeningSnapshot = { ...awakeningSnapshot, ...patch };
      for (const listener of [...awakeningSubscribers]) listener();
    }
    function useAwakeningStatus() {
      return React.useSyncExternalStore(
        React.useCallback((listener) => { awakeningSubscribers.add(listener); return () => awakeningSubscribers.delete(listener); }, []),
        () => awakeningSnapshot,
      );
    }
    async function refreshAwakeningStatus() {
      try {
        const response = await fetch(API + '/state', { cache: 'no-store' });
        const data = await response.json();
        if (!data || !data.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
        publishAwakening({
          loaded: true,
          awakening: data.awakening === true,
          variant: data.awakeningVariant === 'full' ? 'full' : 'lite',
          error: '',
        });
      } catch (error) {
        publishAwakening({ loaded: true, error: String(error && error.message ? error.message : error) });
      }
    }
    let awakeningPollTimer = null;
    let awakeningPollUsers = 0;
    function onAwakeningVisibility() {
      if (typeof document !== 'undefined' && !document.hidden) void refreshAwakeningStatus();
    }
    function acquireAwakeningPolling() {
      awakeningPollUsers += 1;
      if (awakeningPollTimer === null) {
        void refreshAwakeningStatus();
        awakeningPollTimer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void refreshAwakeningStatus();
        }, 30000);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onAwakeningVisibility);
      }
      return () => {
        awakeningPollUsers -= 1;
        if (awakeningPollUsers > 0 || awakeningPollTimer === null) return;
        clearInterval(awakeningPollTimer);
        awakeningPollTimer = null;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onAwakeningVisibility);
      };
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
      extRow: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' },
      extLabel: { fontSize: 12, opacity: 0.65, minWidth: 84, lineHeight: '28px' },
      chipBox: { flex: '1 1 260px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', minHeight: 28 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 2, padding: '2px 2px 2px 9px', borderRadius: 7, border: '1px solid rgba(128,128,128,0.35)', background: 'rgba(128,128,128,0.08)', fontSize: 12, lineHeight: '18px' },
      chipX: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '2px 5px', opacity: 0.55, borderRadius: 5 },
      chipAdd: { width: 28, height: 26, borderRadius: 7, border: '1px dashed rgba(128,128,128,0.55)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 15, lineHeight: 1, opacity: 0.75, padding: 0 },
      chipInput: { width: 76, height: 26, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 7, border: '1px solid rgba(128,128,128,0.55)', background: 'transparent', color: 'inherit', outline: 'none' },
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

    /*
     * 扩展名名单：名单外一律「程序 + 文件夹」两路都做；名单命中即固定单路。
     * folderOnlyExts  —— 只打开文件夹并选中，不调用默认程序（apk → 不启动模拟器）
     * programOnlyExts —— 只调用默认程序，不弹资源管理器（exe/bat 等执行型）
     * 互斥校验在 Host 侧；这里只做输入解析、默认值与展示。
     */
    const NATIVE_FOLDER_ONLY_DEFAULT = ['apk'];
    const NATIVE_PROGRAM_ONLY_DEFAULT = ['exe', 'com', 'bat', 'cmd', 'vbs', 'vbe', 'ps1', 'msi', 'lnk', 'scr'];
    const NATIVE_EXT_MAX = 32;
    function parseExtInput(text) {
      return String(text || '')
        .split(/[\s,，、;；]+/u)
        .map(item => item.trim().toLowerCase().replace(/^\.+/u, ''))
        .filter(Boolean);
    }

    // Plugin-lifetime state: closing the settings page does not turn this off.
    let nativeSnapshot = {
      openNative: false,
      folderOnlyExts: [...NATIVE_FOLDER_ONLY_DEFAULT],
      programOnlyExts: [...NATIVE_PROGRAM_ONLY_DEFAULT],
      saving: false, savingExts: false, message: '', error: '', compatibility: '', notice: null,
    };
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
        if (revision === nativeRevision) publishNative({
          openNative: data.openNative === true,
          folderOnlyExts: Array.isArray(data.folderOnlyExts) ? data.folderOnlyExts : [...NATIVE_FOLDER_ONLY_DEFAULT],
          programOnlyExts: Array.isArray(data.programOnlyExts) ? data.programOnlyExts : [...NATIVE_PROGRAM_ONLY_DEFAULT],
          error: '',
        });
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
        if (revision === nativeRevision) publishNative({
          openNative: data.openNative === true,
          folderOnlyExts: Array.isArray(data.folderOnlyExts) ? data.folderOnlyExts : nativeSnapshot.folderOnlyExts,
          programOnlyExts: Array.isArray(data.programOnlyExts) ? data.programOnlyExts : nativeSnapshot.programOnlyExts,
          saving: false, message: '已保存，即时生效，无需重启。',
        });
      } catch (error) {
        // Fail closed; an unsaved toggle must never silently activate opening.
        if (revision === nativeRevision) publishNative({ openNative: false, saving: false, error: '保存失败：' + error.message });
      }
    }
    async function saveExtLists(folderOnlyExts, programOnlyExts) {
      const revision = ++nativeRevision;
      publishNative({ savingExts: true, message: '', error: '' });
      try {
        const data = await nativeJson('/native-setting', { folderOnlyExts, programOnlyExts });
        if (revision === nativeRevision) publishNative({
          folderOnlyExts: Array.isArray(data.folderOnlyExts) ? data.folderOnlyExts : folderOnlyExts,
          programOnlyExts: Array.isArray(data.programOnlyExts) ? data.programOnlyExts : programOnlyExts,
          savingExts: false, message: '名单已保存，即时生效，无需重启。',
        });
      } catch (error) {
        if (revision === nativeRevision) publishNative({ savingExts: false, error: '保存失败：' + error.message });
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
        const data = await nativeJson('/native-open', { path: target, ...(operations ? { operations } : {}) });
        if (!nativeDisposed && id === nativeNoticeSequence) {
          const explorer = data.explorer;
          const program = data.program;
          const message = explorer?.reused === true
            ? '已切换到已打开的资源管理器窗口（未新建）' + (explorer.selected === true ? '，并选中目标文件。' : '。')
            : program && !explorer ? '已请求系统默认程序打开（该扩展名只走这一路）；窗口是否出现尚未核实。'
            : !program && explorer ? '已请求资源管理器定位（该扩展名只走这一路）；窗口是否出现尚未核实。'
            : '打开请求已提交；窗口是否出现尚未核实。';
          publishNative({ message, notice: null });
        }
      } catch (error) {
        if (!nativeDisposed && id === nativeNoticeSequence) {
          const results = [
            { key: 'program', label: '系统程序', result: error.program },
            { key: 'explorer', label: '资源管理器', result: error.explorer },
          ].filter(item => item.result);
          const retryOperations = results.length
            ? results.filter(item => !item.result.ok).map(item => item.key)
            : (Array.isArray(operations) ? operations : []);
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
      const [state, setState] = useState({
        visible: true,
        serviceWindow: true,
        shutdownOnTurnEnd: true,
        console: { enabled: true, push: true },
      });
      const [saving, setSaving] = useState('');
      const [message, setMessage] = useState('');
      const [tone, setTone] = useState('note');
      const [runs, setRuns] = useState([]);

      function adopt(data) {
        setState({
          visible: data.visible !== false,
          serviceWindow: data.serviceWindow !== false,
          shutdownOnTurnEnd: data.shutdownOnTurnEnd !== false,
          console: {
            enabled: !(data.console && data.console.enabled === false),
            push: !(data.console && data.console.push === false),
          },
        });
      }

      async function load() {
        try {
          const res = await fetch('/visible-shell/api/state', { cache: 'no-store' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '读取失败');
          adopt(data);
        } catch (error) {
          setTone('warn');
          setMessage('读取失败：' + String(error && error.message ? error.message : error));
        }
      }

      async function loadRuns() {
        try {
          const res = await fetch('/visible-shell/api/runs', { cache: 'no-store' });
          const data = await res.json();
          if (data.ok) setRuns(Array.isArray(data.runs) ? data.runs : []);
        } catch { /* 状态徽标读不到不影响开关 */ }
      }

      useEffect(() => {
        let disposed = false;
        void load();
        void loadRuns();
        const timer = setInterval(() => {
          if (disposed) return;
          if (typeof document !== 'undefined' && document.hidden) return;
          void loadRuns();
        }, 5000);
        return () => { disposed = true; clearInterval(timer); };
      }, []);

      async function persist(patch, key) {
        setSaving(key);
        setMessage('');
        try {
          const res = await fetch('/visible-shell/api/set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          adopt(data);
          setTone('ok');
          setMessage('已保存，即时生效，无需重启。');
        } catch (error) {
          setTone('warn');
          setMessage('保存失败：' + String(error && error.message ? error.message : error));
          void load();
        } finally {
          setSaving('');
        }
      }

      const running = runs.filter(run => run.status === 'running');

      function block(label, desc, checked, onToggle, key) {
        return [
          el('div', { style: { ...S.head, marginTop: 14 } },
            el('div', { style: S.title }, label),
            el(Switch, {
              checked,
              disabled: Boolean(saving),
              label,
              onChange: event => { void onToggle(event.target.checked); },
            })),
          el('div', { style: S.desc }, desc),
        ];
      }

      return el('div', { style: S.card },
        el('div', { style: S.title }, '命令执行'),
        ...block('命令窗口',
          '开启后，DSH 执行每条命令都会弹出一个真实的终端窗口，命令跑完窗口自动关闭，输出经日志回传对话；关闭后恢复隐藏执行（与官方内置一致）。开关由 visible-shell 插件提供，读写它的 state.json，即时生效、不重启。',
          state.visible, next => persist({ visible: next }, 'visible'), 'visible'),
        ...block('服务窗口',
          '带 run_in_background 的命令（ComfyUI、codex CLI、任何常驻服务）窗口保留到对话结束；由 WMI 拉起，服务常驻也不会把工具调用吊死。',
          state.serviceWindow, next => persist({ serviceWindow: next }, 'serviceWindow'), 'serviceWindow'),
        ...block('对话结束自动关服务',
          '一轮对话结束时关掉本会话启动的全部服务进程，释放显存与后台占用。只关本会话的，不影响别的对话。',
          state.shutdownOnTurnEnd, next => persist({ shutdownOnTurnEnd: next }, 'shutdownOnTurnEnd'), 'shutdownOnTurnEnd'),
        ...block('总控台',
          '新对话自动打开一个命令总控台窗口，实时列出每条命令的开始时间、耗时与结果；对话结束时渲染成 PNG。',
          state.console.enabled, next => persist({ console: { enabled: next } }, 'console'), 'console'),
        el('div', { style: { ...S.desc, marginTop: 4 } },
          el('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
            el('input', {
              type: 'checkbox',
              checked: state.console.push,
              disabled: !state.console.enabled || Boolean(saving),
              onChange: event => { void persist({ console: { push: event.target.checked } }, 'push'); },
            }),
            '对话结束时把总控台截图连同结论推送到企业微信（由 wecom-notify 执行）')),
        el('div', { style: S.status }, '当前：' + (state.visible ? '每条命令弹窗' : '隐藏执行')
          + ' · 服务窗口' + (state.serviceWindow ? '开' : '关')
          + ' · 对话结束' + (state.shutdownOnTurnEnd ? '关服务' : '不关')
          + ' · 总控台' + (state.console.enabled ? '开' : '关')
          + (state.console.push ? '（含推送）' : '')
          + (saving ? ' · 保存中…' : '')),
        running.length > 0
          ? el('div', { style: S.note }, '运行中：' + running.map(run => (run.title || run.runId) + '（pid ' + run.pid + '）').join('、'))
          : null,
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
      const forceStop = useForceStopSetting();
      const [forceStopMessage, setForceStopMessage] = useState('');
      const [patchPath, setPatchPath] = useState('');
      const [hidden, setHidden] = useState(false);
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState('');
      const [tone, setTone] = useState('note');

      const [rules, setRules] = useState(false);
      const [rulesSaving, setRulesSaving] = useState(false);
      const [rulesMessage, setRulesMessage] = useState('');
      const [rulesTone, setRulesTone] = useState('note');
      const [rulesInfo, setRulesInfo] = useState(null);
      const [awakening, setAwakening] = useState(false);
      const [awakeningSaving, setAwakeningSaving] = useState(false);
      const [awakeningMessage, setAwakeningMessage] = useState('');
      const [awakeningTone, setAwakeningTone] = useState('note');
      const [awakeningPath, setAwakeningPath] = useState('');
      const [awakeningVariant, setAwakeningVariant] = useState('lite');
      const [awakeningChars, setAwakeningChars] = useState(null);
      const [awakeningLiteChars, setAwakeningLiteChars] = useState(null);
      const [variantSaving, setVariantSaving] = useState(false);
      const [revealing, setRevealing] = useState('');
      // 名单编辑：'' = 没在输入；'folder' / 'program' = 哪个名单正在加一个格。
      const [extEditing, setExtEditing] = useState('');
      const [extDraft, setExtDraft] = useState({ folder: '', program: '' });
      const extCancelRef = React.useRef(false);

      function listOf(which) {
        return which === 'folder' ? (native.folderOnlyExts || []) : (native.programOnlyExts || []);
      }
      function beginExtEdit(which) {
        if (native.savingExts || extEditing === which) return;
        // 切到另一个名单时，先把正在输入的那个提交掉，避免内容被吞。
        if (extEditing) void commitExtEdit(extEditing);
        extCancelRef.current = false;
        setExtDraft(prev => ({ ...prev, [which]: '' }));
        setExtEditing(which);
      }
      async function commitExtEdit(which) {
        if (extCancelRef.current) { extCancelRef.current = false; return; }
        const raw = extDraft[which];
        setExtEditing('');
        setExtDraft(prev => ({ ...prev, [which]: '' }));
        const added = parseExtInput(raw);
        if (!added.length) return;
        const merged = Array.from(new Set([...listOf(which), ...added]));
        if (which === 'folder') await saveExtLists(merged, native.programOnlyExts || []);
        else await saveExtLists(native.folderOnlyExts || [], merged);
      }
      function removeExt(which, ext) {
        if (native.savingExts) return;
        const rest = listOf(which).filter(item => item !== ext);
        if (which === 'folder') void saveExtLists(rest, native.programOnlyExts || []);
        else void saveExtLists(native.folderOnlyExts || [], rest);
      }
      function renderExtRow(which, label) {
        const list = listOf(which);
        const editing = extEditing === which;
        const draft = extDraft[which];
        return el('div', { style: S.extRow },
          el('span', { style: S.extLabel }, label),
          el('div', { style: S.chipBox },
            list.map(ext => el('span', { key: ext, style: S.chip },
              el('span', null, ext),
              el('button', {
                type: 'button', style: S.chipX, title: '移除 .' + ext, disabled: native.savingExts,
                onClick: () => removeExt(which, ext),
              }, '×'))),
            editing
              ? el('input', {
                type: 'text', autoFocus: true, value: draft, style: S.chipInput, placeholder: 'apk',
                disabled: native.savingExts,
                onChange: event => setExtDraft(prev => ({ ...prev, [which]: event.target.value })),
                // 点空白处 / 回车即保存；Esc 取消这一格。
                onBlur: () => { void commitExtEdit(which); },
                onKeyDown: event => {
                  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                  else if (event.key === 'Escape') {
                    event.preventDefault();
                    extCancelRef.current = true;
                    setExtDraft(prev => ({ ...prev, [which]: '' }));
                    setExtEditing('');
                  }
                },
              })
              : el('button', {
                type: 'button', style: S.chipAdd, title: '添加扩展名', disabled: native.savingExts,
                onClick: () => beginExtEdit(which),
              }, '＋')));
      }


      useEffect(() => { void load(); }, []);

      async function load() {
        try {
          const res = await fetch(API + '/state', { cache: 'no-store' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '读取失败');
          setHidden(!data.enabled);
          setRules(Boolean(data.globalRules));
          setAwakening(Boolean(data.awakening));
          setAwakeningPath(data.awakeningPath || '');
          setAwakeningVariant(data.awakeningVariant === 'full' ? 'full' : 'lite');
          setAwakeningChars(Number.isFinite(data.awakeningChars) ? data.awakeningChars : null);
          setAwakeningLiteChars(Number.isFinite(data.awakeningLiteChars) ? data.awakeningLiteChars : null);
          setPatchPath(data.patchPath || '');
          try {
            const infoRes = await fetch(API + '/global-rules', { cache: 'no-store' });
            const info = await infoRes.json();
            if (info.ok) setRulesInfo(info);
          } catch {
            // 规则源信息读不到不影响其它卡片
          }
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

      async function persistRules(next) {
        setRulesSaving(true);
        setRulesMessage('');
        try {
          const res = await fetch(API + '/global-rules', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          setRules(Boolean(data.globalRules));
          if (data.changed) {
            await restartAt('rules');
            return;
          }
          setRulesMessage('没有变化，无需重启。');
          setRulesTone('note');
          setRulesSaving(false);
        } catch (error) {
          setRules(!next);
          setRulesMessage('保存失败：' + String(error && error.message ? error.message : error));
          setRulesTone('warn');
          setRulesSaving(false);
        }
      }

      async function persistAwakening(next) {
        setAwakeningSaving(true);
        setAwakeningMessage('');
        try {
          const res = await fetch(API + '/awakening', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          setAwakening(Boolean(data.awakening));
          if (data.changed) {
            await restartAt('awakening');
            return;
          }
          setAwakeningMessage('没有变化，无需重启。');
          setAwakeningTone('note');
          setAwakeningSaving(false);
        } catch (error) {
          setAwakening(!next);
          setAwakeningMessage('保存失败：' + String(error && error.message ? error.message : error));
          setAwakeningTone('warn');
          setAwakeningSaving(false);
        }
      }

      /**
       * 切换觉醒提示词版本：lite（精简 6 类）/ full（完整 25 类）。
       * 觉醒开着时后端会立即用新版本重写补丁，需要重启才生效；关着时只记配置。
       */
      async function persistAwakeningVariant(next) {
        if (next === awakeningVariant || variantSaving) return;
        const label = next === 'lite' ? '精简版' : '完整版';
        setVariantSaving(true);
        setAwakeningMessage('');
        try {
          const res = await fetch(API + '/awakening-variant', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ variant: next }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '切换失败');
          setAwakeningVariant(data.awakeningVariant === 'full' ? 'full' : 'lite');
          if (data.changed) {
            await restartAt('awakening');
            return;
          }
          setAwakeningMessage(data.applied === false ? '已切换为' + label + '；觉醒未开启，下次开启时生效。' : '已是' + label + '，未做改动。');
          setAwakeningTone('ok');
        } catch (error) {
          setAwakeningMessage('切换失败：' + String(error && error.message ? error.message : error));
          setAwakeningTone('warn');
        }
        setVariantSaving(false);
      }

      /**
       * 提示词更新入口：在资源管理器里打开源文件所在目录并选中它。
       * which: 'rules' → GLOBAL-RULES.md；'awakening' → AWAKENING-PROMPT.txt。
       * 只定位不改内容，用户改完文本再拨开关或点「重新注入」。
       */
      async function reveal(which) {
        setRevealing(which);
        const setM = which === 'rules' ? setRulesMessage : setAwakeningMessage;
        const setT = which === 'rules' ? setRulesTone : setAwakeningTone;
        setM('');
        try {
          const res = await fetch(API + '/reveal', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target: which }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '打开失败');
          setM('已在资源管理器中打开：' + data.dir + '（已选中 ' + (data.path || '').split(/[\\/]/).pop() + '）');
          setT('ok');
        } catch (error) {
          setM('打开目录失败：' + String(error && error.message ? error.message : error));
          setT('warn');
        }
        setRevealing('');
      }

      function onToggleRules(event) {
        const next = event.target.checked;
        setRules(next);
        void persistRules(next);
      }

      async function syncRules() {
        setRulesSaving(true);
        setRulesMessage('');
        try {
          const res = await fetch(API + '/global-rules/sync', { method: 'POST' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '重新注入失败');
          setRules(Boolean(data.globalRules));
          setRulesMessage(data.changed ? '已重新注入三个预设，正在重启…' : '源文件未变，补丁已是最新。');
          setRulesTone(data.changed ? 'note' : 'ok');
          if (data.changed) {
            await restartAt('rules');
            return;
          }
          setRulesSaving(false);
        } catch (error) {
          setRulesMessage('重新注入失败：' + String(error && error.message ? error.message : error));
          setRulesTone('warn');
          setRulesSaving(false);
        }
      }

      /** which: 'api' | 'rules' —— 重启状态显示在触发它的那张卡片上 */
      async function restartAt(which) {
        const setS = which === 'awakening' ? setAwakeningSaving : which === 'rules' ? setRulesSaving : setSaving;
        const setM = which === 'awakening' ? setAwakeningMessage : which === 'rules' ? setRulesMessage : setMessage;
        const setT = which === 'awakening' ? setAwakeningTone : which === 'rules' ? setRulesTone : setTone;
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
            el('div', { style: S.title }, '全局规则'),
            el(Switch, { checked: rules, disabled: rulesSaving || awakening || awakeningSaving, label: '全局规则', onChange: onToggleRules })),
          el('div', { style: S.desc }, '开启后，把插件目录 GLOBAL-RULES.md 的正文压成单行，注入三个 Agent 预设的 persona.prefix（系统提示前段）；关闭时只移除标记块，其余字符不动。改动写进 profile 补丁，拨动开关即自动重启生效；源文件改完点「重新注入」。'),
          el('div', { style: S.status }, '当前：' + (rules ? '已注入 3/3 个预设' : '未注入') + (rulesSaving ? ' · 处理中…' : '')
            + (rulesInfo && rulesInfo.exists
              ? ' · 源 ' + rulesInfo.sourceBytes + ' 字节 / ' + rulesInfo.sourceLines + ' 行 → ' + rulesInfo.injectedChars + ' 字符单行'
              : ' · 源文件缺失')),
          rulesInfo && rulesInfo.truncated ? el('div', { style: S.warn }, '源文件超出单行注入上限，注入时已截断。') : null,
          rulesMessage ? el('div', { style: rulesTone === 'warn' ? S.warn : rulesTone === 'ok' ? S.ok : S.note }, rulesMessage) : null,
          el('div', { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            el('button', { style: S.btn, disabled: rulesSaving || !rules || awakening || awakeningSaving, onClick: () => { void syncRules(); } }, '重新注入'),
            el('button', { style: S.btn, disabled: revealing === 'rules', onClick: () => { void reveal('rules'); } }, revealing === 'rules' ? '打开中…' : '打开目录')),
          rulesInfo ? el('div', { style: S.mono }, '源：' + rulesInfo.path) : null),
        el('div', { style: S.card },
          el('div', { style: S.head },
            el('div', { style: S.title }, '觉醒模式'),
            el(Switch, { checked: awakening, disabled: awakeningSaving || rulesSaving, label: '觉醒模式',
              onChange: event => { const next = event.target.checked; setAwakening(next); void persistAwakening(next); } })),
          el('div', { style: S.desc }, '开启后，用所选版本的提示词正文替换三个 Agent 预设的 persona.prefix；关闭后从原文快照逐字恢复。保存后自动重启。开启期间暂时锁定「全局规则」，避免互相覆盖。改完提示词再拨一次开关（或重开）即可重新载入。'),
          el('div', { style: S.status }, '当前：' + (awakening ? '已开启' : '未开启') + (awakeningSaving ? ' · 处理中…' : '')),
          awakeningMessage ? el('div', { style: awakeningTone === 'warn' ? S.warn : awakeningTone === 'ok' ? S.ok : S.note }, awakeningMessage) : null,
          el('div', { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            el('span', { style: { fontSize: 12, opacity: 0.65 } }, '提示词版本：'),
            el('button', {
              style: awakeningVariant === 'lite' ? { ...S.btn, ...S.primary } : S.btn,
              disabled: variantSaving || awakeningSaving,
              title: Number.isFinite(awakeningLiteChars) ? '精简版正文 ' + awakeningLiteChars + ' 字符' : '精简版正文大小未知',
              onClick: () => { void persistAwakeningVariant('lite'); },
            }, '精简 · 6 类' + charsSuffix(awakeningLiteChars)),
            el('button', {
              style: awakeningVariant === 'full' ? { ...S.btn, ...S.primary } : S.btn,
              disabled: variantSaving || awakeningSaving,
              title: Number.isFinite(awakeningChars) ? '完整版正文 ' + awakeningChars + ' 字符' : '完整版正文大小未知',
              onClick: () => { void persistAwakeningVariant('full'); },
            }, '完整 · 25 类' + charsSuffix(awakeningChars))),
          el('div', { style: S.note }, '精简版保留：游戏外挂与反作弊绕过、逆向与破解、成人内容与片源检索、提示词对抗研究、固件与硬件、盗版资源检索，其余 19 类全部删除。觉醒已开启时切换版本会立即重写补丁并自动重启；未开启时只记配置，下次开启生效。'),
          el('div', { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            el('button', { style: S.btn, disabled: revealing === 'awakening', onClick: () => { void reveal('awakening'); } }, revealing === 'awakening' ? '打开中…' : '打开目录')),
          el('div', { style: S.mono }, '源：' + (awakeningPath || '（未知）'))),
        el('div', { style: S.card },
          el('div', { style: S.head },
            el('div', { style: S.title }, '打开资源管理器和程序'),
            el(Switch, { checked: native.openNative, disabled: native.saving, label: '打开资源管理器和程序',
              onChange: event => { void saveNativeSettings(event.target.checked); } })),
          el('div', { style: S.desc }, '开启后，点击聊天里的本地绝对路径链接，会保留 Sidebar 原有预览，再按下面的名单请求系统打开该路径。行号链接、相对路径和网页链接保持原有行为。'),
          el('div', { style: S.desc }, '名单外的文件默认「程序打开 + 文件夹定位」两路都做；点「＋」把扩展名加进名单，就固定只走那一路。同一个扩展名只能出现在一边。'),
          renderExtRow('folder', '只开文件夹：'),
          el('div', { style: S.note }, '例如 apk：资源管理器定位并选中该文件，绝不调用默认程序，模拟器不会被拉起。点 × 移除；「＋」输入后点空白处或回车即保存，Esc 取消。'),
          renderExtRow('program', '只开程序：'),
          el('div', { style: S.note }, '例如 exe：只启动程序，不再弹资源管理器定位。这一排清空后，这些文件会恢复两路都做（多点一个窗口）。每边最多 ' + NATIVE_EXT_MAX + ' 项。'),
          (native.programOnlyExts || []).length === 0
            ? el('div', { style: S.warn }, '「只开程序」名单是空的：exe 等会恢复两路都做，启动程序时会多弹一个资源管理器窗口。')
            : null,
          el('div', { style: S.status }, '当前：' + (native.openNative ? '已开启' : '未开启')
            + ' · 只开文件夹 ' + (native.folderOnlyExts || []).length + ' 项'
            + ' · 只开程序 ' + (native.programOnlyExts || []).length + ' 项'
            + (native.saving || native.savingExts ? ' · 保存中…' : '')
            + ' · 保存即时生效'),
          native.message ? el('div', { style: S.note }, native.message) : null,
          native.error ? el('div', { style: S.warn }, native.error) : null,
          native.compatibility ? el('div', { style: S.warn }, native.compatibility) : null),
        el('div', { style: S.card },
          el('div', { style: S.head },
            el('div', { style: S.title }, '强制终止当前任务'),
            el(Switch, {
              checked: forceStop.enabled,
              label: '强制终止当前任务',
              onChange: event => {
                const next = event.target.checked;
                setForceStopMessage('');
                void saveForceStopSetting(next).then(problem => setForceStopMessage(problem ? '保存失败：' + problem : '已保存，即时生效。'));
              },
            })),
          el('div', { style: S.desc }, '开启后，对话输入框下方的状态栏多一条「运行时长 + 强制终止」：运行时长按本轮 turn 的真实起点计时（刷新页面不跳表）；点一下「强制终止」立即触发（没有二次确认，误点就会中断本轮并丢弃未完成的输出），会先发官方中止信号，再清理该会话的后台任务、终端进程和子代理，用来对付「暂停按了没反应」的卡住。点完若 8 秒内还在跑，状态栏会多出「仍在运行 · 重启 DSH」——那是最后兜底，单击即重启，会连同其它会话一起重启、页面断开几秒。关闭后这条状态栏完全不显示。'),
          el('div', { style: S.status }, '当前：' + (forceStop.enabled ? '已开启' : '未开启') + ' · 保存即时生效'),
          forceStopMessage ? el('div', { style: S.note }, forceStopMessage) : null),
        el(CookieCleanCard, {}),
        el(VisibleShellCard, {}),
        el(ProxyCard, {}),
        el(BalanceCard, {}),
        el('div', { style: S.card },
          el('div', { style: S.title }, '说明'),
          el('div', { style: S.desc }, '这是个人插件 dsh-lqconfig。每次改动都会先备份原补丁（.bak-lqconfig-时间戳）；「隐藏 API」与「全局规则」保存后仍按原逻辑自动重启；「打开资源管理器和程序」的开关与两个扩展名名单都只保存 state.json，立即生效，不触发重启。规则正文（含思维链那句）统一写在 GLOBAL-RULES.md，改完点「重新注入」。以后要加别的个人开关，往这里加卡片即可。')));
    }

    /**
     * 侧边栏底部常驻代理状态徽标：圆点 + 简短状态，点击弹出详情。
     * 余额行渲染在同一列内的正上方——slot 容器是横向 flex，独立注册会被排成左右并排，
     * 所以这里让代理组件自己竖排两行，代理保持左对齐。
     */
    /* ---------------- 认证 Cookie 自动清理：开关 + 阈值 + 保留条数 ---------------- */
    function CookieCleanCard() {
      const [state, setState] = useState({ enabled: true, keep: 2, min: 30, report: null });
      const [minInput, setMinInput] = useState('30');
      const [keepInput, setKeepInput] = useState('2');
      const [message, setMessage] = useState('');
      const [saving, setSaving] = useState(false);

      useEffect(() => {
        let alive = true;
        void fetch(API + '/state', { cache: 'no-store' })
          .then(response => response.json())
          .then(data => {
            if (!alive || !data || !data.ok) return;
            const keep = Number.isFinite(Number(data.cookieKeep)) ? Number(data.cookieKeep) : 2;
            const min = Number.isFinite(Number(data.cookieCleanMin)) ? Number(data.cookieCleanMin) : 30;
            setState({ enabled: data.cookieAutoClean !== false, keep, min, report: data.cookieCleanup || null });
            setKeepInput(String(keep));
            setMinInput(String(min));
          })
          .catch(() => {});
        return () => { alive = false; };
      }, []);

      async function save(patch) {
        setSaving(true);
        try {
          const response = await fetch(API + '/cookie-clean', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
          });
          const data = await response.json();
          if (!data || !data.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
          setState(current => ({ ...current, enabled: data.cookieAutoClean !== false, keep: data.cookieKeep, min: data.cookieCleanMin, report: data.cookieCleanup || current.report }));
          setKeepInput(String(data.cookieKeep));
          setMinInput(String(data.cookieCleanMin));
          setMessage('已保存，下次关闭应用时按新设置执行。');
        } catch (error) {
          setMessage('保存失败：' + String(error && error.message ? error.message : error));
        } finally {
          setSaving(false);
        }
      }

      const report = state.report;
      const reportText = !report
        ? '还没有清理记录'
        : report.skipped === 'disabled'
          ? '上次关闭：自动清理已关闭，未执行'
          : report.skipped === 'below-min'
            ? '上次关闭：共 ' + report.found + ' 条，未超过阈值 ' + (report.min || state.min) + '，未清理'
            : report.ok
              ? '上次关闭：共 ' + report.found + ' 条，删除 ' + report.removed + ' 条，保留 ' + report.kept + ' 条'
              : '上次清理失败：' + (report.error || report.reason || '未知');

      return el('div', { style: S.card },
        el('div', { style: S.head },
          el('div', { style: S.title }, '自动清理旧认证 Cookie'),
          el(Switch, {
            checked: state.enabled,
            disabled: saving,
            label: '自动清理旧认证 Cookie',
            onChange: event => { setMessage(''); void save({ enabled: event.target.checked }); },
          })),
        el('div', { style: S.desc }, '本地认证 Cookie 的名字里带端口，而应用每次启动端口都不同，所以每次启动都会多一条；浏览器又不按端口隔离，请求时会把它们全部带上。攒到约 70 条就会顶破请求头上限，导致启动失败（Web authentication failed）。开启后，每次关闭应用都会自动删掉旧记录。'),
        el('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' } },
          el('span', { style: { fontSize: 12, opacity: 0.7 } }, '超过此条数才清理'),
          el('input', {
            type: 'number', value: minInput, min: 1, max: 1000,
            onChange: event => setMinInput(event.target.value),
            style: { width: 90, padding: '5px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: 13 },
          }),
          el('span', { style: { fontSize: 12, opacity: 0.7, marginLeft: 6 } }, '清理后保留'),
          el('input', {
            type: 'number', value: keepInput, min: 1, max: 10,
            onChange: event => setKeepInput(event.target.value),
            style: { width: 70, padding: '5px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: 13 },
          }),
          el('button', { style: S.btn, disabled: saving, onClick: () => { setMessage(''); void save({ min: Number(minInput), keep: Number(keepInput) }); } }, '保存')),
        el('div', { style: S.status }, reportText + (saving ? ' · 保存中…' : '') + ' · 关闭应用后执行'),
        message ? el('div', { style: S.note }, message) : null);
    }

    function ProxyStatusBadge(props) {
      const wide = props.wide !== false;
      const store = useProxyStatus();
      const state = store.state;
      const balance = useBalance();
      const awake = useAwakeningStatus();

      useEffect(() => acquireProxyPolling(), []);
      useEffect(() => acquireAwakeningPolling(), []);
      const [modeMenu, setModeMenu] = useState(false);
      const modeMenuRef = React.useRef(null);
      const [modeSaving, setModeSaving] = useState(false);
      const [balanceRefreshing, setBalanceRefreshing] = useState(false);

      // 菜单打开时：点外部或按 Esc 关闭（捕获阶段监听，避免被内部 stopPropagation 挡住）
      useEffect(() => {
        if (!modeMenu) return undefined;
        function onDocPointerDown(event) {
          const node = modeMenuRef.current;
          if (node && node.contains(event.target)) return;
          setModeMenu(false);
        }
        function onDocKeyDown(event) {
          if (event.key === 'Escape') setModeMenu(false);
        }
        document.addEventListener('pointerdown', onDocPointerDown, true);
        document.addEventListener('keydown', onDocKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onDocPointerDown, true);
          document.removeEventListener('keydown', onDocKeyDown, true);
        };
      }, [modeMenu]);

      /**
       * 三模式切换（点击左下角觉醒行弹出的菜单）：
       * normal = 关闭觉醒；lite = 开启 + 精简版；full = 开启 + 完整版。
       * 先对齐版本再对齐开关，任一改动落地后统一重启一次。
       */
      async function applyAwakeningMode(mode) {
        if (modeSaving) return;
        setModeMenu(false);
        const wantEnabled = mode !== 'normal';
        const wantVariant = mode === 'full' ? 'full' : 'lite';
        setModeSaving(true);
        let needRestart = false;
        try {
          if (wantEnabled && wantVariant !== awake.variant) {
            const res = await fetch(API + '/awakening-variant', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ variant: wantVariant }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || '切换版本失败');
            if (data.changed) needRestart = true;
          }
          if (wantEnabled !== awake.awakening) {
            const res = await fetch(API + '/awakening', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled: wantEnabled }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || '切换开关失败');
            if (data.changed) needRestart = true;
          }
          if (needRestart) {
            await refreshAwakeningStatus();
            await new Promise(resolve => setTimeout(resolve, 600));
            try { await fetch(API + '/restart', { method: 'POST' }); } catch { /* 重启请求失败不阻塞 */ }
            return;
          }
          await refreshAwakeningStatus();
        } catch (error) {
          publishAwakening({ error: String(error && error.message ? error.message : error) });
        }
        setModeSaving(false);
      }

      async function onBalanceRefresh(event) {
        event.stopPropagation();
        if (balanceRefreshing) return;
        setBalanceRefreshing(true);
        try {
          await refreshBalance(true);
          await new Promise(resolve => setTimeout(resolve, 400));
        } finally {
          setBalanceRefreshing(false);
        }
      }
      useEffect(() => {
        if (!balance.enabled) return undefined;
        return acquireBalancePolling();
      }, [balance.enabled]);

      // 三态：觉醒关闭=正常模式；开启+精简=进化模式；开启+完整=觉醒模式
      const aMode = awake.error ? '状态未知'
        : !awake.loaded ? '读取中…'
          : !awake.awakening ? '正常模式'
            : awake.variant === 'full' ? '觉醒模式' : '进化模式';
      const aColor = awake.error ? '#c0392b'
        : !awake.loaded ? 'rgba(128,128,128,0.6)'
          : !awake.awakening ? 'rgba(128,128,128,0.6)'
            : awake.variant === 'full' ? '#8e44ad' : '#c28b30';
      const aHalo = awake.awakening && !awake.error
        ? (awake.variant === 'full' ? '0 0 0 3px rgba(142,68,173,0.16)' : '0 0 0 3px rgba(194,139,48,0.16)')
        : 'none';
      const aDetail = '觉醒模式：' + aMode
        + (awake.error ? '（' + awake.error + '）'
          : awake.awakening ? (awake.variant === 'full' ? '（提示词完整版 25 类）' : '（提示词精简版 6 类）')
            : '（未注入提示词，用原生人格）');

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
        el('div', { ref: modeMenuRef, style: { position: 'relative' } },
          el('button', {
            type: 'button',
            title: aDetail + '，点击切换模式',
            'aria-haspopup': 'menu',
            'aria-expanded': modeMenu ? 'true' : 'false',
            onClick: (event) => { event.stopPropagation(); setModeMenu(!modeMenu); },
            style: {
              display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, width: '100%',
              padding: wide ? '6px 10px' : '6px', margin: 0,
              background: modeMenu ? 'rgba(128,128,128,0.14)' : 'transparent',
              border: 'none', borderRadius: 8, cursor: 'pointer', color: 'inherit',
              fontSize: 12, textAlign: 'left', justifyContent: wide ? 'flex-start' : 'center',
            },
          },
            el('span', {
              'aria-hidden': 'true',
              style: {
                width: 8, height: 8, flex: '0 0 auto', borderRadius: 4, background: aColor,
                boxShadow: aHalo,
                transition: 'background .2s',
              },
            }),
            wide ? el('span', {
              style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 },
            }, modeSaving ? '切换中…' : aMode) : null),
          modeMenu ? el('div', {
            role: 'menu',
            style: {
              position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, minWidth: 168,
              padding: 4, borderRadius: 10, zIndex: 9999,
              border: '1px solid rgba(128,128,128,0.32)',
              background: 'rgba(150,150,150,0.22)',
              backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
            },
          },
            [['normal', '正常模式', '关闭提示词注入'], ['lite', '进化模式', '开启 · 精简 6 类'], ['full', '觉醒模式', '开启 · 完整 25 类']].map(([mode, name, hint]) => {
              const current = mode === 'normal' ? !awake.awakening : (awake.awakening && awake.variant === mode);
              return el('button', {
                key: mode,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': current ? 'true' : 'false',
                disabled: modeSaving,
                onClick: (event) => { event.stopPropagation(); void applyAwakeningMode(mode); },
                style: {
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 8px', margin: 0, background: current ? 'rgba(128,128,128,0.20)' : 'transparent',
                  border: 'none', borderRadius: 7, cursor: modeSaving ? 'default' : 'pointer',
                  color: 'inherit', fontSize: 12, textAlign: 'left',
                },
              },
                el('span', { style: { width: 10, flex: '0 0 auto', opacity: current ? 0.9 : 0 } }, current ? '✓' : ''),
                el('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
                  el('span', { style: { whiteSpace: 'nowrap' } }, name),
                  el('span', { style: { fontSize: 10, opacity: 0.6, whiteSpace: 'nowrap' } }, hint)));
            })) : null),
        balance.enabled ? el('button', {
          type: 'button',
          title: bDetail + '，点击立即刷新',
          onClick: onBalanceRefresh,
          disabled: balanceRefreshing,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, width: '100%',
            padding: wide ? '6px 10px' : '6px', margin: 0,
            background: 'transparent', border: 'none', borderRadius: 8,
            cursor: balanceRefreshing ? 'default' : 'pointer', color: 'inherit',
            fontSize: 12, textAlign: 'left', justifyContent: wide ? 'flex-start' : 'center',
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
          }, balanceRefreshing ? '刷新中…' : bLabel) : null) : null,
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
    /* ---------------- 强制终止：开关 + 对话下方状态栏的运行时长 ---------------- */
    let forceStopSnapshot = { enabled: true, loaded: false };
    const forceStopSubscribers = new Set();
    function publishForceStop(patch) {
      forceStopSnapshot = { ...forceStopSnapshot, ...patch };
      for (const listener of [...forceStopSubscribers]) listener();
    }
    function useForceStopSetting() {
      return React.useSyncExternalStore(
        React.useCallback(listener => { forceStopSubscribers.add(listener); return () => forceStopSubscribers.delete(listener); }, []),
        () => forceStopSnapshot,
      );
    }
    async function loadForceStopSetting() {
      try {
        const response = await fetch(API + '/state', { cache: 'no-store' });
        const data = await response.json();
        if (data && data.ok) publishForceStop({ enabled: data.forceStop !== false, loaded: true });
      } catch { /* 读不到时保持默认开启 */ }
    }
    async function saveForceStopSetting(enabled) {
      publishForceStop({ enabled });
      try {
        const response = await fetch(API + '/force-stop-setting', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
        });
        const data = await response.json();
        if (!data || !data.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
        publishForceStop({ enabled: data.forceStop !== false });
        return '';
      } catch (error) {
        publishForceStop({ enabled: !enabled });
        return String(error && error.message ? error.message : error);
      }
    }

    /** 点了强制终止后，超过这么久会话仍在运行，就亮出「重启 DSH」保底按钮。 */
    const FORCE_STOP_STALL_MS = 8000;

    function formatRunDuration(startedAt, now) {
      const total = Math.max(0, Math.floor((now - startedAt) / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      const hours = Math.floor(minutes / 60);
      const pad = value => String(value).padStart(2, '0');
      return hours > 0 ? hours + ':' + pad(minutes % 60) + ':' + pad(seconds) : pad(minutes) + ':' + pad(seconds);
    }

    /**
     * 对话下方状态栏条目：运行时长 + 强制终止。
     * 运行态与起点由 Host 的 /api/turn-clock 给（刷新页面也不跳表），客户端只负责显示与点击。
     */
    function ForceStopDock(props) {
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';
      const setting = useForceStopSetting();
      const [clock, setClock] = useState({ running: false, startedAt: 0 });
      const [now, setNow] = useState(() => Date.now());
      const [phase, setPhase] = useState('idle');
      const [hover, setHover] = useState(false);
      const [message, setMessage] = useState('');
      /** 最近一次点「强制终止」的时间点；到点还没停下来就进保底状态。 */
      const [stallAt, setStallAt] = useState(0);
      const [restarting, setRestarting] = useState(false);
      const actionTimer = React.useRef(null);

      useEffect(() => {
        if (!sessionId || !setting.enabled) return undefined;
        let alive = true;
        const poll = async () => {
          try {
            const response = await fetch(API + '/turn-clock?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' });
            const data = await response.json();
            if (!alive || !data || !data.ok) return;
            const next = { running: data.running === true, startedAt: Number(data.startedAt) || 0 };
            setClock(current => (current.running === next.running && current.startedAt === next.startedAt ? current : next));
            if (next.running) {
              setNow(Date.now());
            } else {
              // 只有真的读到「不跑了」才算终止完成，避免乐观更新把还在跑的会话藏掉。
              setPhase(current => (current === 'stopping' || current === 'stalled' ? 'done' : current));
              setStallAt(0);
            }
          } catch { /* 单次失败忽略，下轮再试 */ }
        };
        void poll();
        const timer = setInterval(poll, 3000);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId, setting.enabled]);

      useEffect(() => {
        if (!clock.running) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(timer);
      }, [clock.running]);

      useEffect(() => () => { if (actionTimer.current) clearTimeout(actionTimer.current); }, []);

      /** phase 落到 done 后 4 秒复位；保底状态（stalled）不自动消失，等人处置。 */
      useEffect(() => {
        if (phase !== 'done') return undefined;
        if (actionTimer.current) clearTimeout(actionTimer.current);
        actionTimer.current = setTimeout(() => { setPhase('idle'); setMessage(''); }, 4000);
        return () => { if (actionTimer.current) clearTimeout(actionTimer.current); };
      }, [phase]);

      /** 保底：点了终止若干秒仍未停止，就亮出「重启 DSH」按钮。 */
      useEffect(() => {
        if (!stallAt) return undefined;
        const timer = setInterval(() => {
          if (Date.now() - stallAt < FORCE_STOP_STALL_MS) return;
          setStallAt(0);
          setPhase(current => (current === 'stopping' ? 'stalled' : current));
        }, 500);
        return () => clearInterval(timer);
      }, [stallAt]);

      function clearActionTimer() {
        if (actionTimer.current) { clearTimeout(actionTimer.current); actionTimer.current = null; }
      }

      async function stop() {
        if (restarting) return;
        clearActionTimer();
        setPhase('stopping');
        setMessage('');
        setStallAt(Date.now());
        try {
          const response = await fetch(API + '/force-stop', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
          });
          const data = await response.json();
          if (!data || !data.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
          const problems = (Array.isArray(data.steps) ? data.steps : []).filter(step => step && step.ok !== true && step.detail);
          // 不再乐观地把 running 改 false：停没停以轮询结果为准，没停就交给下面的保底。
          setMessage(problems.length
            ? '部分未完成：' + problems.map(step => step.name + ' ' + step.detail).join('；')
            : '已发出强制终止');
        } catch (error) {
          setPhase('idle');
          setStallAt(0);
          setMessage('强制终止失败：' + String(error && error.message ? error.message : error));
        }
      }

      /** 最后兜底：重启 DSH。单击即重启——会连同其它会话一起重启，页面断开几秒。 */
      async function restartNow() {
        if (restarting) return;
        setRestarting(true);
        setMessage('正在重启，页面稍后会断开…');
        try {
          await fetch(API + '/restart', { method: 'POST' });
        } catch { /* 重启时连接先断是正常的 */ }
        // 真重启了页面就断了；8 秒还活着说明没成功，把按钮放回来。
        setTimeout(() => setRestarting(false), 8000);
      }

      /** 点击即触发：不做二次确认，误点会直接丢弃本轮未完成的输出。 */
      function onPress() {
        if (phase === 'stopping' || phase === 'done') return;
        void stop();
      }

      if (!setting.enabled) return null;
      if (!clock.running && phase !== 'stopping' && phase !== 'done' && phase !== 'stalled') return null;

      const label = phase === 'stopping' ? '终止中…' : phase === 'done' ? '已终止' : '强制终止';
      const duration = clock.running && clock.startedAt ? formatRunDuration(clock.startedAt, now) : '';

      return el('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 8,
          fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
          lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
          color: 'var(--dsw-alias-label-tertiary)',
          whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
        },
      },
        el('span', {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 4,
            color: 'var(--dsw-alias-state-success-primary, #1e8449)',
          },
        },
          el('span', { 'aria-hidden': 'true', style: { fontSize: 11, lineHeight: '14px' } }, '⏱'),
          el('span', null, duration ? '运行 ' + duration : '运行中')),
        el('button', {
          type: 'button',
          title: '强制终止：立即中止本轮（会丢弃未完成的输出），并清理该会话的后台任务、终端、子代理',
          'aria-label': '强制终止当前任务',
          disabled: phase === 'stopping' || phase === 'done',
          onClick: onPress,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex', alignItems: 'center',
            border: '1px solid var(--dsw-alias-state-error-primary, #c0392b)',
            background: hover ? 'rgba(192,57,43,0.10)' : 'transparent',
            color: 'var(--dsw-alias-state-error-primary, #c0392b)',
            opacity: phase === 'stopping' || phase === 'done' ? 0.6 : 1,
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            padding: '1px 8px', fontSize: 'inherit', lineHeight: 'inherit',
            cursor: phase === 'stopping' || phase === 'done' ? 'default' : 'pointer',
            fontFamily: 'inherit', whiteSpace: 'nowrap',
          },
        }, label),
        phase === 'stalled'
          ? el('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-state-warning-primary, #b7791f)' },
          },
            el('span', null, '仍在运行'),
            el('button', {
              type: 'button',
              title: '重启 DSH：会连同其它会话一起重启，页面断开几秒；专门用来救「终止了也不停」的死结',
              'aria-label': '重启 DSH',
              disabled: restarting,
              onClick: () => { void restartNow(); },
              style: {
                display: 'inline-flex', alignItems: 'center',
                border: '1px solid var(--dsw-alias-state-error-primary, #c0392b)',
                background: 'rgba(192,57,43,0.10)',
                color: 'var(--dsw-alias-state-error-primary, #c0392b)',
                opacity: restarting ? 0.6 : 1,
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                padding: '1px 8px', fontSize: 'inherit', lineHeight: 'inherit',
                cursor: restarting ? 'default' : 'pointer',
                fontFamily: 'inherit', whiteSpace: 'nowrap',
              },
            }, restarting ? '重启中…' : '重启 DSH'))
          : null,
        message
          ? el('span', {
            title: message,
            style: { opacity: 0.7, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' },
          }, message)
          : null);
    }

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
      void loadForceStopSetting();
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
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock', id: 'dsh-lqconfig.force-stop', order: -1,
      }, ForceStopDock));
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
