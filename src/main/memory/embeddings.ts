/**
 * Embedding Service + Vector Search
 *
 * Generates embeddings via OpenRouter (text-embedding-3-small),
 * stores them as BLOBs in SQLite, and performs cosine similarity search.
 *
 * For < 100K memories, in-memory cosine search is fast enough.
 *
 * The generation cache (text → embedding) is persisted to SQLite
 * (embedding_cache table) so API calls aren't repeated after restart.
 */
import { createHash } from 'crypto'
import { getDatabase } from '../db/database'
import { LLMFactory } from '../llm'

// ─── Types ──────────────────────────────────────────────────

export interface VectorSearchResult {
  memoryId: string
  memoryType: string
  similarity: number
  embeddingText: string
}

// ─── Embedding Service ──────────────────────────────────────

export class EmbeddingService {
  private db = getDatabase()
  private cache = new Map<string, Float32Array>() // hot cache for recent embeddings
  private maxCacheSize = 1000
  private maxDbCacheSize = 5000
  private dbLoaded = false

  /**
   * Load persisted embedding cache from SQLite into memory.
   * Called lazily on first generate() call.
   */
  private loadFromDb(): void {
    if (this.dbLoaded) return
    this.dbLoaded = true

    try {
      const rows = this.db.all<{ text_hash: string; text_prefix: string; embedding: Buffer; dims: number }>(
        `SELECT text_hash, text_prefix, embedding, dims FROM embedding_cache ORDER BY last_used DESC LIMIT ?`,
        this.maxCacheSize
      )

      for (const row of rows) {
        const arr = bufferToFloat32(row.embedding)
        if (arr.length === row.dims) {
          // Use text_hash as cache key (we can't reconstruct full text)
          this.cache.set(row.text_hash, arr)
        }
      }

      if (rows.length > 0) {
        console.log(`[Embeddings] Loaded ${rows.length} cached embeddings from SQLite`)
      }
    } catch (err) {
      console.warn('[Embeddings] Failed to load cache from SQLite:', err)
    }
  }

  /**
   * Persist an embedding to the SQLite cache.
   */
  private persistToDb(textHash: string, textPrefix: string, embedding: Float32Array): void {
    try {
      const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
      this.db.run(
        `INSERT INTO embedding_cache (text_hash, text_prefix, embedding, dims, created_at, last_used)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(text_hash) DO UPDATE SET last_used = datetime('now')`,
        textHash,
        textPrefix,
        buffer,
        embedding.length
      )
    } catch (err) {
      console.warn('[Embeddings] Failed to persist to SQLite:', err)
    }
  }

