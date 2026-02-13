/**
 * Local Tool Types — Shared types for the built-in tool provider
 *
 * Local tools use the same McpTool / McpToolCallResult shapes so they're
 * seamlessly interchangeable with MCP tools from the executor's perspective.
 */
export { type McpTool as LocalTool, type McpToolCallResult as LocalToolResult } from '../mcp/types'
