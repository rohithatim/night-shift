const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const RESERVED_CODES = new Set(['api', 'assets', 'admin', 'health', 'favicon.ico'])
const MAX_EVENTS_PER_LINK = 100
const LINK_INDEX_KEY = 'shortline:links'
const COUNTER_KEY = 'shortline:counter'
const LINK_KEY_PREFIX = 'shortline:link:'

const memoryStore = globalThis.__shortlineStore || {
  counter: 62 ** 5,
  links: {},
  rateBuckets: new Map(),
}

globalThis.__shortlineStore = memoryStore
const durableStore = createDurableStore()

export async function handleShortlineRequest(req, res) {
  try {
    const url = new URL(req.url || '/api', getRequestOrigin(req))
    const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }

    if (segments[0] === 'health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        storage: durableStore.type,
        durable: durableStore.type !== 'memory',
        links: (await durableStore.listLinks()).length,
        generatedIdsStartAt: encodeBase62(62 ** 5),
      })
    }

    if (segments[0] === 'links') {
      return handleLinks(req, res, segments)
    }

    if (segments[0] === 'r' && segments[1] && req.method === 'GET') {
      return redirectToLongUrl(req, res, segments[1])
    }

    return sendJson(res, 404, { error: 'API route not found.' })
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Unexpected API error.',
    })
  }
}

async function handleLinks(req, res, segments) {
  const code = segments[1]

  if (segments.length === 1 && req.method === 'GET') {
    const links = (await durableStore.listLinks())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((link) => publicLink(link, req))

    return sendJson(res, 200, { links })
  }

  if (segments.length === 1 && req.method === 'POST') {
    if (isVercelWithoutDurableStore()) {
      return sendJson(res, 500, {
        error:
          'Short links need Vercel KV or Upstash Redis connected before they can work reliably on Vercel.',
      })
    }

    const rateLimitError = checkCreationRateLimit(req)
    if (rateLimitError) {
      return sendJson(res, 429, { error: rateLimitError })
    }

    const body = await readBody(req)
    const urlResult = normalizeUrl(body.longUrl)
    if (urlResult.error) {
      return sendJson(res, 400, { error: urlResult.error })
    }

    const aliasResult = normalizeAlias(body.customAlias)
    if (aliasResult.error) {
      return sendJson(res, 400, { error: aliasResult.error })
    }

    const expiryResult = normalizeExpiry(body.expiresAt)
    if (expiryResult.error) {
      return sendJson(res, 400, { error: expiryResult.error })
    }

    const shortCode = aliasResult.alias || (await generateCode())
    if (await durableStore.getLink(shortCode)) {
      return sendJson(res, 409, { error: 'That short code is already taken.' })
    }

    const link = {
      code: shortCode,
      longUrl: urlResult.url,
      createdAt: new Date().toISOString(),
      expiresAt: expiryResult.expiresAt,
      clickCount: 0,
      recentClicks: [],
    }

    await durableStore.setLink(shortCode, link)
    return sendJson(res, 201, { link: publicLink(link, req) })
  }

  if (segments.length === 2 && req.method === 'GET') {
    const link = await durableStore.getLink(code)
    if (!link) {
      return sendJson(res, 404, { error: 'Short URL not found.' })
    }

    return sendJson(res, 200, { link: publicLink(link, req) })
  }

  if (segments.length === 2 && req.method === 'DELETE') {
    if (!(await durableStore.getLink(code))) {
      return sendJson(res, 404, { error: 'Short URL not found.' })
    }

    await durableStore.deleteLink(code)
    res.statusCode = 204
    return res.end()
  }

  return sendJson(res, 405, { error: 'Method not allowed.' })
}

async function redirectToLongUrl(req, res, code) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    return sendMessage(res, 404, 'Short link not found')
  }

  const link = await durableStore.getLink(code)
  if (!link) {
    return sendMessage(res, 404, 'Short link not found')
  }

  if (isExpired(link)) {
    return sendMessage(res, 410, 'This short link has expired')
  }

  link.clickCount += 1
  link.recentClicks.unshift({
    timestamp: new Date().toISOString(),
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || 'unknown',
    referrer: req.headers.referer || 'direct',
  })
  link.recentClicks = link.recentClicks.slice(0, MAX_EVENTS_PER_LINK)
  await durableStore.setLink(code, link)

  res.statusCode = 302
  res.setHeader('Location', link.longUrl)
  return res.end()
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body
  }

  if (typeof req.body === 'string') {
    return JSON.parse(req.body || '{}')
  }

  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }

  const rawBody = Buffer.concat(chunks).toString('utf8')
  return rawBody ? JSON.parse(rawBody) : {}
}

function encodeBase62(value) {
  let remaining = value
  let encoded = ''

  while (remaining > 0) {
    encoded = BASE62[remaining % 62] + encoded
    remaining = Math.floor(remaining / 62)
  }

  return encoded || '0'
}

async function generateCode() {
  let code = ''

  do {
    const nextCounter = await durableStore.nextCounter()
    code = encodeBase62(nextCounter)
  } while ((await durableStore.getLink(code)) || RESERVED_CODES.has(code.toLowerCase()))

  return code
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: 'Enter a URL to shorten.' }
  }

  const trimmedValue = value.trim()
  if (trimmedValue.length > 4096) {
    return { error: 'URL is too long.' }
  }

  try {
    const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmedValue)
      ? trimmedValue
      : `https://${trimmedValue}`
    const parsed = new URL(candidate)
    const hostname = parsed.hostname.toLowerCase()

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: 'Only http and https URLs are supported.' }
    }

    if (!hostname.includes('.') || hostname.endsWith('.')) {
      return { error: 'Enter a valid public domain or absolute URL.' }
    }

    if (isBlockedHost(hostname)) {
      return { error: 'Local and private-network URLs are blocked.' }
    }

    return { url: parsed.toString() }
  } catch {
    return { error: 'Enter a valid public domain or absolute URL.' }
  }
}

