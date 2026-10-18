/**
 * dsh-lqconfig —— 个人配置插件（浏览器半侧）
 *
 * 设置里的「LQ配置」分区：滑块控件，改动即时保存，保存后提示「暂不重启 / 立即重启」。
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
          'aria-label': '隐藏 API',
          style: { position: 'absolute', inset: 0, opacity: 0, margin: 0, zIndex: 1, cursor: disabled ? 'default' : 'pointer' },
        }),
        el('span', { style: { position: 'absolute', inset: 0, borderRadius: 12, background: checked ? '#1a1a1a' : 'rgba(128,128,128,0.35)', transition: 'background .2s' } }),
        el('span', { style: { position: 'absolute', top: 3, left: checked ? 23 : 3, width: 18, height: 18, borderRadius: 9, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .2s' } }));
    }

    function LqSection() {
      const [patchPath, setPatchPath] = useState('');
      const [hidden, setHidden] = useState(false);
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(false);
      const [message, setMessage] = useState('');
      const [tone, setTone] = useState('note');

      useEffect(() => { void load(); }, []);

      async function load() {
        try {
          const res = await fetch(API + '/state', { cache: 'no-store' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '读取失败');
          setHidden(!data.enabled);
          setPatchPath(data.patchPath || '');
        } catch (error) {
          setMessage('读取失败：' + String(error && error.message ? error.message : error));
          setTone('warn');
        }
      }

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
            setNotice(true);
            setMessage('已保存，重启后生效。');
            setTone('ok');
          } else {
            setNotice(false);
            setMessage('没有变化，无需重启。');
            setTone('note');
          }
        } catch (error) {
          setHidden(!nextHidden);
          setMessage('保存失败：' + String(error && error.message ? error.message : error));
          setTone('warn');
        } finally {
          setSaving(false);
        }
      }

      function onToggle(event) {
        const next = event.target.checked;
        setHidden(next);
        setNotice(false);
        void persist(next);
      }

      async function restart() {
        setSaving(true);
        setMessage('正在重启，页面稍后会断开…');
        setTone('note');
        try {
          await fetch(API + '/restart', { method: 'POST' });
        } catch (error) {
          setMessage('重启请求失败：' + String(error && error.message ? error.message : error));
          setTone('warn');
          setSaving(false);
        }
      }

      return el('div', { style: S.page },
        el('div', { style: S.card },
          el('div', { style: S.head },
            el('div', { style: S.title }, '隐藏 API'),
            el(Switch, { checked: hidden, disabled: saving, onChange: onToggle })),
          el('div', { style: S.desc }, '开启后，设置里的「DeepSeek」卡片和模型选择器里的「DeepSeek」分组都会消失；DeepSeek 账号通道不受影响。改动写进 profile 补丁，重启后生效。'),
          el('div', { style: S.status }, '当前：' + (hidden ? '已隐藏' : '显示中') + (saving ? ' · 处理中…' : '')),
          notice
            ? el('div', { style: S.notice },
                el('span', null, '需要重启才能生效。'),
                el('span', { style: { display: 'flex', gap: 8 } },
                  el('button', { type: 'button', style: S.btn, disabled: saving, onClick: () => setNotice(false) }, '暂不重启'),
                  el('button', { type: 'button', style: { ...S.btn, ...S.primary }, disabled: saving, onClick: restart }, '立即重启')))
            : null,
          message ? el('div', { style: tone === 'warn' ? S.warn : tone === 'ok' ? S.ok : S.note }, message) : null,
          patchPath ? el('div', { style: S.mono }, '补丁：' + patchPath) : null),
        el('div', { style: S.card },
          el('div', { style: S.title }, '说明'),
          el('div', { style: S.desc }, '这是个人插件 dsh-lqconfig。每次改动都会先备份原补丁（.bak-lqconfig-时间戳）；以后要加别的个人开关，往这里加卡片即可。')));
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
