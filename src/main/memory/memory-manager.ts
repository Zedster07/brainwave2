/**
 * Memory Manager — Unified interface to all memory subsystems
 *
 * Multi-strategy recall: vector similarity + FTS5 keyword + recency.
 * Handles embedding generation, indexing, and result ranking.
 * This is the single entry point that agents and the Orchestrator use.
 */
import { EpisodicMemoryStore, type EpisodicEntry, type StoreEpisodicInput } from './episodic'
import { SemanticMemoryStore, type SemanticEntry, type StoreSemanticInput } from './semantic'
import { EmbeddingService, getEmbeddingService, type VectorSearchResult } from './embeddings'
import { FTSService, getFTSService, type FTSResult } from './fts'
import { WorkingMemory, getWorkingMemory } from './working-memory'
import { getPeopleStore, type PersonEntry } from './people'
import { getProceduralStore, type ProceduralEntry } from './procedural'
import { getProspectiveStore, type ProspectiveEntry } from './prospective'
import { getDatabase } from '../db/database'
import { getEventBus } from '../agents/event-bus'
import { countTokens } from '../llm/token-counter'

// ─── Types ──────────────────────────────────────────────────

export interface RecallOptions {
  memoryTypes?: Array<'episodic' | 'semantic'>
  limit?: number
  minSimilarity?: number
  includeRecent?: boolean
}

export interface RecallResult {
  id: string
  type: 'episodic' | 'semantic'
  content: string
  relevance: number         // combined score 0-1
  source: 'vector' | 'fts' | 'recent'
  entry: EpisodicEntry | SemanticEntry
}

export interface MemoryStats {
  episodic: number
  semantic: number
  embeddings: { total: number; byType: Record<string, number> }
  fts: { totalIndexed: number; byType: Record<string, number> }
  dbSizeMB: number
}

// ─── Memory Manager ─────────────────────────────────────────

export class MemoryManager {
  readonly episodic = new EpisodicMemoryStore()
  readonly semantic = new SemanticMemoryStore()
  readonly embeddings: EmbeddingService
  readonly fts: FTSService
  readonly working: WorkingMemory

  private bus = getEventBus()

  constructor(embeddingService: EmbeddingService, ftsService: FTSService) {
    this.embeddings = embeddingService
    this.fts = ftsService
    this.working = getWorkingMemory()
  }

  // ─── Store (Encoding) ──────────────────────────────────

  /** Store an episodic memory with automatic embedding + FTS indexing */
  async storeEpisodic(input: StoreEpisodicInput): Promise<EpisodicEntry> {
    const entry = this.episodic.store(input)

    // Generate and store embedding
    try {
      const embedding = await this.embeddings.generate(input.content)
      this.embeddings.storeEmbedding(entry.id, 'episodic', embedding, input.content)
    } catch (err) {
      console.warn('[Memory] Embedding generation failed for episodic:', err)
    }

    // Index for FTS
    this.fts.index(entry.id, 'episodic', input.content, input.tags)

    this.bus.emitEvent('system:log', {
      level: 'debug',
      message: `Stored episodic memory: ${input.content.slice(0, 80)}...`,
      data: { id: entry.id, importance: entry.importance },
    })

    return entry
  }

  /** Store a semantic memory with automatic embedding + FTS indexing */
  async storeSemantic(input: StoreSemanticInput): Promise<SemanticEntry> {
    const entry = this.semantic.store(input)
    const textContent = `${input.subject} ${input.predicate} ${input.object}`

    // Generate and store embedding
    try {
      const embedding = await this.embeddings.generate(textContent)
      this.embeddings.storeEmbedding(entry.id, 'semantic', embedding, textContent)
    } catch (err) {
      console.warn('[Memory] Embedding generation failed for semantic:', err)
    }

    // Index for FTS
    this.fts.index(entry.id, 'semantic', textContent, input.tags)

    this.bus.emitEvent('system:log', {
      level: 'debug',
      message: `Stored semantic memory: ${input.subject} ${input.predicate} ${input.object}`,
      data: { id: entry.id, confidence: entry.confidence },
    })

    return entry
  }

  // ─── Recall (Retrieval) ────────────────────────────────

