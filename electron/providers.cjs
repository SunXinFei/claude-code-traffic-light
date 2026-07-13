'use strict'
//
// Claude 模型供应商切换 —— 复刻自 cc-switch 的核心能力
//
// 对应 cc-switch 的：
//   src-tauri/src/config.rs            -> 路径 / 原子写 / 键排序
//   src-tauri/src/services/provider/live.rs -> sanitize / 写 live settings.json
//   src-tauri/src/commands/provider.rs -> CRUD / switch
//   src/config/claudeProviderPresets.ts -> 预设
//
// 关键适配：本项目 setupClaudeHooks() 会把 hooks 写进 ~/.claude/settings.json，
// 因此切换时不能像 cc-switch 那样整文件覆盖（会抹掉 hooks），改用「合并写」：
//   - env 由 provider 整体替换（避免上一个 provider 的 ANTHROPIC_MODEL 等残留泄漏）
//   - hooks / permissions / mcpServers / enabledPlugins 等非供应商字段从当前文件保留
//   - provider 声明的其它顶层键按 provider 写入
//   - 写前 sanitize（删 apiFormat / api_format）
//   - 原子写（临时文件 + rename），键名字母序，pretty 2 空格 —— 与 cc-switch 一致
//

const fs = require('fs')
const path = require('path')
const os = require('os')

// 测试隔离：CC_TL_TEST_HOME 指向临时目录时可避免触碰真实 ~/.claude（仅用于测试/调试）
const HOME = (process.env.CC_TL_TEST_HOME && process.env.CC_TL_TEST_HOME.trim())
  || os.homedir()
const CLAUDE_DIR = path.join(HOME, '.claude')
const STATE_DIR = path.join(CLAUDE_DIR, 'traffic_light')
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json')
const PROVIDERS_FILE = path.join(STATE_DIR, 'providers.json')

// 仅供 live 写入时剔除的内部字段（绝不写入 Claude settings.json）
function sanitizeForLive(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config
  const v = deepClone(config)
  delete v.apiFormat
  delete v.api_format
  delete v.openrouterCompatMode
  delete v.openrouter_compat_mode
  return v
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

// 递归按字母序排序 JSON 对象键（移植自 cc-switch sort_json_keys），保证确定性输出
function sortJsonKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys)
  }
  if (value && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonKeys(value[key])
    }
    return sorted
  }
  return value
}

function readJsonFile(p, fallback) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (e) {
    console.error(`[providers] read json failed: ${p}`, e)
  }
  return fallback
}

