/**
 * visible-shell —— 浏览器半侧已停用。
 * 「命令窗口」开关已并入 dsh-lqconfig 的「LQ配置」分区，
 * 这里只保留一个空插件，避免设置区重复、也避免加载时报缺失。
 */
window.__ModuleLoader__.load({
  id: 'visible-shell',
  factory: () => {
    const module = { exports: {} };
    function apply() { /* 设置区已迁移到 dsh-lqconfig */ }
    module.exports = { apply, inject: [], name: 'visible-shell-client' };
    return module.exports;
  },
});
