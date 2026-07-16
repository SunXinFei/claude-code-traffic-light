# Claude Code Traffic Light 🚦

![macOS](https://img.shields.io/badge/macOS-supported-blue)
![Windows](https://img.shields.io/badge/Windows-supported-blue)
![Electron](https://img.shields.io/badge/Electron-31-blue)

## 产品介绍

![Claude Code Traffic Light 产品介绍](image.png)

## 功能

- **真正置顶** — Electron 窗口置顶，全屏/多桌面都能看到
- **精美 UI** — CSS 交通灯，呼吸/脉冲/环形动画，深色/浅色主题
- **AI 余额光环** — Apple Watch 风格渐变色环（红→橙→黄→绿），直观显示大模型API 余额比例
- **AI 余额/用量查询** - 支持 10 个大模型供应商：DeepSeek、阶跃星辰、硅基流动、OpenRouter、Novita（按量付费余额）与火山 Ark、Kimi、智谱 GLM、MiniMax、ZenMux（Coding Plan 用量），余额/用量光环一眼掌握
- **模型供应商切换** — 集成 [cc-switch](https://github.com/farion1231/cc-switch) 核心能力，在设置面板 / 托盘菜单一键切换 Claude Code 使用的 API（25+ 内置预设，hooks 等配置自动保留）
- **声音提示** — Web Audio 合成提示音，可静音
- **多项目** — 同时跑多个 Claude Code 会话，自动切换，托盘菜单也可手动选择
- **点击跳转** — 点击灯泡，自动跳转到对应项目所在的 IDE 窗口（支持 VSCode/Cursor/Windsurf 等）
- **自动清理** — 会话关闭后自动从项目列表移除，不会堆积
- **自动检测** — 启动时自动检测正在运行的 Claude Code 会话
- **自动配置** — 启动时自动注入 hooks，无需手动配置
- **窗口可拖拽** — 拖到屏幕任意位置，位置自动记忆

## 安装

从 [Releases](https://github.com/SunXinFei/claude-code-traffic-light/releases) 下载对应平台安装包：

- **macOS**：`.dmg`，拖进 Applications 即可
- **Windows**：`.exe` 安装包，双击安装即可

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
# macOS
npm run dist

# Windows（需在 Windows 上执行）
npm run dist:win
```

## 原理

通过 Claude Code 的 [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) 机制，在会话状态变化时写文件，Electron 主进程轮询文件更新 UI。

- **红灯**：用户提交问题 / Claude 调用工具时触发
- **黄灯**：`AskUserQuestion`（Claude 问你问题）时触发
- **绿灯**：`Stop` / `StopFailure`（Claude 完成，包括中途退出）时触发
- **跳转**：利用 hook 环境变量识别宿主应用，通过 IDE CLI 精确定位项目窗口
- **清理**：`SessionEnd` hook 在对话关闭时自动删除项目文件

## Claude 模型供应商切换

集成 [cc-switch](https://github.com/farion1231/cc-switch) 的核心能力，无需另装工具即可在红绿灯里一键切换 Claude Code 实际使用的 API 供应商。

### 用法

- **设置面板**：打开「AI 模型设置」弹窗，顶部新增「🔀 Claude 模型供应商」分区，点击任意供应商即可切换；支持置顶 📌、编辑 ✏、删除 🗑、添加自定义、一键「导入当前 Claude 配置」
- **托盘菜单**：右键托盘图标 →「🔀 切换模型」子菜单，快捷切换已配置 / 置顶 / 官方 / 当前供应商
- **生效方式**：切换会改写 `~/.claude/settings.json` 的 `env`，**需重启 Claude Code 或新开会话才生效**

### 内置预设

内置 25+ 供应商预设（密钥留空，由用户填写）：Claude 官方、DeepSeek、Kimi For Coding、Kimi (Moonshot)、智谱 GLM（z.ai / bigmodel）、火山 Agentplan、BytePlus、豆包 Seed、OpenRouter、SiliconFlow、MiniMax（国内 / 海外）、阿里 Bailian For Coding、百度千帆、StepFun、ModelScope、LongCat、Gemini Native、AWS Bedrock (AKSK)、AiHubMix、DMXAPI、PackyCode、APIKEY.FUN、CherryIN 等。未填密钥的预设默认隐藏，勾选「显示全部」可展开。

### 与 cc-switch 的差异（合并写）

本项目的 `setupClaudeHooks()` 会把 hooks 写进 `~/.claude/settings.json`，因此切换时**不能像 cc-switch 那样整文件覆盖**（会抹掉 hooks），改用「合并写」：

- `env` 由供应商整体替换（避免上一个供应商的 `ANTHROPIC_MODEL` 等残留泄漏）
- `hooks` / `permissions` / `mcpServers` / `enabledPlugins` 等非供应商字段从当前文件保留
- 切走前自动回填当前 `env` 到即将离开的供应商，保留你在 Claude Code 内的手动改动（改模型名、加 env 等）
- 写前 sanitize（剔除 `apiFormat` 等内部字段），原子写（临时文件 + rename），键名字母序、2 空格缩进 —— 与 cc-switch 输出一致

供应商列表持久化在 `~/.claude/traffic_light/providers.json`；切换后余额光环会自动跟随新的 `ANTHROPIC_BASE_URL`。

## AI 余额光环

灯光外圈有一道 Apple Watch 运动环风格的渐变色环，显示当前启用供应商的余额/用量比例。在「AI 模型设置」里从两类中各选一个供应商，填入凭证并保存即启用，两类互斥切换。查询能力参考 [cc-switch](https://github.com/farion1231/cc-switch)，各供应商的接口、认证、解析逻辑集中在 `electron/main.cjs` 的 provider 注册表。

### 按量付费余额（金额类）

支持 DeepSeek、阶跃星辰、硅基流动、OpenRouter、Novita AI，只需一个 API Key：

- **渐变色**：红 -> 橙 -> 黄 -> 绿，余额越低越偏红
- **比例计算**：`当前余额 / 手动预算`，未设预算时自动用充值额度
- **凭证**：优先读环境变量（如 `DEEPSEEK_API_KEY`），也可在设置弹窗配置，每个供应商旁附「获取密钥」直达链接
- **设置弹窗**：点击灯光下方的余额文案或设置面板中的"AI 设置"按钮打开

### Coding Plan 用量（百分比类）

支持火山 Ark、Kimi For Coding、智谱 GLM、MiniMax、ZenMux，展示套餐的三档配额使用百分比与重置时间：

| Level | 含义 |
|-------|------|
| 5 小时 | 当前滚动窗口用量 |
| Weekly | 近 1 周累计用量 |
| Monthly | 近 1 月累计用量（仅火山 Ark） |

- **外环比例**：用最长可用窗口（monthly / weekly / 5h）的剩余比例，用得越多环越空
- **主界面小字**：`2% / 0% / 5%`（5h / weekly / monthly）
- **设置卡片**：每档单独显示已用百分比、剩余百分比、相对重置时间
- **认证**：火山 Ark 用 IAM Access Key ID + Secret（优先环境变量 `VOLC_AK` / `VOLC_SK`，签名实现见 `electron/volcSign.cjs`）；其余用 API Key；ZenMux 额外需填 Base URL
- **刷新**：启动时拉一次，之后每小时自动刷新；设置弹窗也有「刷新」按钮

## 迭代计划

- 📱 **与手机和手表连接** - 将红绿灯状态同步到手机 / 智能手表，离开桌面也能第一时间知道 Claude Code 在等你确认或已完成
- 🗂 **多项目并行最优展示** - 同时运行多个 Claude Code 会话时，探索更清晰的状态汇总、切换与并行展示方案

## 要求

- macOS 12+ 或 Windows 10/11
- Node.js 18+（仅开发/构建时需要）

## License

[MIT](LICENSE)

---

*Vibe coded with Claude Code*
