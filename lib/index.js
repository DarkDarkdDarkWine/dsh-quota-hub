/**
 * dsh-quota-hub — 宿主端（聚合版：GLM + MiniMax）。
 *
 * 职责：向各家 Coding Plan 的监控接口取额度快照，通过本地 HTTP 路由交给
 * 界面。取哪个 Key、打哪个域名、缓存多久都收敛在这里，界面端只负责画。
 *
 * 路由（全部在 /dsh-quota-hub 前缀下）：
 *
 *   GET  /dsh-quota-hub/status.json   所有 provider 的快照 + 配置 + Key 状态（命中缓存）
 *   POST /dsh-quota-hub/refresh.json  强制刷新，返回同样结构
 *   GET  /dsh-quota-hub/config.json   只读配置
 *   POST /dsh-quota-hub/config.json   改 region / 刷新间隔 / Key（provider 维度）
 *
 * 接口事实（2026-10 实测）：
 *
 *   GLM CN     https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *   GLM Global https://api.z.ai/api/monitor/usage/quota/limit
 *     data.limits[]：TIME_LIMIT 有 usage/currentValue/remaining；
 *     两个 TOKENS_LIMIT 只有 percentage + nextResetTime。unit 3 = 5 小时窗口，
 *     unit 6 = 每周窗口（number 不保证是 7，别拿它判断）。
 *     订阅：{origin}/api/biz/subscription/list。未授权时 HTTP 仍是 200，看 body.code。
 *
 *   MiniMax CN     https://api.minimaxi.com/v1/token_plan/remains（备用 www.minimaxi.com）
 *   MiniMax Global https://www.minimax.io/v1/token_plan/remains（备用 api.minimax.io）
 *     GET + Bearer 订阅 Key（必须是 Token Plan 订阅 Key，普通 API Key 查不了）。
 *     body.base_resp.status_code !== 0 即失败（1004 = 鉴权）。
 *     body.model_remains[] 每行一个模型：model_name、start_time/end_time（当前 5 小时
 *     窗口的起止，毫秒）、remains_time（毫秒，距窗口重置）、current_interval_* 与
 *     current_weekly_* 计数。遗留语义：usage_count 是「剩余」不是「已用」；
 *     total=0（如 general 行）算不出百分比 → 显示未知。
 *
 * 纯 JavaScript，无构建、无 SDK 依赖。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-quota-hub'

/** 路由是宿主端唯一需要的服务；credentials / tools 都是可选增强。 */
export const inject = ['webServer']

const BASE = '/dsh-quota-hub'
const CACHE_TTL_MS = 30_000
const ERROR_TTL_MS = 10_000
const MIN_INTERVAL_SECONDS = 60
const MAX_BODY_BYTES = 64 * 1024

/** GLM 专属的旧凭证名（配置里没写 keyRef 时的兜底）。 */
const GLM_FALLBACK_KEY_REF = 'GLM_QUOTA_API_KEY'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

function roundPercent(value) {
  return Math.round(value * 10) / 10
}

function isoOf(ms) {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}

function severityOf(usedPercent) {
  if (usedPercent === null) return 'unknown'
  if (usedPercent >= 90) return 'critical'
  if (usedPercent >= 70) return 'warn'
  return 'ok'
}

// ---------------------------------------------------------------------------
// Provider 定义
// ---------------------------------------------------------------------------

const PROVIDERS = {
  glm: {
    id: 'glm',
    label: 'GLM',
    regions: {
      cn: { id: 'cn', label: '国内版 bigmodel.cn', origin: 'https://open.bigmodel.cn' },
      global: { id: 'global', label: '国际版 z.ai', origin: 'https://api.z.ai' },
    },
    defaultKeyRef: () => 'ZAI_CODING_CN_API_KEY',
    needsKeyHint:
      '插件默认自动复用「设置 → 模型」里 GLM 提供商的 Key（ZAI_CODING_CN_API_KEY）；如果那里已配好，请检查区域设置是否一致。',
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    regions: {
      cn: {
        id: 'cn',
        label: '国内版 minimaxi.com',
        urls: ['https://api.minimaxi.com/v1/token_plan/remains', 'https://www.minimaxi.com/v1/token_plan/remains'],
      },
      global: {
        id: 'global',
        label: '国际版 minimax.io',
        urls: ['https://www.minimax.io/v1/token_plan/remains', 'https://api.minimax.io/v1/token_plan/remains'],
      },
    },
    defaultKeyRef: (region) => (region === 'global' ? 'MINIMAX_API_KEY' : 'MINIMAX_CN_API_KEY'),
    needsKeyHint:
      '插件默认自动复用「设置 → 模型」里 MiniMax 提供商的 Key（国内版 MINIMAX_CN_API_KEY / 国际版 MINIMAX_API_KEY）；注意用量查询必须使用 Token Plan 订阅 Key，普通按量付费 Key 查不了。',
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    regions: {
      cn: { id: 'cn', label: 'api.kimi.com', urls: ['https://api.kimi.com/coding/v1/usages'] },
    },
    // Kimi 的用量接口校验客户端 UA，必须伪装成 Kimi CLI。
    extraHeaders: { 'user-agent': 'KimiCLI/1.6' },
    defaultKeyRef: () => 'KIMI_CODING_API_KEY',
    needsKeyHint: '插件默认自动复用「设置 → 模型」里 Kimi 提供商的 Key（KIMI_CODING_API_KEY）。',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    regions: {
      cn: { id: 'cn', label: 'api.deepseek.com', urls: ['https://api.deepseek.com/user/balance'] },
    },
    defaultKeyRef: () => 'DEEPSEEK_API_KEY',
    needsKeyHint: '插件默认自动复用「设置 → 模型」里 DeepSeek 提供商的 Key（DEEPSEEK_API_KEY）。',
  },
  mimo: {
    id: 'mimo',
    label: '小米 MiMo',
    regions: {
      cn: { id: 'cn', label: '国内版 token-plan-cn', origin: 'https://token-plan-cn.xiaomimimo.com' },
      global: { id: 'global', label: '新加坡 token-plan-sgp', origin: 'https://token-plan-sgp.xiaomimimo.com' },
    },
    defaultKeyRef: (region) => (region === 'global' ? 'XIAOMI_TOKEN_PLAN_API_KEY' : 'XIAOMI_TOKEN_PLAN_CN_API_KEY'),
    needsKeyHint:
      '插件默认自动复用「设置 → 模型」里小米 MiMo 提供商的 Key（国内 XIAOMI_TOKEN_PLAN_CN_API_KEY）。小米不提供额度查询 API，额度为本地按月配额估算。',
  },
}

