const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, clipboard, shell, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const child_process = require('child_process')
const https = require('https')
const http = require('http')
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
  // 统一走 provider 注册表（兼容旧 get-api-key 调用）
  return getProviderApiKey(provider)
}

function getVolcCredentials() {
  const cfg = getProviderConfig('volcengine')
  const ak = process.env.VOLC_AK || cfg.accessKeyId || ''
  const sk = process.env.VOLC_SK || cfg.secretAccessKey || ''
  return { accessKeyId: ak, secretAccessKey: sk }
}

function setVolcCredentials(ak, sk) {
  // 统一走 provider 注册表存储（互斥由 setProviderConfig 处理）
  setProviderConfig('volcengine', (ak && sk) ? { accessKeyId: ak, secretAccessKey: sk } : null)
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
  const valid = p === null || !!BALANCE_PROVIDERS[p] || !!CODING_PLAN_PROVIDERS[p] || p === 'volcengine'
  if (valid) {
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

let lastBalance = null  // { balance_infos: [...], ... } 或 { provider:'codingplan', quotas:[...] }

// ---------- Provider 注册表（参考 cc-switch）----------
// 金额类: GET + Bearer，parseBalance 返回 { balance_infos: [{ total_balance, currency }] }
// 百分比类: parseQuota 返回 { quotas: [{ level:'five_hour'|'weekly'|'monthly', percent, resetTimestamp }] }

function _num(v) {
  if (typeof v === 'number') return v || 0
  if (typeof v === 'string') { const n = parseFloat(v); return isNaN(n) ? 0 : n }
  return 0
}

// 统一 reset 时间为秒级时间戳（兼容 ISO 字符串 / 秒 / 毫秒；0 或负数视为无）
function _toResetSecs(v) {
  if (v == null) return null
  if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? null : Math.floor(t / 1000) }
  if (typeof v === 'number') { if (v <= 0) return null; return v < 1e12 ? v : Math.floor(v / 1000) }
  return null
}

const BALANCE_PROVIDERS = {
  deepseek:    { name: 'DeepSeek',   keyUrl: 'https://platform.deepseek.com/api_keys',    envVar: 'DEEPSEEK_API_KEY',    endpoint: 'https://api.deepseek.com/user/balance',      parseBalance: j => j.balance_infos ? j : { balance_infos: [] } },
  stepfun:     { name: '阶跃星辰',    keyUrl: 'https://platform.stepfun.com/interfacekey',  envVar: 'STEPFUN_API_KEY',     endpoint: 'https://api.stepfun.com/v1/accounts',         parseBalance: j => ({ balance_infos: [{ total_balance: _num(j.balance), currency: 'CNY' }] }) },
  siliconflow: { name: '硅基流动',    keyUrl: 'https://cloud.siliconflow.cn/account/ak',    envVar: 'SILICONFLOW_API_KEY', endpoint: 'https://api.siliconflow.cn/v1/user/info',     parseBalance: j => ({ balance_infos: [{ total_balance: _num(j.data && j.data.totalBalance), currency: 'CNY' }] }) },
  openrouter:  { name: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys',                 envVar: 'OPENROUTER_API_KEY',  endpoint: 'https://openrouter.ai/api/v1/credits',        parseBalance: j => { const d = j.data || {}; return { balance_infos: [{ total_balance: _num(d.total_credits) - _num(d.total_usage), currency: 'USD' }] } } },
  novita:      { name: 'Novita AI',  keyUrl: 'https://novita.ai/getKey',                   envVar: 'NOVITA_API_KEY',      endpoint: 'https://api.novita.ai/v3/user/balance',       parseBalance: j => ({ balance_infos: [{ total_balance: _num(j.availableBalance) / 10000, currency: 'USD' }] }) },
}

// Kimi: limits[].detail.{limit,remaining,resetTime}->5h; usage.{...}->weekly
function _parseKimi(j) {
  const quotas = []
  if (Array.isArray(j.limits)) {
    for (const it of j.limits) {
      const d = it.detail || {}
      const limit = _num(d.limit) || 1
      const used = Math.max(0, limit - _num(d.remaining))
      quotas.push({ level: 'five_hour', percent: limit > 0 ? (used / limit) * 100 : 0, resetTimestamp: _toResetSecs(d.resetTime) })
    }
  }
  if (j.usage) {
    const limit = _num(j.usage.limit) || 1
    const used = Math.max(0, limit - _num(j.usage.remaining))
    quotas.push({ level: 'weekly', percent: limit > 0 ? (used / limit) * 100 : 0, resetTimestamp: _toResetSecs(j.usage.resetTime) })
  }
  return { quotas }
}

// 智谱: data.limits[] 中 type=TOKENS_LIMIT, unit:3->5h, unit:6->weekly, percentage 即已用%
function _parseZhipu(j) {
  const data = j.data || {}
  const limits = Array.isArray(data.limits) ? data.limits : []
  let five = null, weekly = null
  const unclassified = []
  for (const it of limits) {
    if ((it.type || '').toLowerCase() !== 'tokens_limit') continue
    const entry = { percent: _num(it.percentage), resetTimestamp: _toResetSecs(it.nextResetTime) }
    if (it.unit === 3 && !five) five = { ...entry, level: 'five_hour' }
    else if (it.unit === 6 && !weekly) weekly = { ...entry, level: 'weekly' }
    else unclassified.push(entry)
  }
  // 兜底: unit 缺失时无 reset 的优先归 5h
  unclassified.sort((a, b) => (a.resetTimestamp == null ? 0 : 1) - (b.resetTimestamp == null ? 0 : 1))
  for (const e of unclassified) {
    if (!five) five = { ...e, level: 'five_hour' }
    else if (!weekly) weekly = { ...e, level: 'weekly' }
  }
  const quotas = []
  if (five) quotas.push(five)
  if (weekly) quotas.push(weekly)
  return { quotas }
}

// MiniMax: model_remains[general].current_interval_remaining_percent->5h(100-x); current_weekly_status==1 时周桶
function _parseMiniMax(j) {
  const quotas = []
  const remains = Array.isArray(j.model_remains) ? j.model_remains : []
  const item = remains.find(m => m.model_name === 'general')
  if (item) {
    if (item.current_interval_remaining_percent != null) {
      quotas.push({ level: 'five_hour', percent: 100 - _num(item.current_interval_remaining_percent), resetTimestamp: _toResetSecs(item.end_time) })
    }
    if (item.current_weekly_status === 1 && item.current_weekly_remaining_percent != null) {
      quotas.push({ level: 'weekly', percent: 100 - _num(item.current_weekly_remaining_percent), resetTimestamp: _toResetSecs(item.weekly_end_time) })
    }
  }
  return { quotas }
}

// ZenMux: data.quota_5_hour.usage_percentage*100->5h; quota_7_day.usage_percentage*100->weekly
function _parseZenMux(j) {
  const data = j.data || {}
  const quotas = []
  if (data.quota_5_hour) quotas.push({ level: 'five_hour', percent: _num(data.quota_5_hour.usage_percentage) * 100, resetTimestamp: _toResetSecs(data.quota_5_hour.resets_at) })
  if (data.quota_7_day) quotas.push({ level: 'weekly', percent: _num(data.quota_7_day.usage_percentage) * 100, resetTimestamp: _toResetSecs(data.quota_7_day.resets_at) })
  return { quotas }
}

const CODING_PLAN_PROVIDERS = {
  kimi:    { name: 'Kimi For Coding', keyUrl: 'https://platform.moonshot.cn/console/api-keys',                              envVar: 'KIMI_API_KEY',    endpoint: 'https://api.kimi.com/coding/v1/usages',                              parseQuota: _parseKimi },
  zhipu:   { name: '智谱 GLM',         keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',                                envVar: 'ZHIPU_API_KEY',   endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', authMode: 'raw', parseQuota: _parseZhipu },
  minimax: { name: 'MiniMax',          keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', envVar: 'MINIMAX_API_KEY', endpoint: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains', parseQuota: _parseMiniMax },
  zenmux:  { name: 'ZenMux',           keyUrl: 'https://zenmux.ai',                                                          envVar: 'ZENMUX_API_KEY',  needsBaseUrl: true,                                            parseQuota: _parseZenMux },
}

function isCodingPlanProvider(id) {
  return id === 'volcengine' || Object.prototype.hasOwnProperty.call(CODING_PLAN_PROVIDERS, id)
}

function providerMeta(id) {
  if (BALANCE_PROVIDERS[id]) return { ...BALANCE_PROVIDERS[id], kind: 'balance' }
  if (CODING_PLAN_PROVIDERS[id]) return { ...CODING_PLAN_PROVIDERS[id], kind: 'codingplan' }
  if (id === 'volcengine') return { name: '火山 Ark', kind: 'codingplan', needsAksk: true }
  return null
}

// ---------- Provider 配置存取（兼容旧 keys.deepseek / keys.volcengine）----------

function getProviderConfig(id) {
  const keys = readApiKeys()
  if (keys.providers && keys.providers[id]) return { ...keys.providers[id] }
  if (id === 'deepseek' && typeof keys.deepseek === 'string') return { apiKey: keys.deepseek }
  if (id === 'volcengine' && keys.volcengine) return { ...keys.volcengine }
  return {}
}

function getProviderApiKey(id) {
  const meta = BALANCE_PROVIDERS[id] || CODING_PLAN_PROVIDERS[id]
  if (meta && meta.envVar && process.env[meta.envVar]) return process.env[meta.envVar]
  const cfg = getProviderConfig(id)
  return cfg.apiKey || ''
}

function setProviderConfig(id, cfg) {
  const keys = readApiKeys()
  if (!keys.providers) keys.providers = {}
  if (cfg && Object.keys(cfg).length) keys.providers[id] = cfg
  else delete keys.providers[id]
  // 互斥: 有有效凭证则选中此 provider
  const hasCred = cfg && (cfg.apiKey || (cfg.accessKeyId && cfg.secretAccessKey) || cfg.baseUrl)
  if (hasCred) keys.selected_provider = id
  else if (keys.selected_provider === id) keys.selected_provider = null
  writeApiKeys(keys)
}

// ---------- 通用 HTTP GET (JSON) ----------

function _httpGetJSON(url, headers, cb) {
  let u
  try { u = new URL(url) } catch (e) { cb({ _error: 'URL 无效: ' + e.message }); return }
  const options = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: headers || {}, timeout: 15000 }
  const req = https.request(options, (res) => {
    let data = ''
    res.on('data', c => { data += c })
    res.on('end', () => {
      if (res.statusCode === 401 || res.statusCode === 403) { cb({ _error: `鉴权失败 (HTTP ${res.statusCode})` }); return }
      if (res.statusCode < 200 || res.statusCode >= 300) { cb({ _error: `API 错误 (HTTP ${res.statusCode}): ${data.slice(0, 200)}` }); return }
      try { cb({ json: JSON.parse(data) }) } catch { cb({ _error: '解析响应失败' }) }
    })
  })
  req.on('error', e => cb({ _error: e.message }))
  req.on('timeout', () => { req.destroy(); cb({ _error: '请求超时' }) })
  req.end()
}

function fetchBalanceProvider(id) {
  const meta = BALANCE_PROVIDERS[id]
  if (!meta) { lastBalance = { error: '未知供应商: ' + id }; transmitBalance(); return }
  const apiKey = getProviderApiKey(id)
  if (!apiKey) { lastBalance = { error: '未配置 API Key' }; transmitBalance(); return }
  _httpGetJSON(meta.endpoint, { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }, (r) => {
    if (r._error) { lastBalance = { error: r._error }; transmitBalance(); return }
    try {
      const parsed = meta.parseBalance(r.json)
      if (!parsed || !parsed.balance_infos) { lastBalance = { error: '未知响应格式' }; transmitBalance(); return }
      lastBalance = parsed
      transmitBalance()
    } catch (e) { lastBalance = { error: '解析失败: ' + e.message }; transmitBalance() }
  })
}

function fetchCodingPlanProvider(id) {
  const meta = CODING_PLAN_PROVIDERS[id]
  if (!meta) { lastBalance = { provider: 'codingplan', error: '未知供应商: ' + id }; transmitBalance(); return }
  const apiKey = getProviderApiKey(id)
  if (!apiKey) { lastBalance = { provider: 'codingplan', error: '未配置 API Key' }; transmitBalance(); return }
  const cfg = getProviderConfig(id)
  const url = meta.needsBaseUrl ? cfg.baseUrl : meta.endpoint
  if (!url) { lastBalance = { provider: 'codingplan', error: '未配置 Base URL' }; transmitBalance(); return }
  const headers = { 'Accept': 'application/json' }
  headers['Authorization'] = meta.authMode === 'raw' ? apiKey : `Bearer ${apiKey}`
  if (meta.authMode === 'raw') headers['Content-Type'] = 'application/json'
  _httpGetJSON(url, headers, (r) => {
    if (r._error) { lastBalance = { provider: 'codingplan', error: r._error }; transmitBalance(); return }
    const j = r.json
    // 业务级错误检查
    if (id === 'zhipu' && j.success === false) { lastBalance = { provider: 'codingplan', error: 'API 错误: ' + (j.msg || '未知') }; transmitBalance(); return }
    if (id === 'minimax' && j.base_resp && j.base_resp.status_code !== 0) { lastBalance = { provider: 'codingplan', error: `API 错误 (code ${j.base_resp.status_code}): ${j.base_resp.status_msg || ''}` }; transmitBalance(); return }
    if (id === 'zenmux' && j.success !== true) { lastBalance = { provider: 'codingplan', error: 'API 错误: ' + (j.message || '未知') }; transmitBalance(); return }
    try {
      const result = meta.parseQuota(j)
      const quotas = (result.quotas || []).filter(q => q.percent != null)
      if (!quotas.length) { lastBalance = { provider: 'codingplan', error: '暂无用量数据' }; transmitBalance(); return }
      lastBalance = { provider: 'codingplan', quotas }
      transmitBalance()
    } catch (e) { lastBalance = { provider: 'codingplan', error: '解析失败: ' + e.message }; transmitBalance() }
  })
}

// ---------- 手机推送（Bark）----------
// MVP: 仅黄灯（Claude 等你确认）时推一条到手机。手表靠镜像手机通知，不单独做。
// 官方服务器 https://api.day.app/{key}，零依赖（内置 https）。

function getBarkConfig() {
  const keys = readApiKeys()
  const b = keys._bark || {}
  return {
    key: b.key || '',
    server: b.server || 'https://api.day.app',  // 默认官方，可自建
    enabled: !!b.key,
  }
}

function setBarkConfig(cfg) {
  const keys = readApiKeys()
  if (!keys._bark) keys._bark = {}
  if (cfg && cfg.key) {
    keys._bark.key = cfg.key.trim()
    keys._bark.server = (cfg.server || '').trim() || 'https://api.day.app'
  } else {
    keys._bark = {}
  }
  writeApiKeys(keys)
  syncRemoteApproveFlag()  // Bark Key 有无 -> 同步 hook 自动批准标记
  startRemoteServer()      // 确保控制页服务可用
}

// ---------- 手机推送（ntfy，安卓）----------
// ntfy: 开源跨平台推送，安卓用。POST {server}/{topic}，Title/Click headers。
function getNtfyConfig() {
  const keys = readApiKeys()
  const n = keys._ntfy || {}
  return {
    topic: n.topic || '',
    server: n.server || 'https://ntfy.sh',  // 默认官方，可自建
    enabled: !!n.topic,
  }
}

function setNtfyConfig(cfg) {
  const keys = readApiKeys()
  if (!keys._ntfy) keys._ntfy = {}
  if (cfg && cfg.topic) {
    keys._ntfy.topic = cfg.topic.trim()
    keys._ntfy.server = (cfg.server || '').trim() || 'https://ntfy.sh'
  } else {
    keys._ntfy = {}
  }
  writeApiKeys(keys)
  syncRemoteApproveFlag()  // ntfy Topic 有无 -> 同步 hook 自动批准标记
  startRemoteServer()
}

// 已为某项目推过黄灯，避免重复推。状态离开 yellow 后清除，下次再亮黄灯才再推。
let barkNotifiedProject = null
// 当前黄灯项目（供手机控制页展示 + 回传时定位窗口）
let currentYellowProject = null
// 当前黄灯的确认内容（hook_capture.cjs 写入 .prompt 文件，这里读取）
let currentPrompt = ''
// 当前黄灯的待确认请求（hook_capture.cjs 写入 .pending：{id,type,tool,prompt,ts}）
// type=permission -> 滑动写 .approved 信号让 hook 返回 allow/deny；type=question -> 走注入
let currentYellowRequest = null

function readPromptForProject(project) {
  if (!project) return ''
  try {
    const f = path.join(STATE_DIR, `${project}.prompt`)
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8').trim()
  } catch {}
  return ''
}

// 读 .pending 信号 -> {id,type,tool,prompt,ts}；hook_capture.cjs 在 PermissionRequest/AskUserQuestion 时写
function readPendingRequest(project) {
  if (!project) return null
  try {
    const f = path.join(STATE_DIR, `${project}.pending`)
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf-8'))
      if (obj && obj.id) return obj
    }
  } catch {}
  return null
}

