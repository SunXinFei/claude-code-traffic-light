# PRD：红绿灯蓝牙远程授权（Apple Watch / iPhone）

> 状态：Draft · 2026-07-14
> 目标：Claude Code 需要授权（黄灯）时，通过蓝牙让 iPhone / Apple Watch “响铃”，用户像接电话一样 Accept / Decline，或点 Jump 聚焦 Mac 终端。

---

## 0. 两个关键发现（先看）

**发现 1：现在的“点灯”其实没有真的 accept/deny。**
点灯调用的是 `activateHostApp()`（`electron/main.cjs:528`），它只把宿主终端/编辑器窗口拉到最前面，让你手动按 Enter/Esc。**当前没有“程序化批准/拒绝”机制**。所以“手表 accept = 电脑点灯”要修正：点灯只是“跳转聚焦”，真正的 accept/deny 是要新增的能力。这个功能本质是**补上 accept/deny 这条链路**，而不只是“加个蓝牙通知”。

**发现 2：“像接电话一样滑动接听”在 Apple 平台有硬限制。**
- **iPhone**：原生全屏滑动接听 = CallKit。但 CallKit 要求 PushKit VoIP 推送，且 Apple 对**非 VoIP 应用**用 CallKit 会**拒审**（有先例）。安全替代 = Critical Alerts + 通知扩展（绕过静音/DND，带 Accept/Decline 按钮，但横幅不是全屏滑动）。
- **Apple Watch**：**watchOS 没有 CallKit**，第三方拿不到系统接听 UI。只能做**自定义全屏界面**（绿色接听/红色拒绝按钮，可用分页界面做出“滑动”感），不是系统电话 UI。

即“滑动接听”在 iPhone 上有合规风险、在手表上只能自定义模拟。§7 给出权衡选项。

---

## 1. 背景与目标

| | |
|---|---|
| 现状 | Electron 红绿灯轮询 `~/.claude/traffic_light/<project>.state`（300ms），黄灯 = Claude Code 的 `PermissionRequest` hook 触发。点灯 = 聚焦终端。 |
| 目标 | 黄灯时通过蓝牙让 iPhone/Apple Watch “响铃”，用户在手表/手机上像接电话一样 Accept/Decline，或点 Jump 聚焦 Mac 终端。 |
| 范围 | 本地蓝牙为主（~10m）；远程（APNs）列为可选二期。 |

---

## 2. 开源参考

| 项目 | stars | 机制 | 借鉴点 |
|---|---|---|---|
| **achton/ntfy-approve** | 新 | `PermissionRequest` hook + 推送带 Approve/Deny 按钮 + 轮询响应 + **终端/手机先响应者胜** + 超时回退 | **最接近**，模式直接可抄 |
| ZeframLou/call-me | 2.6k | `Stop` hook + Twilio/Telnyx 真实电话 + 语音对话 | “打电话”隐喻来源 |
| tuchg/Lucarne | 310 | Rust 守护进程 + Telegram/微信 + `PermissionRequest` 交互按钮 | 守护进程轮询模式 |
| JessyTsui/Claude-Code-Remote | 1.3k | `Stop`/`SubagentStop` + 邮件/Telegram/LINE | 远程指令注入 |

**空白点：没有任何项目用 BLE 或原生支持 Apple Watch。** 新贡献。

**核心可抄模式（ntfy-approve）**：`PermissionRequest` hook 脚本与终端提示**并行运行**，hook 阻塞等待外部决策，输出 `{"hookSpecificOutput":{"permissionDecision":"allow|deny"}}` 给 Claude Code；终端先响应则 hook 进程被杀、通知清除；超时则回退终端。该路径**不依赖终端聚焦**，比模拟按键稳。

---

## 3. 技术可行性结论

**Mac 蓝牙（外设端）**：用 **Swift CoreBluetooth 小 helper**（`CBPeripheralManager` 广播 + GATT），**不要用** node 的 bleno/noble（外设模式无人维护、Apple Silicon 编译脆弱）。Swift helper 作为独立小二进制随 Electron 打包，通过 stdio/JSON-lines 与主进程通信。Mac **可以**做 BLE 外设（正是所需，因为 watchOS 只能做 central）。

**iPhone 交互**：CallKit（全屏滑动，**拒审风险高**） vs Critical Alerts + 通知扩展（安全，横幅 + 按钮）。**推荐后者**。

**Apple Watch**：无 CallKit，做**自定义全屏接听界面**；watchOS 可作 BLE central **直连 Mac**（不经 iPhone，延迟最低）。

**远程**：APNs 需后端 + Apple Developer $99/年。可选二期。

**硬性依赖**：Apple Developer Program $99/年（发配套 App，含 TestFlight）、Xcode、配套 iOS + watchOS 原生 App。

---

## 4. 推荐架构（hook-decision + BLE，本地优先）

