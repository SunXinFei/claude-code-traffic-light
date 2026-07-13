const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const child_process = require('child_process')
const https = require('https')
const { URL } = require('url')
const { buildArkPresignUrl } = require('./volcSign.cjs')
const providers = require('./providers.cjs')

const TMP          = process.platform === 'win32' ? path.join(os.homedir(), '.claude') : '/tmp'
const STATE_DIR    = path.join(os.homedir(), '.claude', 'traffic_light')
const SELECTED_FILE = path.join(STATE_DIR, 'selected_project')
const PID_FILE     = path.join(TMP, 'cc_traffic_light_electron.pid')
const THEME_FILE   = path.join(TMP, 'cc_traffic_light_theme')
const MUTE_FILE    = path.join(TMP, 'cc_traffic_light_mute')
const STYLE_FILE   = path.join(TMP, 'cc_traffic_light_style')
const POS_FILE     = path.join(os.tmpdir(), 'cc_traffic_light_pos')
const CONFIG_PATH  = path.join(os.homedir(), '.claude', 'settings.json')
const API_KEYS_FILE = path.join(STATE_DIR, 'api_keys.json')
const distPath     = path.join(__dirname, '../dist/index.html')
const isDev        = !fs.existsSync(distPath)

const ICON_PATH = path.join(__dirname, 'tray-icon.png')

const TRAFFIC_MARKER = 'traffic_light_app'

// ---------- State file helpers ----------

function getSelectedProject() {
  try {
    if (fs.existsSync(SELECTED_FILE)) {
      const name = fs.readFileSync(SELECTED_FILE, 'utf-8').trim()
      if (name) return name
    }
  } catch {}
  const projects = listActiveProjects()
  return projects.length > 0 ? projects[0] : 'default'
}

function setSelectedProject(name) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(SELECTED_FILE, name)
  } catch {}
}

function listActiveProjects() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    return fs.readdirSync(STATE_DIR)
      .filter(f => f.endsWith('.state'))
      .map(f => f.replace(/\.state$/, ''))
      .sort()
  } catch { return [] }
}

function getStateFile(projectName) {
  return path.join(STATE_DIR, `${projectName}.state`)
}

function getAppFile(projectName) {
  return path.join(STATE_DIR, `${projectName}.app`)
}

function cleanProjectFiles(projectName) {
  for (const ext of ['.state', '.dir', '.app']) {
    try { fs.unlinkSync(path.join(STATE_DIR, `${projectName}${ext}`)) } catch {}
  }
}

// ---------- API Key helpers ----------

function readApiKeys() {
  try {
    if (fs.existsSync(API_KEYS_FILE)) {
      return JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf-8'))
    }
  } catch {}
  return {}
}

function writeApiKeys(keys) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(API_KEYS_FILE, JSON.stringify(keys, null, 2), 'utf-8')
  } catch (e) {
    console.error('[balance] write api_keys.json failed:', e)
  }
}

function getApiKey(provider) {
  // Priority: env var > config file
  const envMap = { deepseek: 'DEEPSEEK_API_KEY' }
  const envKey = process.env[envMap[provider] || `${provider.toUpperCase()}_API_KEY`]
  if (envKey) return envKey
  const keys = readApiKeys()
  return keys[provider] || ''
}

function getVolcCredentials() {
  const keys = readApiKeys()
  const v = keys.volcengine || {}
  const ak = process.env.VOLC_AK || v.accessKeyId || ''
  const sk = process.env.VOLC_SK || v.secretAccessKey || ''
  return { accessKeyId: ak, secretAccessKey: sk }
}

function setVolcCredentials(ak, sk) {
  const keys = readApiKeys()
  if (ak && sk) {
    keys.volcengine = { accessKeyId: ak, secretAccessKey: sk }
  } else {
    delete keys.volcengine
  }
  // 切换到 volcengine (互斥: 启用 volcengine 时停用 deepseek)
  if (ak && sk) keys.selected_provider = 'volcengine'
  else if (keys.selected_provider === 'volcengine') {
    keys.selected_provider = keys.deepseek ? 'deepseek' : null
  }
  writeApiKeys(keys)
}

function getSelectedProvider() {
  const keys = readApiKeys()
  if (keys.selected_provider) return keys.selected_provider
  if (keys.volcengine?.accessKeyId && keys.volcengine?.secretAccessKey) return 'volcengine'
  if (keys.deepseek || getApiKey('deepseek')) return 'deepseek'
  return null
}

function setSelectedProvider(p) {
  const keys = readApiKeys()
  if (p === 'deepseek' || p === 'volcengine' || p === null) {
    keys.selected_provider = p
    writeApiKeys(keys)
  }
}

// Read which AI service Claude Code is actually using right now, by inspecting
// ~/.claude/settings.json -> env.ANTHROPIC_BASE_URL. cc-switch and similar
// tools all flip this field, so it's the single source of truth.
function detectProviderFromClaudeConfig() {
  try {
    const s = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    const baseUrl = (s.env && s.env.ANTHROPIC_BASE_URL || '').toLowerCase()
    if (!baseUrl) return null
    if (baseUrl.includes('volces.com') || baseUrl.includes('ark.cn-beijing')) return 'volcengine'
    if (baseUrl.includes('deepseek.com')) return 'deepseek'
    return null
  } catch { return null }
}