// 写 .approved 信号：hook_capture.cjs 轮询到匹配 id 后返回 allow/deny 给 Claude
function writeApproved(project, id, behavior) {
  if (!project || !id) return
  try {
    fs.writeFileSync(path.join(STATE_DIR, `${project}.approved`), JSON.stringify({ id, behavior }), 'utf-8')
  } catch {}
}

function sendBarkNotification(title, body, openUrl) {
  const { key, server } = getBarkConfig()
  if (!key) return
  // Bark: GET {server}/{key}/{title}/{body}?...，路径段需 encodeURIComponent
  let qs = 'isArchive=1&group=Claude+Code'
  if (openUrl) qs += '&url=' + encodeURIComponent(openUrl)  // 点通知打开此 URL（手机控制页）
  const url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${qs}`
  try {
    const u = new URL(url)
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'Accept': 'application/json' }, timeout: 10000 }, (res) => {
      res.resume()
    }).on('error', (e) => console.error('[bark] push failed:', e.message))
  } catch (e) { console.error('[bark] url error:', e.message) }
}

// ntfy 推送（安卓）：POST {server}/{topic}，Title/Click headers。点通知打开控制页
function sendNtfyNotification(title, body, openUrl) {
  const { topic, server } = getNtfyConfig()
  if (!topic) return
  const url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`
  try {
    const u = new URL(url)
    const headers = { 'Title': title, 'Tags': 'warning,orange_circle' }
    if (openUrl) headers['Click'] = openUrl  // 点通知打开此 URL（手机控制页）
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers, timeout: 10000 }, (res) => { res.resume() })
    req.on('error', (e) => console.error('[ntfy] push failed:', e.message))
    req.write(body)
    req.end()
  } catch (e) { console.error('[ntfy] url error:', e.message) }
}

