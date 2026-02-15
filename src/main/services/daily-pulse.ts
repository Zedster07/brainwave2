/**
 * Daily Pulse Service — Backend data fetching for the morning briefing
 *
 * Each section fetches data from:
 * - Weather: WeatherAPI.com (direct HTTP)
 * - Emails: Gmail API (placeholder — requires OAuth setup)
 * - News: brave_web_search MCP with user interests
 * - Jira: Jira MCP (already connected)
 * - Reminders: Internal memory/prospective database
 */
import { net } from 'electron'
import { getMcpRegistry } from '../mcp'
import { getDatabase } from '../db/database'

type PulseSection = 'weather' | 'emails' | 'news' | 'jira' | 'confluence' | 'reminders'

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
    case 'confluence':
      return fetchConfluence()
    case 'reminders':
      return fetchReminders()
    default:
      throw new Error(`Unknown pulse section: ${section}`)
  }
}

// ─── Weather (WeatherAPI.com) ───────────────────────────────

const WEATHER_API_KEY = 'aa3be1c721a441bca30180104240812'

async function fetchWeather(): Promise<unknown> {
  const cityName = getSettingValue('daily_pulse_city') || 'Algiers'

  const url = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(cityName)}&days=1&aqi=no&alerts=no`

  console.log(`[DailyPulse] Weather — fetching for city: "${cityName}"`)

  const json = await new Promise<string>((resolve, reject) => {
    const request = net.request(url)
    let body = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { body += chunk.toString() })
      response.on('end', () => {
        if (response.statusCode === 200) resolve(body)
        else reject(new Error(`WeatherAPI responded ${response.statusCode}: ${body.slice(0, 200)}`))
      })
    })
    request.on('error', reject)
    request.end()
  })

  const data = JSON.parse(json)
  const current = data.current
  const forecast = data.forecast?.forecastday?.[0]?.day
  const location = data.location

  return {
    temp: `${Math.round(current.temp_c)}°C`,
    feelsLike: `${Math.round(current.feelslike_c)}°C`,
    condition: current.condition?.text || 'Unknown',
    icon: current.condition?.icon ? `https:${current.condition.icon}` : '',
    high: forecast ? `${Math.round(forecast.maxtemp_c)}°` : '--',
    low: forecast ? `${Math.round(forecast.mintemp_c)}°` : '--',
    city: location?.name || cityName,
    humidity: `${current.humidity}%`,
    wind: `${Math.round(current.wind_kph)} km/h`,
    uv: current.uv != null ? String(current.uv) : undefined,
    chanceOfRain: forecast?.daily_chance_of_rain != null ? `${forecast.daily_chance_of_rain}%` : undefined,
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

/**
 * Reads the Atlassian Cloud ID (UUID) from settings.
 * The Atlassian MCP tools require the cloudId — e.g. 2632a86a-c338-4605-ada6-784c713c7d85
 */
function getSettingValue(key: string): string {
  const db = getDatabase()
  const row = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key)
  if (!row?.value) return ''
  try { return String(JSON.parse(row.value)).trim() } catch { return row.value.trim() }
}

function getAtlassianCloudId(): string {
  return getSettingValue('daily_pulse_atlassian_site')
}

async function fetchJira(): Promise<unknown[]> {
  const registry = getMcpRegistry()

  const cloudId = getAtlassianCloudId()
  const userName = getSettingValue('user_name')

  // Find JQL search tool
  const jqlSearch = registry.getAllTools().find(t =>
    t.name === 'searchJiraIssuesUsingJql' || t.name === 'mcp_com_atlassian_searchJiraIssuesUsingJql'
  )

  if (!jqlSearch) {
    return [{
      key: 'INFO',
      summary: 'Atlassian not connected — go to Settings → Daily Pulse to connect',
      status: 'Info',
      priority: 'Medium',
      type: 'jira',
    }]
  }

  if (!cloudId) {
    return [{
      key: 'SETUP',
      summary: 'Set your Atlassian Cloud ID in Settings → Daily Pulse to see Jira tickets',
      status: 'Info',
      priority: 'Medium',
      type: 'jira',
    }]
  }

  try {
    const assigneeClause = userName
      ? `assignee = currentUser() OR assignee = "${userName}"`
      : 'assignee = currentUser()'
    const jql = `(${assigneeClause}) AND statusCategory != Done ORDER BY updated DESC`

    console.log(`[DailyPulse] Jira JQL — cloudId: "${cloudId}", jql: "${jql}"`)

    const result = await registry.callTool(jqlSearch.key, {
      cloudId,
      jql,
      maxResults: 15,
      fields: ['summary', 'status', 'priority', 'issuetype', 'assignee', 'updated'],
    })

    console.log(`[DailyPulse] Jira JQL result — success: ${result.success}, content length: ${result.content?.length ?? 0}`)

    if (result.success && result.content?.trim()) {
      const parsed = parseJiraResults(result.content)
      if (parsed.length > 0) return parsed
      console.warn('[DailyPulse] Jira parsed 0 items. Raw (first 800):', result.content.slice(0, 800))
    } else if (!result.success) {
      console.warn('[DailyPulse] Jira JQL error:', result.content?.slice(0, 400))
    }
  } catch (err) {
    console.warn('[DailyPulse] Jira JQL search failed:', err)
  }

  return []
}

/**
 * Parse Jira JQL response from Atlassian MCP.
 * Actual shape: { issues: { totalCount, nodes: [ { key, fields: { summary, status, ... }, webUrl } ] } }
 */
function parseJiraResults(content: string): Array<Record<string, string>> {
  try {
    const parsed = JSON.parse(content)

    // The Atlassian MCP returns { issues: { totalCount, nodes: [...] } }
    const nodes = parsed?.issues?.nodes
      ?? (Array.isArray(parsed?.issues) ? parsed.issues : null)
      ?? (Array.isArray(parsed) ? parsed : null)
      ?? []

    if (Array.isArray(nodes) && nodes.length > 0) {
      return nodes.map((issue: Record<string, any>) => {
        const f = issue.fields || {}

        const statusName = typeof f.status === 'object'
          ? (f.status?.statusCategory?.name || f.status?.name)
          : (f.status || issue.status || 'Unknown')

        const priorityName = typeof f.priority === 'object'
          ? f.priority?.name
          : (f.priority || issue.priority || 'Medium')

        const issueTypeName = typeof f.issuetype === 'object'
          ? f.issuetype?.name
          : (f.issuetype || issue.issuetype || '')

        const assigneeName = typeof f.assignee === 'object'
          ? f.assignee?.displayName
          : (f.assignee || issue.assignee || '')

        return {
          key: issue.key || 'N/A',
          summary: f.summary || issue.summary || issue.title || 'No summary',
          status: statusName,
          priority: priorityName,
          type: issueTypeName || 'jira',
          url: issue.webUrl || issue.url || issue.self || '',
          assignee: assigneeName,
        }
      })
    }
  } catch (err) {
    console.warn('[DailyPulse] Failed to parse Jira JSON:', err)
  }

  // Text-based parsing fallback
  const items: Array<Record<string, string>> = []
  const lines = content.split('\n').filter(l => l.trim())
  for (const line of lines.slice(0, 15)) {
    const keyMatch = line.match(/([A-Z]+-\d+)/)
    if (keyMatch) {
      items.push({
        key: keyMatch[1],
        summary: line.replace(keyMatch[0], '').replace(/[-:]\s*/, '').trim() || 'No summary',
        status: 'To Do',
        priority: 'Medium',
        type: 'jira',
      })
    }
  }

  return items
}

// ─── Confluence ─────────────────────────────────────────────

async function fetchConfluence(): Promise<unknown[]> {
  const registry = getMcpRegistry()

  const cloudId = getAtlassianCloudId()

  // Find Confluence CQL search tool
  const cqlSearch = registry.getAllTools().find(t =>
    t.name === 'searchConfluenceUsingCql' || t.name === 'mcp_com_atlassian_searchConfluenceUsingCql'
  )

  if (!cqlSearch) {
    return [{
      id: 'INFO',
      title: 'Atlassian not connected — go to Settings → Daily Pulse to connect',
      space: '',
      url: '',
      lastUpdated: '',
      type: 'info',
    }]
  }

  if (!cloudId) {
    return [{
      id: 'SETUP',
      title: 'Set your Atlassian Cloud ID in Settings → Daily Pulse',
      space: '',
      url: '',
      lastUpdated: '',
      type: 'info',
    }]
  }

  try {
    const cql = `type = page ORDER BY lastModified DESC`

    console.log(`[DailyPulse] Confluence CQL — cloudId: "${cloudId}", cql: "${cql}"`)

    const result = await registry.callTool(cqlSearch.key, {
      cloudId,
      cql,
      limit: 10,
    })

    console.log(`[DailyPulse] Confluence CQL result — success: ${result.success}, content length: ${result.content?.length ?? 0}`)

    if (result.success && result.content?.trim()) {
      const parsed = parseConfluenceResults(result.content)
      if (parsed.length > 0) return parsed
      console.warn('[DailyPulse] Confluence parsed 0 items. Raw (first 800):', result.content.slice(0, 800))
    } else if (!result.success) {
      console.warn('[DailyPulse] Confluence CQL error:', result.content?.slice(0, 400))
    }
  } catch (err) {
    console.warn('[DailyPulse] Confluence CQL search failed:', err)
  }

  return []
}

/**
 * Parse Confluence CQL response from Atlassian MCP.
 * Actual shape: { content: { totalCount, nodes: [ { id, title, space: { key, name }, webUrl, lastModified } ] } }
 */
function parseConfluenceResults(content: string): Array<Record<string, string>> {
  try {
    const parsed = JSON.parse(content)

    // The Atlassian MCP returns { content: { totalCount, nodes: [...] } }
    const nodes = parsed?.content?.nodes
      ?? (Array.isArray(parsed?.content) ? parsed.content : null) // fallback
      ?? parsed?.results
      ?? (Array.isArray(parsed) ? parsed : null)
      ?? []

    if (Array.isArray(nodes) && nodes.length > 0) {
      return nodes.map((page: Record<string, any>) => ({
        id: page.id || 'N/A',
        title: page.title || page.name || 'Untitled',
        space: typeof page.space === 'object' ? (page.space?.name || page.space?.key || '') : (page.space || ''),
        url: page.webUrl || page.url || page._links?.webui || '',
        lastUpdated: page.lastModified || page.version?.when || page.updated || '',
        type: 'confluence',
      }))
    }
  } catch (err) {
    console.warn('[DailyPulse] Failed to parse Confluence JSON:', err)
  }

  return []
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