// If Claude's config points at a different provider than the one we're showing,
// switch to it. Returns the provider now in effect.
function syncProviderFromClaudeConfig() {
  const detected = detectProviderFromClaudeConfig()
  if (!detected) return getSelectedProvider()
  if (detected !== getSelectedProvider()) {
    console.log(`[balance] provider auto-sync: ${getSelectedProvider()} -> ${detected} (from Claude config)`)
    setSelectedProvider(detected)
  }
  return detected
}

// ---------- DeepSeek Balance ----------

let lastBalance = null  // { balance_infos: [...], ... }

function transmitBalance() {
  const data = lastBalance ? { ...lastBalance } : lastBalance
  if (data && typeof data === 'object') {
    const keys = readApiKeys()
    if (keys._budgets?.deepseek) data._budget = keys._budgets.deepseek
    data._provider = keys.selected_provider || (keys.volcengine?.accessKeyId ? 'volcengine' : 'deepseek')
  }
  if (mainWin) mainWin.webContents.send('balance-update', data)
  if (settingsWin) settingsWin.webContents.send('balance-update', data)
}

function fetchDeepSeekBalance() {
  const apiKey = getApiKey('deepseek')
  if (!apiKey) {
    lastBalance = { error: '未配置 API Key' }
    if (mainWin) mainWin.webContents.send('balance-update', lastBalance)
    if (settingsWin) settingsWin.webContents.send('balance-update', lastBalance)
    return
  }

  const options = {
    hostname: 'api.deepseek.com',
    path: '/user/balance',
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    timeout: 10000,
  }

  const req = https.request(options, (res) => {
    let data = ''
    res.on('data', (chunk) => { data += chunk })
    res.on('end', () => {
      try {
        const json = JSON.parse(data)
        if (json.balance_infos) {
          lastBalance = json
        } else if (json.error) {
          lastBalance = { error: json.error.message || json.error }
        } else {
          lastBalance = { error: '未知响应格式' }
        }
      } catch {
        lastBalance = { error: '解析响应失败' }
      }
      transmitBalance()
    })
  })

  req.on('error', (e) => {
    lastBalance = { error: e.message }
    if (mainWin) mainWin.webContents.send('balance-update', lastBalance)
    if (settingsWin) settingsWin.webContents.send('balance-update', lastBalance)
  })

  req.on('timeout', () => {
    req.destroy()
    lastBalance = { error: '请求超时' }
    if (mainWin) mainWin.webContents.send('balance-update', lastBalance)
    if (settingsWin) settingsWin.webContents.send('balance-update', lastBalance)
  })

  req.end()
}

// ---------- Volcengine Ark Coding Plan Usage ----------

const VOLC_ERROR_MAP = {
  SignatureDoesNotMatch: '签名失败，检查 Secret Access Key',
  InvalidAccessKeyId: 'Access Key ID 无效',
  RequestExpired: '请求过期（本机时钟漂移）',
  InvalidActionOrVersion: 'Action 或 Version 不支持',
  MissingSecurityToken: '缺少 Security Token（需 STS 临时凭证）',
  UnauthorizedOperation: 'AK 无权访问 Ark Coding Plan',
}

function fetchVolcArkUsage() {
  const { accessKeyId, secretAccessKey } = getVolcCredentials()
  if (!accessKeyId || !secretAccessKey) {
    lastBalance = { provider: 'volcengine', error: '未配置 AK/SK' }
    transmitBalance()
    return
  }

  let presign
  try {
    presign = buildArkPresignUrl({
      accessKeyId,
      secretAccessKey,
      action: 'GetCodingPlanUsage',
    })
  } catch (e) {
    lastBalance = { provider: 'volcengine', error: '签名构造失败: ' + e.message }
    transmitBalance()
    return
  }

  const u = new URL(presign.url)
  const body = '{}'
  const options = {
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 10000,
  }

  const req = https.request(options, (res) => {
    let data = ''
    res.on('data', (chunk) => { data += chunk })
    res.on('end', () => {
      try {
        const json = JSON.parse(data)
        const meta = json.ResponseMetadata || {}
        if (meta.Error) {
          const code = meta.Error.Code || ''
          lastBalance = {
            provider: 'volcengine',
            error: VOLC_ERROR_MAP[code] || `${code}: ${meta.Error.Message || ''}`,
          }
        } else if (json.Result?.QuotaUsage) {
          lastBalance = {
            provider: 'volcengine',
            status: json.Result.Status || '',
            updateTimestamp: json.Result.UpdateTimestamp || 0,
            quotas: json.Result.QuotaUsage.map((q) => ({
              level: q.Level,
              percent: q.Percent,
              resetTimestamp: q.ResetTimestamp,
            })),
          }
        } else {
          lastBalance = { provider: 'volcengine', error: '未知响应格式' }
        }
      } catch {
        lastBalance = { provider: 'volcengine', error: '解析响应失败' }
      }
      transmitBalance()
    })
  })

  req.on('error', (e) => {
    lastBalance = { provider: 'volcengine', error: e.message }
    transmitBalance()
  })

  req.on('timeout', () => {
    req.destroy()
    lastBalance = { provider: 'volcengine', error: '请求超时' }
    transmitBalance()
  })

  req.write(body)
  req.end()
}

