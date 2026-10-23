# dsh-lqconfig 项目规则：个人插件开发与维护

> 本节是 **项目级规则**，由 `@deepseek-ai/dsh-agent-instructions` 从会话工作目录向上查找加载：
> 只有当会话 cwd 位于 `D:\AI\WorkSpace\dsh-lqconfig`（或其子目录）时才生效。
> 内容于 2026-10-23 从全局规则 `~/.dsh/AGENTS.md` 的「9 个人插件开发与维护」整节迁入。

DSH 端个人插件（如 dsh-lqconfig）的统一约定。做这类工作前先通读本篇。

## 1 目录与声明

- 放在 `$DSH_HOME\profiles\<profile>\local\<name>\`（桌面端 profile 名通常是 `desktop`）
- `package.json`：
  - `"type": "module"`，`main` 指向宿主半入口
  - `exports["./client"]` 指向浏览器半入口
  - `dsh.client` 声明 `{ platform: "web", inject: [...] }`，DSH 才会把它当浏览器插件扫描
- 在 profile 的 `cordis.patch.yml` 加挂载行：

```yaml
- insert:
    - id: <name>
      name: ./local/<name>/index.js
```

## 2 双半侧契约

- **宿主半**：`export const name`、`export const inject = ['webServer']`、`export function apply(ctx)`，用 `ctx.webServer.register({ kind: 'prefix', path, handler })` 暴露同源 HTTP 路由
- **浏览器半**：`window.__ModuleLoader__.load({ id, factory })`，factory 返回 `{ apply, inject: ['slots'], name }`
- 设置分区：`ctx.slots.inject('settings.section', function* () { yield ctx.slots.register({ name: 'settings.section', id, order, label: () => '显示名' }, 组件) })`
- **React 渲染陷阱**：`jsx()` 只接受 `(type, props, key)`，多子节点必须走 `props.children`；用 `el(type, props, ...children)` 包一层，否则页面空白且不报错

## 3 配置写入

- 改 `cordis.patch.yml` 前先复制一份 `.bak-<name>-<时间戳>`
- 增删用标记块（`# >>> <name> ...` / `# <<< <name>`），便于精确移除
- 只覆盖目标字段（如 `disabled: true`），`config` 整体替换要谨慎
- 改完提示「重启生效」；不要假设热加载

## 4 升级与安装

- 运行中的 DSH 会占用 `node_modules/<plugin>`，`pnpm install` 替换会 `EPERM`——**必须先关闭应用**
- profile 的 pnpm 可用 `C:\Users\L6H7Q\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`（`node <pnpm.mjs> install`）
- 本地定制包：`npm pack --ignore-scripts` 生成 tgz，依赖改 `file:<tgz>` 再 install

## 5 已有个人插件

| 插件 | 位置 | 说明 |
|---|---|---|
| dsh-lqconfig | `profiles/desktop/local/dsh-lqconfig/` | 设置「LQ配置」分区：隐藏 API、思维链优先中文、系统打开、自动代理（内置 mihomo，启动预热 + 按需）。含重启脚本 `restart-dsh.vbs`。仓库 https://github.com/L6H7Q7/dsh-lqconfig |
