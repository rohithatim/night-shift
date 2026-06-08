import {
  Activity,
  BarChart3,
  Check,
  Clock3,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Moon,
  Sun,
  Trash2,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import './App.css'

type ClickEvent = {
  timestamp: string
  ip: string
  userAgent: string
  referrer: string
}

type LinkRecord = {
  code: string
  longUrl: string
  shortUrl: string
  createdAt: string
  expiresAt: string | null
  clickCount: number
  recentClicks: ClickEvent[]
  status: 'active' | 'expired'
}

type Theme = 'light' | 'dark'

const expiryOptions = [
  { label: 'Never', value: '' },
  { label: '1 hour', value: '1' },
  { label: '24 hours', value: '24' },
  { label: '7 days', value: '168' },
  { label: '30 days', value: '720' },
]

function getInitialTheme(): Theme {
  const savedTheme = window.localStorage.getItem('shortline-theme')
  return savedTheme === 'dark' ? 'dark' : 'light'
}

function App() {
  const [longUrl, setLongUrl] = useState('')
  const [customAlias, setCustomAlias] = useState('')
  const [expiryHours, setExpiryHours] = useState('')
  const [links, setLinks] = useState<LinkRecord[]>([])
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [latestLink, setLatestLink] = useState<LinkRecord | null>(null)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  const selectedLink = useMemo(
    () => links.find((link) => link.code === selectedCode) || links[0],
    [links, selectedCode],
  )

  const stats = useMemo(() => {
    const totalClicks = links.reduce((sum, link) => sum + link.clickCount, 0)
    const activeLinks = links.filter((link) => link.status === 'active').length

    return { totalClicks, activeLinks }
  }, [links])

  useEffect(() => {
    void loadLinks()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('shortline-theme', theme)
  }, [theme])

  async function loadLinks() {
    setIsLoading(true)
    setError('')

    try {
      const response = await fetch('/api/links')
      const data = await readApiJson(response)

      if (!response.ok) {
        throw new Error(data.error || 'Unable to load links.')
      }

      setLinks(data.links)
      setSelectedCode((current) => current || data.links[0]?.code || null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load links.')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')

    const expiresAt = expiryHours
      ? new Date(Date.now() + Number(expiryHours) * 60 * 60 * 1000).toISOString()
      : null

    try {
      const response = await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          longUrl,
          customAlias: customAlias || undefined,
          expiresAt,
        }),
      })
      const data = await readApiJson(response)

      if (!response.ok) {
        throw new Error(data.error || 'Unable to shorten URL.')
      }

      setLinks((current) => [data.link, ...current])
      setSelectedCode(data.link.code)
      setLatestLink(data.link)
      setLongUrl('')
      setCustomAlias('')
      setExpiryHours('')
      void copyShortUrl(data.link)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to shorten URL.')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function copyShortUrl(link: LinkRecord) {
    try {
      await navigator.clipboard.writeText(link.shortUrl)
      setCopiedCode(link.code)
      window.setTimeout(() => setCopiedCode(null), 1600)
    } catch {
      setError('Short link created, but clipboard access was blocked.')
    }
  }

  async function deleteLink(code: string) {
    const previous = links
    setLinks((current) => current.filter((link) => link.code !== code))
    setLatestLink((current) => (current?.code === code ? null : current))

    try {
      const response = await fetch(`/api/links/${code}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) {
        const data = await readApiJson(response)
        throw new Error(data.error || 'Unable to delete link.')
      }
    } catch (deleteError) {
      setLinks(previous)
      setLatestLink(previous.find((link) => link.code === code) || latestLink)
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete link.')
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Shortline home">
          <span className="brand-mark">
            <Link2 size={17} strokeWidth={2.4} />
          </span>
          <span>Shortline</span>
        </a>
        <div className="top-actions">
          <button
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className="theme-toggle"
            type="button"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      <section className="hero-grid">
        <div className="intro">
          <h1>Shortline</h1>
        </div>

        <form className="shortener-panel" onSubmit={handleSubmit}>
          <label htmlFor="long-url">Destination URL</label>
          <div className="url-input">
            <Link2 size={18} />
            <input
              id="long-url"
              required
              type="text"
              inputMode="url"
              value={longUrl}
              onChange={(event) => setLongUrl(event.target.value)}
            />
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="alias">Custom alias</label>
              <input
                id="alias"
                value={customAlias}
                maxLength={32}
                onChange={(event) => setCustomAlias(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="expiry">Expiration</label>
              <select
                id="expiry"
                value={expiryHours}
                onChange={(event) => setExpiryHours(event.target.value)}
              >
                {expiryOptions.map((option) => (
                  <option key={option.label} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? <Loader2 className="spin" size={17} /> : <Zap size={17} />}
            Create short link
          </button>

          {latestLink ? (
            <div className="inline-result" aria-label="Latest short URL">
              <a
                className="inline-result-url"
                href={latestLink.shortUrl}
                rel="noreferrer"
                target="_blank"
              >
                {latestLink.shortUrl}
              </a>
              <div className="action-cluster">
                <button
                  aria-label="Copy latest short URL"
                  className="icon-button"
                  type="button"
                  title="Copy short URL"
                  onClick={() => void copyShortUrl(latestLink)}
                >
                  {copiedCode === latestLink.code ? <Check size={16} /> : <Copy size={16} />}
                </button>
                <a
                  aria-label="Open latest short URL"
                  className="icon-button"
                  href={latestLink.shortUrl}
                  rel="noreferrer"
                  target="_blank"
                  title="Open short URL"
                >
                  <ExternalLink size={16} />
                </a>
              </div>
            </div>
          ) : null}

          {error ? <p className="error-banner">{error}</p> : null}
        </form>
      </section>

      <section className="metric-row" aria-label="URL shortener metrics">
        <Metric icon={<Link2 size={18} />} label="Total links" value={links.length.toString()} />
        <Metric icon={<Activity size={18} />} label="Active links" value={stats.activeLinks.toString()} />
        <Metric icon={<BarChart3 size={18} />} label="Total clicks" value={stats.totalClicks.toString()} />
      </section>

      <section className="workspace">
        <div className="link-table">
          <div className="section-heading">
            <h2>Links</h2>
            <button className="ghost-button" type="button" onClick={() => void loadLinks()}>
              <Activity size={16} />
              Refresh
            </button>
          </div>

          {isLoading ? (
            <div className="empty-state">
              <Loader2 className="spin" size={20} />
              Loading links
            </div>
          ) : links.length === 0 ? (
            <div className="empty-state">Create your first short URL to populate analytics.</div>
          ) : (
            <div className="rows">
              {links.map((link) => (
                <button
                  className={`link-row ${selectedLink?.code === link.code ? 'selected' : ''}`}
                  key={link.code}
                  type="button"
                  onClick={() => setSelectedCode(link.code)}
                >
                  <span className="row-main">
                    <span className="short-code">/{link.code}</span>
                    <span className="long-url">{link.longUrl}</span>
                  </span>
                  <span className={`badge ${link.status}`}>{link.status}</span>
                  <span className="click-count">{link.clickCount}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="analytics-panel">
          {selectedLink ? (
            <>
              <div className="section-heading">
                <h2>Analytics</h2>
                <div className="action-cluster">
                  <button
                    aria-label="Copy short URL"
                    className="icon-button"
                    type="button"
                    title="Copy short URL"
                    onClick={() => void copyShortUrl(selectedLink)}
                  >
                    {copiedCode === selectedLink.code ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                  <a
                    aria-label="Open short URL"
                    className="icon-button"
                    href={selectedLink.shortUrl}
                    rel="noreferrer"
                    target="_blank"
                    title="Open short URL"
                  >
                    <ExternalLink size={16} />
                  </a>
                  <button
                    aria-label="Delete short URL"
                    className="icon-button danger"
                    type="button"
                    title="Delete short URL"
                    onClick={() => void deleteLink(selectedLink.code)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <div className="short-preview">
                <span>{selectedLink.shortUrl}</span>
              </div>

              <div className="detail-grid">
                <Detail label="Clicks" value={selectedLink.clickCount.toString()} />
                <Detail label="Created" value={formatDate(selectedLink.createdAt)} />
                <Detail
                  label="Expires"
                  value={selectedLink.expiresAt ? formatDate(selectedLink.expiresAt) : 'Never'}
                />
                <Detail label="Status" value={selectedLink.status} />
              </div>

              <div className="events">
                <div className="events-title">
                  <Clock3 size={16} />
                  Recent click events
                </div>
                {selectedLink.recentClicks.length === 0 ? (
                  <p className="muted">No redirects recorded yet.</p>
                ) : (
                  selectedLink.recentClicks.map((click) => (
                    <div className="event-row" key={`${click.timestamp}-${click.ip}`}>
                      <span>{formatDate(click.timestamp)}</span>
                      <strong>{click.ip}</strong>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">Select a link to inspect click metadata.</div>
          )}
        </aside>
      </section>
    </main>
  )
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

async function readApiJson(response: Response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return response.json()
  }

  const text = await response.text()
  const message = text.trim().slice(0, 120)
  throw new Error(message || 'API returned a non-JSON response.')
}

export default App