// DeepSeek 无订阅窗口：余额走官方 /user/balance，「今日花费」是本地估算
// （会话日志 token × 价格表 × 峰谷系数），不是账单。
// 价格单位：USD / 1M token（官方 docs 口径，高峰价；错峰一律半价）。
// 可在 $DSH_HOME/dsh-quota-hub/config.json 的 providers.deepseek.prices 里覆盖。
const DEEPSEEK_PRICES = {
  default: { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 },
  'deepseek-flash': { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 },
  'deepseek-v4-pro': { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 },
}

/** 高峰时段：UTC 周一至周五 01:00-04:00 与 06:00-10:00（官方规则；中国法定节假日豁免未内置）。 */
function deepseekIsPeak(time) {
  const d = new Date(time)
  const dow = d.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const h = d.getUTCHours() + d.getUTCMinutes() / 60
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

function deepseekPriceRow(prices, model) {
  const table = prices && typeof prices === 'object' ? prices : {}
  const row = (typeof model === 'string' && table[model]) || table.default || DEEPSEEK_PRICES.default
  const g = (k) => (typeof row[k] === 'number' && Number.isFinite(row[k]) ? row[k] : DEEPSEEK_PRICES.default[k])
  return { cacheHitInput: g('cacheHitInput'), cacheMissInput: g('cacheMissInput'), output: g('output') }
}

const PROVIDER_IDS = Object.keys(PROVIDERS)

// ---------------------------------------------------------------------------
// 配置（v2：provider 维度；读取时自动迁移 v1 的扁平结构）
// ---------------------------------------------------------------------------

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function configPath() {
  return join(homeDir(), 'dsh-quota-hub', 'config.json')
}

function normalizeProviderConfig(def, raw) {
  const regionIds = Object.keys(def.regions)
  const next = { region: regionIds[0], keyRef: null, enabled: true }
  if (!isObject(raw)) return next
  if (typeof raw.region === 'string' && Object.prototype.hasOwnProperty.call(def.regions, raw.region)) next.region = raw.region
  if (typeof raw.keyRef === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.keyRef)) next.keyRef = raw.keyRef
  if (raw.enabled === false) next.enabled = false
  return next
}

function defaultConfig() {
  return {
    version: 2,
    intervalSeconds: 120,
    enabled: true,
    providers: {
      glm: normalizeProviderConfig(PROVIDERS.glm, { region: 'cn' }),
      minimax: normalizeProviderConfig(PROVIDERS.minimax, { region: 'cn' }),
      kimi: normalizeProviderConfig(PROVIDERS.kimi, { region: 'cn' }),
      deepseek: normalizeProviderConfig(PROVIDERS.deepseek, { region: 'cn' }),
      mimo: normalizeProviderConfig(PROVIDERS.mimo, { region: 'cn', monthlyTokens: 4_100_000_000 }),
    },
  }
}

function normalizeConfig(raw) {
  const next = defaultConfig()
  if (!isObject(raw)) return next
  const interval = Number(raw.intervalSeconds)
  if (Number.isFinite(interval)) next.intervalSeconds = Math.min(3600, Math.max(MIN_INTERVAL_SECONDS, Math.round(interval)))
  if (raw.enabled === false) next.enabled = false
  if (isObject(raw.providers)) {
    for (const id of PROVIDER_IDS) {
      if (Object.prototype.hasOwnProperty.call(raw.providers, id)) {
        next.providers[id] = normalizeProviderConfig(PROVIDERS[id], raw.providers[id])
      }
    }
  } else if (raw.version !== 2) {
    // v1 扁平结构：region/keyRef 全部属于 GLM。
    next.providers.glm = normalizeProviderConfig(PROVIDERS.glm, raw)
  }
  return next
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath(), 'utf8')))
  } catch {
    return defaultConfig()
  }
}

function saveConfig(config) {
  const dir = join(homeDir(), 'dsh-quota-hub')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
}

function effectiveKeyRef(providerId, providerConfig) {
  const provider = PROVIDERS[providerId]
  if (providerConfig.keyRef) return providerConfig.keyRef
  return provider.defaultKeyRef(providerConfig.region)
}