  /**
   * Multi-strategy recall — the main memory search method.
   * Combines vector similarity, FTS keyword search, and recency.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult[]> {
    const {
      memoryTypes = ['episodic', 'semantic'],
      limit = 10,
      minSimilarity = 0.5,
      includeRecent = true,
    } = options

    const allResults: RecallResult[] = []

    // Strategy 1: Vector similarity search
    for (const type of memoryTypes) {
      try {
        const vectorResults = await this.embeddings.search(query, {
          memoryType: type,
          limit: limit * 2, // fetch more, will deduplicate
          minSimilarity,
        })

        for (const vr of vectorResults) {
          const entry = this.resolveEntry(vr.memoryId, vr.memoryType as 'episodic' | 'semantic')
          if (entry) {
            allResults.push({
              id: vr.memoryId,
              type: vr.memoryType as 'episodic' | 'semantic',
              content: vr.embeddingText,
              relevance: vr.similarity,
              source: 'vector',
              entry,
            })
          }
        }
      } catch (err) {
        console.warn(`[Memory] Vector search failed for ${type}:`, err)
      }
    }

    // Strategy 2: FTS keyword search
    for (const type of memoryTypes) {
      try {
        const ftsResults = this.fts.search(query, { memoryType: type, limit: limit * 2 })

        for (const fr of ftsResults) {
          // Skip if already found via vector search
          if (allResults.some((r) => r.id === fr.memoryId)) continue

          const entry = this.resolveEntry(fr.memoryId, fr.memoryType as 'episodic' | 'semantic')
          if (entry) {
            allResults.push({
              id: fr.memoryId,
              type: fr.memoryType as 'episodic' | 'semantic',
              content: fr.content,
              relevance: this.ftsRankToRelevance(fr.rank),
              source: 'fts',
              entry,
            })
          }
        }
      } catch (err) {
        console.warn(`[Memory] FTS search failed for ${type}:`, err)
      }
    }

    // Strategy 3: Recency (recent episodic memories have natural relevance)
    if (includeRecent && memoryTypes.includes('episodic')) {
      const recent = this.episodic.getRecent(5)
      for (const ep of recent) {
        if (!allResults.some((r) => r.id === ep.id)) {
          allResults.push({
            id: ep.id,
            type: 'episodic',
            content: ep.content,
            relevance: 0.3, // base recency score
            source: 'recent',
            entry: ep,
          })
        }
      }
    }

    // Deduplicate and rank
    const ranked = this.rankResults(allResults)
    return ranked.slice(0, limit)
  }

  /**
   * Recall and format as context strings (for agent prompts).
   * @param maxTokens Optional token budget — memories exceeding it are trimmed/dropped (default 2000)
   */
  async recallForContext(query: string, limit = 5, maxTokens = 2000): Promise<string[]> {
    const results = await this.recall(query, { limit })

    const formatted = results.map((r) => {
      if (r.type === 'episodic') {
        const ep = r.entry as EpisodicEntry
        return `[Episode ${ep.timestamp}] ${ep.content} (importance: ${ep.importance})`
      } else {
        const sem = r.entry as SemanticEntry
        return `[Knowledge] ${sem.subject} ${sem.predicate} ${sem.object} (confidence: ${sem.confidence})`
      }
    })

    // Also search the People store for person-related context
    try {
      const peopleStore = getPeopleStore()
      const matchedPeople = peopleStore.search(query, 5)
      // Also include all people if query is identity-related
      const identityQuery = /who am i|my name|know me|remember me|about me/i.test(query)
      const allPeople = identityQuery ? peopleStore.getAll(10) : []
      // Merge and deduplicate
      const peopleMap = new Map<string, typeof matchedPeople[0]>()
      for (const p of [...matchedPeople, ...allPeople]) {
        if (!peopleMap.has(p.id)) peopleMap.set(p.id, p)
      }
      const peopleContext = Array.from(peopleMap.values()).map((p) => {
        const parts = [`[Person] ${p.name}`]
        if (p.relationship) parts.push(`relationship: ${p.relationship}`)
        if (p.traits.length > 0) parts.push(`traits: ${p.traits.join(', ')}`)
        if (Object.keys(p.preferences).length > 0) parts.push(`preferences: ${JSON.stringify(p.preferences)}`)
        return parts.join(' — ')
      })

      // Search procedural memory for relevant learned workflows
      let proceduralContext: string[] = []
      try {
        const proceduralStore = getProceduralStore()
        const matchedProcedures = proceduralStore.search(query, 3)
        proceduralContext = matchedProcedures
          .filter((p) => p.successRate >= 0.3 || p.executionCount === 0)
          .map((p) => {
            const steps = p.steps.map((s) => `  ${s.order}. ${s.action}`).join('\n')
            return `[Procedure] ${p.name}${p.description ? ': ' + p.description : ''} (success: ${(p.successRate * 100).toFixed(0)}%, used ${p.executionCount}x)\n${steps}`
          })
      } catch (err) {
        console.warn('[MemoryManager] Procedural store search failed:', err)
      }

      const allMemories = [...peopleContext, ...formatted, ...proceduralContext]

      // Token budget enforcement — trim memories that exceed budget
      if (maxTokens > 0) {
        return this.trimToTokenBudget(allMemories, maxTokens)
      }
      return allMemories
    } catch (err) {
      console.warn('[MemoryManager] People store search failed:', err)
      if (maxTokens > 0) {
        return this.trimToTokenBudget(formatted, maxTokens)
      }
      return formatted
    }
  }