// 原子写 JSON（移植自 cc-switch atomic_write + write_json_file）
function writeJsonAtomic(p, obj) {
  const parent = path.dirname(p)
  fs.mkdirSync(parent, { recursive: true })
  const sorted = sortJsonKeys(obj === undefined ? null : obj)
  const json = JSON.stringify(sorted, null, 2)
  const tmp = path.join(parent, `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, json, 'utf-8')
  // Windows 上 rename 到已存在目标会失败，先删
  try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch {}
  fs.renameSync(tmp, p)
}

// ---------- 读取 / 写入 Claude live settings.json ----------

function readClaudeSettings() {
  return readJsonFile(CLAUDE_SETTINGS_PATH, {}) || {}
}

// 合并构造切换后的 settings.json：保留 hooks/permissions 等，env 由 provider 接管
function buildSwitchedSettings(providerConfig) {
  const current = readClaudeSettings() || {}
  const next = deepClone(current) || {}

  const cfg = providerConfig && typeof providerConfig === 'object' ? providerConfig : {}

  // env 由 provider 整体替换（若 provider 无 env 则清空 env）
  if (Object.prototype.hasOwnProperty.call(cfg, 'env')) {
    next.env = deepClone(cfg.env) || {}
  } else {
    delete next.env
  }

  // provider 声明的其它顶层键覆盖写入
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'env') continue
    next[k] = deepClone(v)
  }

  // 顶层 `model` 字段会覆盖 env.ANTHROPIC_MODEL，导致切换后"模型没变"。
  // cc-switch 预设只走 env，故切换时清掉顶层 model（除非 provider 显式声明），让 env 生效。
  if (!Object.prototype.hasOwnProperty.call(cfg, 'model')) {
    delete next.model
  }

  return sanitizeForLive(next)
}

// ---------- provider 存储 ----------

function getProviderStore() {
  const store = readJsonFile(PROVIDERS_FILE, null)
  if (store && Array.isArray(store.providers)) {
    if (typeof store.current !== 'string') store.current = ''
    return store
  }
  return { providers: [], current: '' }
}

function saveProviderStore(store) {
  writeJsonAtomic(PROVIDERS_FILE, store)
}

function getProviders() {
  return getProviderStore().providers
}

// 供应商是否已配置（有密钥即算已配置；Official 不需要密钥）
function hasApiKey(provider) {
  if (!provider || !provider.settingsConfig) return false
  const env = provider.settingsConfig.env || {}
  const keyField = provider.apiKeyField || 'ANTHROPIC_AUTH_TOKEN'
  const val = env[keyField]
  return typeof val === 'string' && val.trim().length > 0
}

function isProviderVisible(provider, currentId) {
  return provider.isOfficial
    || provider.id === currentId
    || provider.pinned
    || hasApiKey(provider)
}

function getCurrentProviderId() {
  return getProviderStore().current
}

function getProviderById(id) {
  return getProviders().find((p) => p.id === id) || null
}

function genId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// 新增或更新 provider（有 id 则更新，无则新增）。返回保存后的 provider。
function saveProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new Error('provider 无效')
  if (!provider.name || !String(provider.name).trim()) throw new Error('供应商名称不能为空')
  const store = getProviderStore()
  const cfg = provider.settingsConfig || { env: {} }

  if (provider.id) {
    const idx = store.providers.findIndex((p) => p.id === provider.id)
    if (idx >= 0) {
      // 更新既有 provider，保留原有的 pinned / isOfficial（除非显式传入）
      const existingPinned = store.providers[idx].pinned
      store.providers[idx] = { ...store.providers[idx], ...provider, settingsConfig: cfg, pinned: provider.pinned != null ? provider.pinned : existingPinned }
      saveProviderStore(store)
      return store.providers[idx]
    }
  }

  const created = {
    id: provider.id || genId(),
    name: String(provider.name).trim(),
    settingsConfig: cfg,
    apiKeyField: provider.apiKeyField || detectApiKeyField(cfg),
    websiteUrl: provider.websiteUrl || '',
    isCustom: provider.isCustom !== false,
    isOfficial: !!provider.isOfficial,
    pinned: !!provider.pinned,
    createdAt: Date.now(),
    sortIndex: provider.sortIndex != null ? provider.sortIndex : store.providers.length,
  }
  store.providers.push(created)
  saveProviderStore(store)
  return created
}

function deleteProvider(id) {
  const store = getProviderStore()
  const before = store.providers.length
  store.providers = store.providers.filter((p) => p.id !== id)
  if (store.current === id) store.current = ''
  saveProviderStore(store)
  return store.providers.length < before
}

function detectApiKeyField(cfg) {
  const env = (cfg && cfg.env) || {}
  if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY')) return 'ANTHROPIC_API_KEY'
  return 'ANTHROPIC_AUTH_TOKEN'
}

// ---------- 切换 ----------

function switchProvider(id) {
  const store = getProviderStore()
  const provider = store.providers.find((p) => p.id === id)
  if (!provider) throw new Error(`供应商 ${id} 不存在`)

  // Backfill（对应 cc-switch switch_normal 的回填）：切走前把当前 live 的 env
  // 回填到即将离开的供应商，保留用户在 Claude Code 内对该供应商的手动改动
  // （改模型名、加 env 等），下次切回时还原。
  if (store.current && store.current !== id) {
    const outgoing = store.providers.find((p) => p.id === store.current)
    if (outgoing) {
      const live = readClaudeSettings()
      if (live && live.env && Object.keys(live.env).length > 0) {
        outgoing.settingsConfig = outgoing.settingsConfig || {}
        outgoing.settingsConfig.env = deepClone(live.env)
      }
    }
  }

  const next = buildSwitchedSettings(provider.settingsConfig)
  writeJsonAtomic(CLAUDE_SETTINGS_PATH, next)

  store.current = id
  saveProviderStore(store)
  return { ok: true, current: id, name: provider.name }
}

// 从当前 ~/.claude/settings.json 导入为一个新 provider（迁移用）
function importFromLive(name) {
  const store = getProviderStore()
  let finalName = (name && String(name).trim()) || '当前配置'
  if (store.providers.some((p) => p.name === finalName)) {
    let i = 2
    while (store.providers.some((p) => p.name === `${finalName} ${i}`)) i++
    finalName = `${finalName} ${i}`
  }
  const live = readClaudeSettings()
  const provider = saveProvider({
    name: finalName,
    settingsConfig: live && Object.keys(live).length > 0 ? live : { env: {} },
    isCustom: true,
  })
  return provider
}

// ---------- 预设 ----------

function presetEnv(base, token, model, haiku, sonnet, opus, extra) {
  const env = { ANTHROPIC_BASE_URL: base }
  env[token || 'ANTHROPIC_AUTH_TOKEN'] = ''
  if (model) env.ANTHROPIC_MODEL = model
  if (haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku
  if (sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet
  if (opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus
  if (extra) Object.assign(env, extra)
  return env
}

// 精选自 cc-switch src/config/claudeProviderPresets.ts（密钥留空，由用户填写）
const PROVIDER_PRESETS = [
  {
    id: 'preset-official',
    name: 'Claude 官方',
    websiteUrl: 'https://www.anthropic.com/claude-code',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    isOfficial: true,
    settingsConfig: { env: {} },
  },
  {
    id: 'preset-deepseek',
    name: 'DeepSeek',
    websiteUrl: 'https://platform.deepseek.com',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.deepseek.com/anthropic', 'ANTHROPIC_AUTH_TOKEN',
        'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-pro'),
    },
  },
  {
    id: 'preset-kimi-coding',
    name: 'Kimi For Coding',
    websiteUrl: 'https://www.kimi.com/code/',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.kimi.com/coding/', 'ANTHROPIC_AUTH_TOKEN'),
    },
  },
  {
    id: 'preset-kimi',
    name: 'Kimi (Moonshot)',
    websiteUrl: 'https://platform.kimi.com',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.moonshot.cn/anthropic', 'ANTHROPIC_AUTH_TOKEN',
        'kimi-k2.7-code', 'kimi-k2.7-code', 'kimi-k2.7-code', 'kimi-k2.7-code'),
    },
  },
  {
    id: 'preset-zhipu-zai',
    name: 'Zhipu GLM (z.ai)',
    websiteUrl: 'https://z.ai',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.z.ai/api/anthropic', 'ANTHROPIC_AUTH_TOKEN',
        'glm-5.1', 'glm-5.1', 'glm-5.1', 'glm-5.1'),
    },
  },
  {
    id: 'preset-zhipu-bigmodel',
    name: 'Zhipu GLM (bigmodel)',
    websiteUrl: 'https://open.bigmodel.cn',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://open.bigmodel.cn/api/anthropic', 'ANTHROPIC_AUTH_TOKEN',
        'glm-5.1', 'glm-5.1', 'glm-5.1', 'glm-5.1'),
    },
  },
  {
    id: 'preset-volc-agentplan',
    name: '火山 Agentplan',
    websiteUrl: 'https://www.volcengine.com/product/ark',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://ark.cn-beijing.volces.com/api/coding', 'ANTHROPIC_AUTH_TOKEN',
        'ark-code-latest', 'ark-code-latest', 'ark-code-latest', 'ark-code-latest'),
    },
  },
  {
    id: 'preset-byteplus',
    name: 'BytePlus (火山海外)',
    websiteUrl: 'https://www.byteplus.com/en/product/modelark',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://ark.ap-southeast.bytepluses.com/api/coding', 'ANTHROPIC_AUTH_TOKEN',
        'ark-code-latest', 'ark-code-latest', 'ark-code-latest', 'ark-code-latest'),
    },
  },
  {
    id: 'preset-doubao-seed',
    name: 'DouBaoSeed',
    websiteUrl: 'https://www.volcengine.com/product/doubao',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://ark.cn-beijing.volces.com/api/compatible', 'ANTHROPIC_AUTH_TOKEN',
        'doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-pro-260628',
        'doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-pro-260628', { API_TIMEOUT_MS: '3000000' }),
    },
  },
  {
    id: 'preset-openrouter',
    name: 'OpenRouter',
    websiteUrl: 'https://openrouter.ai',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://openrouter.ai/api', 'ANTHROPIC_AUTH_TOKEN',
        'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4.5',
        'anthropic/claude-sonnet-5', 'anthropic/claude-opus-4.8'),
    },
  },
  {
    id: 'preset-siliconflow',
    name: 'SiliconFlow',
    websiteUrl: 'https://siliconflow.cn',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.siliconflow.cn', 'ANTHROPIC_AUTH_TOKEN',
        'Pro/MiniMaxAI/MiniMax-M2.7', 'Pro/MiniMaxAI/MiniMax-M2.7',
        'Pro/MiniMaxAI/MiniMax-M2.7', 'Pro/MiniMaxAI/MiniMax-M2.7'),
    },
  },
  {
    id: 'preset-minimax',
    name: 'MiniMax',
    websiteUrl: 'https://platform.minimaxi.com',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.minimaxi.com/anthropic', 'ANTHROPIC_AUTH_TOKEN',
        'MiniMax-M2.7', 'MiniMax-M2.7', 'MiniMax-M2.7', 'MiniMax-M2.7',
        { API_TIMEOUT_MS: '3000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1 }),
    },
  },
  {
    id: 'preset-minimax-en',
    name: 'MiniMax (海外)',
    websiteUrl: 'https://platform.minimax.io',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.minimax.io/anthropic', 'ANTHROPIC_AUTH_TOKEN',
        'MiniMax-M2.7', 'MiniMax-M2.7', 'MiniMax-M2.7', 'MiniMax-M2.7',
        { API_TIMEOUT_MS: '3000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1 }),
    },
  },
  {
    id: 'preset-bailian-coding',
    name: '阿里 Bailian For Coding',
    websiteUrl: 'https://bailian.console.aliyun.com',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://coding.dashscope.aliyuncs.com/apps/anthropic', 'ANTHROPIC_AUTH_TOKEN'),
    },
  },
  {
    id: 'preset-qianfan',
    name: '百度 Qianfan Coding Plan',
    websiteUrl: 'https://cloud.baidu.com/product/qianfan_modelbuilder',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://qianfan.baidubce.com/anthropic/coding', 'ANTHROPIC_AUTH_TOKEN',
        'qianfan-code-latest', 'qianfan-code-latest', 'qianfan-code-latest', 'qianfan-code-latest'),
    },
  },
  {
    id: 'preset-stepfun',
    name: 'StepFun',
    websiteUrl: 'https://platform.stepfun.com/step-plan',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.stepfun.com/step_plan', 'ANTHROPIC_AUTH_TOKEN',
        'step-3.5-flash-2603', 'step-3.5-flash-2603', 'step-3.5-flash-2603', 'step-3.5-flash-2603'),
    },
  },
  {
    id: 'preset-modelscope',
    name: 'ModelScope',
    websiteUrl: 'https://modelscope.cn',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api-inference.modelscope.cn', 'ANTHROPIC_AUTH_TOKEN',
        'ZhipuAI/GLM-5.1', 'ZhipuAI/GLM-5.1', 'ZhipuAI/GLM-5.1', 'ZhipuAI/GLM-5.1'),
    },
  },
  {
    id: 'preset-longcat',
    name: 'Longcat',
    websiteUrl: 'https://longcat.chat/platform',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.longcat.chat/anthropic', 'ANTHROPIC_AUTH_TOKEN',
        'LongCat-2.0', 'LongCat-2.0', 'LongCat-2.0', 'LongCat-2.0',
        { ANTHROPIC_SMALL_FAST_MODEL: 'LongCat-2.0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '131072',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1 }),
    },
  },
  {
    id: 'preset-gemini-native',
    name: 'Gemini Native',
    websiteUrl: 'https://ai.google.dev/gemini-api',
    apiKeyField: 'ANTHROPIC_API_KEY',
    settingsConfig: {
      env: presetEnv('https://generativelanguage.googleapis.com', 'ANTHROPIC_API_KEY',
        'gemini-3.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash'),
    },
  },
  {
    id: 'preset-aws-bedrock-aksk',
    name: 'AWS Bedrock (AKSK)',
    websiteUrl: 'https://aws.amazon.com/bedrock/',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: 'https://bedrock-runtime.${AWS_REGION}.amazonaws.com',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: '',
        AWS_REGION: 'us-west-2',
        ANTHROPIC_MODEL: 'global.anthropic.claude-opus-4-8',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-4-8',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
    },
  },
  {
    id: 'preset-aihubmix',
    name: 'AiHubMix',
    websiteUrl: 'https://aihubmix.com',
    apiKeyField: 'ANTHROPIC_API_KEY',
    settingsConfig: {
      env: presetEnv('https://aihubmix.com', 'ANTHROPIC_API_KEY'),
    },
  },
  {
    id: 'preset-dmxapi',
    name: 'DMXAPI',
    websiteUrl: 'https://www.dmxapi.cn',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://www.dmxapi.cn', 'ANTHROPIC_AUTH_TOKEN'),
    },
  },
  {
    id: 'preset-packycode',
    name: 'PackyCode',
    websiteUrl: 'https://www.packyapi.com',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://www.packyapi.com', 'ANTHROPIC_AUTH_TOKEN'),
    },
  },
  {
    id: 'preset-apikey-fun',
    name: 'APIKEY.FUN',
    websiteUrl: 'https://apikey.fun',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://api.apikey.fun', 'ANTHROPIC_AUTH_TOKEN',
        null, null, null, null, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
    },
  },
  {
    id: 'preset-cherryin',
    name: 'CherryIN',
    websiteUrl: 'https://open.cherryin.ai',
    apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
    settingsConfig: {
      env: presetEnv('https://open.cherryin.net', 'ANTHROPIC_AUTH_TOKEN',
        'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4.5',
        'anthropic/claude-sonnet-5', 'anthropic/claude-opus-4.8'),
    },
  },
]

// 从当前 live settings.json 反查匹配的预设 id（按 ANTHROPIC_BASE_URL 精确匹配）
function detectCurrentPresetId() {
  const live = readClaudeSettings()
  const env = (live && live.env) || {}
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!baseUrl) return 'preset-official'
  for (const p of PROVIDER_PRESETS) {
    const pEnv = (p.settingsConfig && p.settingsConfig.env) || {}
    const pUrl = String(pEnv.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (pUrl && pUrl === baseUrl) return p.id
  }
  return null
}

// 首次运行：写入预设（密钥留空）；并设定 current
function ensureDefaultProviders() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
  } catch {}
  const store = getProviderStore()

  // 已有用户数据则不覆盖预设，只补齐缺失的预设 + 设定 current
  const existed = new Set(store.providers.map((p) => p.id))
  let changed = false
  for (const preset of PROVIDER_PRESETS) {
    if (!existed.has(preset.id)) {
      store.providers.push({
        id: preset.id,
        name: preset.name,
        settingsConfig: deepClone(preset.settingsConfig),
        apiKeyField: preset.apiKeyField || 'ANTHROPIC_AUTH_TOKEN',
        websiteUrl: preset.websiteUrl || '',
        isCustom: false,
        isOfficial: !!preset.isOfficial,
        pinned: false,
        sortIndex: store.providers.length,
        createdAt: Date.now(),
      })
      changed = true
    }
  }

  // 设定 current：优先已有 current；否则从 live 反查；再否则导入当前 live 配置
  if (!store.current || !store.providers.some((p) => p.id === store.current)) {
    const presetId = detectCurrentPresetId()
    if (presetId && store.providers.some((p) => p.id === presetId)) {
      store.current = presetId
    } else if (store.providers.length > 0) {
      // live 有非预设配置：导入为「当前配置」并设为 current
      const live = readClaudeSettings()
      if (live && live.env && Object.keys(live.env).length > 0) {
        const imported = {
          id: genId(),
          name: '当前配置',
          settingsConfig: { env: deepClone(live.env) },
          apiKeyField: detectApiKeyField({ env: live.env }),
          websiteUrl: '',
          isCustom: true,
          sortIndex: store.providers.length,
          createdAt: Date.now(),
        }
        store.providers.push(imported)
        store.current = imported.id
      } else {
        store.current = 'preset-official'
      }
    }
    changed = true
  }

  if (changed) saveProviderStore(store)
  return store
}

module.exports = {
  CLAUDE_SETTINGS_PATH,
  PROVIDERS_FILE,
  getProviders,
  getCurrentProviderId,
  getProviderById,
  saveProvider,
  deleteProvider,
  switchProvider,
  importFromLive,
  readClaudeSettings,
  buildSwitchedSettings,
  ensureDefaultProviders,
  hasApiKey,
  isProviderVisible,
  PROVIDER_PRESETS,
}
