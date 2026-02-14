/**
 * Tools barrel — re-exports the local tool provider and permission system
 */
export { getLocalToolProvider } from './local-tools'
export {
  getAgentPermissions,
  canAgentCallTool,
  filterToolsForAgent,
  hasToolAccess,
  type ToolPermissionTier,
  type ToolPermissionConfig,
} from './permissions'
