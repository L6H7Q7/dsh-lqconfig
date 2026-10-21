# visible-shell

把 DSH 内置的 `pwsh` 工具换成「每条命令弹一个可见终端窗口」的个人插件（仅 Windows）。

- 开启：每条命令写进临时脚本，由 `Start-Process -WindowStyle Normal -Wait` 在 Windows Terminal 里执行，
  输出经 `Tee-Object` 落到日志，窗口关闭后由插件读回；控制台里的结果为 `stdout` + `[stderr]` + `[exit code: N]`。
- 关闭：隐藏执行，行为与官方内置 pwsh 工具一致。

## 安装

1. 把本目录放到 `$DSH_HOME/profiles/desktop/local/visible-shell/`。
2. 在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的每个 preset 插件列表里，把 `tool-pwsh` 设为 `disabled: true`，
   并插入本插件（建议用标记块，便于移除）：

   ```yaml
   # >>> visible-shell
   - id: tool-pwsh
     name: '@deepseek-ai/dsh-tool-pwsh'
     disabled: true
   - id: visible-shell
     name: 'file:///C:/Users/<你>/.dsh/profiles/desktop/local/visible-shell/index.js'
   # <<< visible-shell
   ```

3. 重启 DSH。之后设置区会出现「命令窗口」开关（本插件自带；若并入 dsh-lqconfig 则在其「LQ配置」分区里）。

## 开关

- 设置区「命令窗口」，或直接改 `state.json`：`{"visible": true}`。
- 开关即时生效，无需重启。

## 已知限制

- 每次弹窗会抢焦点，每条命令多约 1 秒启动开销。
- `run_in_background` 被忽略：所有调用都前台等待。
- 单条命令超时上限 600 秒（超出会杀掉进程树）。
- 关闭开关后走的是本插件的隐藏执行实现，不是官方执行器。

## 回退

移除 `cordis.patch.yml` 里的标记块、把 `tool-pwsh` 的 `disabled` 恢复为原条件（`!!js process.platform !== 'win32'`），重启即回到官方工具。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：注册 `pwsh` 工具、读开关、`/visible-shell/api/*` 路由 |
| `runner.js` | 零依赖执行核心（可见/隐藏两条路径） |
| `client.js` | 浏览器半：设置区开关 |
| `state.json` | 运行时开关状态（不入库） |
