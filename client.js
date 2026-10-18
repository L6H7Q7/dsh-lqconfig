/**
 * dsh-lqconfig —— 个人配置插件（浏览器半侧）
 *
 * 在「设置」里注册「LQ配置」分区，当前只有一项：
 *   DeepSeek API 通道开关（等价于禁用 llm-deepseek 这一行），改完提示重启。
 */
window.__ModuleLoader__.load({
  id: 'dsh-lqconfig',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const { useEffect, useState } = React;
    const { jsx: h } = require('react/jsx-runtime');

    const API = '/dsh-lqconfig/api';

    const S = {
      page: { padding: '8px 4px', fontSize: 14, lineHeight: 1.6 },
      card: { border: '1px solid rgba(128,128,128,0.28)', borderRadius: 12, padding: '16px 18px', marginBottom: 12 },
      title: { fontSize: 15, fontWeight: 600, marginBottom: 4 },
      desc: { fontSize: 13, opacity: 0.7, marginBottom: 12 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      actions: { display: 'flex', gap: 8, marginTop: 14 },
      btn: { border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: 'inherit' },
      primary: { background: '#1a1a1a', color: '#fff', borderColor: '#1a1a1a' },
      note: { fontSize: 12, opacity: 0.65, marginTop: 10 },
      warn: { fontSize: 12, color: '#c0392b', marginTop: 10 },
      ok: { fontSize: 12, color: '#1e8449', marginTop: 10 },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, opacity: 0.6, wordBreak: 'break-all' },
    };

    function LqSection() {
      const [state, setState] = useState(null);
      const [enabled, setEnabled] = useState(true);
      const [dirty, setDirty] = useState(false);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [tone, setTone] = useState('note');

      useEffect(() => { void load(); }, []);

      async function load() {
        try {
          const res = await fetch(API + '/state', { cache: 'no-store' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '读取失败');
          setState(data);
          setEnabled(data.enabled);
          setDirty(false);
        } catch (error) {
          setMessage('读取失败：' + String(error && error.message ? error.message : error));
          setTone('warn');
        }
      }

      function toggle(next) {
        setEnabled(next);
        setDirty(true);
        setMessage('');
      }

      async function save() {
        setBusy(true);
        setMessage('');
        try {
          const res = await fetch(API + '/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          setState(data);
          setDirty(false);
          setMessage(data.changed ? '已保存，重启应用后生效。' : '没有变化，无需重启。');
          setTone('ok');
        } catch (error) {
          setMessage('保存失败：' + String(error && error.message ? error.message : error));
          setTone('warn');
        } finally {
          setBusy(false);
        }
      }

      async function restart() {
        if (!window.confirm('重启会中断当前对话（会话记录会保留）。确定现在重启吗？')) return;
        setBusy(true);
        setMessage('正在重启，页面稍后会断开…');
        setTone('note');
        try {
          await fetch(API + '/restart', { method: 'POST' });
        } catch (error) {
          setMessage('重启请求失败：' + String(error && error.message ? error.message : error));
          setTone('warn');
          setBusy(false);
        }
      }

      return h('div', { style: S.page },
        h('div', { style: S.card },
          h('div', { style: S.title }, 'DeepSeek API 通道'),
          h('div', { style: S.desc }, '关闭后，设置里的「DeepSeek」卡片和模型选择器里的「DeepSeek」分组都会消失；DeepSeek 账号通道不受影响。改动写进 profile 补丁，重启后生效。'),
          h('div', { style: S.row },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: !enabled, disabled: busy, onChange: (e) => toggle(!e.target.checked) }),
              h('span', null, '隐藏 DeepSeek API 通道')),
            h('span', { style: { fontSize: 12, opacity: 0.7 } }, enabled ? '当前：显示中' : '当前：已隐藏')),
          dirty ? h('div', { style: S.note }, '有未保存的改动。') : null,
          h('div', { style: S.actions },
            h('button', { type: 'button', style: S.btn, disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
            h('button', { type: 'button', style: { ...S.btn, ...S.primary }, disabled: busy, onClick: restart }, '立即重启')),
          message ? h('div', { style: tone === 'warn' ? S.warn : tone === 'ok' ? S.ok : S.note }, message) : null,
          state ? h('div', { style: S.mono }, '补丁：' + state.patchPath) : null),
        h('div', { style: S.card },
          h('div', { style: S.title }, '说明'),
          h('div', { style: S.desc }, '这个分区是个人插件 dsh-lqconfig，配置改动都会先备份原补丁（.bak-lqconfig-时间戳）。后续要加别的个人开关，直接往这里加卡片即可。')));
    }

    function apply(ctx) {
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
