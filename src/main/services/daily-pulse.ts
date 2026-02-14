/**
 * Daily Pulse Service — Backend data fetching for the morning briefing
 *
 * Each section fetches data from:
 * - Weather: brave_web_search MCP
 * - Emails: Gmail API (placeholder — requires OAuth setup)
 * - News: brave_web_search MCP with user interests
 * - Jira: Jira MCP (already connected)
 * - Reminders: Internal memory/prospective database
 */
import { getMcpRegistry } from '../mcp'
import { getDatabase } from '../db/database'

type PulseSection = 'weather' | 'emails' | 'news' | 'jira' | 'reminders'

export async function fetchDailyPulseSection(section: PulseSection): Promise<unknown> {
  switch (section) {
    case 'weather':
      return fetchWeather()
    case 'emails':
      return fetchEmails()
    case 'news':
      return fetchNews()
    case 'jira':
      return fetchJira()
    case 'reminders':
      return fetchReminders()
    default:
      throw new Error(`Unknown pulse section: ${section}`)
  }
}

// ─── Weather ────────────────────────────────────────────────

async function fetchWeather(): Promise<unknown> {
  const db = getDatabase()
  const city = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'daily_pulse_city')
  const cityName = city?.value || 'Algiers'

  const registry = getMcpRegistry()
  const braveSearch = registry.getAllTools().find(t => t.name === 'brave_web_search')

  if (!braveSearch) {
    throw new Error('Brave Search MCP not connected — cannot fetch weather')
  }

  const result = await registry.callTool(braveSearch.key, {
    query: `weather today ${cityName} temperature forecast`,
    count: 3,
  })

  if (!result.success) {
    throw new Error('Failed to fetch weather data')
  }

  // Parse the search results to extract weather info
  return parseWeatherFromSearch(result.content, cityName)
}

function parseWeatherFromSearch(content: string, city: string): Record<string, string> {
  // Extract temperature patterns from search results
  const tempMatch = content.match(/(\d{1,2})\s*°\s*[CF]/) || content.match(/(\d{1,2})\s*degrees/)
  const conditionMatch = content.match(/(sunny|cloudy|rainy|partly cloudy|overcast|clear|fog|snow|storm|windy|humid|thunderstorm)/i)
  const highMatch = content.match(/high[:\s]+(\d{1,2})\s*°/i) || content.match(/max[:\s]+(\d{1,2})/i)
  const lowMatch = content.match(/low[:\s]+(\d{1,2})\s*°/i) || content.match(/min[:\s]+(\d{1,2})/i)
  const humidityMatch = content.match(/humidity[:\s]+(\d{1,3})\s*%/i)
  const windMatch = content.match(/wind[:\s]+(\d{1,3})\s*(km\/h|mph|m\/s)/i)

  return {
    temp: tempMatch ? `${tempMatch[1]}°C` : 'N/A',
    condition: conditionMatch?.[1] ?? 'Unknown',
    high: highMatch ? `${highMatch[1]}°` : '--',
    low: lowMatch ? `${lowMatch[1]}°` : '--',
    city,
    humidity: humidityMatch ? `${humidityMatch[1]}%` : undefined,
    wind: windMatch ? `${windMatch[1]} ${windMatch[2]}` : undefined,
  }
}

// ─── Emails ─────────────────────────────────────────────────

async function fetchEmails(): Promise<unknown[]> {
  // Gmail API requires OAuth2 setup
  // For now, return a helpful placeholder
  const db = getDatabase()
  const gmailConfigured = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'gmail_configured')

  if (!gmailConfigured || gmailConfigured.value !== 'true') {
    return [{
      from: 'Brainwave',
      subject: 'Gmail integration not configured',
      preview: 'Go to Settings → Daily Pulse to connect your Gmail account',
      time: 'now',
      unread: true,
    }]
  }

  // TODO: Implement Gmail API integration
  return []
}

// ─── News ───────────────────────────────────────────────────

