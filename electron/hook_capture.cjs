#!/usr/bin/env node
// Claude Code hook: 从 stdin 读取 hook 输入 JSON，提取"需要确认的内容"写到 .prompt 文件。
// 供红绿灯手机控制页展示（最多 3 行，超出由前端省略）。
//
// 触发场景：
//   - PermissionRequest：Claude 请求执行某工具（如 Bash 命令）需用户授权
//   - PreToolUse:AskUserQuestion：Claude 问用户问题
//
// Claude 通过 stdin 传 JSON，字段大致：
//   { session_id, hook_event_name, tool_name, tool_input: {...}, ... }
// PermissionRequest 可能另有 tool_name / tool_input 或 permission 等字段。
// 脚本容忍字段缺失，尽量提取可读内容；同时把原始 JSON 存一份 .prompt.json 便于调试。

const fs = require('fs')
const path = require('path')
const os = require('os')

const STATE_DIR = process.env.CC_TL_STATE_DIR
  || (process.platform === 'win32'
    ? path.join(os.homedir(), '.claude', 'traffic_light')
    : '/tmp/cc_traffic_light')

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

  // AskUserQuestion: tool_input.question 是问题文本
  if (tool === 'AskUserQuestion' && input.question) {
    return String(input.question)
  }

  // Bash: tool_input.command
  if (input && input.command) {
    return `$ ${input.command}`
  }

  // Write/Edit: tool_input.file_path
  if (input && input.file_path) {
    const op = tool || 'Edit'
    return `${op}: ${input.file_path}`
  }

  // 通用：tool_input 里若有 description / prompt / message
  if (input) {
    for (const k of ['description', 'prompt', 'message', 'content', 'query']) {
      if (typeof input[k] === 'string' && input[k].trim()) return input[k]
    }
  }

  // 兜底：permission 对象
  if (obj.permission && typeof obj.permission === 'object') {
    const p = obj.permission
    if (p.tool) return `${p.tool}`
  }

  // 最后兜底：tool_name
  return tool || ''
}

function truncate(s, max = 300) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

async function main() {
  const raw = await readStdin()
  let obj = {}
  try { obj = JSON.parse(raw) } catch {}

  const project = process.env.CC_TL_PROJECT
    || path.basename(process.env.CLAUDE_PROJECT_DIR || process.cwd())

  const prompt = truncate(pickPrompt(obj))

  try { fs.mkdirSync(STATE_DIR, { recursive: true }) } catch {}
  try {
    fs.writeFileSync(path.join(STATE_DIR, `${project}.prompt`), prompt, 'utf8')
  } catch {}
  // 原始 JSON 调试用
  try {
    fs.writeFileSync(path.join(STATE_DIR, `${project}.prompt.json`), raw || '{}', 'utf8')
  } catch {}
}

main().catch(() => {})