// 状态变化钩子：黄灯 -> 推送（带项目名 + 回传控制页 URL）；其它状态清除已推标记。
function onTrafficStateChange(state, project) {
  if (state === 'yellow') {
    currentYellowProject = project
    currentPrompt = readPromptForProject(project)
    currentYellowRequest = readPendingRequest(project)
    // hook 写 .state 后才写 .pending，有微小时序差；稍后重读兜底
    setTimeout(() => {
      if (currentYellowProject === project && (!currentYellowRequest || !currentYellowRequest.id)) {
        currentYellowRequest = readPendingRequest(project)
      }
    }, 250)
    if (barkNotifiedProject !== project) {
      barkNotifiedProject = project
      const p = project || 'Claude Code'
      const body = currentPrompt ? `${p}：${currentPrompt}`.slice(0, 80) : `${p} 需要你回来操作`
      const ctlUrl = getRemoteControlUrl()
      sendBarkNotification('🟡 Claude Code 等你确认', body, ctlUrl)
      sendNtfyNotification('🟡 Claude Code 等你确认', body, ctlUrl)
    }
  } else {
    // 离开黄灯（变红/绿），清除标记，下次黄灯可再推
    barkNotifiedProject = null
    currentYellowProject = null
    currentPrompt = ''
    currentYellowRequest = null
  }
}

