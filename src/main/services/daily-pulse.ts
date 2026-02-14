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
  const db = getDatabase()

  // Read user settings
  const siteRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'daily_pulse_atlassian_site')
  const nameRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'user_name')
  const siteUrl = siteRow?.value?.trim() || ''
  const userName = nameRow?.value?.trim() || ''

  // Look for Atlassian MCP tools (from atlassian/atlassian-mcp-server)
  // Tool names: searchJiraIssuesUsingJql, getJiraIssue, search (Rovo)
  const jqlSearch = registry.getAllTools().find(t =>
    t.name === 'searchJiraIssuesUsingJql' || t.name === 'mcp_com_atlassian_searchJiraIssuesUsingJql'
  )
  const rovoSearch = registry.getAllTools().find(t =>
    t.name === 'search' || t.name === 'mcp_com_atlassian_search'
  )

  // Also check for generic Jira tools from other MCP providers
  const genericJiraSearch = !jqlSearch ? registry.getAllTools().find(t =>
    t.name.includes('search_issues') || t.name.includes('jira_search')
  ) : null

  const searchTool = jqlSearch || genericJiraSearch

  if (!searchTool && !rovoSearch) {
    return [{
      key: 'INFO',
      summary: 'Atlassian not connected — go to Settings → Daily Pulse to connect',
      status: 'Info',
      priority: 'medium',
      type: 'jira',
    }]
  }

  // Try JQL search first (more precise) — requires cloudId (site URL)
  if (searchTool && siteUrl) {
    try {
      // Build JQL: prefer currentUser(), fallback to name-based assignee search
      const assigneeClause = userName
        ? `assignee = currentUser() OR assignee = "${userName}"`
        : 'assignee = currentUser()'
      const jql = `(${assigneeClause}) AND statusCategory != Done ORDER BY updated DESC`

      console.log(`[DailyPulse] Jira JQL search — cloudId: "${siteUrl}", jql: "${jql}"`)

      const result = await registry.callTool(searchTool.key, {
        cloudId: siteUrl,
        jql,
        maxResults: 15,
        fields: ['summary', 'status', 'priority', 'issuetype', 'assignee', 'updated'],
      })

      console.log(`[DailyPulse] Jira JQL result — success: ${result.success}, content length: ${result.content?.length ?? 0}`)
      if (!result.success) {
        console.warn('[DailyPulse] Jira JQL returned error:', result.content?.slice(0, 300))
      }

      if (result.success && result.content?.trim()) {
        const parsed = parseJiraResults(result.content)
        if (parsed.length > 0) return parsed
        console.warn('[DailyPulse] Jira JQL returned success but parsed 0 items. Raw:', result.content.slice(0, 500))
      }
    } catch (err) {
      console.warn('[DailyPulse] Jira JQL search failed:', err)
    }
  } else if (searchTool && !siteUrl) {
    console.warn('[DailyPulse] JQL search skipped — no Atlassian Site URL configured in Settings → Daily Pulse')
  }

  // Fallback to Rovo search (does NOT require cloudId)
  if (rovoSearch) {
    try {
      const queryParts = ['open Jira issues']
      if (userName) queryParts.push(`assigned to ${userName}`)
      else queryParts.push('assigned to me')
      const query = queryParts.join(' ')

      console.log(`[DailyPulse] Rovo search fallback — query: "${query}"`)
      const result = await registry.callTool(rovoSearch.key, { query })

      console.log(`[DailyPulse] Rovo search result — success: ${result.success}, content length: ${result.content?.length ?? 0}`)
      if (result.success && result.content?.trim()) {
        const parsed = parseJiraResults(result.content)
        if (parsed.length > 0) return parsed
        console.warn('[DailyPulse] Rovo search returned success but parsed 0 items. Raw:', result.content.slice(0, 500))
      }
    } catch (err) {
      console.warn('[DailyPulse] Rovo search failed for Jira:', err)
    }
  }

  // Helpful message if no results
  if (!siteUrl) {
    return [{
      key: 'SETUP',
      summary: 'Set your Atlassian Site URL in Settings → Daily Pulse (e.g. myteam.atlassian.net)',
      status: 'Info',
      priority: 'medium',
      type: 'jira',
    }]
  }

  return []
}

function parseJiraResults(content: string): Array<Record<string, string>> {
  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(content)

    // Handle Atlassian MCP response shape: { issues: [...] } or direct array
    const issues = Array.isArray(parsed)
      ? parsed
      : parsed?.issues ?? parsed?.results ?? parsed?.values ?? (parsed?.key ? [parsed] : [])

    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map(issue => {
        // Handle nested status/priority objects from Atlassian API
        const status = typeof issue.status === 'object' ? (issue.status?.name || issue.status?.statusCategory?.name) : issue.status
        const priority = typeof issue.priority === 'object' ? issue.priority?.name : issue.priority
        const issueType = typeof issue.issuetype === 'object' ? issue.issuetype?.name : (issue.issuetype || issue.issueType)

        return {
          key: issue.key || issue.id || 'N/A',
          summary: issue.summary || issue.title || issue.fields?.summary || 'No summary',
          status: status || issue.fields?.status?.name || 'Unknown',
          priority: priority || issue.fields?.priority?.name || 'medium',
          type: issueType || 'jira',
          url: issue.url || issue.self || '',
          assignee: typeof issue.assignee === 'object' ? issue.assignee?.displayName : (issue.assignee || ''),
        }
      })
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