  /**
   * Prune old entries from the SQLite cache to stay within limits.
   * Called periodically after inserts.
   */
  private pruneDbCache(): void {
    try {
      const count = this.db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM embedding_cache`
      )?.count ?? 0

      if (count > this.maxDbCacheSize) {
        const toDelete = count - this.maxDbCacheSize
        this.db.run(
          `DELETE FROM embedding_cache WHERE text_hash IN (
            SELECT text_hash FROM embedding_cache ORDER BY last_used ASC LIMIT ?
          )`,
          toDelete
        )
        console.log(`[Embeddings] Pruned ${toDelete} old entries from SQLite cache`)
      }
    } catch (err) {
      console.warn('[Embeddings] Failed to prune SQLite cache:', err)
    }
  }

  /**
   * Compute a SHA-256 hash of the text for cache keying.
   */
  private hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  /**
   * Generate an embedding for text via OpenRouter.
   * Falls back to a simple hash-based pseudo-embedding if no API key is configured.
   */
  async generate(text: string): Promise<Float32Array> {
    // Ensure DB cache is loaded
    this.loadFromDb()

    // Check in-memory cache (keyed by text hash)
    const textHash = this.hashText(text)
    const cached = this.cache.get(textHash)
    if (cached) return cached

    try {
      if (LLMFactory.isConfigured('openrouter')) {
        const adapter = LLMFactory.getProvider('openrouter')
        const embedding = await adapter.embeddings(text)
        this.addToCache(textHash, embedding)
        this.persistToDb(textHash, text.slice(0, 200), embedding)
        return embedding
      }
    } catch (err) {
      console.warn('[Embeddings] OpenRouter embedding failed, using fallback:', err)
    }

    // Fallback: deterministic pseudo-embedding (for offline / no API key)
    const fallback = this.pseudoEmbedding(text)
    this.addToCache(textHash, fallback)
    this.persistToDb(textHash, text.slice(0, 200), fallback)
    return fallback
  }

  /**
   * Store an embedding in the index table.
   */
  storeEmbedding(memoryId: string, memoryType: string, embedding: Float32Array, text: string): void {
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)

    // Upsert: replace if same memory_id + memory_type exists
    this.db.run(
      `INSERT INTO embeddings_index (memory_id, memory_type, embedding_text, embedding, created_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(memory_id, memory_type) DO UPDATE SET
         embedding_text = excluded.embedding_text,
         embedding = excluded.embedding,
         created_at = CURRENT_TIMESTAMP`,
      memoryId,
      memoryType,
      text, // store full text
      buffer
    )
  }

  /**
   * Remove an embedding from the index.
   */
  removeEmbedding(memoryId: string, memoryType: string): void {
    this.db.run(
      `DELETE FROM embeddings_index WHERE memory_id = ? AND memory_type = ?`,
      memoryId,
      memoryType
    )
  }

  /**
   * Semantic vector search — find similar memories by cosine similarity.
   */
  async search(
    queryText: string,
    options: {
      memoryType?: string       // filter by type
      limit?: number
      minSimilarity?: number
    } = {}
  ): Promise<VectorSearchResult[]> {
    const { memoryType, limit = 10, minSimilarity = 0.5 } = options

    // Generate query embedding
    const queryEmbedding = await this.generate(queryText)

    // Load candidate embeddings from DB
    let rows: RawEmbeddingRow[]
    if (memoryType) {
      rows = this.db.all<RawEmbeddingRow>(
        `SELECT memory_id, memory_type, embedding_text, embedding FROM embeddings_index WHERE memory_type = ?`,
        memoryType
      )
    } else {
      rows = this.db.all<RawEmbeddingRow>(
        `SELECT memory_id, memory_type, embedding_text, embedding FROM embeddings_index`
      )
    }

    // Score all candidates by cosine similarity
    const scored: VectorSearchResult[] = []

    for (const row of rows) {
      const stored = bufferToFloat32(row.embedding)
      if (stored.length !== queryEmbedding.length) continue // dimension mismatch

      const similarity = cosineSimilarity(queryEmbedding, stored)
      if (similarity >= minSimilarity) {
        scored.push({
          memoryId: row.memory_id,
          memoryType: row.memory_type,
          similarity,
          embeddingText: row.embedding_text,
        })
      }
    }

    // Sort by similarity descending, return top N
    scored.sort((a, b) => b.similarity - a.similarity)
    return scored.slice(0, limit)
  }

  /** Get index stats */
  getStats(): { total: number; byType: Record<string, number>; cacheSize: number; dbCacheSize: number } {
    const total = this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM embeddings_index`
    )?.count ?? 0

    const byTypeRows = this.db.all<{ memory_type: string; count: number }>(
      `SELECT memory_type, COUNT(*) as count FROM embeddings_index GROUP BY memory_type`
    )

    const byType: Record<string, number> = {}
    for (const row of byTypeRows) {
      byType[row.memory_type] = row.count
    }

    const dbCacheSize = this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM embedding_cache`
    )?.count ?? 0

    return { total, byType, cacheSize: this.cache.size, dbCacheSize }
  }

  // ─── Internal ─────────────────────────────────────────────

  /** Add to LRU cache */
  private addToCache(key: string, embedding: Float32Array): void {
    if (this.cache.size >= this.maxCacheSize) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }
    this.cache.set(key, embedding)

    // Prune DB cache every 100 inserts
    if (this.cache.size % 100 === 0) {
      this.pruneDbCache()
    }
  }

  /**
   * Pseudo-embedding fallback: deterministic 384-dim vector from text hash.
   * Not semantically meaningful but provides consistent results for dedup.
   */
  private pseudoEmbedding(text: string, dims = 384): Float32Array {
    const embedding = new Float32Array(dims)
    const normalized = text.toLowerCase().trim()

    // Simple hash-based seeding
    let hash = 0
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0
    }

    // Generate deterministic values using LCG
    let seed = Math.abs(hash)
    for (let i = 0; i < dims; i++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff
      embedding[i] = (seed / 0xffffffff) * 2 - 1 // normalize to [-1, 1]
    }

    // Normalize to unit vector
    let norm = 0
    for (let i = 0; i < dims; i++) norm += embedding[i] * embedding[i]
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let i = 0; i < dims; i++) embedding[i] /= norm
    }

    return embedding
  }
}

// ─── Utility Functions ──────────────────────────────────────

/** Cosine similarity between two vectors */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/** Convert a SQLite BLOB (Buffer) to Float32Array */
function bufferToFloat32(buf: Buffer): Float32Array {
  // Ensure proper alignment
  const aligned = Buffer.alloc(buf.length)
  buf.copy(aligned)
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
}

// ─── Raw DB row type ────────────────────────────────────────

interface RawEmbeddingRow {
  memory_id: string
  memory_type: string
  embedding_text: string
  embedding: Buffer
}

// ─── Singleton ──────────────────────────────────────────────

let instance: EmbeddingService | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!instance) {
    instance = new EmbeddingService()
  }
  return instance
}