function isBlockedHost(hostname) {
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::1'
  ) {
    return true
  }

  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!ipv4) {
    return false
  }

  const [a, b] = ipv4.slice(1).map(Number)
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

function normalizeAlias(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { alias: null }
  }

  const alias = String(value).trim()
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(alias)) {
    return { error: 'Alias must be 3-32 URL-safe characters.' }
  }

  if (RESERVED_CODES.has(alias.toLowerCase())) {
    return { error: 'That alias is reserved.' }
  }

  return { alias }
}

function normalizeExpiry(value) {
  if (value === undefined || value === null || value === '') {
    return { expiresAt: null }
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return { error: 'Expiration must be a valid date.' }
  }

  if (date.getTime() <= Date.now()) {
    return { error: 'Expiration must be in the future.' }
  }

  return { expiresAt: date.toISOString() }
}

function checkCreationRateLimit(req) {
  const key = getClientIp(req)
  const now = Date.now()
  const bucket = memoryStore.rateBuckets.get(key) || { count: 0, resetAt: now + 60_000 }

  if (now > bucket.resetAt) {
    bucket.count = 0
    bucket.resetAt = now + 60_000
  }

  bucket.count += 1
  memoryStore.rateBuckets.set(key, bucket)

  return bucket.count > 30 ? 'Rate limit exceeded. Try again in a minute.' : null
}

function isExpired(link) {
  return Boolean(link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now())
}

function publicLink(link, req) {
  return {
    code: link.code,
    longUrl: link.longUrl,
    shortUrl: makeShortUrl(req, link.code),
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    clickCount: link.clickCount,
    recentClicks: link.recentClicks,
    status: isExpired(link) ? 'expired' : 'active',
  }
}

function makeShortUrl(req, code) {
  return `${getRequestOrigin(req)}/${code}`
}

function getRequestOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5174'
  const protocol = req.headers['x-forwarded-proto'] || (String(host).includes('localhost') ? 'http' : 'https')
  return `${protocol}://${host}`
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

function createDurableStore() {
  const restUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

  if (restUrl && restToken) {
    return createRedisRestStore(restUrl, restToken)
  }

  return createMemoryStore()
}

function isVercelWithoutDurableStore() {
  return process.env.VERCEL === '1' && durableStore.type === 'memory'
}

function createMemoryStore() {
  return {
    type: 'memory',
    async listLinks() {
      return Object.values(memoryStore.links)
    },
    async getLink(code) {
      return memoryStore.links[code] || null
    },
    async setLink(code, link) {
      memoryStore.links[code] = link
    },
    async deleteLink(code) {
      delete memoryStore.links[code]
    },
    async nextCounter() {
      const counter = memoryStore.counter
      memoryStore.counter += 1
      return counter
    },
  }
}

function createRedisRestStore(restUrl, restToken) {
  return {
    type: 'redis-rest',
    async listLinks() {
      const codes = await redisCommand(restUrl, restToken, ['SMEMBERS', LINK_INDEX_KEY])
      if (!Array.isArray(codes) || codes.length === 0) {
        return []
      }

      const values = await redisPipeline(
        restUrl,
        restToken,
        codes.map((code) => ['GET', linkKey(code)]),
      )

      return values
        .map((entry) => parseStoredLink(entry.result))
        .filter(Boolean)
    },
    async getLink(code) {
      return parseStoredLink(await redisCommand(restUrl, restToken, ['GET', linkKey(code)]))
    },
    async setLink(code, link) {
      await redisPipeline(restUrl, restToken, [
        ['SET', linkKey(code), JSON.stringify(link)],
        ['SADD', LINK_INDEX_KEY, code],
      ])
    },
    async deleteLink(code) {
      await redisPipeline(restUrl, restToken, [
        ['DEL', linkKey(code)],
        ['SREM', LINK_INDEX_KEY, code],
      ])
    },
    async nextCounter() {
      const value = await redisCommand(restUrl, restToken, ['INCR', COUNTER_KEY])
      return Number(value) + 62 ** 5
    },
  }
}

async function redisCommand(restUrl, restToken, command) {
  const response = await fetch(restUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${restToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })
  const payload = await response.json()

  if (!response.ok || payload.error) {
    throw new Error(payload.error || 'Redis REST command failed.')
  }

  return payload.result
}

async function redisPipeline(restUrl, restToken, commands) {
  const response = await fetch(`${restUrl.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${restToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  })
  const payload = await response.json()

  if (!response.ok || payload.error) {
    throw new Error(payload.error || 'Redis REST pipeline failed.')
  }

  return payload
}

function parseStoredLink(value) {
  if (!value) {
    return null
  }

  return typeof value === 'string' ? JSON.parse(value) : value
}

function linkKey(code) {
  return `${LINK_KEY_PREFIX}${code}`
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.end(JSON.stringify(payload))
}

function sendMessage(res, statusCode, message) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  return res.end(`<!doctype html><title>${statusCode}</title><main>${message}</main>`)
}
