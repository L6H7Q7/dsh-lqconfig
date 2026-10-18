# dsh-lqconfig

个人用的 DSH 插件，在「设置」里提供 LQ配置 分区，集中放自己的小开关。

## 功能

- 隐藏 DeepSeek API 通道：等价于在 profiles/desktop/cordis.patch.yml 写入
  - id: llm-deepseek 与 disabled: true，关闭后设置页的「DeepSeek」卡片与
  模型选择器里的「DeepSeek」分组一起消失；DeepSeek 账号通道不受影响。
- 保存并重启：改动写进 profile 补丁前自动备份（.bak-lqconfig-时间戳），
  保存后提示重启；「立即重启」会确认后结束并重启应用。

## 安装

把本目录放进 $DSH_HOME/profiles/<profile>/local/dsh-lqconfig/，并在该 profile 的
cordis.patch.yml 里加：

    - insert:
        - id: dsh-lqconfig
          name: ./local/dsh-lqconfig/index.js

重启 DSH 后，设置 → LQ配置。

## 结构

- index.js —— 宿主半：/dsh-lqconfig/api/state|set|restart
- client.js —— 浏览器半：settings.section 分区
- package.json —— 声明 dsh.client
