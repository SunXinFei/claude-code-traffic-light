# Hook 自动批准：滑动确认脱离控制台

## 目标
把"滑动批准"的底层从「模拟键盘回车注入 Claude 控制台」换成「`PermissionRequest` hook 返回 `allow`，Claude 直接执行工具、不弹控制台权限提示」。

- **权限请求**（Bash/Write/Edit 等黄灯）：滑动 → hook 返回 `allow` → Claude 直接跑，全程不碰控制台键盘、不需辅助功能权限、不依赖窗口焦点。
- **AskUserQuestion**：无 hook 能程序化回答（Elicitation 是 MCP 专用），保留现有文字/回车注入。
- 用户在设置里开关此模式；关闭时 hook 立即放行走默认权限提示，Claude 不卡。

## 核心机制（已由官方文档确认）
- `PermissionRequest` hook 在权限提示**之前**触发，只在真正需要权限的工具上触发（不像 PreToolUse 对所有工具）。返回 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}` 可**抑制交互式权限提示**。
- 阻塞的 hook 会让 Claude Code 等待，`command` hook 默认超时 600s（单位**秒**），超时取消并走默认行为——天然 fallback。
- 生命周期：`PreToolUse` → `PermissionRequest` →（工具执行）→ `PostToolUse`。

## 时序

```
Claude 要执行 Bash(需权限)
  → PermissionRequest hook 启动（hook_capture.cjs）
     · 写 {project}.state=yellow（现有，控制页/灯亮）
     · 写 {project}.pending = {id, type:"permission", tool, prompt, ts}
     · 检查 enabled 标记：无 → 立即静默退出（走默认提示，不卡）
     · 有 → 阻塞轮询 {project}.approved（200ms）
  → 红绿灯主进程轮询发现 .pending → 推送 Bark + 控制页展示（含 id）
  → 用户滑动批准 → POST /respond{action:"approve"}
  → 主进程写 {project}.approved = {id, behavior:"allow"}
  → hook 读到 approved 且 id 匹配
     → stdout 输出 decision allow JSON → 删除 pending/approved → 退出
  → Claude 收到 allow → 直接执行工具（控制台不弹提示）
