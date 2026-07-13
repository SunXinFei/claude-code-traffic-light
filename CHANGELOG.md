# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **集成 cc-switch 的切模型能力** - 在设置面板与托盘菜单中一键切换 Claude Code 实际使用的 API 供应商，复刻自 [cc-switch](https://github.com/farion1231/cc-switch) 的核心能力，无需另装工具
  - 内置 25+ 供应商预设（Claude 官方、DeepSeek、Kimi For Coding、Kimi (Moonshot)、智谱 GLM (z.ai / bigmodel)、火山 Agentplan、BytePlus、豆包 Seed、OpenRouter、SiliconFlow、MiniMax（国内 / 海外）、阿里 Bailian For Coding、百度千帆、StepFun、ModelScope、LongCat、Gemini Native、AWS Bedrock (AKSK)、AiHubMix、DMXAPI、PackyCode、APIKEY.FUN、CherryIN 等），密钥留空由用户填写
  - 设置弹窗新增「🔀 Claude 模型供应商」分区：点击切换、置顶、编辑、删除、添加自定义、一键导入当前 `~/.claude/settings.json`
  - 托盘菜单新增「🔀 切换模型」子菜单，快捷切换已配置 / 置顶 / 官方 / 当前供应商
  - 切换采用「合并写」：`env` 由供应商整体替换，`hooks` / `permissions` / `mcpServers` 等非供应商字段自动保留，避免抹掉本项目注入的 hooks
  - 切走前自动回填当前 `env` 到即将离开的供应商，保留用户在 Claude Code 内的手动改动
  - 原子写 + 键名字母序 + sanitize，与 cc-switch 输出一致；切换后余额光环自动跟随新的 `ANTHROPIC_BASE_URL`
  - 供应商列表持久化在 `~/.claude/traffic_light/providers.json`

### 修复

- 黄灯改为 `PermissionRequest` 触发，避免 bash 执行中误闪

### 文档

- README 标注 Windows 平台支持，精简演示段落

---

> 2.0.4 及更早版本的历史见 `git log`；本 CHANGELOG 自 cc-switch 集成起开始维护。
