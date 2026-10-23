/**
 * dsh-glm-quota — 宿主端。
 *
 * 职责只有两件：向智谱 / Z.ai 的监控接口取一次额度快照，并通过本地
 * HTTP 路由把它交给界面。所有判断（取哪个 Key、打哪个域名、缓存多久）
 * 都收敛在这里，界面端只负责画。
 *
 * 路由（全部在 /dsh-glm-quota 前缀下）：
 *
 *   GET  /dsh-glm-quota/status.json   当前快照 + 配置 + Key 状态（命中缓存）
 *   POST /dsh-glm-quota/refresh.json  强制刷新一次，返回同样结构
 *   GET  /dsh-glm-quota/config.json   只读配置
 *   POST /dsh-glm-quota/config.json   改 region / 刷新间隔 / Key
 *
 * 接口事实（2026-10 实测）：
 *   CN      https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *   Global  https://api.z.ai/api/monitor/usage/quota/limit
 *   data.limits[] 里 TIME_LIMIT 有 usage/currentValue/remaining；
 *   两个 TOKENS_LIMIT 只有 percentage + nextResetTime，没有绝对值。
 *   unit 3 = 5 小时会话窗口，unit 6 = 每周窗口（number 不保证是 7，别拿它判断）。
 *   未授权时 HTTP 仍然是 200，必须看 body.code。
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
const DEFAULT_KEY_REF = 'ZAI_CODING_CN_API_KEY'
const FALLBACK_KEY_REF = 'GLM_QUOTA_API_KEY'
const CACHE_TTL_MS = 30_000
const ERROR_TTL_MS = 10_000
const MIN_INTERVAL_SECONDS = 60
const MAX_BODY_BYTES = 64 * 1024

const REGIONS = {
  cn: { id: 'cn', label: '国内版 bigmodel.cn', origin: 'https://open.bigmodel.cn' },
  global: { id: 'global', label: '国际版 z.ai', origin: 'https://api.z.ai' },
}

const DEFAULTS = {
  region: 'cn',
  keyRef: DEFAULT_KEY_REF,
  intervalSeconds: 120,
  enabled: true,
}

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function configPath() {
  return join(homeDir(), 'glm-quota', 'config.json')
}

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

function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
    return normalizeConfig(parsed)
  } catch {
    return { ...DEFAULTS }
  }
}

function normalizeConfig(raw) {
  const next = { ...DEFAULTS }
  if (!isObject(raw)) return next
  if (typeof raw.region === 'string' && Object.prototype.hasOwnProperty.call(REGIONS, raw.region)) next.region = raw.region
  if (typeof raw.keyRef === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.keyRef)) next.keyRef = raw.keyRef
  const interval = Number(raw.intervalSeconds)
  if (Number.isFinite(interval)) next.intervalSeconds = Math.min(3600, Math.max(MIN_INTERVAL_SECONDS, Math.round(interval)))
  if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled
  return next
}

function saveConfig(config) {
  const dir = join(homeDir(), 'glm-quota')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
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

/**
 * 一次接口调用。智谱的鉴权失败是 HTTP 200 + code 401，
 * 所以状态码与业务码都要看。
 */
async function fetchJson(url, key) {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      'user-agent': 'dsh-glm-quota/0.1.0',
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
    const reason = isObject(body) && typeof body.msg === 'string' ? body.msg : `HTTP ${res.status}`
    throw new Error(reason)
  }
  const code = isObject(body) && typeof body.code === 'number' ? body.code : 200
  if (code !== 200 && code !== 0) {
    const reason = isObject(body) && typeof body.msg === 'string' ? body.msg : `接口返回 code=${code}`
    throw new Error(code === 401 || code === 1000 || code === 1001 ? `${reason}（Key 无效或已过期）` : reason)
  }
  return body
}

function windowTitle(unit, number) {
  const n = Number(number) || 1
  if (unit === 3) return `${n} 小时窗口`
  if (unit === 6) return n > 1 ? `${n} 周窗口` : '每周窗口'
  return `额度窗口 ${unit}-${n}`
}

function windowShortTitle(unit, number) {
  const n = Number(number) || 1
  if (unit === 3) return `${n} 小时`
  if (unit === 6) return n > 1 ? `${n} 周` : '每周'
  return `窗口 ${unit}-${n}`
}

