# dsh-lqconfig

个人用的 DSH 插件，在「设置」里提供 **LQ配置** 分区，集中放自己的小开关。

## 功能

- **隐藏 API**（滑块）：等价于在 `profiles/desktop/cordis.patch.yml` 写入
  `- id: llm-deepseek` + `disabled: true`。开启后设置页的「DeepSeek」卡片与
  模型选择器里的「DeepSeek」分组一起消失；DeepSeek 账号通道不受影响。
- **改动即时保存**：拨动滑块立刻写补丁，并保留备份（`.bak-lqconfig-<时间戳>`）。
- **重启提示**：保存成功后给出「暂不重启 / 立即重启」。重启由 VBS（窗口样式 0）
  加 Windows 计划任务执行：不弹命令行窗口，也不受 DSH 进程树影响。

## 安装

把本目录放进 `$DSH_HOME/profiles/<profile>/local/dsh-lqconfig/`，并在该 profile 的
`cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-lqconfig
      name: ./local/dsh-lqconfig/index.js
```

重启 DSH 后，设置 → LQ配置。

## 结构

- `index.js` —— 宿主半：`/dsh-lqconfig/api/state|set|restart`
- `client.js` —— 浏览器半：`settings.section` 分区
- `package.json` —— 声明 `dsh.client`

## 备注

- 个人插件，界面固定中文
- 关掉「隐藏 API」同样即时保存，重启后恢复显示
