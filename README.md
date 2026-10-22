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
- **代理（机场）**（卡片）：内置 mihomo 内核，按订阅节点与地区偏好提供按需代理。
- **改动即时保存**：拨动滑块立刻写补丁，并保留备份（`.bak-lqconfig-<时间戳>`）。
- **拨动即自动重启**：保存成功后直接触发重启，不再二次询问；没有实际变化时不重启、不备份。
  重启由 VBS（窗口样式 0）执行，不弹命令行窗口。**已实测**：从 DSH 内部拉起该脚本后，
  它执行的 `taskkill` 杀掉 DSH，脚本本身仍能活到执行 `start` 把 DSH 拉回来——
  不需要 Windows 计划任务做跳板（早期版本用过 schtasks，已移除）。

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

- `index.js` —— 宿主半：`/dsh-lqconfig/api/state|set|chain-zh|restart|proxy/*`
- `client.js` —— 浏览器半：`settings.section` 分区
- `proxy.js` —— 代理模块：订阅解析、内核生命周期、按偏好选节点
- `package.json` —— 声明 `dsh.client`

## 备注

- 个人插件，界面固定中文
- 关掉「隐藏 API」同样即时保存，重启后恢复显示
- 「思维链优先中文」只作用于系统提示，能显著提高中文思考比例，不能 100% 保证

## 代理（机场）

### 用法

1. 填入机场 Clash 订阅链接并保存——链接为空时开关不可用（前后端都校验）；
2. 拨开开关——这只是**授权**，允许 DSH 按需使用代理，**内核不会现在启动**；内核在真正需要时（或点「测试并选节点」）才拉起，混合端口 `127.0.0.1:7910`、控制口 `127.0.0.1:9099`；
3. 点「读取地区」从订阅实际内容取地区列表（不硬编码，信息类节点如「剩余流量」会被剔除），按点击顺序作为优先级：选了「日本、新加坡」就先在日本里挑延迟最低的，日本全挂才用新加坡；不选则全部节点里挑最低；
4. 「测试并选节点」重新执行一次健康检查并按偏好切换。

模型侧请求 `POST /dsh-lqconfig/api/proxy/ensure` 即可按需拉起内核并拿到代理地址。

### 什么时候启动（按需，不常驻）

DSH 启动时**不会**自动拉起内核，开关本身也**不启动**——开关只决定"允不允许用"。真正拉起内核的只有两种情况：

1. 点「测试并选节点」
2. 直接调 `/api/proxy/ensure`

开关关闭时 `ensure` 会直接报「代理开关未开启」，即"禁止使用"。

关闭开关、或插件卸载（DSH 退出）时会停掉内核并清理 PID 文件，不留孤儿进程。

### 什么时候更新

- **订阅/节点列表**：惰性刷新。缓存在 `proxy-data/providers/zhuiyun.yaml`，按文件 mtime 判断，`refreshMinutes` 默认 **360（6 小时）**；每次 `ensure` 或「读取地区」时检查一次，过期才重新拉订阅。没有定时器，不调用就不刷新。
- **选中的节点**：每次 `ensure` 都重新做——触发 provider 全量健康检查，按偏好顺序取第一个有可用节点的地区里延迟最低的；偏好为空时在全部节点里选最低。
- **改端口要重开**：代理跑着时改端口不生效，关掉开关再开一次；改节点偏好不用重开，下次 `ensure` 会自动重选。

### 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/proxy/state` | 开关、运行状态、当前节点、内核版本、是否已存链接 |
| GET | `/api/proxy/regions` | 从订阅读地区列表（含每个地区的节点数） |
| GET | `/api/proxy/nodes` | 列出解析到的节点名与地区 |
| POST | `/api/proxy/set` | 改链接 / 开关 / 偏好 / 端口；关闭时自动停内核 |
| POST | `/api/proxy/ensure` | 拉起内核 + 按偏好选节点，返回代理地址 |
| POST | `/api/proxy/stop` | 停内核 |

### 相关文件

| 文件 | 说明 | 入库 |
|---|---|---|
| `proxy.js` | 订阅解析、内核生命周期、按偏好选节点 | 是 |
| `bin/mihomo.exe` | 官方 mihomo 内核（v1.19.33，61 MB） | 否 |
| `proxy.json` | 订阅链接、开关、偏好、端口 | 否（含 token） |
| `proxy-data/` | 生成的 config、provider 缓存、PID | 否 |
