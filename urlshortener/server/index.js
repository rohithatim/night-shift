import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PORT = Number(process.env.PORT || 5174)
const DATA_DIR = path.join(__dirname, 'data')
const DATA_FILE = path.join(DATA_DIR, 'store.json')
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const RESERVED_CODES = new Set(['api', 'assets', 'admin', 'health', 'favicon.ico'])
const MAX_EVENTS_PER_LINK = 100

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '16kb' }))

let store = {
  counter: 62 ** 5,
  links: {},
}
let persistQueue = Promise.resolve()

async function bootStore() {
  await fs.mkdir(DATA_DIR, { recursive: true })

  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8')
    store = JSON.parse(raw)
    if (!store.links) {
      store.links = {}
    }
    if (!store.counter) {
      store.counter = 62 ** 5
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
    await persistStore()
  }
}

function persistStore() {
  const snapshot = JSON.stringify(store, null, 2)
  persistQueue = persistQueue.then(async () => {
    const tempFile = `${DATA_FILE}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(tempFile, snapshot)
    await fs.rename(tempFile, DATA_FILE)
  })
  return persistQueue
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

function generateCode() {
  let code = ''

  do {
    code = encodeBase62(store.counter)
    store.counter += 1
  } while (store.links[code] || RESERVED_CODES.has(code.toLowerCase()))

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

function isExpired(link) {
  return Boolean(link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now())
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function makeShortUrl(req, code) {
  const configured = process.env.PUBLIC_BASE_URL
  if (configured) {
    return `${configured.replace(/\/$/, '')}/${code}`
  }

  return `${req.protocol}://${req.get('host')}/${code}`
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

const rateBuckets = new Map()

function creationRateLimit(req, res, next) {
  const key = getClientIp(req)
  const now = Date.now()
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + 60_000 }

  if (now > bucket.resetAt) {
    bucket.count = 0
    bucket.resetAt = now + 60_000
  }

  bucket.count += 1
  rateBuckets.set(key, bucket)

  if (bucket.count > 30) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' })
  }

  return next()
}

setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now > bucket.resetAt) {
      rateBuckets.delete(key)
    }
  }
}, 60_000).unref()

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    links: Object.keys(store.links).length,
    generatedIdsStartAt: encodeBase62(62 ** 5),
  })
})

app.get('/api/links', (req, res) => {
  const links = Object.values(store.links)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((link) => publicLink(link, req))

  res.json({ links })
})

app.get('/api/links/:code', (req, res) => {
  const link = store.links[req.params.code]
  if (!link) {
    return res.status(404).json({ error: 'Short URL not found.' })
  }

  return res.json({ link: publicLink(link, req) })
})

app.post('/api/links', creationRateLimit, async (req, res) => {
  const urlResult = normalizeUrl(req.body.longUrl)
  if (urlResult.error) {
    return res.status(400).json({ error: urlResult.error })
  }

  const aliasResult = normalizeAlias(req.body.customAlias)
  if (aliasResult.error) {
    return res.status(400).json({ error: aliasResult.error })
  }

  const expiryResult = normalizeExpiry(req.body.expiresAt)
  if (expiryResult.error) {
    return res.status(400).json({ error: expiryResult.error })
  }

  const code = aliasResult.alias || generateCode()
  if (store.links[code]) {
    return res.status(409).json({ error: 'That short code is already taken.' })
  }

  const link = {
    code,
    longUrl: urlResult.url,
    createdAt: new Date().toISOString(),
    expiresAt: expiryResult.expiresAt,
    clickCount: 0,
    recentClicks: [],
  }

  store.links[code] = link
  await persistStore()

  return res.status(201).json({ link: publicLink(link, req) })
})

app.delete('/api/links/:code', async (req, res) => {
  if (!store.links[req.params.code]) {
    return res.status(404).json({ error: 'Short URL not found.' })
  }

  delete store.links[req.params.code]
  await persistStore()
  return res.status(204).send()
})

app.get('/:code', (req, res, next) => {
  const code = req.params.code
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    return next()
  }

  const link = store.links[code]
  if (!link) {
    return res.status(404).send(renderMessage('404', 'Short link not found'))
  }

  if (isExpired(link)) {
    return res.status(410).send(renderMessage('410', 'This short link has expired'))
  }

  link.clickCount += 1
  link.recentClicks.unshift({
    timestamp: new Date().toISOString(),
    ip: getClientIp(req),
    userAgent: req.get('user-agent') || 'unknown',
    referrer: req.get('referer') || 'direct',
  })
  link.recentClicks = link.recentClicks.slice(0, MAX_EVENTS_PER_LINK)

  void persistStore().catch((error) => {
    console.error('Failed to persist analytics event', error)
  })

  return res.redirect(302, link.longUrl)
})

const distDir = path.join(__dirname, '..', 'dist')
app.use(express.static(distDir))
app.use((req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

function renderMessage(code, message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${code} - URL Shortener</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; background: #fff; }
      main { width: min(420px, calc(100vw - 40px)); border: 1px solid #e5e5e5; border-radius: 8px; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.08); }
      p { color: #666; margin: 8px 0 0; }
    </style>
  </head>
  <body>
    <main>
      <strong>${code}</strong>
      <p>${message}</p>
    </main>
  </body>
</html>`
}

await bootStore()
app.listen(PORT, () => {
  console.log(`Shortener API running on http://localhost:${PORT}`)
})