// ---------- 手机回传控制（局域网）----------
// 本地 HTTP 服务：手机点推送通知 -> 打开 http://局域网IP:port/?t=token 控制页 ->
// 点按钮 -> POST /respond -> activateHostApp(项目) 把窗口置顶 + 敲键回应 Claude Code。
// 复用现有 activateHostApp 的跨平台窗口定位能力，只加「往激活窗口敲键」。

const REMOTE_PORT = 37271
const REMOTE_TOKEN_FILE = path.join(STATE_DIR, 'remote_token')
// 「Hook 自动批准」开关标记：存在=开启。hook_capture.cjs 启动时检查，不存在则立即放行不阻塞
const REMOTE_APPROVE_ENABLED_FILE = path.join(STATE_DIR, 'remote_approve.enabled')
// token 落盘：重启后保持不变，外部脚本也能读到发推送
function readOrCreateRemoteToken() {
  try {
    if (fs.existsSync(REMOTE_TOKEN_FILE)) {
      const t = fs.readFileSync(REMOTE_TOKEN_FILE, 'utf-8').trim()
      if (/^[a-z0-9]{6,16}$/i.test(t)) return t
    }
  } catch {}
  const t = Math.random().toString(36).slice(2, 10)
  try { fs.writeFileSync(REMOTE_TOKEN_FILE, t, 'utf-8') } catch {}
  return t
}
const remoteToken = readOrCreateRemoteToken()
let remoteLanIp = ''
let remoteServer = null

function discoverLanIp() {
  try {
    const ifaces = os.networkInterfaces()
    for (const name of Object.keys(ifaces)) {
      for (const it of ifaces[name]) {
        if (it.family === 'IPv4' && !it.internal) return it.address
      }
    }
  } catch {}
  return ''
}

function getRemoteControlUrl() {
  if (!remoteLanIp) return ''
  return `http://${remoteLanIp}:${REMOTE_PORT}/?t=${remoteToken}`
}

function getRemoteStatus() {
  return { url: getRemoteControlUrl(), running: !!remoteServer, port: REMOTE_PORT, approve: isRemoteApproveEnabled() }
}

function isRemoteApproveEnabled() {
  try { return fs.existsSync(REMOTE_APPROVE_ENABLED_FILE) } catch { return false }
}

// 同步「Hook 自动批准」标记：有 Bark Key = 开启（写标记）；无 = 关闭（删标记）
// hook_capture.cjs 检查此标记决定是否阻塞等滑动。配了 Bark = 要远程确认 = 自动启用
function syncRemoteApproveFlag() {
  try {
    const { key: barkKey } = getBarkConfig()
    const { topic: ntfyTopic } = getNtfyConfig()
    if (barkKey || ntfyTopic) {  // 配了 Bark 或 ntfy 任一 -> 启用 hook 自动批准
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(REMOTE_APPROVE_ENABLED_FILE, '1')
    } else {
      try { fs.unlinkSync(REMOTE_APPROVE_ENABLED_FILE) } catch {}
    }
  } catch {}
}