```
Claude Code 触发 PermissionRequest
        │
        ▼  (运行 hook 脚本，与终端提示并行)
  hook 脚本: 写 yellow(既有) + 写 pending 请求文件(带 UUID) + 轮询响应文件(≤60s)
        │                                    ▲
        │ pending 文件被 300ms 轮询发现        │ 响应文件被写入
        ▼                                    │
  Electron 主进程 ──stdio──► Swift BLE helper (CBPeripheralManager)
        │                          │ BLE GATT notify (~10m)
        │                          ▼
        │                   iPhone / Apple Watch (CBCentral)
        │                   “接听”界面: Accept / Decline / Jump
        │                          │ BLE write
        └──────────────────────────┘ helper 收到决策 -> Electron 写响应文件
        │
  hook 读到响应 -> stdout 输出 permissionDecision -> Claude Code 执行 allow/deny
  (终端若先响应 -> hook 被杀，通知自动清除；超时 -> 回退终端提示)
```

- **Accept/Decline**：走 hook-decision（稳，无需终端聚焦，Mac 锁屏也行只要 Claude Code 在跑）。
- **Jump（跳转）**：独立 BLE 命令 -> 复用既有 `activateHostApp()`，把 Mac 终端拉到前台。
- **复用既有架构**：全部基于文件交接（和现状一致），不需要新建 IPC/HTTP server。

### 备选架构（keystroke，更简单但脆弱）
保留既有 hook（只写 yellow 即返回），Electron 检测到 yellow -> BLE -> 手表；手表 Accept/Decline -> 用 `osascript` 模拟 Enter/Esc 给终端。**缺点**：终端必须可见聚焦、需 macOS 辅助功能权限、Mac 锁屏失效。仅用于快速 demo。

---

## 5. BLE GATT 设计

```
Service: "CC Permission" (自定义 UUID)
 ├─ PermissionRequest (notify)   Mac->设备: {id, tool, summary, timeout}
 ├─ Response (write)             设备->Mac: {id, decision: accept|deny|jump}
 └─ Status (read/notify)         Mac->设备: waiting|resolved|timeout
```

---

## 6. 各端实现要点

- **Mac Electron**：新增 `electron/bluetooth-bridge.cjs`（管 Swift helper 生命周期 + 文件交接）、hook 脚本（阻塞轮询）、设置面板加“远程控制”开关与配对码、托盘加“远程:已连接”指示。
- **Swift helper**：~50KB，`CBPeripheralManager` 广播 + GATT，stdio 收发 JSON。
- **watchOS App**：`CBCentralManager` 扫描连接 Mac；收到 notify 弹自定义全屏接听界面（绿 Accept / 红 Decline / Jump）。
- **iOS App（二期）**：BLE central + Critical Alert + Notification Content Extension（展开式 Accept/Decline）。
- **hook 脚本**：UUID 请求文件 + 响应文件，与 Electron 用文件握手（契合现有轮询架构）。

---

## 7. 关键决策与权衡

| 决策点 | 选项 A | 选项 B | 建议 |
|---|---|---|---|
| iPhone 接听 UI | CallKit（全屏滑动） | Critical Alerts（横幅+按钮） | **B**（A 拒审风险高） |
| accept/deny 链路 | hook-decision | 模拟按键 | **hook-decision**（稳） |
| 手表连 Mac | 直连 BLE（无 iPhone） | 经 iPhone/WatchConnectivity | **直连**（延迟低、依赖少） |
| 覆盖范围 | 仅 BLE（~10m） | +APNs 远程 | 先 BLE，远程二期 |
| 手表 UI | 自定义全屏（模拟滑动） | 通知 action 按钮 | 自定义全屏（更接近“接电话”） |

---

## 8. 风险

- **App Store 拒审**：CallKit 用于非 VoIP。-> 用 Critical Alerts 规避。
- **BLE 范围**：~10m，超出收不到。-> hook 超时回退终端；远程用 APNs。
- **macOS 权限**：蓝牙（helper 首次弹窗）、辅助功能（仅 keystroke 方案需要）。
- **Claude Code hook API 变动**：`PermissionRequest` 的 `permissionDecision` 输出契约依赖 Claude Code 版本。-> 锁版本测试。
- **watchOS 后台/电量**：后台扫描受限。-> App 前台或通过 notify 唤醒。
- **多项目并发**：红绿灯支持多项目，请求需带 project + UUID 区分，响应按 ID 路由。

---

## 9. 建议分期

- **Phase 0（spike，1-2 天）**：Swift `CBPeripheralManager` + 一个 watchOS central demo，打通“Mac 写 -> 手表收到 -> 手表回写 -> Mac 收到”往返。先证明链路。
- **Phase 1（MVP，本地）**：hook-decision + BLE + watch 自定义接听界面 + Jump。**最小可用**。
- **Phase 2**：iPhone 配套 + Critical Alerts。
- **Phase 3（可选）**：APNs 远程 + 轻量后端。

---

## 10. 待决策的开放问题

1. **CallKit 风险能否接受？** 能接受就走 iPhone 全屏滑动；不能就 Critical Alerts 横幅 + 按钮。
2. **Apple Watch 直连 BLE，还是经 iPhone 中转？** 直连更简单，但手表要独立 App。
3. **远程（APNs，超出蓝牙范围）是否在范围内？** 要的话需后端 + $99/年。
4. **keystroke 方案作为快速 fallback 可接受吗？**（需辅助功能权限）