async function fetchNews(): Promise<unknown[]> {
  const db = getDatabase()
  const interestsRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'daily_pulse_interests')
  const interests = interestsRow?.value || 'technology, AI, software development'

  const registry = getMcpRegistry()
  const braveSearch = registry.getAllTools().find(t => t.name === 'brave_web_search')

  if (!braveSearch) {
    throw new Error('Brave Search MCP not connected — cannot fetch news')
  }

  // Search for news matching user interests
  const topics = interests.split(',').map(t => t.trim()).slice(0, 3)
  const newsItems: Array<Record<string, string>> = []

  for (const topic of topics) {
    try {
      const result = await registry.callTool(braveSearch.key, {
        query: `${topic} latest news today 2026`,
        count: 3,
      })

      if (result.success && result.content) {
        const parsed = parseNewsFromSearch(result.content, topic)
        newsItems.push(...parsed)
      }
    } catch {
      console.warn(`[DailyPulse] Failed to fetch news for topic: ${topic}`)
    }
  }

  return newsItems.slice(0, 10)
}

function parseNewsFromSearch(content: string, _topic: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = []

  // Parse brave search results — they typically come as title/url/description entries
  const titleRegex = /Title:\s*(.+)/gi
  const urlRegex = /URL:\s*(https?:\/\/[^\s]+)/gi
  const descRegex = /Description:\s*(.+)/gi

  const titles = [...content.matchAll(titleRegex)].map(m => m[1].trim())
  const urls = [...content.matchAll(urlRegex)].map(m => m[1].trim())
  const descs = [...content.matchAll(descRegex)].map(m => m[1].trim())

  for (let i = 0; i < Math.min(titles.length, 3); i++) {
    const url = urls[i] || ''
    const domain = url ? new URL(url).hostname.replace('www.', '') : 'Unknown'

    items.push({
      title: titles[i] || 'Untitled',
      source: domain,
      url: url,
      snippet: descs[i] || '',
    })
  }

  return items
}

// ─── Jira / Confluence ──────────────────────────────────────

async function fetchJira(): Promise<unknown[]> {
  const registry = getMcpRegistry()

  // Look for Jira search tools
  const jiraSearch = registry.getAllTools().find(t =>
    t.name.includes('search_issues') || t.name.includes('jira_search') || t.name.includes('search_jira')
  )

  if (!jiraSearch) {
    // Try Rovo search as fallback
    const rovoSearch = registry.getAllTools().find(t => t.name.includes('rovo_search'))
    if (rovoSearch) {
      try {
        const result = await registry.callTool(rovoSearch.key, {
          query: 'my open issues assigned to me',
          product: 'jira',
        })
        if (result.success) {
          return parseJiraResults(result.content)
        }
      } catch {
        console.warn('[DailyPulse] Rovo search failed for Jira')
      }
    }

    return [{
      key: 'INFO',
      summary: 'Jira MCP not connected — go to Settings → Tools to add Jira',
      status: 'Info',
      priority: 'medium',
      type: 'jira',
    }]
  }

  try {
    const result = await registry.callTool(jiraSearch.key, {
      jql: 'assignee = currentUser() AND status != Done ORDER BY updated DESC',
      maxResults: 10,
    })
    if (result.success) {
      return parseJiraResults(result.content)
    }
  } catch (err) {
    console.warn('[DailyPulse] Jira search failed:', err)
  }

  return []
}

function parseJiraResults(content: string): Array<Record<string, string>> {
  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) {
      return parsed.map(issue => ({
        key: issue.key || issue.id || 'N/A',
        summary: issue.summary || issue.title || 'No summary',
        status: issue.status || issue.state || 'Unknown',
        priority: issue.priority || 'medium',
        type: 'jira',
        url: issue.url || issue.self || '',
      }))
    }
  } catch {
    // Not JSON — try text parsing
  }

  // Text-based parsing fallback
  const items: Array<Record<string, string>> = []
  const lines = content.split('\n').filter(l => l.trim())

  for (const line of lines.slice(0, 10)) {
    const keyMatch = line.match(/([A-Z]+-\d+)/)
    if (keyMatch) {
      items.push({
        key: keyMatch[1],
        summary: line.replace(keyMatch[0], '').replace(/[-:]\s*/, '').trim().slice(0, 100) || 'No summary',
        status: 'To Do',
        priority: 'medium',
        type: 'jira',
      })
    }
  }

  return items
}

// ─── Reminders ──────────────────────────────────────────────

async function fetchReminders(): Promise<unknown[]> {
  const db = getDatabase()

  try {
    // Query prospective memory for active reminders
    const rows = db.all<Record<string, string>>(`
      SELECT id, intention AS text, trigger_type AS triggerType, trigger_value AS triggerValue,
             created_at AS createdAt
      FROM prospective_memory
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT 10
    `)

    return rows
  } catch {
    // Table might not exist yet
    return []
  }
}
