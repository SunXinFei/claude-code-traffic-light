# 手机推送 + 滑动批准（Hook 自动确认）

> 状态：Released · v2.3.1+ · 2026-07-31
> 目标：Claude 权限请求（写文件等）不再弹控制台提示，手机/本地控制页滑动批准后 Claude 直接执行。多 Claude 对话并行时无需逐个找 session 按 yes。

---

## 0. 一句话原理

`PermissionRequest` hook 返回 `allow` → 控制台不弹权限提示 → 工具直接执行（Claude 标注 `Allowed by PermissionRequest hook`）。"滑动批准" = 主进程写 `.approved` 信号 → hook 读到后返回 `allow`。**替代原来的模拟键盘回车注入**，不依赖辅助功能权限 / 窗口焦点。

---

## 1. 配置

设置 → 📱 手机推送，顶部有 **iOS（Bark）/ 安卓（ntfy）** 两个 tab。

### iOS（Bark）

| 步骤 | 操作 |
|---|---|
| 1 | App Store 装 [Bark](https://apps.apple.com/us/app/bark-push-notifications/id1403753865) |
| 2 | Bark 里复制专属 Key |
| 3 | 红绿灯 → iOS tab → 填 Bark Key → 保存 → 测试推送 |

服务器留空用官方 `https://api.day.app`，可填自建地址。

### 安卓（ntfy）

| 步骤 | 操作 |
|---|---|
| 1 | 装 [ntfy](https://f-droid.org/packages/io.heckel.ntfy/)（F-Droid / Google Play / [ntfy.sh](https://ntfy.sh)） |
| 2 | ntfy app 里**订阅一个 Topic**（自己起名，如 `claude-light-abc123`） |
| 3 | 红绿灯 → 安卓 tab → 填**同名 Topic** → 保存 → 测试推送 |

服务器留空用官方 `https://ntfy.sh`，国内访问不稳可自建。点推送通知会打开控制页。

> 控制页 URL（`http://局域网IP:37271/?t=token`）不再在设置页显示，避免未配置推送的用户误打开。打开控制页的唯一入口是**点推送通知**。

---

## 2. 使用流程

1. Claude 要执行需权限的工具（写文件等）→ 亮黄灯
2. 手机收到推送（Bark / ntfy，带项目名 + 待确认内容摘要）
3. **点通知** → 打开控制页（手机或本机浏览器）
4. **滑动批准** → Claude 控制台不弹提示，工具直接执行

拒绝：点"拒绝" → hook 返回 `deny`，Claude 换路子。
超时：最多等 290s 未滑动 → 回退控制台手动确认（不卡死）。

---

## 3. 启用条件

填了 **Bark Key 或 ntfy Topic 任一** → 自动启用 Hook 自动批准（写 `~/.claude/traffic_light/remote_approve.enabled` 标记）。

- 配了推送 → hook 阻塞等滑动批准（脱离控制台）
- 没配 → hook 立即放行 → Claude 走控制台原流程（不卡）

`hook_capture.cjs` 每次权限请求时现读标记文件，所以**保存配置后下一次权限请求即生效，不用重启 app**。

---

## 4. dev 测试步骤

> 发版前必须按此流程测试通过，才允许 `git tag` + `git push`。

1. **重启 dev app**：Ctrl+C 杀掉旧 dev 进程，重新 `npm run dev` 加载新代码（main.cjs 改动不热加载）。
2. 设置 → 📱 手机推送：
   - 顶部有 **iOS / 安卓** 两个 tab，点着能切换。
   - 原来的 `http://...?t=...` 控制页 URL **应不再显示**。
   - iOS tab：Bark 配置照常能保存 / 测试（确认没改坏）。
3. **ntfy 不用安卓机也能测**：
   - 浏览器开 `https://ntfy.sh/你起的topic名`（如 `https://ntfy.sh/cl-test-abc`）订阅。
   - 红绿灯切安卓 tab，填同名 Topic → 保存 → 测试推送。
   - 看那个网页有没有收到消息（验证 ntfy 协议）。
4. **真实链路**（用 Write 触发，别用 Bash）：
   - 在 Claude 会话发：`请把 hi 写入 /tmp/test_approve.txt`
   - 红绿灯亮黄灯 → 手机/网页收到推送 → 点通知打开控制页 → 滑动批准
   - 预期：Claude 控制台**不弹权限提示**，文件直接写入，显示 `Allowed by PermissionRequest hook`。
5. **对照**：清空 Bark Key / ntfy Topic 并保存 → 再触发写文件 → 控制台**应弹权限提示**（回到原流程）。

---

## 5. 排错

| 现象 | 原因 | 解决 |
|---|---|---|
| 滑动**只跳转不确认** | 没填 Bark Key / ntfy Topic → enabled 标记没开 → hook 立即放行走注入路径 → 注入失败（辅助功能权限/焦点） | 填 Key/Topic + 点保存，确认 `ls ~/.claude/traffic_light/remote_approve.enabled` 存在 |
| ntfy 收不到推送 | Topic 不同名 / 服务器不可达 / 自建服务器未对公网开放 | 核对 Topic 拼写；浏览器直接访问 `https://ntfy.sh/{topic}` 验证；自建检查反代 |
| Bash 不走滑动批准 | Bash 被 `rtk hook claude` 在 PreToolUse 阶段提前放行，不触发 PermissionRequest | 正常，Bash 无需也接管不了。测 hook 用 **Write** 触发 |
| 控制台仍弹提示（配了推送） | `hook_capture.cjs` 未更新到 STATE_DIR（app 没重启） | 重启 app，让其 copyFileSync 新版脚本 |
| AskUserQuestion 不能滑动回答 | 无 hook 能替用户回答问题内容 | 正常，AskUserQuestion 仍走文字注入 |

---

## 6. 边界

- **AskUserQuestion**：无 hook 能程序化回答，仍走窗口激活 + 敲键注入（控制页"发送文字"）。
- **Bash**：被 `rtk hook claude` 提前放行，不触发 PermissionRequest、不亮黄灯，不在此功能范围内。
- **网络**：手机与电脑同一 WiFi（局域网控制页）；ntfy 推送走公网（ntfy.sh 或自建）。
- **超时**：hook 阻塞最多 290s（settings.json 里 hook `timeout:300` 秒），超时回退控制台手动确认。

---

## 7. 原理详解

### 信号协议（`~/.claude/traffic_light/`）

| 文件 | 写入方 | 内容 | 作用 |
|---|---|---|---|
| `<project>.state` | hook（projectCmd） | `yellow` | 红绿灯主进程轮询发现黄灯 |
| `<project>.prompt` | hook_capture.cjs | 待确认内容摘要 | 控制页卡片展示 |
| `<project>.pending` | hook_capture.cjs | `{id,type,tool,prompt,ts}` | 主进程读 → 推送 + 控制页；`type=permission` 才阻塞 |
| `<project>.approved` | 主进程（滑动后） | `{id,behavior:"allow"|"deny"}` | hook 轮询匹配 id → 返回 decision |

### 时序

```
Claude 要执行 Write(需权限)
  → PermissionRequest hook 启动（hook_capture.cjs）
     · 检查 remote_approve.enabled 标记：无 → 立即放行（走控制台原流程）
     · 有 → 写 .pending → 阻塞轮询 .approved（200ms，上限 290s）
  → 主进程轮询 .state=yellow → 读 .pending → 推送 Bark/ntfy + 控制页展示
  → 用户滑动批准 → POST /respond{action:approve}
  → 主进程写 .approved={id,behavior:allow}
  → hook 读到匹配 id → stdout 输出 decision allow JSON → 清理 .pending/.approved
  → Claude 收到 allow → 直接执行（控制台不弹提示）
```

### hook 输出（PermissionRequest）

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

`behavior`：`allow`（执行）/ `deny`（拒绝）。无 `ask`/`defer`；hook 不输出 decision（超时/未启用）则走默认权限提示。

### 关键文件

| 文件 | 职责 |
|---|---|
| `electron/hook_capture.cjs` | hook 脚本：写 .prompt/.pending，阻塞等 .approved，输出 decision。复制到 STATE_DIR 供外部 node 执行 |
| `electron/main.cjs` | 轮询 .state/.pending、Bark/ntfy 推送、`/respond` 路由、`syncRemoteApproveFlag`、控制页 HTML |
| `electron/settings.html` | iOS/安卓 tab 配置 UI |
| `~/.claude/settings.json` | `PermissionRequest` hook 配置（带 `timeout:300`） |
