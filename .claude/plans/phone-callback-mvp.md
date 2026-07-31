# 手机回传 MVP（局域网）

## 目标
Claude 亮黄灯时,手机收到推送 → 点通知打开控制页 → 在手机上点「确认/拒绝/输入文字」→ 真的回传到电脑,激活对应项目窗口并敲键回应 Claude Code。手表靠镜像手机通知。

## 架构（局域网,零外部依赖）

```
[Claude 黄灯] → 红绿灯检测 → Bark 推送(带 url=http://局域网IP:port/?t=token)
                                        ↓ 手机点通知
                              手机浏览器打开控制页(本地服务提供)
                                        ↓ 点按钮/输入
                          POST /respond → 主进程 → activateHostApp(项目) + 敲键
```

复用现成能力:`activateHostApp(projectName)` 已经能跨平台(mac osascript / win PowerShell)找到并激活对应项目的终端/IDE 窗口。回传只在其后加「往激活窗口敲键」一步。

## 改动文件

### 1. electron/main.cjs（核心）

**新增本地 HTTP 服务**（Node `http` 模块,零依赖）:
- 启动时绑定局域网 IPv4(`os.networkInterfaces` 取第一个非内网 IPv4)+ 固定端口(如 37271)
- 生成随机 token(内存中),每个请求校验,防局域网他人乱发
- 路由:
  - `GET /?t=TOKEN` → 返回手机控制页 HTML(内嵌字符串,无需独立文件)
  - `POST /respond?t=TOKEN` → body `{project, action, text}` → 触发回传

**新增敲键注入**（复用 activateHostApp 后调用）:
- mac:`osascript` System Events `keystroke`(需辅助功能权限,与现有窗口激活同权限,无新增)
- win:PowerShell `WScript.Shell.SendKeys`(激活后发给前台窗口)
- action 映射:
  - `enter` → 回车(确认默认,最通用)
  - `yes` → `y` + 回车
  - `no` → `n` + 回车
  - `text` → 输入文字 + 回车(给 AskUserQuestion 用)
- 流程:先 `activateHostApp(project)`(已含 mac 的 0.4s delay 让窗口到前台)→ 再发敲键

**增强 Bark 推送**:
- 黄灯推送时附 `url=http://局域网IP:port/?t=TOKEN`,手机点通知即打开控制页
- 记录 `currentYellowProject`(复用现有 barkNotifiedProject 逻辑),控制页显示 + 回传时定位窗口

**新增 IPC** `get-remote-status` → 返回 `{ url, running }` 供设置页展示

### 2. electron/settings.html
Bark 区块加一行状态:「手机控制页:http://x.x.x.x:port」+ 服务运行状态,便于手动在手机浏览器打开测试。

### 3. electron/preload.cjs
暴露 `getRemoteStatus()`。

## 手机控制页（本地服务返回的 HTML）
移动端友好、大按钮:
- 标题:「🟡 Claude Code 等你确认」+ 项目名
- 预设按钮:「↵ 回车确认」「✓ 同意 y」「✗ 拒绝 n」
- 文本输入框 +「发送」(输入文字回车)
- 点击后 POST /respond,显示「已发送 ✓」

## 诚实的边界（MVP）
1. **仅局域网**:手机与电脑同一 WiFi。出门(蜂窝/异地网络)控制页打不开 → phase 2 接 ntfy 公网中转。
2. **看不到问题原文**:hook 只写 "yellow",不抓 prompt 内容。手机上是通用按钮 + 自由输入,不能显示 Claude 具体问了啥 → phase 2 增强 hook 抓问题文本。
3. **盲操作限制**:离开屏幕时,「回车确认」最安全(y/n 常见);AskUserQuestion 需凭记忆输入。
4. **安全**:token 门禁防局域网他人;仅绑定局域网口。
5. **权限**:mac 需辅助功能权限(现有窗口激活已需,无新增)。

## 验证
- node --check 三个文件
- 手动:黄灯 → 手机收到带链接通知 → 点开控制页 → 点「回车」→ 电脑窗口置顶并敲回车