function refreshSelectedBalance() {
  const p = syncProviderFromClaudeConfig()
  if (p === 'volcengine') fetchVolcArkUsage()
  else if (p === 'deepseek') fetchDeepSeekBalance()
  else {
    lastBalance = { error: '未配置任何 provider' }
    transmitBalance()
  }
}

// ---------- Activate host app ----------

// Known host apps. `matchers` are substrings matched (case-insensitive)
// against TERM_PROGRAM and any ancestor process name. Order matters for the
// Windows running-process fallback: editors first, terminals last.
// `macProc` is the System Events process name (defaults to macName when not
// set) — needed for Electron apps whose executable name differs from the
// display name (e.g. VSCode runs as "Code").
const HOST_APPS = [
  { matchers: ['vscode'],             macName: 'Visual Studio Code', macProc: 'Code', macCli: 'code',     macCliReuse: true, winProc: 'Code' },
  { matchers: ['cursor'],             macName: 'Cursor',             macCli: 'cursor', macCliReuse: true, winProc: 'Cursor' },
  { matchers: ['windsurf'],           macName: 'Windsurf',           macCli: 'windsurf', macCliReuse: true, winProc: 'Windsurf' },
  { matchers: ['zed'],                macName: 'Zed',                macCli: 'zed',   winProc: 'zed' },
  { matchers: ['sublime', 'subl'],    macName: 'Sublime Text',       macCli: 'subl',  winProc: 'sublime_text' },
  { matchers: ['webstorm', 'wstorm'], macName: 'WebStorm',           macCli: 'wstorm', winProc: 'webstorm64' },
  { matchers: ['intellij'],           macName: 'IntelliJ IDEA',      winProc: 'idea64' },
  { matchers: ['iterm'],              macName: 'iTerm',              winProc: null },
  { matchers: ['apple_terminal'],     macName: 'Terminal',           winProc: null },
  { matchers: ['warp'],               macName: 'Warp',               winProc: null },
  { matchers: ['ghostty'],            macName: 'Ghostty',            winProc: null },
  { matchers: ['kitty'],              macName: 'kitty',              winProc: null },
  { matchers: ['alacritty'],          macName: 'Alacritty',          winProc: null },
  { matchers: ['windowsterminal'],    macName: null,                 winProc: 'WindowsTerminal' },
  { matchers: ['powershell', 'pwsh'], macName: null,                 winProc: 'pwsh' },
  { matchers: ['cmd.exe'],            macName: null,                 winProc: 'cmd' },
]

// Resolve which host app a Claude session is running inside. `info` carries
// term_program (TERM_PROGRAM) and vscode_ipc (VSCODE_IPC_HOOK). `extra` is
// extra candidate strings (e.g. ancestor process names) for the fallback.
//
// VSCode, Cursor, and Windsurf all set TERM_PROGRAM="vscode" — they're forks.
// The VSCODE_IPC_HOOK socket path embeds the real app name, so we use it to
// disambiguate (and pick the right CLI: `code` vs `cursor` vs `windsurf`).
function findHostApp(info, ...extra) {
  const tp = (info && info.term_program || '').toLowerCase()
  const ipc = (info && info.vscode_ipc || '').toLowerCase()
  if (tp.includes('vscode') || ipc.includes('cursor') || ipc.includes('windsurf') || ipc.includes('vscode-ipc')) {
    if (ipc.includes('cursor'))   return HOST_APPS.find(a => a.matchers.includes('cursor'))
    if (ipc.includes('windsurf')) return HOST_APPS.find(a => a.matchers.includes('windsurf'))
    return HOST_APPS.find(a => a.matchers.includes('vscode'))
  }
  const hay = [info && info.term_program, ...extra].filter(Boolean).join(' ').toLowerCase()
  if (!hay) return null
  return HOST_APPS.find(a => a.matchers.some(m => hay.includes(m))) || null
}

function readAppInfo(projectName) {
  const appFile = getAppFile(projectName)
  if (!fs.existsSync(appFile)) return null
  let raw
  try { raw = fs.readFileSync(appFile, 'utf-8').trim() } catch { return null }
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  // Fallback: non-JSON. The Windows batch hook writes two lines
  // (term_program\nvscode_ipc) because building JSON with escaped backslashes
  // in cmd is fragile.
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  return { term_program: lines[0] || '', vscode_ipc: lines[1] || '' }
}

// Walk the parent process chain from `startPid`, returning ancestor names
// joined by spaces. Used to recover the host app when TERM_PROGRAM is unset.
function macAncestorNames(startPid) {
  const names = []
  let pid = parseInt(startPid, 10)
  for (let i = 0; i < 10 && pid > 1; i++) {
    let name
    try {
      name = child_process.execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf-8', timeout: 1500 }).trim()
    } catch { break }
    if (!name) break
    names.push(path.basename(name))
    let ppidStr
    try {
      ppidStr = child_process.execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8', timeout: 1500 }).trim()
    } catch { break }
    const next = parseInt(ppidStr, 10)
    if (!next || next === pid) break
    pid = next
  }
  return names.join(' ')
}