```

拒绝：`action:"deny"` → `behavior:"deny"`，Claude 收到拒绝原因、换路子。
超时（300s）没滑：hook 静默退出 → Claude Code 走默认权限提示（控制台弹，用户仍可手动确认）。

## 信号协议（STATE_DIR = ~/.claude/traffic_light）

**`{project}.pending`**（hook 写，主进程读）：
```json
{"id":"<requestId>","type":"permission","tool":"Bash","prompt":"$ npm install","ts":1234567890}
```

**`{project}.approved`**（主进程写，hook 读，一次性）：
```json
{"id":"<requestId>","behavior":"allow"}
```

- `id` 由 hook 生成（`Date.now().toString(36)+Math.random()` + pid），用于匹配"这一次请求"，防止一次滑动批准多个请求。
- hook 读到匹配的 approved 后删除 pending+approved（一次性信号）。
- AskUserQuestion 走 `{project}.pending` 但 `type:"question"`，hook 写完即退出不阻塞；主进程据此在滑动时改走注入而非写 approved。

## 改动文件

### 1. `electron/hook_capture.cjs`（核心改造）
现有：读 stdin → pickPrompt → 写 `.prompt`/`.prompt.json` → 退出。

新增分支（读 `hook_event_name`）：
- **`PermissionRequest`**：
  1. 照常写 `.prompt`（控制页展示）。
  2. 检查 `STATE_DIR/remote_approve.enabled` 标记文件，不存在 → 立即 `process.exit(0)`（不输出 decision → 走默认提示）。**这是"关闭时不卡"的关键。**
  3. 生成 `id`，写 `{project}.pending`（type:"permission"）。
  4. 轮询 `{project}.approved`（200ms 间隔，上限 300s）：id 匹配 → stdout 输出对应 decision JSON → 清理 → 退出；超时 → 静默退出（fallback）。
- **`PreToolUse` + `tool_name==="AskUserQuestion"`**：写 `.prompt` + `{project}.pending`（type:"question"）→ 立即退出（不阻塞、不输出 decision）。
- 其它/兜底：保持现状（写 .prompt 退出）。
- stdout 只在 PermissionRequest 命中批准时输出**纯 JSON**（其他情况静默），避免污染 Claude Code 的 hook 输出解析。

### 2. `electron/main.cjs`
- **`setupClaudeHooks()`**：`PermissionRequest` 的 capture hook 条目加 `timeout: 300`（秒），即 `{type:'command', command, timeout:300}`，避免撞默认 600s 让 Claude 卡太久。hook 命令本身不变（脚本内部判 enabled）。
- **轮询（poll, ~1426）**：黄灯时除读 `.state` 外，读 `.pending` 拿 `{id, type}`，存到模块级 `currentYellowRequest`（与 `currentYellowProject`/`currentPrompt` 并列）。`onTrafficStateChange` 里同步更新。
- **`handleRemoteRespond()`（~526）**：按 `currentYellowRequest.type` 分流：
  - `permission` + action `approve`/`enter` → 写 `.approved={id,behavior:"allow"}`（不再 keystroke）。
  - `permission` + action `no`/`deny` → 写 `.approved={id,behavior:"deny"}`。
  - `question` 或无 type → 走现有 `activateHostApp`+`injectKeystrokes`（保留）。
  - `focus`（点卡片切窗口）不变。
- **`/respond` 路由（~693）**：接受新 action `approve`/`deny`（兼容旧 `enter`/`no`）。
- **enabled 开关**：新增 IPC `set-remote-approve(enabled)` / `get-remote-approve`，写/删 `STATE_DIR/remote_approve.enabled`。开启时确保 `startRemoteServer()` 启动（含本机 `127.0.0.1` 监听，方便"本地页面"滑动）。
- **`remoteServer` 监听**：额外监听 `127.0.0.1`，本机浏览器开控制页更顺（用户明确提到"本地页面"）。
- **`hook_capture.cjs` 复制（~1752）**：不变（app ready 已 copyFileSync，新版自动覆盖）。

### 3. `electron/settings.html` + `preload.cjs`
- Bark 分区下新增开关：「滑动批准（Hook 自动确认，免控制台回车）」+ 说明"开启后 Claude 权限请求会等你在此控制页滑动批准，最多 5 分钟未操作则回退到控制台手动确认"。
- 开关联动：开启时若未填 Bark key 也可用（本机控制页），但建议同时配 Bark 才能远程。
- `preload.cjs` 暴露 `setRemoteApprove`/`getRemoteApprove`。

### 4. 控制页（`remoteControlPage()` HTML, ~538）
- 滑动批准文案根据 type 微调：permission →「滑动批准（允许执行）」；question →「滑动批准（回车）」。
- 滑动 `done()` 改 `respond('approve')`（permission）或 `respond('enter')`（question）。主进程按 type 已分流，前端可统一发 `approve`，由主进程判断更稳。
- 拒绝按钮 permission 场景发 `deny`。

## 开关与超时策略
- **默认关**：避免用户不知情时 Claude 卡住等超时。
- **enabled 标记文件**：`remote_approve.enabled`。hook 启动先查标记，无则立即放行——即使 hook 装着也不卡。开关切换只写/删标记，无需重装 hook。
- **超时 300s**：hook 内部上限 + settings.json hook `timeout:300` 双保险。超时 fallback 到控制台手动确认。

## AskUserQuestion 边界（诚实）
- 无 hook 能替用户回答问题内容，`question` 类型仍靠 `injectKeystrokes` 注入回车/文字。
- 即开启 Hook 自动批准后，**只有权限请求真的脱离控制台**；AskUserQuestion 仍是注入（但用户在控制页操作体验一致，底层分流透明）。

## 风险与验证
1. **最大风险**：`PermissionRequest` hook 返回 decision 实际能否抑制提示——文档确认能，但需实测当前 Claude Code 版本。**先写最小验证**：手动在 settings.json 加一个固定返回 allow 的 PermissionRequest hook，跑 Claude 触发权限请求，确认控制台不弹、工具直接执行。验证通过再全面改。
2. **多 hook stdout 合并**：`PermissionRequest` 现配两条（stateCmd + yellowCaptureCmd）。stateCmd stdout 空，capture 脚本输出纯 JSON。需确认 Claude Code 采纳 capture 脚本的 hookSpecificOutput。若不采纳，改为把 decision 输出独立成一条 hook。
3. **生产打包**：`hook_capture.cjs` 改动后，app 启动 copyFileSync 覆盖 STATE_DIR 旧版；已运行的用户重启 app 即生效。
4. `node --check` 三个文件；手动 e2e：开开关 → Claude 触发 Bash 权限 → 控制页滑动 → 工具执行且控制台不弹提示 → 关开关 → 同请求控制台正常弹提示。

## 不在范围内
- 公网远程（仍局域网 + Bark 推送链路不变）。
- AskUserQuestion 的 hook 化回答（技术不可行）。
- 白名单/免确认（本次只做"每次滑动实时批准"）。
