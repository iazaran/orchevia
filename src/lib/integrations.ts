/**
 * Integration types (TypeScript mirror of `orchevia-core` git/github/mcp).
 */

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface GitHubState {
  installed: boolean;
  authenticated: boolean;
  user?: string;
  version?: string;
}

export function newMcpId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `mcp-${Date.now().toString(36)}${rand}`;
}

export function validateMcpServer(server: McpServerConfig): string[] {
  const errors: string[] = [];
  if (server.id.trim() === '') errors.push('Server id must not be empty.');
  if (server.name.trim() === '') errors.push('Server name must not be empty.');
  if (server.command.trim() === '') errors.push('Server command must not be empty.');
  for (const arg of server.args) {
    if (arg.includes('\0') || arg.includes('\n')) {
      errors.push(`Argument '${arg}' contains invalid characters.`);
    }
  }
  return errors;
}