// ---------------------------------------------------------------------------
// HTTP 基件
// ---------------------------------------------------------------------------

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 一次 GET：Bearer 鉴权，HTTP 非 2xx 或非 JSON 抛错；业务码交给调用方判断。 */
async function httpGetJson(url, key, extraHeaders) {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      'user-agent': 'dsh-quota-hub/0.2.0',
      ...(extraHeaders || {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${res.status}：接口没有返回 JSON`)
  }
  if (!res.ok) {
    const base = isObject(body) && isObject(body.base_resp) ? body.base_resp : null
    const reason =
      (base !== null && typeof base.status_msg === 'string' && base.status_msg) ||
      (isObject(body) && typeof body.msg === 'string' && body.msg) ||
      `HTTP ${res.status}`
    throw new Error(reason)
  }
  return body
}

// ---------------------------------------------------------------------------
// GLM 归一化
// ---------------------------------------------------------------------------

function glmWindowTitle(unit, number) {
  const n = Number(number) || 1
  if (unit === 3) return `${n} 小时窗口`
  if (unit === 6) return n > 1 ? `${n} 周窗口` : '每周窗口'
  return `额度窗口 ${unit}-${n}`
}

function glmWindowShortTitle(unit, number) {
  const n = Number(number) || 1
  if (unit === 3) return `${n} 小时`
  if (unit === 6) return n > 1 ? `${n} 周` : '每周'
  return `窗口 ${unit}-${n}`
}

function glmWindowId(unit) {
  if (unit === 3) return 'session'
  if (unit === 6) return 'weekly'
  return `unit-${unit}`
}

async function collectGlm(region, key, fetchedAt) {
  const origin = PROVIDERS.glm.regions[region].origin
  let quota
  try {
    quota = await httpGetJson(`${origin}/api/monitor/usage/quota/limit`, key)
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : String(cause))
  }
  // 智谱的鉴权失败是 HTTP 200 + body.code 401。
  const code = isObject(quota) && typeof quota.code === 'number' ? quota.code : 200
  if (code !== 200 && code !== 0) {
    const reason = isObject(quota) && typeof quota.msg === 'string' ? quota.msg : `接口返回 code=${code}`
    throw new Error(code === 401 || code === 1000 || code === 1001 ? `${reason}（Key 无效或已过期）` : reason)
  }
  let subscription = null
  try {
    subscription = await httpGetJson(`${origin}/api/biz/subscription/list`, key)
  } catch {
    subscription = null
  }

  const data = isObject(quota.data) ? quota.data : {}
  const limits = Array.isArray(data.limits) ? data.limits : []
  const windows = []
  const extras = []
  for (const limit of limits) {
    if (!isObject(limit)) continue
    const resetAt = isoOf(limit.nextResetTime)
    if (limit.type === 'TIME_LIMIT') {
      const total = Number(limit.usage)
      const used = Number(limit.currentValue)
      const remaining = Number(limit.remaining)
      const percent = Number.isFinite(total) && total > 0 && Number.isFinite(used) ? roundPercent((used / total) * 100) : null
      extras.push({
        id: 'search',
        title: '联网搜索 / 网页读取',
        used: Number.isFinite(used) ? used : null,
        total: Number.isFinite(total) ? total : null,
        remaining: Number.isFinite(remaining) ? remaining : null,
        usedPercent: percent,
        resetAt,
        details: Array.isArray(limit.usageDetails)
          ? limit.usageDetails.filter(isObject).map((d) => ({ modelCode: String(d.modelCode), usage: Number(d.usage) || 0 }))
          : [],
      })
      continue
    }
    const usedPercent = clampPercent(Number(limit.percentage))
    windows.push({
      id: glmWindowId(limit.unit),
      title: glmWindowTitle(limit.unit, limit.number),
      shortTitle: glmWindowShortTitle(limit.unit, limit.number),
      unit: Number(limit.unit) || null,
      number: Number(limit.number) || null,
      usedPercent,
      remainingPercent: usedPercent === null ? null : roundPercent(100 - usedPercent),
      severity: severityOf(usedPercent),
      resetAt,
    })
  }
  const order = { session: 0, weekly: 1 }
  windows.sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9))

  let plan = null
  if (isObject(subscription) && Array.isArray(subscription.data) && subscription.data.length > 0) {
    const first = subscription.data.find((entry) => isObject(entry) && entry.status === 'VALID') ?? subscription.data[0]
    if (isObject(first)) {
      plan = {
        name: typeof first.productName === 'string' ? first.productName : null,
        bigTitle: typeof first.productBigTitle === 'string' ? first.productBigTitle : null,
        status: typeof first.status === 'string' ? first.status : null,
        autoRenew: first.autoRenew === 1 || first.autoRenew === true,
        nextRenewTime: typeof first.nextRenewTime === 'string' ? first.nextRenewTime : null,
        billingCycle: typeof first.billingCycle === 'string' ? first.billingCycle : null,
        currentPeriod: Number.isFinite(Number(first.currentPeriod)) ? Number(first.currentPeriod) : null,
      }
    }
  }

  return {
    windows,
    extras,
    plan,
    level: typeof data.level === 'string' ? data.level : null,
  }
}

// ---------------------------------------------------------------------------
// MiniMax 归一化
// ---------------------------------------------------------------------------

const MINIMAX_AUTH_HINT = 'Key 无效或不是订阅 Key：MiniMax 用量查询必须使用 Token Plan 订阅 Key，普通按量付费 API Key 查不了。'

function isMinimaxAuthFailure(message) {
  return /cookie is missing|log in again|unauthorized|invalid api key|invalid token|status_code["\s:]*1004|1004/i.test(message)
}

/** 语义：这些字段给的是「剩余」；遗留 usage_count 也是剩余。返回剩余百分比或 null。 */
function minimaxRemainingPercent(row, window) {
  const percent = pickNumber(row, [
    `current_${window}_remaining_percent`,
    `${window}_remaining_percent`,
    `current_${window}_remain_percent`,
  ])
  if (percent !== undefined) return Math.min(100, Math.max(0, roundPercent(percent)))
  const remaining = pickNumber(row, [
    `current_${window}_remaining_count`,
    `current_${window}_remains_count`,
    `${window}_remaining_count`,
    `${window}_remains_count`,
  ])
  const total = pickNumber(row, [`current_${window}_total_count`, `${window}_total_count`])
  if (remaining !== undefined && total !== undefined && total > 0) {
    return Math.min(100, Math.max(0, roundPercent((remaining / total) * 100)))
  }
  const usageAsRemaining = pickNumber(row, [`current_${window}_usage_count`, `${window}_usage_count`])
  if (usageAsRemaining !== undefined && total !== undefined && total > 0) {
    return Math.min(100, Math.max(0, roundPercent((usageAsRemaining / total) * 100)))
  }
  return null
}

function pickNumber(row, names) {
  for (const name of names) {
    const value = Number(row[name])
    if (Number.isFinite(value)) return value
  }
  return undefined
}

function minimaxSpanHours(row) {
  const start = Number(row.start_time)
  const end = Number(row.end_time)
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const hours = (end - start) / 3_600_000
    if (Number.isInteger(hours) && hours > 0 && hours <= 24) return hours
  }
  return 5
}

async function collectMinimax(region, key, fetchedAt) {
  const urls = PROVIDERS.minimax.regions[region].urls
  let body
  let lastError
  for (const url of urls) {
    try {
      body = await httpGetJson(url, key)
      break
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause)
      if (!/无法连接|超时|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|certificate|ssl|tls/i.test(lastError)) throw cause
    }
  }
  if (body === undefined) throw new Error(lastError ?? '查询失败')

  const base = isObject(body.base_resp) ? body.base_resp : {}
  const statusCode = Number(base.status_code)
  if (statusCode !== 0) {
    const raw = typeof base.status_msg === 'string' && base.status_msg !== '' ? base.status_msg : `MiniMax 返回错误 (${statusCode})`
    throw new Error(isMinimaxAuthFailure(raw) ? MINIMAX_AUTH_HINT : raw)
  }
  const rows = Array.isArray(body.model_remains) ? body.model_remains.filter(isObject) : []
  if (rows.length === 0) throw new Error('无模型配额数据')

  const spanHours = minimaxSpanHours(rows[0])
  const extras = []
  const includedRows = []
  for (const row of rows) {
    const name = typeof row.model_name === 'string' && row.model_name !== '' ? row.model_name : typeof row.model === 'string' ? row.model : '模型'
    const intervalRemaining = minimaxRemainingPercent(row, 'interval')
    const weeklyRemaining = minimaxRemainingPercent(row, 'weekly')
    const intervalEnd = Number(row.end_time)
    const known = [intervalRemaining, weeklyRemaining]
    const hasData = pickNumber(row, ['current_interval_total_count', 'current_weekly_total_count']) > 0
    if (hasData) includedRows.push({ name, intervalRemaining, weeklyRemaining })
    extras.push({
      id: `model-${name}`,
      title: `模型 ${name}`,
      used: null,
      total: null,
      remaining: null,
      remainingPercent: intervalRemaining,
      usedPercent: intervalRemaining === null ? null : roundPercent(100 - intervalRemaining),
      weeklyRemainingPercent: weeklyRemaining,
      resetAt: isoOf(intervalEnd),
      details: [],
    })
  }

  const worstUsed = (pick) => {
    const values = includedRows.map(pick).filter((v) => v !== null && v !== undefined)
    if (values.length === 0) return null
    return roundPercent(Math.max(...values.map((r) => 100 - r)))
  }
  const intervalEndMax = rows.reduce((acc, row) => Math.max(acc, Number(row.end_time) || 0), 0)
  const windows = [
    {
      id: 'session',
      title: `${spanHours} 小时窗口`,
      shortTitle: `${spanHours} 小时`,
      unit: null,
      number: spanHours,
      usedPercent: worstUsed((r) => r.intervalRemaining),
      remainingPercent: null,
      severity: 'unknown',
      resetAt: isoOf(intervalEndMax),
    },
    {
      id: 'weekly',
      title: '每周窗口',
      shortTitle: '每周',
      unit: null,
      number: null,
      usedPercent: worstUsed((r) => r.weeklyRemaining),
      remainingPercent: null,
      severity: 'unknown',
      resetAt: null,
    },
  ]
  for (const w of windows) {
    if (w.usedPercent !== null) {
      w.remainingPercent = roundPercent(100 - w.usedPercent)
      w.severity = severityOf(w.usedPercent)
    }
  }
  return { windows, extras, plan: null, level: null }
}

// ---------------------------------------------------------------------------
// Kimi 归一化
// ---------------------------------------------------------------------------

/** Kimi 的 limit/remaining 是字符串；used 缺失时（窗口刚重置）用 limit-remaining 补。 */
function kimiQuota(u) {
  if (!isObject(u)) return null
  const limit = Number(u.limit)
  const remaining = Number(u.remaining)
  const usedRaw = Number(u.used)
  if (!Number.isFinite(limit) && !Number.isFinite(remaining)) return null
  const used = Number.isFinite(usedRaw)
    ? usedRaw
    : Number.isFinite(limit) && Number.isFinite(remaining)
      ? Math.max(0, limit - remaining)
      : NaN
  const percent = Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? roundPercent((used / limit) * 100) : null
  return { used, limit, remaining, percent }
}

function kimiReset(value) {
  if (typeof value !== 'string' || value === '') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

async function collectKimi(region, key, fetchedAt) {
  const regionDef = PROVIDERS.kimi.regions[region]
  const body = await httpGetJson(regionDef.urls[0], key, PROVIDERS.kimi.extraHeaders)

  const windows = []
  const extras = []
  // 优先用新版 usages.limit_5h / limit_7d（直接给 used_ratio 0~1）。
  const usages = isObject(body.usages) ? body.usages : null
  const ratioWindow = (key, id, title, shortTitle) => {
    const entry = usages !== null && isObject(usages[key]) ? usages[key] : null
    if (entry === null) return false
    const ratio = Number(entry.used_ratio)
    const usedPercent = Number.isFinite(ratio) ? clampPercent(ratio * 100) : null
    windows.push({
      id,
      title,
      shortTitle,
      unit: null,
      number: null,
      usedPercent,
      remainingPercent: usedPercent === null ? null : roundPercent(100 - usedPercent),
      severity: severityOf(usedPercent),
      resetAt: kimiReset(entry.reset_time),
    })
    return true
  }
  const hasNew = ratioWindow('limit_5h', 'session', '5 小时窗口', '5 小时')
  ratioWindow('limit_7d', 'weekly', '每周窗口', '每周')

  // 旧版结构兜底：usage = 周额度，limits[] = 滚动窗口（window.duration + timeUnit）。
  if (!hasNew) {
    const weekly = kimiQuota(body.usage)
    if (weekly !== null) {
      windows.push({
        id: 'weekly',
        title: '每周窗口',
        shortTitle: '每周',
        unit: null,
        number: null,
        usedPercent: weekly.percent === null ? null : clampPercent(weekly.percent),
        remainingPercent: weekly.percent === null ? null : roundPercent(100 - weekly.percent),
        severity: severityOf(weekly.percent),
        resetAt: kimiReset(isObject(body.usage) ? body.usage.resetTime : null),
      })
    }
    const limits = Array.isArray(body.limits) ? body.limits.filter(isObject) : []
    for (const limit of limits) {
      const window = isObject(limit.window) ? limit.window : {}
      const detail = isObject(limit.detail) ? limit.detail : limit
      const quota = kimiQuota(detail)
      if (quota === null) continue
      const duration = Number(window.duration) || 0
      const unit = typeof window.timeUnit === 'string' ? window.timeUnit : ''
      const minutes = unit.includes('MINUTE') ? duration : unit.includes('HOUR') ? duration * 60 : duration
      const hours = Math.round((minutes / 60) * 10) / 10
      const title = Number.isInteger(hours) ? `${hours} 小时窗口` : `${minutes} 分钟窗口`
      windows.push({
        id: 'session',
        title,
        shortTitle: Number.isInteger(hours) ? `${hours} 小时` : `${minutes} 分钟`,
        unit: null,
        number: hours,
        usedPercent: quota.percent === null ? null : clampPercent(quota.percent),
        remainingPercent: quota.percent === null ? null : roundPercent(100 - quota.percent),
        severity: severityOf(quota.percent),
        resetAt: kimiReset(detail.resetTime),
      })
    }
  }

  // 加量包（boosterWallet）与并发上限放进 extras。
  const wallet = isObject(body.boosterWallet) ? body.boosterWallet : null
  const walletBal = wallet !== null && isObject(wallet.balance) ? wallet.balance : null
  const amountLeft = Number(walletBal !== null ? walletBal.amountLeft : wallet !== null ? wallet.amountLeft : NaN)
  if (Number.isFinite(amountLeft)) {
    extras.push({
      id: 'booster',
      title: '加量包剩余',
      used: null,
      total: null,
      remaining: amountLeft,
      usedPercent: null,
      resetAt: kimiReset(walletBal !== null ? walletBal.periodEnd : wallet !== null ? wallet.periodEnd : null),
      details: [],
    })
  }
  const parallel = isObject(body.parallel) ? body.parallel : {}
  const parallelLimit = Number(parallel.limit)
  if (Number.isFinite(parallelLimit)) {
    extras.push({ id: 'parallel', title: '并发上限', used: null, total: parallelLimit, remaining: null, usedPercent: null, resetAt: null, details: [] })
  }

  const user = isObject(body.user) ? body.user : {}
  const membership = isObject(user.membership) ? user.membership : {}
  const level = typeof membership.level === 'string' && membership.level !== '' ? membership.level : null
  if (windows.length === 0 && extras.length === 0) throw new Error('响应里没有可识别的额度数据')

  const order = { session: 0, weekly: 1 }
  windows.sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9))
  return { windows, extras, plan: null, level }
}

// ---------------------------------------------------------------------------
// 宿主装配
// ---------------------------------------------------------------------------

export function apply(ctx) {
  /** credentials / tools 都是可选服务：宿主没提供时插件仍然能用。
   *  热重建时服务可能晚于插件就绪，所以每次使用时都重新解析，而不是只在 apply 时取一次。 */
  const services = () => ({
    credentials: typeof ctx.get === 'function' ? ctx.get('credentials') : undefined,
    tools: typeof ctx.get === 'function' ? ctx.get('tools') : undefined,
  })

  let config = loadConfig()
  const state = {}
  const ledgerPath = join(homeDir(), 'dsh-quota-hub', 'ledger.json')
  const ledger = loadLedger()
  let detachUsageCapture = null
  // -------------------------------------------------------------------------
  // DeepSeek：官方余额 + 今日花费（本地估算）
  // -------------------------------------------------------------------------

  async function collectDeepseek(_region, key, fetchedAt) {
    const body = await httpGetJson('https://api.deepseek.com/user/balance', key)
    if (body.is_available === false || !Array.isArray(body.balance_infos) || body.balance_infos.length === 0) {
      throw new Error('DeepSeek 余额接口返回为空（账户不可用或 Key 无效）。')
    }
    const primary = body.balance_infos[0]
    const money = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? '?'))
    const headline = `${primary.currency === 'CNY' ? '¥' : primary.currency + ' '}${money(primary.total_balance)}`
    const extras = [
      {
        id: 'balance',
        title: '账户余额（官方）',
        display: headline,
        detail: `充值 ${money(primary.topped_up_balance)} / 赠送 ${money(primary.granted_balance)}（${primary.currency}）`,
      },
    ]
    const spend = deepseekTodaySpend()
    if (spend !== null) {
      extras.push({
        id: 'today',
        title: '今日花费（本地估算）',
        display: `$${spend.cost.toFixed(3)}`,
        detail: `${spend.requests} 次请求（高峰 ${spend.peakRequests} / 错峰 ${spend.offRequests}），按会话日志 token×价格×峰谷估算，非账单口径`,
      })
    }
    // 峰谷定价信息（官方规则：UTC 工作日 01-04 / 06-10 高峰，其余半价）
    const nowPeak = deepseekIsPeak(fetchedAt)
    extras.push({
      id: 'zone',
      title: '当前定价区间',
      display: nowPeak ? '高峰时段' : '错峰时段（半价）',
      detail: '高峰=UTC 周一至周五 01:00-04:00 与 06:00-10:00；周末全天错峰。中国法定节假日豁免未内置',
    })
    const flashP = DEEPSEEK_PRICES['deepseek-flash']
    const proP = DEEPSEEK_PRICES['deepseek-v4-pro']
    extras.push({
      id: 'pricing',
      title: '模型定价（每百万 token，高峰价）',
      display: `flash 命中 $${flashP.cacheHitInput} · 未命中 $${flashP.cacheMissInput} · 输出 $${flashP.output}`,
      detail: `v4-pro 命中 $${proP.cacheHitInput} · 未命中 $${proP.cacheMissInput} · 输出 $${proP.output}；错峰一律半价。在 config providers.deepseek.prices 可覆盖`,
    })
    return { level: null, plan: null, headline, windows: [], extras }
  }

  // ---- 会话事件 → 用量行（幂等：sessionId:seq） ----

  function foldDeepseekEvents(events) {
    const rows = []
    let header = null
    let last = null
    const settle = (turn, step, seq, time, usage) => {
      if (!last || last.turn !== turn || last.step !== step || last.settled) return
      const u = usage && typeof usage === 'object' ? usage : {}
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
      const totalInput = num(u.inputTokens)
      const cacheHit = Math.min(num(u.cacheReadTokens), totalInput)
      rows.push({
        seq,
        time,
        provider: header ? header.provider : undefined,
        model: header ? header.model : undefined,
        cacheHitInput: cacheHit,
        cacheMissInput: totalInput - cacheHit,
        output: num(u.outputTokens),
        reasoning: num(u.reasoningTokens),
        failed: false,
      })
      last.settled = true
    }
    for (const event of Array.isArray(events) ? events : []) {
      if (!isObject(event)) continue
      const data = isObject(event.data) ? event.data : {}
      const seq = typeof event.seq === 'number' ? event.seq : 0
      const time = typeof event.time === 'number' ? event.time : Date.now()
      switch (event.type) {
        case 'request/header': {
          const cfg = data.header && isObject(data.header.config) ? data.header.config : null
          if (cfg && (typeof cfg.provider === 'string' || typeof cfg.model === 'string')) {
            header = { provider: cfg.provider, model: cfg.model }
          }
          break
        }
        case 'step/start':
          last = { turn: data.turn, step: data.step, settled: false }
          break
        case 'assistant/chunk': {
          const chunk = isObject(data.chunk) ? data.chunk : null
          if (chunk && chunk.type === 'usage') settle(data.turn, data.step, seq, time, chunk.usage)
          break
        }
        case 'assistant/message':
          if (data.usage !== undefined) settle(data.turn, data.step, seq, time, data.usage)
          break
        case 'turn/end':
          last = null
          break
        default:
          break
      }
    }
    return rows
  }

  const isDeepseekRow = (row) =>
    /deepseek/i.test(String(row.provider ?? '')) ||
    ((row.provider === undefined || row.provider === null) && /deepseek/i.test(String(row.model ?? '')))

  function deepseekRowCost(row) {
    const prices = config.providers.deepseek && config.providers.deepseek.prices
    const p = deepseekPriceRow(prices, row.model)
    const factor = deepseekIsPeak(row.time) ? 1 : 0.5
    return (
      (row.cacheHitInput * p.cacheHitInput +
        row.cacheMissInput * p.cacheMissInput +
        (row.output + row.reasoning) * p.output) *
      factor /
      1_000_000
    )
  }

  function deepseekTodaySpend() {
    const now = new Date()
    const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
    let cost = 0
    let requests = 0
    let peakRequests = 0
    let offRequests = 0
    for (const row of Object.values(ledger.rows)) {
      if (!isDeepseekRow(row)) continue
      const d = new Date(row.time)
      if (`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` !== todayKey) continue
      if (row.failed) continue
      cost += deepseekRowCost(row)
      requests += 1
      if (deepseekIsPeak(row.time)) peakRequests += 1
      else offRequests += 1
    }
    return { cost, requests, peakRequests, offRequests }
  }

  // ---- ledger 持久化（$DSH_HOME/dsh-quota-hub/ledger.json，保留 7 天） ----

  function loadLedger() {
    try {
      let rawText = null
      try {
        rawText = readFileSync(ledgerPath, 'utf8')
      } catch {
        try {
          rawText = readFileSync(join(homeDir(), 'glm-quota', 'ledger.json'), 'utf8')
        } catch {}
      }
      if (rawText === null) throw new Error('ledger not found')
      const raw = JSON.parse(rawText)
      if (raw && isObject(raw.rows)) return { version: 1, rows: raw.rows }
    } catch {}
    return { version: 1, rows: {} }
  }

  let ledgerSaveTimer = null
  function scheduleLedgerSave() {
    if (ledgerSaveTimer !== null) return
    ledgerSaveTimer = setTimeout(() => {
      ledgerSaveTimer = null
      try {
        const cutoff = Date.now() - 7 * 24 * 3600_000
        for (const [k, row] of Object.entries(ledger.rows)) {
          if (row.time < cutoff) delete ledger.rows[k]
        }
        mkdirSync(dirname(ledgerPath), { recursive: true })
        writeFileSync(ledgerPath, JSON.stringify(ledger))
      } catch {}
    }, 15_000)
    if (ledgerSaveTimer.unref) ledgerSaveTimer.unref()
  }

  function upsertLedgerRows(sessionId, rows) {
    let added = 0
    for (const row of rows) {
      const key = `${sessionId}:${row.seq}`
      if (ledger.rows[key] === undefined) {
        ledger.rows[key] = row
        added += 1
      }
    }
    if (added > 0) scheduleLedgerSave()
    return added
  }

  // 实时：session/event 广播 → 缓冲 → 折叠入库
  const liveBuffers = new Map()
  function attachUsageCapture(ctx) {
    let off = null
    try {
      off = ctx.on('session/event', (session, event) => {
        if (!session || typeof session.id !== 'string' || !event || typeof event.seq !== 'number') return
        let buf = liveBuffers.get(session.id)
        if (!buf) liveBuffers.set(session.id, (buf = []))
        buf.push(event)
        if (buf.length >= 50) {
          liveBuffers.set(session.id, [])
          upsertLedgerRows(session.id, foldDeepseekEvents(buf))
        }
      })
    } catch {}
    const timer = setInterval(() => {
      for (const [id, buf] of liveBuffers) {
        if (buf.length === 0) continue
        liveBuffers.set(id, [])
        upsertLedgerRows(id, foldDeepseekEvents(buf))
      }
    }, 15_000)
    if (timer.unref) timer.unref()
    return () => {
      if (typeof off === 'function') off()
      clearInterval(timer)
    }
  }

  // 启动补扫：把历史会话日志折叠入库（幂等，不会重复计数）
  async function scanSessionLogs(ctx) {
    let sessionQuery = null
    try {
      sessionQuery = ctx.get('sessionQuery')
    } catch {}
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return
    try {
      const list = await sessionQuery.listSessions()
      for (const record of Array.isArray(list) ? list : []) {
        const header = record && record.header ? record.header : record
        const sessionId = header && header.id
        if (typeof sessionId !== 'string' || sessionId === '') continue
        try {
          const snapshot = await sessionQuery.readSession(sessionId)
          const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
          upsertLedgerRows(sessionId, foldDeepseekEvents(events))
        } catch {}
      }
    } catch {}
  }

  for (const id of PROVIDER_IDS) state[id] = { snapshot: null, inflight: null }
  let timer = null

  const publicConfig = () => ({
    version: 2,
    intervalSeconds: config.intervalSeconds,
    enabled: config.enabled,
    providers: PROVIDER_IDS.map((id) => {
      const def = PROVIDERS[id]
      const pc = config.providers[id]
      return {
        id,
        label: def.label,
        region: pc.region,
        regionLabel: def.regions[pc.region].label,
        regionOptions: Object.values(def.regions).map((r) => ({ value: r.id, label: r.label })),
        keyRef: effectiveKeyRef(id, pc),
        customKeyRef: pc.keyRef,
        defaultKeyRef: def.defaultKeyRef(pc.region),
        enabled: pc.enabled,
      }
    }),
  })

  async function keyStatus(providerId) {
    const pc = config.providers[providerId]
    const ref = effectiveKeyRef(providerId, pc)
    const credentials = services().credentials
    if (credentials === undefined || typeof credentials.describe !== 'function') {
      const ambient = typeof process.env[ref] === 'string' && process.env[ref] !== ''
      return { ref, configured: ambient, source: ambient ? 'env' : null, writable: false, writableReason: '宿主没有凭证服务' }
    }
    try {
      const info = await credentials.describe(ref)
      return {
        ref,
        configured: info.configured === true,
        source: typeof info.source === 'string' ? info.source : null,
        writable: info.writable === true,
      }
    } catch (cause) {
      return { ref, configured: false, source: null, writable: false, writableReason: String(cause) }
    }
  }

  async function resolveKey(providerId) {
    const pc = config.providers[providerId]
    const ref = effectiveKeyRef(providerId, pc)
    const credentials = services().credentials
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(ref)
        if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value !== '') {
          return resolved.value.trim()
        }
      } catch {
        /* 落到环境变量 */
      }
    }
    const fromEnv = typeof process.env[ref] === 'string' ? process.env[ref].trim() : ''
    return fromEnv === '' ? null : fromEnv
  }

  async function errorSnapshot(providerId, message, extra = {}) {
    const pc = config.providers[providerId]
    const def = PROVIDERS[providerId]
    return {
      provider: providerId,
      label: def.label,
      ok: false,
      fetchedAt: Date.now(),
      region: pc.region,
      regionLabel: def.regions[pc.region].label,
      level: null,
      plan: null,
      windows: [],
      extras: [],
      worstWindowId: null,
      worstUsedPercent: null,
      error: message,
      needsKey: false,
      ...extra,
    }
  }

  /** 单个 provider 的一次完整取数。 */
  async function collect(providerId) {
    const def = PROVIDERS[providerId]
    const pc = config.providers[providerId]
    if (!pc.enabled) {
      return errorSnapshot(providerId, '该 provider 已在配置中停用。', { disabled: true })
    }
    const fetchedAt = Date.now()
    const key = await resolveKey(providerId)
    if (key === null) {
      return errorSnapshot(providerId, `没有找到可用的 API Key（期望凭证 ${effectiveKeyRef(providerId, pc)}）。${def.needsKeyHint}`, {
        needsKey: true,
      })
    }
    try {
      const collectFn =
        providerId === 'glm'
          ? collectGlm
          : providerId === 'minimax'
            ? collectMinimax
            : providerId === 'kimi'
              ? collectKimi
              : collectDeepseek
      const data = await collectFn(pc.region, key, fetchedAt)
      const worst = data.windows.reduce(
        (acc, w) => (w.usedPercent !== null && (acc === null || w.usedPercent > acc.usedPercent) ? w : acc),
        null,
      )
      return {
        provider: providerId,
        label: def.label,
        ok: true,
        fetchedAt,
        region: pc.region,
        regionLabel: def.regions[pc.region].label,
        level: data.level,
        plan: data.plan,
        headline: data.headline,
        windows: data.windows,
        extras: data.extras,
        worstWindowId: worst === null ? null : worst.id,
        worstUsedPercent: worst === null ? null : worst.usedPercent,
        error: null,
        needsKey: false,
      }
    } catch (cause) {
      return errorSnapshot(providerId, cause instanceof Error ? cause.message : String(cause))
    }
  }

  function getSnapshot(providerId, force) {
    const slot = state[providerId]
    // 错误快照（尤其 needsKey）只短缓存：凭证服务晚就绪/用户刚存 Key 后能很快自愈。
    const ttl = slot.snapshot !== null && slot.snapshot.ok !== true ? ERROR_TTL_MS : CACHE_TTL_MS
    const fresh = slot.snapshot !== null && Date.now() - slot.snapshot.fetchedAt < ttl
    if (!force && fresh) return Promise.resolve(slot.snapshot)
    if (slot.inflight !== null) return slot.inflight
    slot.inflight = collect(providerId)
      .then((snapshot) => {
        slot.snapshot = snapshot
        return snapshot
      })
      .catch((cause) => {
        const snapshot = errorSnapshot(providerId, cause instanceof Error ? cause.message : String(cause))
        slot.snapshot = snapshot
        return snapshot
      })
      .finally(() => {
        slot.inflight = null
      })
    return slot.inflight
  }

  async function statusPayload(force = false) {
    const entries = await Promise.all(
      PROVIDER_IDS.map(async (id) => {
        const [snapshot, key] = await Promise.all([getSnapshot(id, force), keyStatus(id)])
        return { ...snapshot, key }
      }),
    )
    return { ok: true, config: publicConfig(), providers: entries }
  }

  function schedule() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (!config.enabled) return
    const period = Math.max(MIN_INTERVAL_SECONDS, config.intervalSeconds) * 1000
    timer = setInterval(() => {
      for (const id of PROVIDER_IDS) void getSnapshot(id, true)
    }, period)
    if (typeof timer.unref === 'function') timer.unref()
  }

  // ---- 路由 -------------------------------------------------------------

  const handleStatus = (req, res) => {
    registerTool() // 热重建后 tools 服务可能晚就绪，顺路补注册
    void statusPayload(false)
      .then((payload) => sendJson(res, payload))
      .catch((cause) => sendJson(res, { ok: false, error: String(cause) }, 500))
  }

  const handleRefresh = (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: '只支持 POST' }, 405)
      return
    }
    for (const id of PROVIDER_IDS) {
      state[id].snapshot = null
      state[id].inflight = null
    }
    void statusPayload(true)
      .then((payload) => sendJson(res, payload))
      .catch((cause) => sendJson(res, { ok: false, error: String(cause) }, 500))
  }

  const handleConfig = (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, { ok: true, config: publicConfig() })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: '只支持 GET / POST' }, 405)
      return
    }
    void (async () => {
      const patch = await readBody(req)
      if (!isObject(patch)) {
        sendJson(res, { ok: false, error: '请求体必须是对象' }, 400)
        return
      }
      const next = JSON.parse(JSON.stringify(config))

      // patch 形状：
      //   { provider: 'minimax', region?: 'cn'|'global', keyRef?: string|null,
      //     enabled?: boolean, apiKey?: string }
      //   顶层 intervalSeconds / enabled 仍然是全局的。
      const providerId = typeof patch.provider === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, patch.provider) ? patch.provider : null

      if (Object.prototype.hasOwnProperty.call(patch, 'intervalSeconds')) {
        const interval = Number(patch.intervalSeconds)
        if (!Number.isFinite(interval)) {
          sendJson(res, { ok: false, error: 'intervalSeconds 必须是数字' }, 400)
          return
        }
        next.intervalSeconds = Math.min(3600, Math.max(MIN_INTERVAL_SECONDS, Math.round(interval)))
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
        if (typeof patch.enabled !== 'boolean') {
          sendJson(res, { ok: false, error: 'enabled 必须是布尔值' }, 400)
          return
        }
        next.enabled = patch.enabled
      }

      if (providerId !== null) {
        const pc = next.providers[providerId]
        const def = PROVIDERS[providerId]
        if (Object.prototype.hasOwnProperty.call(patch, 'region')) {
          if (typeof patch.region !== 'string' || !Object.prototype.hasOwnProperty.call(def.regions, patch.region)) {
            sendJson(res, { ok: false, error: 'region 只能是 ' + Object.keys(def.regions).join(' / ') }, 400)
            return
          }
          pc.region = patch.region
          // 区域变化后默认凭证名跟随区域，除非用户显式写过 keyRef。
          if (!pc.keyRef) pc.keyRef = null
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'keyRef')) {
          if (patch.keyRef !== null && (typeof patch.keyRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(patch.keyRef))) {
            sendJson(res, { ok: false, error: 'keyRef 必须是合法的环境变量名或 null' }, 400)
            return
          }
          pc.keyRef = patch.keyRef === null || patch.keyRef === '' ? null : patch.keyRef
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'providerEnabled')) {
          if (typeof patch.providerEnabled !== 'boolean') {
            sendJson(res, { ok: false, error: 'providerEnabled 必须是布尔值' }, 400)
            return
          }
          pc.enabled = patch.providerEnabled
        }
        // Key 写入走凭证服务：空串表示清除，非空表示保存。
        if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
          if (typeof patch.apiKey !== 'string') {
            sendJson(res, { ok: false, error: 'apiKey 必须是字符串' }, 400)
            return
          }
          const credentials = services().credentials
          if (credentials === undefined || typeof credentials.set !== 'function') {
            sendJson(res, { ok: false, error: '宿主没有凭证服务，无法保存 API Key' }, 501)
            return
          }
          const value = patch.apiKey.trim()
          const ref = effectiveKeyRef(providerId, pc)
          try {
            if (value === '') await credentials.unset(ref)
            else await credentials.set(ref, value)
          } catch (cause) {
            sendJson(res, { ok: false, error: `保存 API Key 失败：${cause instanceof Error ? cause.message : String(cause)}` }, 500)
            return
          }
          state[providerId].snapshot = null
        }
      }

      const changed =
        next.intervalSeconds !== config.intervalSeconds ||
        next.enabled !== config.enabled ||
        PROVIDER_IDS.some((id) => JSON.stringify(next.providers[id]) !== JSON.stringify(config.providers[id]))
      config = next
      try {
        saveConfig(config)
      } catch (cause) {
        sendJson(res, { ok: false, error: `保存配置失败：${cause instanceof Error ? cause.message : String(cause)}` }, 500)
        return
      }
      if (changed) schedule()
      if (providerId !== null) {
        // region / keyRef 变了就该立刻重查。
        state[providerId].snapshot = null
      }
      sendJson(res, await statusPayload(true))
    })().catch((cause) => {
      sendJson(res, { ok: false, error: cause instanceof Error ? cause.message : String(cause) }, 500)
    })
  }

  // ---- agent 工具（可选增强） -------------------------------------------

  let toolRegistered = false
  function registerTool() {
    if (toolRegistered) return
    const tools = services().tools
    if (tools === undefined || typeof tools.register !== 'function') return
    try {
      tools.register({
        name: 'glm_quota',
        description:
          '查询已配置的 Coding Plan 额度（GLM Coding Plan、MiniMax Token Plan）：各窗口已用百分比、重置时间与订阅信息。用户问「额度还剩多少」「还能用多久」时调用。',
        parameters: {
          type: 'object',
          properties: {
            refresh: { type: 'boolean', description: '为 true 时跳过 30 秒缓存，强制向接口重新查询。' },
            provider: { type: 'string', description: '只查某一家：glm 或 minimax。缺省查全部。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => [{ type: 'text', text: formatForModel(value) }],
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        execute: async (args) => {
          const force = isObject(args) && args.refresh === true
          const only = isObject(args) && typeof args.provider === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, args.provider) ? args.provider : null
          const payload = await statusPayload(force)
          const providers = only === null ? payload.providers : payload.providers.filter((p) => p.provider === only)
          return { ok: true, providers }
        },
      })
      toolRegistered = true
    } catch {
      /* 工具注册失败不该拖垮插件 */
    }
  }

  function formatForModel(value) {
    if (!isObject(value) || !Array.isArray(value.providers)) return '没有拿到额度数据。'
    const blocks = []
    for (const snapshot of value.providers) {
      const lines = [`【${snapshot.label}】`]
      if (snapshot.ok !== true) {
        lines.push(`查询失败：${snapshot.error ?? '未知错误'}`)
        blocks.push(lines.join('\n'))
        continue
      }
      const planName = snapshot.plan !== null && typeof snapshot.plan.name === 'string' ? snapshot.plan.name : null
      lines.push(`套餐：${planName ?? '未知'}${snapshot.level ? `（${snapshot.level}）` : ''}`)
      if (snapshot.plan !== null && typeof snapshot.plan.nextRenewTime === 'string') lines.push(`下次续费：${snapshot.plan.nextRenewTime}`)
      for (const window of snapshot.windows) {
        const used = window.usedPercent === null ? '未知' : `${window.usedPercent}%`
        const left = window.remainingPercent === null ? '未知' : `${window.remainingPercent}%`
        lines.push(`${window.title}：已用 ${used}，剩余 ${left}，重置 ${window.resetAt ?? '未知'}`)
      }
      for (const extra of snapshot.extras) {
        if (extra.usedPercent !== null && extra.usedPercent !== undefined) {
          lines.push(`${extra.title}：剩余 ${extra.remainingPercent ?? '?'}%（5 小时窗口）`)
        } else {
          lines.push(`${extra.title}：${extra.used ?? '?'} / ${extra.total ?? '?'}，重置 ${extra.resetAt ?? '未知'}`)
        }
      }
      lines.push(`查询时间：${new Date(snapshot.fetchedAt).toISOString()}`)
      blocks.push(lines.join('\n'))
    }
    return blocks.join('\n\n')
  }

  // ---- 挂载 -------------------------------------------------------------

  try {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: `${BASE}/status.json`, handler: handleStatus }), 'dsh-quota-hub: status')
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: `${BASE}/refresh.json`, handler: handleRefresh }), 'dsh-quota-hub: refresh')
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: `${BASE}/config.json`, handler: handleConfig }), 'dsh-quota-hub: config')
  } catch (cause) {
    throw new Error(`dsh-quota-hub：路由注册失败（${cause instanceof Error ? cause.message : String(cause)}）`)
  }

  registerTool()
  schedule()
  // DeepSeek 今日花费：实时监听 + 启动后补扫历史会话（都幂等，不会重复计数）。
  try {
    ctx.effect(() => attachUsageCapture(ctx), 'dsh-quota-hub: usage-capture')
  } catch {
    detachUsageCapture = attachUsageCapture(ctx)
  }
  const scanTimer = setTimeout(() => {
    void scanSessionLogs(ctx).catch(() => {})
  }, 3_000)
  if (scanTimer.unref) scanTimer.unref()
  // 启动时就预热一次，徽标打开即有数。
  for (const id of PROVIDER_IDS) void getSnapshot(id, false)
}