function winAncestorNames(startPid) {
  const script = `$p=[int]${parseInt(startPid, 10)}; $n=''; for($i=0;$i -lt 10 -and $p -gt 0;$i++){$x=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue; if(-not $x){break}; $n += ' ' + $x.Name; $p=[int]$x.ParentProcessId}; $n.Trim()`
  try {
    return child_process.execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf-8', timeout: 4000 }).trim()
  } catch { return '' }
}

function findRunningWinHost() {
  try {
    const out = child_process.execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf-8', timeout: 3000 })
    const running = new Set()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/)
      if (m) running.add(m[1].replace(/\.exe$/i, ''))
    }
    return HOST_APPS.find(a => a.winProc && running.has(a.winProc)) || null
  } catch { return null }
}

function activateMacApp(appName) {
  try {
    child_process.execFileSync('osascript', ['-e', `tell application "${appName}" to activate`], { timeout: 3000 })
  } catch {}
}

// Escape a string for safe embedding inside an AppleScript double-quoted string.
function escAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Activate `appName` and, if `folderBasename` is given, bring the window whose
// title contains it to the front. Editors' window titles include the workspace
// folder name (VSCode default: "${activeEditorShort} — ${rootName}"), so this
// picks the right window among several open ones. Uses System Events because
// Electron apps don't expose a `windows` collection through their own AppleScript
// suite. Falls back to plain activate if no window matches or System Events is
// unavailable (missing accessibility permission).
function activateMacAppWindow(appName, procName, folderBasename) {
  if (!folderBasename) { activateMacApp(appName); return }
  const script = `
tell application "${escAppleScript(appName)}" to activate
delay 0.4
tell application "System Events"
  tell process "${escAppleScript(procName)}"
    set targetWin to missing value
    repeat with w in windows
      if name of w contains "${escAppleScript(folderBasename)}" then
        set targetWin to w
        exit repeat
      end if
    end repeat
    if targetWin is not missing value then
      perform action "AXRaise" of targetWin
    end if
  end tell
end tell`.trim()
  try {
    child_process.execFileSync('osascript', ['-e', script], { timeout: 3000 })
  } catch {
    activateMacApp(appName)
  }
}

