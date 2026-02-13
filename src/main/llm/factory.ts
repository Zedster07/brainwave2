/**
 * LLM Factory & Manager
 *
 * Creates provider instances and manages per-agent model assignments.
 * Caches provider instances by API key to avoid re-initialization.
 */
import { OpenRouterProvider } from './openrouter'
import { ReplicateProvider } from './replicate'
import { FallbackLLMAdapter } from './fallback-adapter'
import type { LLMAdapter, LLMConfig, AgentModelConfig, ModelMode } from './types'
import { DEFAULT_AGENT_MODELS, MODEL_MODE_PRESETS } from './types'

export class LLMFactory {
  private static providers = new Map<string, LLMAdapter>()
  private static configs: Record<string, LLMConfig> = {}
  private static agentModels: Record<string, AgentModelConfig> = { ...DEFAULT_AGENT_MODELS }
  private static currentMode: ModelMode = 'normal'

  /** Register API keys for providers */
  static configure(provider: 'openrouter' | 'replicate', config: LLMConfig): void {
    this.configs[provider] = config
    // Invalidate cached provider so next call creates fresh instance
    this.providers.delete(provider)
  }

  /** Check if a provider is configured (has API key) */
  static isConfigured(provider: 'openrouter' | 'replicate'): boolean {
    return !!this.configs[provider]?.apiKey
  }

  /** Get or create a provider instance */
  static getProvider(provider: 'openrouter' | 'replicate'): LLMAdapter {
    const cached = this.providers.get(provider)
    if (cached) return cached

    const config = this.configs[provider]
    if (!config?.apiKey) {
      throw new Error(
        `No API key configured for ${provider}. Call LLMFactory.configure() first.`
      )
    }

    let instance: LLMAdapter
    switch (provider) {
      case 'openrouter':
        instance = new OpenRouterProvider(config)
        break
      case 'replicate':
        instance = new ReplicateProvider(config)
        break
    }

    this.providers.set(provider, instance)
    return instance
  }

  /**
   * Get the LLM adapter for a specific agent type.
   * Returns a FallbackLLMAdapter that tries the primary provider first,
   * then falls back to the alternate provider if both are configured.
   */
  static getForAgent(agentType: string): LLMAdapter {
    const agentConfig = this.agentModels[agentType]
    if (!agentConfig) {
      console.warn(`[LLM] No model config for agent "${agentType}", using orchestrator defaults`)
      return this.getProvider('openrouter')
    }

    const primary = this.getProvider(agentConfig.provider)

    // Determine fallback provider (the other one)
    const fallbackProviderName: 'openrouter' | 'replicate' =
      agentConfig.provider === 'openrouter' ? 'replicate' : 'openrouter'

    let fallback: LLMAdapter | null = null
    if (this.isConfigured(fallbackProviderName)) {
      try {
        fallback = this.getProvider(fallbackProviderName)
      } catch {
        // Fallback provider not available, proceed without it
      }
    }

    return new FallbackLLMAdapter(primary, fallback, agentConfig.model)
  }

  /** Get the model config for a specific agent */
  static getAgentConfig(agentType: string): AgentModelConfig | undefined {
    return this.agentModels[agentType]
  }

  /** Override model config for a specific agent */
  static setAgentModel(agentType: string, config: AgentModelConfig): void {
    this.agentModels[agentType] = config
  }

  /** Get all agent model configurations */
  static getAllAgentConfigs(): Record<string, AgentModelConfig> {
    return { ...this.agentModels }
  }

  /** Switch all agents to a preset mode (beast / normal / economy) */
  static setMode(mode: ModelMode): void {
    const preset = MODEL_MODE_PRESETS[mode]
    if (!preset) {
      console.warn(`[LLM] Unknown mode "${mode}", keeping current config`)
      return
    }
    this.currentMode = mode
    this.agentModels = { ...preset }
    console.log(`[LLM] Switched to ${mode} mode — ${Object.keys(preset).length} agents reconfigured`)
  }

  /** Get the current model mode */
  static getMode(): ModelMode {
    return this.currentMode
  }

  /** Reset all configurations (useful for testing) */
  static reset(): void {
    this.providers.clear()
    this.configs = {}
    this.agentModels = { ...DEFAULT_AGENT_MODELS }
    this.currentMode = 'normal'
  }
}
