/**
 * Plugin Agent — A manifest-driven agent created by the plugin system
 *
 * Extends BaseAgent with configuration from a PluginManifest.
 * The system prompt, capabilities, and description come from
 * the manifest rather than being hard-coded in a class.
 */
import { BaseAgent, type AgentContext, type AgentResult, type SubTask } from '../agents/base-agent'
import type { AgentType } from '../agents/event-bus'
import type { PluginManifest } from './types'

export class PluginAgent extends BaseAgent {
  readonly type: AgentType
  readonly capabilities: string[]
  readonly description: string
  private readonly manifest: PluginManifest

  constructor(manifest: PluginManifest) {
    super()
    // Cast to AgentType — the type system is widened to string at runtime
    this.type = manifest.agentType as AgentType
    this.capabilities = [...manifest.capabilities]
    this.description = manifest.description
    this.manifest = manifest
  }

  protected getSystemPrompt(_context: AgentContext): string {
    // Inject standard Brainwave framing around the plugin's custom prompt
    return `You are a custom plugin agent in the Brainwave system.

Plugin: ${this.manifest.name} v${this.manifest.version}
${this.manifest.author ? `Author: ${this.manifest.author}` : ''}
Type: ${this.manifest.agentType}
Capabilities: ${this.capabilities.join(', ')}

--- Plugin Instructions ---

${this.manifest.systemPrompt}

--- End Plugin Instructions ---

Guidelines:
- Follow the plugin instructions above precisely
- Be thorough, accurate, and clear in your output
- If you cannot complete the task, explain why and suggest alternatives
- Always report your confidence level (0-1) and reasoning`
  }

  /** Override execute to optionally use plugin's preferred model */
  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    // The base class execute() calls this.think() which uses LLMFactory.getForAgent(this.type)
    // Model preference is handled at the registry level by configuring the LLM factory
    return super.execute(task, context)
  }

  /** Get the source manifest */
  getManifest(): PluginManifest {
    return { ...this.manifest }
  }
}