function activateWinApp(procName) {
  const script = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
}
"@
$pr = Get-Process -Name '${procName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if ($pr) { [void][Win]::ShowWindowAsync($pr.MainWindowHandle, 9); [void][Win]::SetForegroundWindow($pr.MainWindowHandle) }
`.trim()
  try {
    child_process.execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf-8', timeout: 5000 })
  } catch {}
}

// Layer 1 (Mac): editor CLI with reuse-window. `code -r $dir` / `cursor -r $dir`
// tells the editor to focus the workspace if already open (the editor knows its
// own windows far better than we can guess from titles). Returns true on success
// so the caller can skip the AppleScript fallbacks.
function tryMacCli(host, projectDir) {
  if (!host.macCli || !projectDir) return false
  // Prefer `which` (respects the launching shell's PATH, incl. nvm/homebrew);
  // fall back to common install dirs for Dock-launched apps with minimal PATH.
  let cli = ''
  try { cli = child_process.execSync(`which ${host.macCli} 2>/dev/null`).toString().trim() } catch {}
  if (!cli) {
    for (const p of [`/usr/local/bin/${host.macCli}`, `/opt/homebrew/bin/${host.macCli}`]) {
      if (fs.existsSync(p)) { cli = p; break }
    }
  }
  if (!cli) return false
  const args = host.macCliReuse ? ['-r', projectDir] : [projectDir]
  try {
    child_process.execFileSync(cli, args, { timeout: 5000 })
    return true
  } catch { return false }
}

function activateHostApp(projectName) {
  const info = readAppInfo(projectName)
  if (!info) return

  let host = findHostApp(info)
  if (!host && info.ppid) {
    const ancestors = process.platform === 'darwin' ? macAncestorNames(info.ppid) : winAncestorNames(info.ppid)
    host = findHostApp(info, ancestors)
  }
  // Last resort on Windows: pick a known running terminal/editor.
  if (!host && process.platform === 'win32') {
    host = findRunningWinHost()
  }
  if (!host) return

  // Read project dir once (used by CLI layer and the title-match layer).
  let projectDir = ''
  const dirFile = path.join(STATE_DIR, `${projectName}.dir`)
  try { if (fs.existsSync(dirFile)) projectDir = fs.readFileSync(dirFile, 'utf-8').trim() } catch {}
  const folderBasename = projectDir ? path.basename(projectDir) : ''

  if (process.platform === 'darwin') {
    if (!host.macName) return
    // Layer 1: editor CLI reuse-window — most reliable, focuses the exact workspace.
    if (tryMacCli(host, projectDir)) return
    // Layer 2: AppleScript title match via System Events (needs Accessibility).
    // Editors' window titles contain the workspace folder name.
    if (folderBasename) {
      activateMacAppWindow(host.macName, host.macProc || host.macName, folderBasename)
      return
    }
    // Layer 3: terminals / no folder info — just activate the app.
    activateMacApp(host.macName)
  } else if (process.platform === 'win32' && host.winProc) {
    activateWinApp(host.winProc)
  }
}

// ---------- Persistence helpers ----------

function readTheme() {
  try {
    const t = fs.existsSync(THEME_FILE) ? fs.readFileSync(THEME_FILE, 'utf-8').trim() : ''
    return (t === 'light' || t === 'dark') ? t : 'dark'
  } catch { return 'dark' }
}

function readMute() {
  try {
    return fs.existsSync(MUTE_FILE) && fs.readFileSync(MUTE_FILE, 'utf-8').trim() === 'true'
  } catch { return false }
}

function readStyle() {
  try {
    const s = fs.existsSync(STYLE_FILE) ? fs.readFileSync(STYLE_FILE, 'utf-8').trim() : ''
    return s === 'single' ? 'single' : 'triple'
  } catch { return 'triple' }
}

// ---------- Hook auto-configuration ----------

function setupClaudeHooks() {
  const isWin = process.platform === 'win32'
  const stateCmd = (color) => isWin
    ? `cmd /c "echo ${color}> %USERPROFILE%\\.claude\\cc_traffic_light_state"`
    : `echo ${color} > /tmp/cc_traffic_light_state`

  // Per-project: write state + dir + app info
  const projectCmd = (color) => {
    if (isWin) {
      // %~nxF = leaf of CLAUDE_PROJECT_DIR; <nul set /p writes without newline.
      // .app gets two lines (term_program\nvscode_ipc) — JSON with escaped
      // backslashes is too fragile in cmd, and readAppInfo parses this shape.
      return `for %F in ("%CLAUDE_PROJECT_DIR%") do @(echo ${color}>"%USERPROFILE%\\.claude\\traffic_light\\%~nxF.state" & <nul set /p =%CLAUDE_PROJECT_DIR%>"%USERPROFILE%\\.claude\\traffic_light\\%~nxF.dir" & (echo %TERM_PROGRAM%& echo %VSCODE_IPC_HOOK%)>"%USERPROFILE%\\.claude\\traffic_light\\%~nxF.app") & REM ${TRAFFIC_MARKER}`
    }
    return `project=$(basename "$\{CLAUDE_PROJECT_DIR:-$PWD}") && mkdir -p ${STATE_DIR} && echo ${color} > ${STATE_DIR}/"$project".state && echo "$\{CLAUDE_PROJECT_DIR:-$PWD}" > ${STATE_DIR}/"$project".dir && printf '{"term_program":"%s","ppid":"%s","vscode_ipc":"%s"}' "$\{TERM_PROGRAM:-}" "$\{PPID:-}" "$\{VSCODE_IPC_HOOK:-}" > ${STATE_DIR}/"$project".app # ${TRAFFIC_MARKER}`
  }

  // SessionEnd: clean up project files
  const sessionEndCmd = () => {
    if (isWin) {
      return `for %F in ("%CLAUDE_PROJECT_DIR%") do @del /q "%USERPROFILE%\\.claude\\traffic_light\\%~nxF.state" "%USERPROFILE%\\.claude\\traffic_light\\%~nxF.dir" "%USERPROFILE%\\.claude\\traffic_light\\%~nxF.app" 2>nul & REM ${TRAFFIC_MARKER}`
    }
    return `project=$(basename "$\{CLAUDE_PROJECT_DIR:-$PWD}") && rm -f ${STATE_DIR}/"$project".state ${STATE_DIR}/"$project".dir ${STATE_DIR}/"$project".app # ${TRAFFIC_MARKER}`
  }

  // Tool execution = red. Yellow fires on PermissionRequest (auth dialog) and AskUserQuestion.
  const PERMISSION_TOOLS = 'Bash|Write|Edit|Read|NotebookEdit|WebFetch|mcp__'

  const HOOKS_TO_ADD = [
    { event: 'UserPromptSubmit', command: stateCmd('red') },
    { event: 'UserPromptSubmit', command: projectCmd('red') },
    { event: 'Stop',             command: stateCmd('green') },
    { event: 'Stop',             command: projectCmd('green') },
    { event: 'StopFailure',      command: stateCmd('green') },
    { event: 'StopFailure',      command: projectCmd('green') },
    { event: 'PreToolUse',       matcher: 'AskUserQuestion', command: stateCmd('yellow') },
    { event: 'PreToolUse',       matcher: 'AskUserQuestion', command: projectCmd('yellow') },
    { event: 'PreToolUse',       matcher: PERMISSION_TOOLS, command: stateCmd('red') },
    { event: 'PreToolUse',       matcher: PERMISSION_TOOLS, command: projectCmd('red') },
    { event: 'PostToolUse',      matcher: PERMISSION_TOOLS, command: stateCmd('red') },
    { event: 'PostToolUse',      matcher: PERMISSION_TOOLS, command: projectCmd('red') },
    { event: 'PermissionRequest', command: stateCmd('yellow') },
    { event: 'PermissionRequest', command: projectCmd('yellow') },
    { event: 'SessionEnd',       command: sessionEndCmd() },
  ]

  // Clean ALL events that might contain old traffic light hooks
  const ALL_HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse',
    'SessionStart', 'SessionEnd', 'StopFailure', 'PermissionRequest', 'Elicitation']

  let settings = {}
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      settings = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    }
  } catch { settings = {} }

  if (!settings.hooks) settings.hooks = {}

  let changed = false
  for (const event of ALL_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) continue
    const before = settings.hooks[event].length
    settings.hooks[event] = settings.hooks[event].filter(h => {
      if (!Array.isArray(h.hooks)) return true
      return !h.hooks.some(hh =>
        typeof hh.command === 'string' && (
          hh.command.includes('cc_traffic_light_state') ||
          hh.command.includes('traffic_light_app') ||
          hh.command.includes('.state') ||
          hh.command.includes('traffic_light')
        )
      )
    })
    if (settings.hooks[event].length !== before) changed = true
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }

  for (const { event, matcher, command } of HOOKS_TO_ADD) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
    const entry = { hooks: [{ type: 'command', command }] }
    if (matcher) entry.matcher = matcher
    settings.hooks[event].push(entry)
    changed = true
  }

  if (changed) {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf-8')
    } catch {}
  }
}

