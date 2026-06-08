# Claude Code Traffic Light 🚦

macOS 浮动红绿灯，一眼看懂 Claude Code 在干嘛。[English](README_EN.md)

![macOS](https://img.shields.io/badge/macOS-supported-blue)
![Electron](https://img.shields.io/badge/Electron-31-blue)
![License](https://img.shields.io/license/MIT-yellow)

![Screenshot](image.png)

## 灯的含义

| 灯 | 状态 | 含义 |
|----|------|------|
| 🔴 红灯呼吸 | 忙碌 | Claude 正在处理/调用工具 |
| 🟡 黄灯闪烁 | 等你 | Claude 在问你问题，等你回答 |
| 🟢 绿灯常亮 | 完成 | Claude 处理完毕，等你输入 |

## 功能

- **真正置顶** — Electron 窗口置顶，全屏/多桌面都能看到
- **精美 UI** — CSS 交通灯，呼吸/脉冲/环形动画，深色/浅色主题
- **AI 余额光环** — Apple Watch 风格渐变色环（红→橙→黄→绿），直观显示 DeepSeek API 余额比例
- **声音提示** — Web Audio 合成提示音，可静音
- **多项目** — 同时跑多个 Claude Code 会话，自动切换，托盘菜单也可手动选择
- **点击跳转** — 点击灯泡，自动跳转到对应项目所在的 IDE 窗口（支持 VSCode/Cursor/Windsurf 等）
- **自动清理** — 会话关闭后自动从项目列表移除，不会堆积
- **自动检测** — 启动时自动检测正在运行的 Claude Code 会话
- **自动配置** — 启动时自动注入 hooks，无需手动配置
- **窗口可拖拽** — 拖到屏幕任意位置，位置自动记忆

## 安装

从 [Releases](https://github.com/DemoJj/claude-code-traffic-light/releases) 下载 `.dmg`，拖进 Applications 即可。

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

## AI 余额光环

灯光外圈有一道 Apple Watch 运动环风格的渐变色环，显示 DeepSeek API 余额比例。

- **渐变色**：红 → 橙 → 黄 → 绿，余额越低越偏红
- **比例计算**：`当前余额 / 手动预算`，未设预算时自动用充值额度
- **API Key**：优先读环境变量 `DEEPSEEK_API_KEY`，也可在设置弹窗中配置
- **设置弹窗**：点击灯光下方的余额文案或设置面板中的"AI 设置"按钮打开

## 要求

- macOS 12+
- Node.js 18+（仅开发/构建时需要）

## License

[MIT](LICENSE)

---

*Vibe coded with Claude Code*