// 敲键注入：mac 用 System Events keystroke（需辅助功能权限，与窗口激活同权限）；
// win 用 WScript.Shell.SendKeys 发给前台窗口。action: enter|yes|no|text
function injectKeystrokes(action, text) {
  if (process.platform === 'darwin') {
    // keystroke 对非 ASCII（中文）不稳，改用剪贴板粘贴
    if (action === 'text' && text && /[^\x00-\x7F]/.test(text)) {
      const clip = escAppleScript(text)
      const script = `set the clipboard to "${clip}"\ntell application "System Events" to keystroke "v" using command down\ndelay 0.15\ntell application "System Events" to keystroke return`
      try { child_process.execFileSync('osascript', ['-e', script], { timeout: 3000 }) } catch (e) { console.error('[remote] mac paste failed:', e.message) }
      return
    }
    // ASCII 路径：keystroke 单字符 + return（注意 return 不加引号才是回车键）
    let script
    if (action === 'enter') {
      script = `tell application "System Events" to keystroke return`
    } else if (action === 'yes' || action === 'no') {
      const ch = action === 'yes' ? 'y' : 'n'
      script = `tell application "System Events" to keystroke "${ch}"\ndelay 0.05\ntell application "System Events" to keystroke return`
    } else if (action === 'text' && text) {
      const k = escAppleScript(text)
      script = `tell application "System Events" to keystroke "${k}"\ndelay 0.05\ntell application "System Events" to keystroke return`
    } else return
    try { child_process.execFileSync('osascript', ['-e', script], { timeout: 3000 }) } catch (e) { console.error('[remote] mac keystroke failed:', e.message) }
  } else if (process.platform === 'win32') {
    // SendKeys: ~ = Enter；多字节用剪贴板
    if (action === 'text' && text && /[^\x00-\x7F]/.test(text)) {
      const clip = text.replace(/'/g, "''")
      const paste = `$w = New-Object -ComObject WScript.Shell; Set-Clipboard -Value '${clip}'; Start-Sleep -Milliseconds 50; $w.SendKeys('^v'); Start-Sleep -Milliseconds 100; $w.SendKeys('~')`
      try { child_process.execFileSync('powershell', ['-NoProfile', '-Command', paste], { encoding: 'utf-8', timeout: 5000 }) } catch (e) { console.error('[remote] win paste failed:', e.message) }
      return
    }
    let send
    if (action === 'enter') send = '~'
    else if (action === 'yes') send = 'y~'
    else if (action === 'no') send = 'n~'
    else if (action === 'text' && text) send = text.replace(/[{}^%~+()]/g, '{$&}') + '~'  // 转义 SendKeys 特殊字符
    else return
    const script = `$w = New-Object -ComObject WScript.Shell; $w.SendKeys('${send.replace(/'/g, "''")}')`
    try { child_process.execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf-8', timeout: 5000 }) } catch (e) { console.error('[remote] win keystroke failed:', e.message) }
  }
}

// 处理手机回传：权限请求 -> 写 .approved 信号让 hook 返回 allow/deny；AskUserQuestion -> 激活窗口+敲键
function handleRemoteRespond(project, action, text) {
  const target = project || currentYellowProject
  if (action === 'focus') {
    // 点卡片：只切到电脑对应窗口，不敲键
    if (target) activateHostApp(target)
    return
  }
  // 权限请求：写 .approved 信号，hook_capture.cjs 轮询到后返回 allow/deny 给 Claude（不碰控制台）
  let req = currentYellowRequest
  if (!req || !req.id) req = readPendingRequest(target)  // 兜底：pending 晚到
  if (req && req.type === 'permission') {
    const behavior = (action === 'no' || action === 'deny') ? 'deny' : 'allow'
    writeApproved(target, req.id, behavior)
    return
  }
  // AskUserQuestion / 其它：激活窗口 + 敲键注入（无 hook 能替用户回答问题，保持现状）
  if (target) activateHostApp(target)
  // 窗口置顶需要一点时间（mac osascript 内含 delay 0.4），稍候再敲键
  const keyAction = (action === 'approve') ? 'enter' : action  // approve/enter 统一当回车（提交默认）
  setTimeout(() => injectKeystrokes(keyAction, text), process.platform === 'darwin' ? 500 : 300)
}

function remoteControlPage() {
  const rawProj = currentYellowProject || ''
  const proj = rawProj ? escHtml(rawProj) : ''
  const prompt = currentPrompt ? escHtml(currentPrompt) : ''
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><title>Claude Code 等你确认</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden}
body{
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;
  background:
    radial-gradient(circle at 80% 70%,rgba(124,255,199,.30),transparent 35%),
    radial-gradient(circle at 20% 80%,rgba(255,180,220,.16),transparent 35%),
    radial-gradient(circle at 60% 20%,rgba(88,160,255,.22),transparent 40%),
    linear-gradient(180deg,#0b1630,#14253f 45%,#182c44);
  background-attachment:fixed;
  color:#fff;height:100vh;height:100dvh;
  display:flex;flex-direction:column;align-items:center;
  padding:calc(env(safe-area-inset-top) + 14px) 20px calc(env(safe-area-inset-bottom) + 20px);
}
/* 顶部区 + 中间卡片区：靠上分布，不垂直居中（避免顶部太空） */
.main{flex:1 1 auto;width:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;min-height:0;overflow:hidden;padding-top:8px}
/* 项目名为主（大），Claude Code 为辅（小） */
h1{font-size:15px;font-weight:600;text-align:center;color:#d8e4ff;letter-spacing:.3px;margin-bottom:6px}
.proj{font-size:26px;font-weight:700;text-align:center;word-break:break-all;line-height:1.2}
.wait{text-align:center;color:#d8e4ff;margin:18px 0 18px;font-size:16px}
/* 玻璃卡片（可点击：点 = 切到电脑对应窗口） */
.card{
  width:100%;max-width:340px;padding:20px;border-radius:24px;cursor:pointer;
  background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);
  backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 20px 50px rgba(0,0,0,.18);
  transition:transform .15s,background .15s;
}
.card:active{transform:scale(0.97);background:rgba(255,255,255,.16)}
.title{color:#fff;font-weight:700;font-size:15px}
.cmd{margin:12px 0;color:#fff;font-size:16px;font-weight:300;word-break:break-all;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;line-height:1.4}
/* 更多操作 */
.more-toggle{margin-top:14px;color:#d8e4ff;font-size:13px;cursor:pointer;opacity:.7;text-decoration:underline}
.more-toggle:active{opacity:1}
.more{display:none;width:100%;max-width:340px;margin-top:14px;max-height:40vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
.more.show{display:block;animation:up .25s ease}
@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.more .btn{display:block;width:100%;padding:15px;border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px}
.b-yes{background:rgba(0,122,255,.9);color:#fff}
.b-no{background:rgba(255,69,58,.9);color:#fff}
input{width:100%;padding:14px;border-radius:14px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#fff;font-size:16px;margin-bottom:10px;outline:none}
input::placeholder{color:rgba(255,255,255,.4)}
input:focus{border-color:#7cffc7}
.b-send{background:rgba(48,209,88,.9);color:#fff}
/* 底部 Decline + 滑动批准 */
.bottom{width:100%;max-width:340px;flex-shrink:0;padding-top:16px}
.decline{text-align:center;color:#fff;font-weight:600;margin-bottom:14px;cursor:pointer;padding:8px;opacity:.85}
.slider{
  height:76px;border-radius:38px;background:#0b1630;
  position:relative;overflow:hidden;padding:4px;touch-action:none;
}
/* 光带层：conic 铺满整个 slider 并旋转 */
.slider::before{
  content:'';position:absolute;inset:0;z-index:0;pointer-events:none;
  background:conic-gradient(from 0deg,transparent 0deg,rgba(126,255,92,0) 240deg,rgba(126,255,92,.9) 320deg,rgba(126,255,92,0) 360deg);
  animation:flow 3s linear infinite;
}
@keyframes flow{to{transform:rotate(360deg)}}
/* 内层轨道：绝对不透明，盖死中间光带，只留 4px 边框光环 */
.track{position:relative;height:100%;border-radius:34px;background:#14253f;z-index:1;overflow:hidden}
.slider.done{background:rgba(126,255,92,.9)}
.slider.done::before{display:none}
/* 滑动成功后半透明绿色光环呼吸 */
.slider.done-glow{box-shadow:0 0 0 0 rgba(126,255,92,.6);animation:doneGlow 1.6s ease-out}
@keyframes doneGlow{
  0%{box-shadow:0 0 0 0 rgba(126,255,92,.6),0 0 30px 0 rgba(126,255,92,.5)}
  100%{box-shadow:0 0 0 24px rgba(126,255,92,0),0 0 30px 0 rgba(126,255,92,0)}
}
.knob{position:absolute;left:4px;top:4px;width:64px;height:64px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;color:#0b1630;z-index:3;box-shadow:0 6px 16px rgba(0,0,0,.25)}
.lbl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;z-index:2;font-size:16px}
.slider.done .lbl{color:#0b1630}
.slider.done .knob{display:none}
/* 发送成功遮罩 */
.sent{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;flex-direction:column;align-items:center;justify-content:center;z-index:9;backdrop-filter:blur(8px)}
.sent.show{display:flex}
.sent .ok{width:88px;height:88px;border-radius:50%;background:rgba(126,255,92,.95);display:flex;align-items:center;justify-content:center;font-size:42px;color:#0b1630;margin-bottom:18px;animation:pop .3s ease}
@keyframes pop{from{transform:scale(0)}to{transform:scale(1)}}
.sent p{font-size:18px;color:#fff;font-weight:600}
</style></head><body>
<div class="main">
  <h1>Claude Code</h1>
  ${proj ? `<div class="proj">${proj}</div>` : ''}
  <div class="wait">等你确认</div>
  <div class="card" onclick="respond('focus')">
    <div class="title">权限请求</div>
    <div class="cmd">${prompt || 'Claude 需要你回来操作'}</div>
  </div>
  <div class="more-toggle" onclick="toggle()">其他回应</div>
  <div class="more" id="more">
    <button class="btn b-yes" onclick="respond('yes')">✓ 同意 (y)</button>
    <input id="txt" placeholder="输入文字后发送（回车）">
    <button class="btn b-send" onclick="respond('text')">发送文字</button>
  </div>
</div>
<div class="bottom">
  <div class="decline" onclick="respond('no')">拒绝</div>
  <div class="slider" id="slider">
    <div class="track">
      <div class="knob" id="knob">›</div>
      <div class="lbl">滑动批准</div>
    </div>
  </div>
</div>
<div class="sent" id="sent"><div class="ok">✓</div><p id="sentTxt">已发送</p></div>
<script>
function toggle(){var m=document.getElementById('more');m.classList.toggle('show');}
function respond(action){
  var text=action==='text'?document.getElementById('txt').value:'';
  fetch('/respond?t=${remoteToken}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,text:text})})
   .then(function(r){return r.json()})
   .then(function(d){showSent(d.ok?(action==='focus'?'已切到电脑':'已发送'):'操作失败');})
   .catch(function(){showSent('网络错误');});
}
function showSent(t){var s=document.getElementById('sent');document.getElementById('sentTxt').textContent=t;s.classList.add('show');}
// 滑动批准：拖到 70% 触发回车
(function(){
  var slider=document.getElementById('slider'),knob=slider.querySelector('.knob');
  var maxLeft=0,dragging=false,startX=0,startLeft=4;
  function measure(){maxLeft=slider.offsetWidth-knob.offsetWidth-8;}
  function start(x){if(slider.classList.contains('done'))return;measure();dragging=true;startX=x;startLeft=knob.offsetLeft;knob.style.transition='none';}
  function move(x){if(!dragging)return;var left=Math.max(4,Math.min(maxLeft,startLeft+(x-startX)));knob.style.left=left+'px';if(left>=maxLeft*0.7)done();}
  function end(){if(!dragging)return;dragging=false;knob.style.transition='left .2s';if(!slider.classList.contains('done'))knob.style.left='4px';}
  function done(){if(slider.classList.contains('done'))return;slider.classList.add('done');slider.classList.add('done-glow');knob.style.left=maxLeft+'px';respond('approve');}
  slider.addEventListener('touchstart',function(e){start(e.touches[0].clientX);},{passive:true});
  slider.addEventListener('touchmove',function(e){move(e.touches[0].clientX);},{passive:true});
  slider.addEventListener('touchend',end);
  slider.addEventListener('mousedown',function(e){start(e.clientX);e.preventDefault();});
  window.addEventListener('mousemove',function(e){move(e.clientX);});
  window.addEventListener('mouseup',end);
  window.addEventListener('resize',measure);
})();
</script>
</body></html>`
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function startRemoteServer() {
  if (remoteServer) return
  remoteLanIp = discoverLanIp()  // 可能为空（纯本机）：手机推送无直链，但本机 127.0.0.1 仍可用
  remoteServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`)
    if (u.searchParams.get('t') !== remoteToken) { res.statusCode = 403; res.end('forbidden'); return }
    if (req.method === 'GET' && u.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(remoteControlPage())
    } else if (req.method === 'POST' && u.pathname === '/respond') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          const { action, text, project } = JSON.parse(body || '{}')
          handleRemoteRespond(project || currentYellowProject, action, text)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message }))
        }
      })
    } else {
      res.statusCode = 404; res.end('not found')
    }
  })
  remoteServer.on('error', (e) => { console.error('[remote] server error:', e.message); remoteServer = null })
  // 监听所有接口：手机走 LAN IP，本机浏览器走 127.0.0.1（"本地页面"滑动）
  remoteServer.listen(REMOTE_PORT, () => {
    console.log(`[remote] control page: ${getRemoteControlUrl() || `http://127.0.0.1:${REMOTE_PORT}/?t=${remoteToken}`}`)
  })
}

function transmitBalance() {
  const data = lastBalance ? { ...lastBalance } : lastBalance
  if (data && typeof data === 'object') {
    const keys = readApiKeys()
    const sel = keys.selected_provider
    if (sel && BALANCE_PROVIDERS[sel] && keys._budgets && keys._budgets[sel]) data._budget = keys._budgets[sel]
    const fallback = keys.volcengine && keys.volcengine.accessKeyId ? 'volcengine' : 'deepseek'
    data._provider = sel || fallback
    const meta = providerMeta(data._provider)
    if (meta) data._providerName = meta.name
    if (isCodingPlanProvider(data._provider)) data._isQuota = true
  }
  if (mainWin) mainWin.webContents.send('balance-update', data)
  if (settingsWin) settingsWin.webContents.send('balance-update', data)
}

// DeepSeek 余额查询已并入通用 fetchBalanceProvider('deepseek')

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
              level: q.Level === 'session' ? 'five_hour' : q.Level,
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
  else if (CODING_PLAN_PROVIDERS[p]) fetchCodingPlanProvider(p)
  else if (BALANCE_PROVIDERS[p]) fetchBalanceProvider(p)
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
      return `for %F in ("%CLAUDE_PROJECT_DIR%") do @del /q "%USERPROFILE%\\.claude\\traffic_light\\%~nxF.state" "%USERPROFILE%\\.claude\\traffic_light\\%~nxF.dir" "%USERPROFILE%\\.claude\\traffic_light\\%~nxF.app" "%USERPROFILE%\\.claude\\traffic_light\\%~nxF.prompt" "%USERPROFILE%\\.claude\\traffic_light\\%~nxF.prompt.json" 2>nul & REM ${TRAFFIC_MARKER}`
    }
    return `project=$(basename "$\{CLAUDE_PROJECT_DIR:-$PWD}") && rm -f ${STATE_DIR}/"$project".state ${STATE_DIR}/"$project".dir ${STATE_DIR}/"$project".app ${STATE_DIR}/"$project".prompt ${STATE_DIR}/"$project".prompt.json # ${TRAFFIC_MARKER}`
  }

  // 黄灯时抓取 Claude 要确认的内容（stdin JSON -> hook_capture.cjs -> .prompt 文件）
  // 脚本复制到 STATE_DIR，避免 ASAR 打包后外部 node 读不到
  const captureScript = path.join(STATE_DIR, 'hook_capture.cjs')
  const captureCmd = isWin
    ? `set "CC_TL_STATE_DIR=${STATE_DIR}" & set "CC_TL_PROJECT=%CLAUDE_PROJECT_DIR%" & node "${captureScript}"`
    : `CC_TL_STATE_DIR=${STATE_DIR} CC_TL_PROJECT="$\{CLAUDE_PROJECT_DIR:-$PWD}" node "${captureScript}"`

  // 去掉 projectCmd 末尾的注释（# traffic_light_app / REM traffic_light_app），
  // 否则后续 && captureCmd 会被当成注释吃掉。
  // projectCmd 末尾的 shell 注释（mac: # / win: & REM）会吃掉后续命令
  const macRe = / # traffic_light_app$/
  const winRe = / & REM traffic_light_app$/
  const popen = (color) => {
    const raw = projectCmd(color)
    return macRe.test(raw) ? raw.replace(macRe, '') : raw.replace(winRe, '')
  }
  // 带 capture 的黄灯命令 = projectCmd + capture + 恢复注释标记
  const yellowCaptureCmd = (color) => `${popen(color)} && ${captureCmd}  # ${TRAFFIC_MARKER}`

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
    { event: 'PreToolUse',       matcher: 'AskUserQuestion', command: yellowCaptureCmd('yellow') },
    { event: 'PreToolUse',       matcher: PERMISSION_TOOLS, command: stateCmd('red') },
    { event: 'PreToolUse',       matcher: PERMISSION_TOOLS, command: projectCmd('red') },
    { event: 'PostToolUse',      matcher: PERMISSION_TOOLS, command: stateCmd('red') },
    { event: 'PostToolUse',      matcher: PERMISSION_TOOLS, command: projectCmd('red') },
    { event: 'PermissionRequest', command: stateCmd('yellow') },
    { event: 'PermissionRequest', command: yellowCaptureCmd('yellow'), timeout: 300 },
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

  for (const { event, matcher, command, timeout } of HOOKS_TO_ADD) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
    const handler = { type: 'command', command }
    if (timeout) handler.timeout = timeout  // 秒：PermissionRequest 阻塞等待滑动的上限
    const entry = { hooks: [handler] }
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
                onTrafficStateChange(state, p)  // 手机推送（Bark）
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
  // 外部链接（获取 API Key 等）用系统浏览器打开，而非在应用内新开窗口
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
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
          onTrafficStateChange(state, p)  // 手机推送（Bark）
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

  // 倒计时归零提醒：发系统通知（silent，声音由前端蜂鸣负责）
  ipcMain.handle('cd-alert', (_e, title, body) => {
    if (Notification.isSupported()) {
      const n = new Notification({ title: title || '⏰ 倒计时结束', body: body || '', silent: true })
      n.show()
      n.on('click', () => { if (mainWin) { mainWin.show(); mainWin.focus() } })
    }
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

  // ---------- 手机推送（Bark）----------
  ipcMain.handle('get-bark-config', () => getBarkConfig())
  ipcMain.on('set-bark-config', (_, cfg) => setBarkConfig(cfg))
  ipcMain.handle('get-remote-status', () => getRemoteStatus())
  ipcMain.handle('get-ntfy-config', () => getNtfyConfig())
  ipcMain.on('set-ntfy-config', (_, cfg) => setNtfyConfig(cfg))
  ipcMain.handle('test-ntfy', async () => {
    const { topic, server } = getNtfyConfig()
    if (!topic) return { ok: false, error: '未配置 ntfy Topic' }
    try {
      const ok = await new Promise((resolve) => {
        const url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`
        const u = new URL(url)
        const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Title': '🧪 测试推送', 'Tags': 'white_check_mark' }, timeout: 10000 }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300))
        })
        req.on('error', () => resolve(false))
        req.on('timeout', () => { req.destroy(); resolve(false) })
        req.write('ntfy 推送已连通')
        req.end()
      })
      return ok ? { ok: true } : { ok: false, error: '推送请求失败，检查 Topic / 服务器' }
    } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('test-bark', async () => {
    const { key } = getBarkConfig()
    if (!key) return { ok: false, error: '未配置 Bark Key' }
    try {
      const ok = await new Promise((resolve) => {
        const { server } = getBarkConfig()
        const url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(key)}/${encodeURIComponent('🧪 测试推送')}/${encodeURIComponent('手机推送已连通')}`
        const u = new URL(url)
        const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'Accept': 'application/json' }, timeout: 10000 }, (res) => {
          let d = ''
          res.on('data', (c) => { d += c })
          res.on('end', () => { resolve(res.statusCode >= 200 && res.statusCode < 300) })
        })
        req.on('error', () => resolve(false))
        req.on('timeout', () => { req.destroy(); resolve(false) })
      })
      return ok ? { ok: true } : { ok: false, error: '推送请求失败，检查 Key / 服务器' }
    } catch (e) { return { ok: false, error: e.message } }
  })

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

  // ---------- 多供应商余额查询（参考 cc-switch）----------
  ipcMain.handle('provider-list', () => {
    const balance = Object.entries(BALANCE_PROVIDERS).map(([id, p]) => ({ id, name: p.name, keyUrl: p.keyUrl, kind: 'balance' }))
    const codingPlan = [
      { id: 'volcengine', name: '火山 Ark', keyUrl: 'https://console.volcengine.com/iam/keymanage', kind: 'codingplan', needsAksk: true },
      ...Object.entries(CODING_PLAN_PROVIDERS).map(([id, p]) => ({ id, name: p.name, keyUrl: p.keyUrl, kind: 'codingplan', needsBaseUrl: !!p.needsBaseUrl })),
    ]
    return { balance, codingPlan }
  })

  ipcMain.handle('get-provider-config', (_, id) => getProviderConfig(id))

  ipcMain.on('set-provider-config', (_, id, cfg) => {
    setProviderConfig(id, cfg || null)
    refreshSelectedBalance()
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

  // 复制 hook_capture.cjs 到 STATE_DIR，避免生产版本 ASAR 打包后外部 node 读不到
  try {
    const src = path.join(__dirname, 'hook_capture.cjs')
    const dst = path.join(STATE_DIR, 'hook_capture.cjs')
    fs.copyFileSync(src, dst)
  } catch (e) { console.error('[hook] copy capture script failed:', e.message) }

  if (process.platform !== 'win32') {
    require('child_process').exec("pkill -f 'traffic_light.py'")
  }

  detectRunningSessions()
  setupClaudeHooks()
  providers.ensureDefaultProviders()
  syncRemoteApproveFlag()  // 启动时按 Bark Key 有无同步 hook 自动批准标记

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
  startRemoteServer()
})

app.on('will-quit', () => {
  try { if (remoteServer) remoteServer.close() } catch {}
  try { fs.unlinkSync(PID_FILE) } catch {}
})

app.on('window-all-closed', () => app.quit())