// ---------- Menu builders ----------

let mainWin = null
let tray = null
let settingsWin = null

function buildAppMenu(currentTheme) {
  return Menu.buildFromTemplate([
    {
      label: 'CC 红绿灯',
      submenu: [
        { label: '关于 CC 红绿灯', role: 'about' },
        { type: 'separator' },
        {
          label: currentTheme === 'dark' ? '切换浅色模式' : '切换深色模式',
          click: () => {
            const next = currentTheme === 'dark' ? 'light' : 'dark'
            try { fs.writeFileSync(THEME_FILE, next) } catch {}
            if (mainWin) mainWin.webContents.send('theme-change', next)
            Menu.setApplicationMenu(buildAppMenu(next))
            if (tray) tray.setContextMenu(buildTrayMenu(next, readStyle()))
          }
        },
        { type: 'separator' },
        { label: '隐藏', role: 'hide' },
        { label: '退出', accelerator: 'Cmd+Q', click: () => app.quit() }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { type: 'separator' },
        { label: '退出', accelerator: 'Cmd+Q', click: () => app.quit() }
      ]
    }
  ])
}

function buildTrayMenu(currentTheme, currentStyle, selectedProject) {
  const isSingle = currentStyle === 'single'
  const projects = listActiveProjects()
  const currentProject = selectedProject || getSelectedProject()

  const items = []

  // 模型供应商切换（复刻 cc-switch 的托盘快捷切换；只显示已配置/置顶/官方/当前的）
  const allProviders = providers.getProviders()
  const currentProviderId = providers.getCurrentProviderId()
  const visibleProviders = allProviders.filter(p => providers.isProviderVisible(p, currentProviderId))
  if (visibleProviders.length > 0) {
    const modelSubmenu = visibleProviders.map(p => ({
      label: p.id === currentProviderId ? `● ${p.name}` : p.name,
      click: () => {
        try {
          providers.switchProvider(p.id)
          syncProviderFromClaudeConfig()
          refreshSelectedBalance()
        } catch (e) { console.error('[cc] tray switch failed:', e) }
        refreshTrayMenu()
      },
    }))
    items.push({ label: '🔀 切换模型', submenu: modelSubmenu })
    items.push({ type: 'separator' })
  }

  // Project selector as submenu
  if (projects.length > 0) {
    const projectSubmenu = projects.map(p => ({
      label: p === currentProject ? `● ${p}` : p,
      click: () => {
        setSelectedProject(p)
        if (tray) tray.setContextMenu(buildTrayMenu(currentTheme, currentStyle, p))
        if (mainWin) {
          mainWin.webContents.send('project-change', p)
          // Also send the new project's current state
          const stateFile = getStateFile(p)
          try {
            if (fs.existsSync(stateFile)) {
              const state = fs.readFileSync(stateFile, 'utf-8').trim()
              if (['red', 'yellow', 'green'].includes(state)) {
                mainWin.webContents.send('state-change', state, p)
              }
            }
          } catch {}
        }
      }
    }))
    items.push({ label: '📁 选择项目', submenu: projectSubmenu })
    items.push({ type: 'separator' })
  }

  items.push(
    {
      label: isSingle ? '切换到三灯样式' : '切换到单灯样式',
      click: () => {
        const next = isSingle ? 'triple' : 'single'
        try { fs.writeFileSync(STYLE_FILE, next) } catch {}
        if (mainWin) mainWin.webContents.send('style-change', next)
        if (tray) tray.setContextMenu(buildTrayMenu(currentTheme, next, currentProject))
      }
    },
    { type: 'separator' },
    {
      label: currentTheme === 'dark' ? '切换浅色模式' : '切换深色模式',
      click: () => {
        const next = currentTheme === 'dark' ? 'light' : 'dark'
        try { fs.writeFileSync(THEME_FILE, next) } catch {}
        if (mainWin) mainWin.webContents.send('theme-change', next)
        if (tray) tray.setContextMenu(buildTrayMenu(next, currentStyle, currentProject))
        Menu.setApplicationMenu(buildAppMenu(next))
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  )

  return Menu.buildFromTemplate(items)
}

// 用当前 theme/style/project 重建托盘菜单（供应商变更后调用）
function refreshTrayMenu() {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu(readTheme(), readStyle(), getSelectedProject()))
}

// ---------- Settings window ----------

function openSettingsWindow() {
  if (settingsWin) {
    settingsWin.focus()
    return
  }

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const w = 420, h = 620

  settingsWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((sw - w) / 2),
    y: Math.round((sh - h) / 2),
    title: 'AI 模型设置',
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#1c1c1e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  })

  settingsWin.loadFile(path.join(__dirname, 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
}

// ---------- Window creation ----------

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  let wx = sw - 120, wy = 80
  try {
    if (fs.existsSync(POS_FILE)) {
      const [px, py] = fs.readFileSync(POS_FILE, 'utf-8').split(',').map(Number)
      if (px >= 0 && px < sw - 20 && py >= 0 && py < sh - 20) { wx = px; wy = py }
    }
  } catch {}

  mainWin = new BrowserWindow({
    width: 100,
    height: 220,
    x: wx,
    y: wy,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWin.setAlwaysOnTop(true, 'floating')
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (isDev) {
    mainWin.loadURL('http://localhost:5173')
  } else {
    mainWin.loadFile(distPath)
  }

  let lastState = ''
  let selectedProject = getSelectedProject()
  const projectStates = {}  // { projectName: lastKnownState }

  // Poll ALL project state files — auto-switch to whichever changed
  const poll = setInterval(() => {
    try {
      const projects = listActiveProjects()

      for (const p of projects) {
        const stateFile = getStateFile(p)
        if (!fs.existsSync(stateFile)) continue
        const state = fs.readFileSync(stateFile, 'utf-8').trim()
        if (!['red', 'yellow', 'green'].includes(state)) continue

        const prevState = projectStates[p]
        if (state !== prevState) {
          projectStates[p] = state
          // Auto-switch to the project that changed
          selectedProject = p
          setSelectedProject(p)
          lastState = state
          mainWin.webContents.send('state-change', state, p)
          mainWin.webContents.send('project-change', p)
          // Refresh tray menu
          const theme = readTheme()
          const style = readStyle()
          if (tray) tray.setContextMenu(buildTrayMenu(theme, style, p))
          break  // One change per poll tick is enough
        }
      }
    } catch {}
  }, 300)

  // Poll project list changes for tray menu refresh
  let lastProjectList = listActiveProjects().join(',')
  const projectPoll = setInterval(() => {
    try {
      const currentList = listActiveProjects().join(',')
      if (currentList !== lastProjectList) {
        lastProjectList = currentList
        const theme = readTheme()
        const style = readStyle()
        const sp = getSelectedProject()
        if (tray) tray.setContextMenu(buildTrayMenu(theme, style, sp))
        if (mainWin) mainWin.webContents.send('project-change', sp)
      }
    } catch {}
  }, 2000)

  mainWin.on('closed', () => { clearInterval(poll); clearInterval(projectPoll); clearInterval(balancePoll); mainWin = null; if (!settingsWin) app.quit() })
  mainWin.on('moved', () => {
    try {
      const [x, y] = mainWin.getPosition()
      fs.writeFileSync(POS_FILE, `${x},${y}`)
    } catch {}
  })

  // IPC handlers
  ipcMain.on('set-state', (_, state) => {
    try {
      const stateFile = getStateFile(getSelectedProject())
      fs.writeFileSync(stateFile, state)
      lastState = state
    } catch {}
  })

  ipcMain.on('focus-app', () => {
    activateHostApp(getSelectedProject())
  })

  ipcMain.on('activate-host', () => {
    const project = getSelectedProject()
    activateHostApp(project)
  })

  ipcMain.on('quit', () => app.quit())

  ipcMain.handle('get-theme', () => readTheme())

  ipcMain.handle('get-mute', () => readMute())

  ipcMain.on('set-mute', (_, muted) => {
    try { fs.writeFileSync(MUTE_FILE, muted ? 'true' : 'false') } catch {}
  })

  ipcMain.on('set-window-height', (_, h) => {
    if (mainWin) mainWin.setSize(100, h)
  })

  ipcMain.on('set-theme', (_, theme) => {
    try { fs.writeFileSync(THEME_FILE, theme) } catch {}
    if (tray) tray.setContextMenu(buildTrayMenu(theme, readStyle(), getSelectedProject()))
    Menu.setApplicationMenu(buildAppMenu(theme))
  })

  ipcMain.handle('get-style', () => readStyle())

  ipcMain.on('set-style', (_, style) => {
    try { fs.writeFileSync(STYLE_FILE, style) } catch {}
    if (tray) tray.setContextMenu(buildTrayMenu(readTheme(), style, getSelectedProject()))
  })

  ipcMain.handle('get-projects', () => listActiveProjects())

  ipcMain.handle('get-selected-project', () => getSelectedProject())

  ipcMain.on('select-project', (_, name) => {
    setSelectedProject(name)
  })

  // Balance IPC
  ipcMain.handle('get-balance', () => lastBalance)

  ipcMain.on('refresh-balance', () => {
    refreshSelectedBalance()
  })

  ipcMain.on('set-api-key', (_, provider, key) => {
    const keys = readApiKeys()
    if (key) {
      keys[provider] = key
      // 互斥: 启用 deepseek 切换到 deepseek
      if (provider === 'deepseek') keys.selected_provider = 'deepseek'
    } else {
      delete keys[provider]
      if (keys.selected_provider === provider) {
        keys.selected_provider = keys.volcengine?.accessKeyId ? 'volcengine' : null
      }
    }
    writeApiKeys(keys)
    refreshSelectedBalance()
  })

  ipcMain.handle('get-api-key', (_, provider) => getApiKey(provider))

  ipcMain.handle('get-volc-credentials', () => getVolcCredentials())

  ipcMain.on('set-volc-credentials', (_, ak, sk) => {
    setVolcCredentials(ak, sk)
    refreshSelectedBalance()
  })

  ipcMain.handle('get-selected-provider', () => getSelectedProvider())

  ipcMain.on('select-provider', (_, p) => {
    setSelectedProvider(p)
    refreshSelectedBalance()
  })

  ipcMain.handle('get-budget', (_, provider) => {
    const keys = readApiKeys()
    const budgets = keys._budgets || {}
    return budgets[provider] || null
  })

  ipcMain.on('set-budget', (_, provider, amount) => {
    try {
      const keys = readApiKeys()
      if (!keys._budgets) keys._budgets = {}
      if (amount > 0) {
        keys._budgets[provider] = amount
      } else {
        delete keys._budgets[provider]
      }
      writeApiKeys(keys)
      console.log('[balance] budget saved:', provider, amount, '->', API_KEYS_FILE)
      // Re-fetch to update the main window ring
      transmitBalance()
      return true
    } catch (e) {
      console.error('[balance] budget save failed:', e)
      return false
    }
  })

  // Fetch balance on startup and every hour
  refreshSelectedBalance()
  const balancePoll = setInterval(refreshSelectedBalance, 3600 * 1000)

  ipcMain.handle('read-clipboard', () => {
    try { return clipboard.readText() } catch { return '' }
  })

  ipcMain.on('open-settings', () => {
    openSettingsWindow()
  })

  // ---------- Claude 模型供应商切换（复刻 cc-switch 核心）----------

  ipcMain.handle('cc:get-providers', () => providers.getProviders())

  ipcMain.handle('cc:get-current-provider', () => providers.getCurrentProviderId())

  ipcMain.handle('cc:switch-provider', (_, id) => {
    try {
      const result = providers.switchProvider(id)
      // 切换后让余额环跟随新的 env.ANTHROPIC_BASE_URL
      syncProviderFromClaudeConfig()
      refreshSelectedBalance()
      refreshTrayMenu()
      if (settingsWin) settingsWin.webContents.send('cc:current-changed', result.current)
      if (mainWin) mainWin.webContents.send('cc:current-changed', result.current)
      return result
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('cc:save-provider', (_, provider) => {
    try {
      const saved = providers.saveProvider(provider)
      refreshTrayMenu()
      if (settingsWin) settingsWin.webContents.send('cc:providers-changed')
      return { ok: true, provider: saved }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('cc:delete-provider', (_, id) => {
    const removed = providers.deleteProvider(id)
    refreshTrayMenu()
    if (settingsWin) settingsWin.webContents.send('cc:providers-changed')
    return removed
  })

  ipcMain.handle('cc:get-live-settings', () => providers.readClaudeSettings())

  ipcMain.handle('cc:import-from-live', (_, name) => {
    try {
      const saved = providers.importFromLive(name)
      refreshTrayMenu()
      if (settingsWin) settingsWin.webContents.send('cc:providers-changed')
      return { ok: true, provider: saved }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
}

// ---------- Detect running Claude Code sessions ----------

function detectRunningSessions() {
  if (process.platform === 'win32') return
  try {
    // Find Claude Code processes and their working directories
    const result = child_process.execSync(
      `ps -eo pid,command | grep -i 'claude' | grep -v grep | grep -v traffic_light | head -20`,
      { encoding: 'utf-8', timeout: 3000 }
    )
    const lines = result.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const pid = line.trim().split(/\s+/)[0]
      try {
        // Get the cwd of each Claude process
        const cwd = child_process.execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1 | cut -c2-`, {
          encoding: 'utf-8', timeout: 2000
        }).trim()
        if (cwd && cwd !== '/' && !cwd.includes('Electron')) {
          const projectName = path.basename(cwd)
          const stateFile = getStateFile(projectName)
          const dirFile = path.join(STATE_DIR, `${projectName}.dir`)
          // Only create if not already exists
          if (!fs.existsSync(stateFile)) {
            fs.writeFileSync(stateFile, 'red')
            fs.writeFileSync(dirFile, cwd)
          }
        }
      } catch {}
    }
  } catch {}
}

// ---------- App lifecycle ----------

app.whenReady().then(() => {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }) } catch {}

  if (process.platform !== 'win32') {
    require('child_process').exec("pkill -f 'traffic_light.py'")
  }

  detectRunningSessions()
  setupClaudeHooks()
  providers.ensureDefaultProviders()

  try { fs.writeFileSync(PID_FILE, process.pid.toString()) } catch {}

  const theme = readTheme()
  const style = readStyle()
  const selectedProject = getSelectedProject()

  Menu.setApplicationMenu(buildAppMenu(theme))

  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 22, height: 22 })
  tray = new Tray(icon)
  tray.setToolTip('CC 红绿灯')
  tray.setContextMenu(buildTrayMenu(theme, style, selectedProject))

  createWindow()
})

app.on('will-quit', () => {
  try { fs.unlinkSync(PID_FILE) } catch {}
})

app.on('window-all-closed', () => app.quit())
