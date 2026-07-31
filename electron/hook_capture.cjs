#!/usr/bin/env node
// Claude Code hook：从 stdin 读取 hook 输入 JSON，提取"需要确认的内容"写到 .prompt 文件，
// 供红绿灯手机/本地控制页展示（最多 3 行，超出由前端省略）。
//
// 触发场景：
//   - PermissionRequest：Claude 请求执行某工具（如 Bash 命令）需用户授权
//   - PreToolUse:AskUserQuestion：Claude 问用户问题
//
// 额外职责（PermissionRequest）：若开启「Hook 自动批准」，阻塞等待用户在控制页滑动
// 批准/拒绝，再把决定以 hookSpecificOutput JSON 返回给 Claude Code——抑制控制台权限
// 提示，工具直接执行（允许）或被拒（拒绝）。未开启时立即放行走默认权限提示，不阻塞。
//
// Claude 通过 stdin 传 JSON，字段大致：
//   { session_id, hook_event_name, tool_name, tool_input: {...}, ... }
// 脚本容忍字段缺失，尽量提取可读内容；同时把原始 JSON 存一份 .prompt.json 便于调试。

const fs = require('fs')
const path = require('path')
const os = require('os')

const STATE_DIR = process.env.CC_TL_STATE_DIR
  || path.join(os.homedir(), '.claude', 'traffic_light')

// 开启「Hook 自动批准」时主进程写此标记文件；不存在 -> hook 立即放行不阻塞
const ENABLED_FILE = path.join(STATE_DIR, 'remote_approve.enabled')
// 等待用户滑动的上限（秒）。略小于 settings.json 里 hook 的 timeout(300s)，留余量做清理
const WAIT_TIMEOUT_MS = 290 * 1000
const POLL_INTERVAL_MS = 200

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => resolve(data))
    // hook 超时保护：1.5s 没读完就放弃
    setTimeout(() => resolve(data), 1500)
  })
}

function pickPrompt(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const tool = obj.tool_name || obj.tool || ''
  const input = obj.tool_input || obj.input || {}
  // description 是 Claude 给的人类可读摘要，优先用
  const desc = (typeof input.description === 'string' && input.description.trim())
    || (typeof obj.description === 'string' && obj.description.trim())
    || ''

  // AskUserQuestion: 问题文本
  if (tool === 'AskUserQuestion' && input.question) {
    return String(input.question)
  }

  // Bash: 有 description 就用它，否则截取命令
  if (input && input.command) {
    if (desc) return desc
    const cmd = String(input.command).split('\n')[0].trim()
    return cmd.length > 60 ? '$ ' + cmd.slice(0, 60) + '…' : '$ ' + cmd
  }

  // Write/Edit: description 优先，否则显示文件名
  if (input && input.file_path) {
    if (desc) return desc
    const filename = require('path').basename(String(input.file_path))
    return `${tool}: ${filename}`
  }

  // 通用兜底：各种可能字段
  if (desc) return desc
  if (input) {
    for (const k of ['prompt', 'message', 'content', 'query']) {
      if (typeof input[k] === 'string' && input[k].trim()) return input[k]
    }
  }
  if (obj.permission && typeof obj.permission === 'object') {
    const p = obj.permission
    if (p.tool) return `${p.tool}`
  }
  return tool || ''
}

function truncate(s, max = 300) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

// 同步阻塞毫秒级 sleep（Atomics.wait 优先，不可用则降级忙等）
function sleepMs(ms) {
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(buf, 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* busy wait fallback */ }
  }
}

function makeRequestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '-' + process.pid
}

function isRemoteApproveEnabled() {
  try { return fs.existsSync(ENABLED_FILE) } catch { return false }
}

// 写 .pending 信号：主进程轮询读到后推送 + 控制页展示
function writePending(project, req) {
  try {
    fs.writeFileSync(path.join(STATE_DIR, `${project}.pending`), JSON.stringify(req), 'utf8')
  } catch {}
}

// 阻塞轮询 .approved 信号，匹配 requestId 返回 'allow' | 'deny'；超时返回 null
function waitForDecision(project, requestId) {
  const approvedFile = path.join(STATE_DIR, `${project}.approved`)
  const start = Date.now()
  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    try {
      if (fs.existsSync(approvedFile)) {
        const data = JSON.parse(fs.readFileSync(approvedFile, 'utf8'))
        if (data && data.id === requestId) return data.behavior === 'deny' ? 'deny' : 'allow'
      }
    } catch {}
    sleepMs(POLL_INTERVAL_MS)
  }
  return null
}

// 把决定以 hookSpecificOutput JSON 输出到 stdout（PermissionRequest 专用）
function emitDecision(behavior) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior }, // 'allow' | 'deny'
    },
  }))
}

function cleanupSignal(project) {
  try { fs.unlinkSync(path.join(STATE_DIR, `${project}.pending`)) } catch {}
  try { fs.unlinkSync(path.join(STATE_DIR, `${project}.approved`)) } catch {}
}

async function main() {
  const raw = await readStdin()
  let obj = {}
  try { obj = JSON.parse(raw) } catch {}

  const project = path.basename(process.env.CC_TL_PROJECT
    || process.env.CLAUDE_PROJECT_DIR || process.cwd())

  const event = obj.hook_event_name || ''
  const tool = obj.tool_name || obj.tool || ''
  const prompt = truncate(pickPrompt(obj))

  try { fs.mkdirSync(STATE_DIR, { recursive: true }) } catch {}
  try {
    fs.writeFileSync(path.join(STATE_DIR, `${project}.prompt`), prompt, 'utf8')
  } catch {}
  // 原始 JSON 调试用
  try {
    fs.writeFileSync(path.join(STATE_DIR, `${project}.prompt.json`), raw || '{}', 'utf8')
  } catch {}

  // ---- PermissionRequest：可阻塞等待滑动批准 ----
  if (event === 'PermissionRequest') {
    // 未开启 Hook 自动批准：立即放行，走默认权限提示（控制台手动确认），不阻塞 Claude
    if (!isRemoteApproveEnabled()) return

    const id = makeRequestId()
    writePending(project, { id, type: 'permission', tool, prompt, ts: Date.now() })

    const behavior = waitForDecision(project, id)
    cleanupSignal(project)

    // 拿到决定 -> 返回给 Claude Code 抑制/拒绝权限提示；超时 -> 静默退出走默认提示
    if (behavior === 'allow' || behavior === 'deny') emitDecision(behavior)
    return
  }

  // ---- AskUserQuestion：写 pending(type:question) 供主进程展示，不阻塞 ----
  // 无 hook 能程序化回答问题内容，确认仍靠主进程注入回车/文字（保持现状）
  if (event === 'PreToolUse' && tool === 'AskUserQuestion') {
    const id = makeRequestId()
    writePending(project, { id, type: 'question', tool, prompt, ts: Date.now() })
    return
  }

  // 其它事件：仅写 .prompt，无额外动作
}

main().catch(() => {})
