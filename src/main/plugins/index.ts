/**
 * Plugins barrel — re-exports all plugin system modules
 */
export { getPluginRegistry } from './registry'
export { PluginAgent } from './plugin-agent'
export { isBuiltInAgentType, BUILT_IN_AGENT_TYPES } from './types'
export type { PluginManifest, PluginInfo } from './types'
