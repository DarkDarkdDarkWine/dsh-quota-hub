/**
 * dsh-glm-quota — 宿主端（聚合版：GLM + MiniMax）。
 *
 * 职责：向各家 Coding Plan 的监控接口取额度快照，通过本地 HTTP 路由交给
 * 界面。取哪个 Key、打哪个域名、缓存多久都收敛在这里，界面端只负责画。
 *
 * 路由（全部在 /dsh-glm-quota 前缀下）：
 *
 *   GET  /dsh-glm-quota/status.json   所有 provider 的快照 + 配置 + Key 状态（命中缓存）
 *   POST /dsh-glm-quota/refresh.json  强制刷新，返回同样结构
 *   GET  /dsh-glm-quota/config.json   只读配置
 *   POST /dsh-glm-quota/config.json   改 region / 刷新间隔 / Key（provider 维度）
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
import { join } from 'node:path'

export const name = 'dsh-glm-quota'

/** 路由是宿主端唯一需要的服务；credentials / tools 都是可选增强。 */
export const inject = ['webServer']

const BASE = '/dsh-glm-quota'
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
}

const PROVIDER_IDS = Object.keys(PROVIDERS)

// ---------------------------------------------------------------------------
// 配置（v2：provider 维度；读取时自动迁移 v1 的扁平结构）
// ---------------------------------------------------------------------------

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function configPath() {
  return join(homeDir(), 'glm-quota', 'config.json')
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
  const dir = join(homeDir(), 'glm-quota')
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
async function httpGetJson(url, key) {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      'user-agent': 'dsh-glm-quota/0.2.0',
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
      const data = providerId === 'glm' ? await collectGlm(pc.region, key, fetchedAt) : await collectMinimax(pc.region, key, fetchedAt)
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
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: `${BASE}/status.json`, handler: handleStatus }), 'dsh-glm-quota: status')
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: `${BASE}/refresh.json`, handler: handleRefresh }), 'dsh-glm-quota: refresh')
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: `${BASE}/config.json`, handler: handleConfig }), 'dsh-glm-quota: config')
  } catch (cause) {
    throw new Error(`dsh-glm-quota：路由注册失败（${cause instanceof Error ? cause.message : String(cause)}）`)
  }

  registerTool()
  schedule()
  // 启动时就预热一次，徽标打开即有数。
  for (const id of PROVIDER_IDS) void getSnapshot(id, false)
}
