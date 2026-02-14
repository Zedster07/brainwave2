/**
 * Daily Pulse — Morning briefing dashboard
 *
 * Shows a personalized overview: weather, emails, news, Jira, reminders, stats.
 * Data is fetched via IPC from the main process which uses MCP tools.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Sun,
  RefreshCw,
  Mail,
  Newspaper,
  CloudSun,
  CheckSquare,
  Bell,
  Activity,
  Loader2,
  AlertCircle,
  ExternalLink,
} from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────

interface PulseCard {
  id: string
  title: string
  icon: React.ElementType
  status: 'idle' | 'loading' | 'loaded' | 'error'
  data: unknown
  error?: string
  colorClass: string
}

interface WeatherData {
  temp: string
  condition: string
  high: string
  low: string
  city: string
  humidity?: string
  wind?: string
}

interface EmailItem {
  from: string
  subject: string
  preview: string
  time: string
  unread: boolean
}

interface NewsItem {
  title: string
  source: string
  url: string
  snippet: string
  time?: string
}

interface JiraItem {
  key: string
  summary: string
  status: string
  priority: string
  type: 'jira' | 'confluence'
  url?: string
}

interface ReminderItem {
  id: string
  text: string
  triggerType: string
  triggerValue: string
  createdAt: string
}

interface QuickStats {
  emails: number
  jiraTickets: number
  reminders: number
  weather: string
}

// ─── Card Sections ──────────────────────────────────────────

const PULSE_SECTIONS = [
  'weather',
  'emails',
  'news',
  'jira',
  'reminders',
] as const
type PulseSection = (typeof PULSE_SECTIONS)[number]

// ─── Greeting ───────────────────────────────────────────────

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function getFormattedDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

// ─── Component ──────────────────────────────────────────────

export function DailyPulse() {
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [userName, setUserName] = useState('Dada')

  // Per-section state
  const [weather, setWeather] = useState<{ status: 'idle' | 'loading' | 'loaded' | 'error'; data?: WeatherData; error?: string }>({ status: 'idle' })
  const [emails, setEmails] = useState<{ status: 'idle' | 'loading' | 'loaded' | 'error'; data?: EmailItem[]; error?: string }>({ status: 'idle' })
  const [news, setNews] = useState<{ status: 'idle' | 'loading' | 'loaded' | 'error'; data?: NewsItem[]; error?: string }>({ status: 'idle' })
  const [jira, setJira] = useState<{ status: 'idle' | 'loading' | 'loaded' | 'error'; data?: JiraItem[]; error?: string }>({ status: 'idle' })
  const [reminders, setReminders] = useState<{ status: 'idle' | 'loading' | 'loaded' | 'error'; data?: ReminderItem[]; error?: string }>({ status: 'idle' })

  // ── Fetch a single section ──
  const fetchSection = useCallback(async (section: PulseSection) => {
    const setters: Record<PulseSection, (v: any) => void> = {
      weather: setWeather,
      emails: setEmails,
      news: setNews,
      jira: setJira,
      reminders: setReminders,
    }

    const setter = setters[section]
    setter({ status: 'loading' })

    try {
      const result = await window.brainwave.getDailyPulseData(section)
      setter({ status: 'loaded', data: result })
    } catch (err) {
      setter({ status: 'error', error: err instanceof Error ? err.message : 'Failed to load' })
    }
  }, [])

  // ── Refresh all sections ──
  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    await Promise.allSettled(PULSE_SECTIONS.map((s) => fetchSection(s)))
    setLastRefreshed(new Date())
    setRefreshing(false)
  }, [fetchSection])

  // Load user name from settings
  useEffect(() => {
    window.brainwave.getSetting<string>('user_name').then((name) => {
      if (name) setUserName(name)
    }).catch(() => {})
  }, [])

  // Auto-load on mount
  useEffect(() => {
    refreshAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Quick Stats Banner ──
  const statsLine = buildStatsLine(weather, emails, jira, reminders)

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Sun className="w-6 h-6 text-amber-400" />
            <h2 className="text-xl font-semibold text-white">
              {getGreeting()}, {userName}
            </h2>
          </div>
          <p className="text-sm text-gray-400 ml-9">{getFormattedDate()}</p>
        </div>
        <button
          onClick={refreshAll}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
            bg-white/[0.06] hover:bg-white/[0.10] text-gray-300 hover:text-white
            border border-white/[0.06] transition-all duration-200
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Quick Stats Banner */}
      {statsLine && (
        <div className="glass-card px-5 py-3 mb-6 flex items-center gap-3">
          <Activity className="w-4 h-4 text-accent flex-shrink-0" />
          <span className="text-sm text-gray-300">{statsLine}</span>
          {lastRefreshed && (
            <span className="ml-auto text-xs text-gray-500">
              Updated {lastRefreshed.toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {/* Card Grid — 2 columns on large, 1 on small */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Weather — full width top */}
        <div className="lg:col-span-2">
          <WeatherCard state={weather} onRetry={() => fetchSection('weather')} />
        </div>

        {/* Email */}
        <SectionCard
          title="Email"
          icon={Mail}
          colorClass="text-blue-400"
          status={emails.status}
          error={emails.error}
          onRetry={() => fetchSection('emails')}
        >
          {emails.data && emails.data.length > 0 ? (
            <div className="space-y-2">
              {emails.data.map((email, i) => (
                <div key={i} className={`flex items-start gap-3 p-3 rounded-lg ${email.unread ? 'bg-blue-500/[0.06]' : 'bg-white/[0.02]'}`}>
                  <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${email.unread ? 'bg-blue-400' : 'bg-gray-600'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-sm font-medium truncate ${email.unread ? 'text-white' : 'text-gray-300'}`}>
                        {email.from}
                      </span>
                      <span className="text-xs text-gray-500 flex-shrink-0">{email.time}</span>
                    </div>
                    <p className="text-sm text-gray-300 truncate">{email.subject}</p>
                    <p className="text-xs text-gray-500 truncate mt-0.5">{email.preview}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : emails.status === 'loaded' ? (
            <EmptyState text="No recent emails" />
          ) : null}
        </SectionCard>

        {/* News */}
        <SectionCard
          title="News"
          icon={Newspaper}
          colorClass="text-emerald-400"
          status={news.status}
          error={news.error}
          onRetry={() => fetchSection('news')}
        >
          {news.data && news.data.length > 0 ? (
            <div className="space-y-2">
              {news.data.map((item, i) => (
                <div key={i} className="p-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-200 line-clamp-2">{item.title}</h4>
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-500 hover:text-accent flex-shrink-0 mt-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">{item.snippet}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-xs text-accent/70">{item.source}</span>
                    {item.time && <span className="text-xs text-gray-600">• {item.time}</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : news.status === 'loaded' ? (
            <EmptyState text="No news found" />
          ) : null}
        </SectionCard>

        {/* Jira / Confluence */}
        <SectionCard
          title="Jira & Confluence"
          icon={CheckSquare}
          colorClass="text-blue-300"
          status={jira.status}
          error={jira.error}
          onRetry={() => fetchSection('jira')}
        >
          {jira.data && jira.data.length > 0 ? (
            <div className="space-y-2">
              {jira.data.map((item, i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.02]">
                  <PriorityDot priority={item.priority} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-accent/70">{item.key}</span>
                      <StatusBadge status={item.status} />
                    </div>
                    <p className="text-sm text-gray-300 truncate">{item.summary}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : jira.status === 'loaded' ? (
            <EmptyState text="No open tickets" />
          ) : null}
        </SectionCard>

        {/* Reminders */}
        <SectionCard
          title="Reminders"
          icon={Bell}
          colorClass="text-amber-400"
          status={reminders.status}
          error={reminders.error}
          onRetry={() => fetchSection('reminders')}
        >
          {reminders.data && reminders.data.length > 0 ? (
            <div className="space-y-2">
              {reminders.data.map((item, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02]">
                  <Bell className="w-4 h-4 text-amber-400/60 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-300">{item.text}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-gray-500">{item.triggerType}: {item.triggerValue}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : reminders.status === 'loaded' ? (
            <EmptyState text="No active reminders" />
          ) : null}
        </SectionCard>
      </div>
    </div>
  )
}

// ─── Sub-Components ─────────────────────────────────────────

function WeatherCard({ state, onRetry }: {
  state: { status: string; data?: WeatherData; error?: string }
  onRetry: () => void
}) {
  if (state.status === 'loading') {
    return (
      <div className="glass-card p-6 flex items-center justify-center gap-3 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading weather...</span>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="glass-card p-6 flex items-center justify-between">
        <div className="flex items-center gap-3 text-red-400">
          <AlertCircle className="w-5 h-5" />
          <span className="text-sm">{state.error || 'Failed to load weather'}</span>
        </div>
        <button onClick={onRetry} className="text-xs text-accent hover:text-accent/80">Retry</button>
      </div>
    )
  }

  if (state.status === 'loaded' && state.data) {
    const w = state.data
    return (
      <div className="glass-card p-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <CloudSun className="w-10 h-10 text-amber-400" />
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-white">{w.temp}</span>
              <span className="text-lg text-gray-400">{w.condition}</span>
            </div>
            <p className="text-sm text-gray-400 mt-0.5">
              {w.city} • H: {w.high} L: {w.low}
              {w.humidity ? ` • Humidity: ${w.humidity}` : ''}
              {w.wind ? ` • Wind: ${w.wind}` : ''}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return null
}

function SectionCard({ title, icon: Icon, colorClass, status, error, onRetry, children }: {
  title: string
  icon: React.ElementType
  colorClass: string
  status: string
  error?: string
  onRetry: () => void
  children: React.ReactNode
}) {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${colorClass}`} />
          <h3 className="text-sm font-semibold text-white">{title}</h3>
        </div>
        {status === 'error' && (
          <button onClick={onRetry} className="text-xs text-accent hover:text-accent/80">Retry</button>
        )}
      </div>

      {status === 'loading' && (
        <div className="flex items-center justify-center py-8 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">Loading...</span>
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-center gap-2 py-4 text-red-400/80">
          <AlertCircle className="w-4 h-4" />
          <span className="text-sm">{error || 'Failed to load'}</span>
        </div>
      )}

      {status === 'loaded' && children}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="py-6 text-center text-gray-500 text-sm">{text}</div>
  )
}

function PriorityDot({ priority }: { priority: string }) {
  const colors: Record<string, string> = {
    highest: 'bg-red-500',
    high: 'bg-orange-400',
    medium: 'bg-yellow-400',
    low: 'bg-blue-400',
    lowest: 'bg-gray-400',
  }
  return (
    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${colors[priority.toLowerCase()] ?? 'bg-gray-400'}`} />
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    'to do': 'bg-gray-500/20 text-gray-400',
    'in progress': 'bg-blue-500/20 text-blue-400',
    'done': 'bg-green-500/20 text-green-400',
    'in review': 'bg-purple-500/20 text-purple-400',
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${colors[status.toLowerCase()] ?? 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  )
}

// ─── Helpers ────────────────────────────────────────────────

function buildStatsLine(
  weather: { status: string; data?: WeatherData },
  emails: { status: string; data?: EmailItem[] },
  jira: { status: string; data?: JiraItem[] },
  reminders: { status: string; data?: ReminderItem[] },
): string | null {
  const parts: string[] = []

  if (weather.status === 'loaded' && weather.data) {
    parts.push(`${weather.data.temp} ${weather.data.condition}`)
  }

  if (emails.status === 'loaded' && emails.data) {
    const unread = emails.data.filter((e) => e.unread).length
    parts.push(`${unread} unread email${unread !== 1 ? 's' : ''}`)
  }

  if (jira.status === 'loaded' && jira.data) {
    parts.push(`${jira.data.length} Jira ticket${jira.data.length !== 1 ? 's' : ''}`)
  }

  if (reminders.status === 'loaded' && reminders.data) {
    parts.push(`${reminders.data.length} reminder${reminders.data.length !== 1 ? 's' : ''}`)
  }

  return parts.length > 0 ? parts.join(' • ') : null
}
