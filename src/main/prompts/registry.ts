/**
 * Prompt Registry — Centralized prompt management with versioning.
 *
 * Each prompt is registered with a name, a template function, and an auto-computed
 * content hash. This enables:
 * - Version tracking: every agent run records which prompt version produced it
 * - Audit trail: see when prompts last changed
 * - Future A/B testing: swap between registered variants
 *
 * Prompts are identified by `name` (e.g., "coder-system") and versioned by content hash.
 * When the prompt text changes (even a single character), the version hash updates automatically.
 */
import { createHash } from 'crypto'

// ─── Types ──────────────────────────────────────────────────

export interface PromptEntry {
  /** Unique name, e.g. "triage", "coder-system", "synthesis" */
  name: string
  /** Human-readable version label, e.g. "v1", "v2-improved" */
  label: string
  /** Content hash (first 8 chars of SHA-256) — auto-computed */
  hash: string
  /** Combined version string: "label:hash", e.g. "v1:a4f2c9e1" */
  version: string
  /** The template function that generates the prompt text */
  getTemplate: (...args: unknown[]) => string
  /** When this version was registered */
  registeredAt: number
}

export interface PromptVersion {
  name: string
  version: string
  label: string
  hash: string
}

// ─── Registry ───────────────────────────────────────────────

class PromptRegistry {
  private prompts = new Map<string, PromptEntry>()

  /**
   * Register a prompt template.
   * The content hash is computed from the template function's toString()
   * so it automatically changes when the code changes.
   */
  register(
    name: string,
    label: string,
    getTemplate: (...args: unknown[]) => string
  ): PromptEntry {
    const hash = this.computeHash(getTemplate.toString())
    const entry: PromptEntry = {
      name,
      label,
      hash,
      version: `${label}:${hash}`,
      getTemplate,
      registeredAt: Date.now(),
    }
    this.prompts.set(name, entry)
    return entry
  }

  /**
   * Get a prompt by name and render it with the given arguments.
   * Returns the rendered text and the version string.
   */
  render(name: string, ...args: unknown[]): { text: string; version: string } {
    const entry = this.prompts.get(name)
    if (!entry) {
      throw new Error(`[PromptRegistry] Unknown prompt: "${name}"`)
    }
    return {
      text: entry.getTemplate(...args),
      version: entry.version,
    }
  }

  /**
   * Get version info for a prompt without rendering it.
   */
  getVersion(name: string): PromptVersion | null {
    const entry = this.prompts.get(name)
    if (!entry) return null
    return {
      name: entry.name,
      version: entry.version,
      label: entry.label,
      hash: entry.hash,
    }
  }

  /**
   * List all registered prompts with their versions.
   */
  listAll(): PromptVersion[] {
    return Array.from(this.prompts.values()).map((e) => ({
      name: e.name,
      version: e.version,
      label: e.label,
      hash: e.hash,
    }))
  }

  /**
   * Check if a prompt is registered.
   */
  has(name: string): boolean {
    return this.prompts.has(name)
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 8)
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: PromptRegistry | null = null

export function getPromptRegistry(): PromptRegistry {
  if (!instance) {
    instance = new PromptRegistry()
  }
  return instance
}

export { PromptRegistry }