function windowId(unit) {
  if (unit === 3) return 'session'
  if (unit === 6) return 'weekly'
  return `unit-${unit}`
}

function severityOf(usedPercent) {
  if (usedPercent === null) return 'unknown'
  if (usedPercent >= 90) return 'critical'
  if (usedPercent >= 70) return 'warn'
  return 'ok'
}

/** 把 quota 的 data 摊成界面要的形状；subscription 只是补充信息。 */
function buildSnapshot({ quota, subscription, region, fetchedAt }) {
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
      id: windowId(limit.unit),
      title: windowTitle(limit.unit, limit.number),
      shortTitle: windowShortTitle(limit.unit, limit.number),
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

  const worst = windows.reduce((acc, w) => (w.usedPercent !== null && (acc === null || w.usedPercent > acc.usedPercent) ? w : acc), null)

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
    ok: true,
    fetchedAt,
    region,
    host: REGIONS[region].origin,
    level: typeof data.level === 'string' ? data.level : null,
    plan,
    windows,
    extras,
    worstWindowId: worst === null ? null : worst.id,
    worstUsedPercent: worst === null ? null : worst.usedPercent,
    error: null,
    needsKey: false,
  }
}

export function apply(ctx) {
  /** credentials / tools 都是可选服务：宿主没提供时插件仍然能用。
   *  热重建时服务可能晚于插件就绪，所以每次使用时都重新解析，而不是只在 apply 时取一次。 */
  const services = () => ({
    credentials: typeof ctx.get === 'function' ? ctx.get('credentials') : undefined,
    tools: typeof ctx.get === 'function' ? ctx.get('tools') : undefined,
  })

  let config = loadConfig()
  const cache = { snapshot: null, inflight: null }
  let timer = null

  const publicConfig = () => ({
    region: config.region,
    regionLabel: REGIONS[config.region].label,
    regionOptions: Object.values(REGIONS).map((r) => ({ value: r.id, label: r.label })),
    keyRef: config.keyRef,
    defaultKeyRef: DEFAULT_KEY_REF,
    fallbackKeyRef: FALLBACK_KEY_REF,
    intervalSeconds: config.intervalSeconds,
    enabled: config.enabled,
  })

  async function keyStatus() {
    const ref = config.keyRef
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

  async function resolveKey() {
    const ref = config.keyRef
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

  async function errorSnapshot(message, extra = {}) {
    return {
      ok: false,
      fetchedAt: Date.now(),
      region: config.region,
      host: REGIONS[config.region].origin,
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

  /** 打两次接口，合成一份快照；订阅信息失败不影响额度本身。 */
  async function collect() {
    const fetchedAt = Date.now()
    const key = await resolveKey()
    if (key === null) {
      return errorSnapshot(`没有找到可用的 API Key（期望凭证 ${config.keyRef}）。插件默认自动复用「设置 → 模型」里 GLM 提供商的 Key；如果那里已配好，请检查区域设置是否一致。`, {
        needsKey: true,
      })
    }
    const origin = REGIONS[config.region].origin
    let quota
    try {
      quota = await fetchJson(`${origin}/api/monitor/usage/quota/limit`, key)
    } catch (cause) {
      return errorSnapshot(cause instanceof Error ? cause.message : String(cause))
    }
    let subscription = null
    try {
      subscription = await fetchJson(`${origin}/api/biz/subscription/list`, key)
    } catch {
      subscription = null
    }
    return buildSnapshot({ quota, subscription, region: config.region, fetchedAt })
  }

  function getSnapshot(force) {
    // 错误快照（尤其 needsKey）只短缓存：凭证服务晚就绪/用户刚存 Key 后能很快自愈。
    const ttl = cache.snapshot !== null && cache.snapshot.ok !== true ? ERROR_TTL_MS : CACHE_TTL_MS
    const fresh = cache.snapshot !== null && Date.now() - cache.snapshot.fetchedAt < ttl
    if (!force && fresh) return Promise.resolve(cache.snapshot)
    if (cache.inflight !== null) return cache.inflight
    cache.inflight = collect()
      .then((snapshot) => {
        cache.snapshot = snapshot
        return snapshot
      })
      .catch((cause) => {
        const snapshot = errorSnapshot(cause instanceof Error ? cause.message : String(cause))
        cache.snapshot = snapshot
        return snapshot
      })
      .finally(() => {
        cache.inflight = null
      })
    return cache.inflight
  }

  async function statusPayload() {
    const [snapshot, key] = await Promise.all([getSnapshot(false), keyStatus()])
    return { ok: true, config: publicConfig(), key, snapshot }
  }

  function schedule() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (!config.enabled) return
    const period = Math.max(MIN_INTERVAL_SECONDS, config.intervalSeconds) * 1000
    timer = setInterval(() => {
      void getSnapshot(true)
    }, period)
    if (typeof timer.unref === 'function') timer.unref()
  }

  // ---- 路由 -------------------------------------------------------------

  const handleStatus = (req, res) => {
    registerTool() // 热重建后 tools 服务可能晚就绪，顺路补注册
    void statusPayload()
      .then((payload) => sendJson(res, payload))
      .catch((cause) => sendJson(res, { ok: false, error: String(cause) }, 500))
  }

  const handleRefresh = (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: '只支持 POST' }, 405)
      return
    }
    cache.snapshot = null
    void statusPayload()
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
      const next = { ...config }
      if (Object.prototype.hasOwnProperty.call(patch, 'region')) {
        if (typeof patch.region !== 'string' || !Object.prototype.hasOwnProperty.call(REGIONS, patch.region)) {
          sendJson(res, { ok: false, error: 'region 只能是 cn / global' }, 400)
          return
        }
        next.region = patch.region
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'keyRef')) {
        if (typeof patch.keyRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(patch.keyRef)) {
          sendJson(res, { ok: false, error: 'keyRef 必须是合法的环境变量名' }, 400)
          return
        }
        next.keyRef = patch.keyRef
      }
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
        try {
          if (value === '') await credentials.unset(next.keyRef)
          else await credentials.set(next.keyRef, value)
        } catch (cause) {
          sendJson(res, { ok: false, error: `保存 API Key 失败：${cause instanceof Error ? cause.message : String(cause)}` }, 500)
          return
        }
        cache.snapshot = null
      }

      const changed = next.region !== config.region || next.keyRef !== config.keyRef || next.intervalSeconds !== config.intervalSeconds || next.enabled !== config.enabled
      config = next
      try {
        saveConfig(config)
      } catch (cause) {
        sendJson(res, { ok: false, error: `保存配置失败：${cause instanceof Error ? cause.message : String(cause)}` }, 500)
        return
      }
      if (changed) schedule()
      sendJson(res, await statusPayload())
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
          '查询当前 GLM Coding Plan 的额度：5 小时会话窗口与每周窗口的已用百分比、重置时间，以及订阅套餐信息。用户问「额度还剩多少」「还能用多久」时调用。',
        parameters: {
          type: 'object',
          properties: {
            refresh: { type: 'boolean', description: '为 true 时跳过 30 秒缓存，强制向接口重新查询。' },
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
          const snapshot = await getSnapshot(force)
          return snapshot
        },
      })
      toolRegistered = true
    } catch {
      /* 工具注册失败不该拖垮插件 */
    }
  }

  function formatForModel(snapshot) {
    if (!isObject(snapshot)) return '没有拿到额度数据。'
    if (snapshot.ok !== true) return `查询失败：${snapshot.error ?? '未知错误'}`
    const lines = []
    const planName = snapshot.plan !== null && typeof snapshot.plan.name === 'string' ? snapshot.plan.name : null
    lines.push(`套餐：${planName ?? '未知'}${snapshot.level ? `（${snapshot.level}）` : ''}`)
    if (snapshot.plan !== null && typeof snapshot.plan.nextRenewTime === 'string') lines.push(`下次续费：${snapshot.plan.nextRenewTime}`)
    for (const window of snapshot.windows) {
      const used = window.usedPercent === null ? '未知' : `${window.usedPercent}%`
      const left = window.remainingPercent === null ? '未知' : `${window.remainingPercent}%`
      lines.push(`${window.title}：已用 ${used}，剩余 ${left}，重置 ${window.resetAt ?? '未知'}`)
    }
    for (const extra of snapshot.extras) {
      lines.push(`${extra.title}：${extra.used ?? '?'} / ${extra.total ?? '?'}，重置 ${extra.resetAt ?? '未知'}`)
    }
    lines.push(`查询时间：${new Date(snapshot.fetchedAt).toISOString()}`)
    return lines.join('\n')
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
  void getSnapshot(false)
}