  // ─── Delete ────────────────────────────────────────────

  /** Delete a memory and its indexes */
  deleteMemory(id: string, type: 'episodic' | 'semantic'): boolean {
    let deleted = false

    if (type === 'episodic') {
      deleted = this.episodic.delete(id)
    } else {
      deleted = this.semantic.delete(id)
    }

    if (deleted) {
      this.embeddings.removeEmbedding(id, type)
      this.fts.remove(id, type)
    }

    return deleted
  }

  // ─── Stats ─────────────────────────────────────────────

  getStats(): MemoryStats {
    const db = getDatabase()

    return {
      episodic: this.episodic.count(),
      semantic: this.semantic.count(),
      embeddings: this.embeddings.getStats(),
      fts: this.fts.getStats(),
      dbSizeMB: db.getSize(),
    }
  }

  // ─── Internal ─────────────────────────────────────────────

  /** Resolve a memory entry from its ID and type */
  private resolveEntry(memoryId: string, type: 'episodic' | 'semantic'): EpisodicEntry | SemanticEntry | null {
    if (type === 'episodic') {
      return this.episodic.recall(memoryId)
    } else {
      return this.semantic.recall(memoryId)
    }
  }

  /** Convert FTS5 rank score to a 0-1 relevance score */
  private ftsRankToRelevance(rank: number): number {
    // FTS5 rank is negative (lower = better match)
    // Convert to 0-1 scale. Typical range is -10 to 0
    return Math.min(1, Math.max(0, 1 + rank / 10))
  }

  /** Rank and deduplicate results by combined relevance */
  private rankResults(results: RecallResult[]): RecallResult[] {
    // Merge scores for same memory found via different strategies
    const byId = new Map<string, RecallResult>()

    for (const result of results) {
      const existing = byId.get(result.id)
      if (existing) {
        // Boost score — found via multiple strategies
        existing.relevance = Math.min(1, existing.relevance + result.relevance * 0.5)
      } else {
        byId.set(result.id, { ...result })
      }
    }

    return [...byId.values()].sort((a, b) => b.relevance - a.relevance)
  }

  /**
   * Trim a list of memory strings to fit within a token budget.
   * Keeps items in order, truncating the last one that partially fits.
   */
  private trimToTokenBudget(memories: string[], maxTokens: number): string[] {
    const result: string[] = []
    let totalTokens = 0

    for (const mem of memories) {
      const tokens = countTokens(mem)
      if (totalTokens + tokens <= maxTokens) {
        result.push(mem)
        totalTokens += tokens
      } else {
        // Partially fit: truncate to remaining budget (rough char estimate)
        const remaining = maxTokens - totalTokens
        if (remaining > 50) {
          // ~4 chars per token heuristic for truncation point
          const charLimit = remaining * 4
          result.push(mem.slice(0, charLimit) + '\n[...memory truncated to fit budget]')
        }
        break
      }
    }

    if (result.length < memories.length) {
      console.log(`[MemoryManager] Trimmed recalled memories from ${memories.length} to ${result.length} items (~${totalTokens}/${maxTokens} tokens)`)
    }
    return result
  }
}

