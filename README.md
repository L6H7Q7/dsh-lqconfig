# dsh-lqconfig

个人用的 DSH 插件，在「设置」里提供 **LQ配置** 分区，集中放自己的小开关。

## 功能

- **隐藏 API**（滑块）：等价于在 `profiles/desktop/cordis.patch.yml` 写入
  `- id: llm-deepseek` + `disabled: true`。开启后设置页的「DeepSeek」卡片与
  模型选择器里的「DeepSeek」分组一起消失；DeepSeek 账号通道不受影响。
- **思维链优先中文**（滑块）：把三个 Agent 预设（standard / ptc / cordis）里
  `persona.suffix`（系统提示尾部）的 `''` 换成一句「内部思考用简体中文、技术
  术语保留英文」的指令；关闭时还原为空。只动这 3 行，正则限定「10 空格缩进 +
  `suffix: ''`」，不会误伤别的 `suffix`。
- **改动即时保存**：拨动滑块立刻写补丁，并保留备份（`.bak-lqconfig-<时间戳>`）。
- **拨动即自动重启**：保存成功后直接触发重启，不再二次询问；没有实际变化时不重启、不备份。
  重启由 VBS（窗口样式 0）加 Windows 计划任务执行：不弹命令行窗口，也不受 DSH
  进程树影响。

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

- `index.js` —— 宿主半：`/dsh-lqconfig/api/state|set|chain-zh|restart`
- `client.js` —— 浏览器半：`settings.section` 分区
- `package.json` —— 声明 `dsh.client`

## 备注

- 个人插件，界面固定中文
- 关掉「隐藏 API」同样即时保存，重启后恢复显示
- 「思维链优先中文」只作用于系统提示，能显著提高中文思考比例，不能 100% 保证

## 代理（机场）

设置页新增「代理（机场）」卡片：

1. 填入机场 Clash 订阅链接并保存——链接为空时开关不可用；
2. 拨开开关，插件用内置 mihomo 内核启动本地代理（默认混入 `127.0.0.1:7910`，控制口 `127.0.0.1:9099`）；
3. 点「读取地区」从订阅实际内容取地区列表（不硬编码），按点击顺序作为优先级：选了「日本、新加坡」就先在日本里挑延迟最低的，日本全挂才用新加坡；不选则全部节点里挑最低；
4. 「测试并选节点」重新执行一次健康检查并按偏好切换。

模型侧请求 `POST /dsh-lqconfig/api/proxy/ensure` 即可按需拉起内核并拿到代理地址。

### 相关文件

| 文件 | 说明 | 入库 |
|---|---|---|
| `proxy.js` | 订阅解析、内核生命周期、按偏好选节点 | 是 |
| `bin/mihomo.exe` | 官方 mihomo 内核（v1.19.33） | 否 |
| `proxy.json` | 订阅链接、开关、偏好 | 否（含 token） |
| `proxy-data/` | 生成的配置与节点缓存 | 否 |