// ─── Export/Import Types ────────────────────────────────────

export interface BrainwaveMemoryExport {
  version: 1
  exportedAt: string
  data: {
    episodic: EpisodicEntry[]
    semantic: SemanticEntry[]
    procedural: ProceduralEntry[]
    prospective: ProspectiveEntry[]
    people: PersonEntry[]
  }
}

/** Export all memories to a JSON-serializable object */
export function exportAllMemories(): BrainwaveMemoryExport {
  const mm = getMemoryManager()
  const procedural = getProceduralStore()
  const prospective = getProspectiveStore()
  const people = getPeopleStore()

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      episodic: mm.episodic.getAll(),
      semantic: mm.semantic.getAll(),
      procedural: procedural.getAll(),
      prospective: prospective.getAll(),
      people: people.getAll(),
    },
  }
}

/** Import memories from an export object. Returns counts of imported/skipped. */
export function importAllMemories(
  exportData: BrainwaveMemoryExport
): { imported: number; skipped: number } {
  if (exportData.version !== 1) {
    throw new Error(`Unsupported export version: ${exportData.version}`)
  }

  const mm = getMemoryManager()
  const procedural = getProceduralStore()
  const prospective = getProspectiveStore()
  const people = getPeopleStore()

  let imported = 0
  let skipped = 0

  // Episodic — store via MemoryManager so embeddings + FTS are indexed
  for (const entry of exportData.data.episodic ?? []) {
    try {
      mm.storeEpisodic({
        content: entry.content,
        context: entry.context ?? {},
        emotionalValence: entry.emotionalValence ?? 0,
        importance: entry.importance ?? 0.5,
        tags: entry.tags ?? [],
        metadata: entry.metadata ?? {},
      })
      imported++
    } catch {
      skipped++
    }
  }

  // Semantic — store via MemoryManager (has upsert/dedup logic)
  for (const entry of exportData.data.semantic ?? []) {
    try {
      mm.storeSemantic({
        subject: entry.subject,
        predicate: entry.predicate,
        object: entry.object,
        confidence: entry.confidence ?? 0.8,
        source: entry.source ?? 'import',
        tags: entry.tags ?? [],
        metadata: entry.metadata ?? {},
      })
      imported++
    } catch {
      skipped++
    }
  }

  // Procedural
  for (const entry of exportData.data.procedural ?? []) {
    try {
      procedural.store({
        name: entry.name,
        description: entry.description ?? undefined,
        steps: entry.steps ?? [],
        triggerConditions: entry.triggerConditions ?? [],
        tags: entry.tags ?? [],
        metadata: entry.metadata ?? {},
      })
      imported++
    } catch {
      skipped++
    }
  }

  // Prospective
  for (const entry of exportData.data.prospective ?? []) {
    try {
      prospective.store({
        intention: entry.intention,
        triggerType: entry.triggerType,
        triggerValue: entry.triggerValue,
        priority: entry.priority ?? 0.5,
        dueAt: entry.dueAt ?? undefined,
        tags: entry.tags ?? [],
        metadata: entry.metadata ?? {},
      })
      imported++
    } catch {
      skipped++
    }
  }

  // People — upserts by name
  for (const entry of exportData.data.people ?? []) {
    try {
      people.store({
        name: entry.name,
        relationship: entry.relationship ?? undefined,
        traits: entry.traits ?? [],
        preferences: entry.preferences ?? {},
        metadata: entry.metadata ?? {},
      })
      imported++
    } catch {
      skipped++
    }
  }

  console.log(`[Memory] Import complete: ${imported} imported, ${skipped} skipped`)
  return { imported, skipped }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: MemoryManager | null = null

export function initMemoryManager(): MemoryManager {
  if (!instance) {
    instance = new MemoryManager(getEmbeddingService(), getFTSService())
    console.log('[Memory] MemoryManager initialized')
  }
  return instance
}

export function getMemoryManager(): MemoryManager {
  if (!instance) {
    return initMemoryManager()
  }
  return instance
}
