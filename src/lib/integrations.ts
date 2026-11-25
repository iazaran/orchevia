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

export const MCP_SETUP_GUIDE =
  'https://github.com/iazaran/orchevia/blob/main/docs/integrations.md#connection-recipes';

export type McpCategory =
  'Work & docs' | 'Code & tickets' | 'Web & research' | 'Data & cloud' | 'Local';

export const MCP_CATEGORIES: McpCategory[] = [
  'Work & docs',
  'Code & tickets',
  'Web & research',
  'Data & cloud',
  'Local',
];

/**
 * A ready-made local (stdio) MCP server. Commands, flags, variables and tool
 * names were checked against each project's README or registry entry in
 * November 2026. Remote-only services run through `mcp-remote`, which keeps
 * OAuth in the browser and expands `${VAR}` header values itself, so no
 * secret is ever stored in Orchevia.
 */
export interface McpPreset {
  id: string;
  name: string;
  category: McpCategory;
  /** What the server gives a workflow, in one line. */
  summary: string;
  command: string;
  args: string[];
  /** Environment variables the server reads; values stay in your shell. */
  env: string[];
  /** Set when any one of `env` is enough (alternative tokens). */
  envAnyOf?: boolean;
  /** Variables that unlock more but are not needed. */
  envOptional?: string[];
  /** How you sign in. */
  auth: 'none' | 'env' | 'oauth' | 'login';
  /** The preset only exposes tools that read. */
  readOnly: boolean;
  /** What must be installed first. */
  needs: string;
  steps: string[];
  /** Example tools for MCP Tool steps, with their main arguments. */
  tools: { name: string; args: string }[];
  /** An argument you must replace before saving. */
  placeholder?: string;
  /** Works with Ticket steps (`jira_get_issue`). */
  ticket?: boolean;
  source: string;
  /**
   * How earlier Orchevia versions saved this server (name, command and
   * arguments), so servers made from an older setup are still recognized
   * and can be updated to the current one.
   */
  legacy?: LegacyMcpSetup[];
}

/** A setup as an earlier Orchevia version saved it. */
export interface LegacyMcpSetup {
  name: string;
  command: string;
  args: string[];
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    category: 'Work & docs',
    summary: 'Gmail, Drive, Docs, Calendar and Sheets in one read-only server.',
    command: 'uvx',
    args: [
      'workspace-mcp',
      '--tools',
      'gmail',
      'drive',
      'calendar',
      'docs',
      'sheets',
      '--read-only',
    ],
    env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'USER_GOOGLE_EMAIL'],
    auth: 'oauth',
    readOnly: true,
    needs: 'uv, and a Google Cloud OAuth client (Desktop app)',
    steps: [
      'In Google Cloud, create an OAuth client of type Desktop app and enable the Gmail, Drive, Docs, Calendar and Sheets APIs.',
      'Export the client ID, client secret and your Google address in your shell profile, then restart Orchevia.',
      'The first tool call opens Google sign-in in your browser. --read-only asks only for read scopes.',
      'Remove services from --tools to share less. Using the gws CLI instead? Use npx -y gws-mcp-server --read-only --services docs,drive,gmail.',
    ],
    tools: [
      { name: 'search_gmail_messages', args: 'query, user_google_email' },
      { name: 'get_doc_content', args: 'document_id, user_google_email' },
      { name: 'search_drive_files', args: 'query, user_google_email' },
      { name: 'get_events', args: 'user_google_email' },
    ],
    source: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    legacy: [
      {
        name: 'Google Docs',
        command: 'gws-mcp-server',
        args: ['--read-only', '--services', 'docs,drive'],
      },
      {
        name: 'Gmail',
        command: 'gws-mcp-server',
        args: ['--read-only', '--services', 'gmail'],
      },
    ],
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    category: 'Work & docs',
    summary: 'Outlook mail, Calendar, OneDrive and Teams, read-only.',
    command: 'npx',
    args: ['-y', '@softeria/ms-365-mcp-server', '--read-only'],
    env: [],
    auth: 'login',
    readOnly: true,
    needs: 'Node.js 20+',
    steps: [
      'Sign in once in a terminal: npx -y @softeria/ms-365-mcp-server --login (device code).',
      'Add --org-mode for Teams and SharePoint in a work or school account.',
      'This is a community server. Microsoft’s own Work IQ server needs a Microsoft 365 Copilot license.',
    ],
    tools: [
      { name: 'list-mail-messages', args: 'none' },
      { name: 'get-mail-message', args: 'messageId' },
      { name: 'list-calendar-events', args: 'none' },
    ],
    source: 'https://github.com/Softeria/ms-365-mcp-server',
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'Work & docs',
    summary: 'Read channel history, threads and the channel list.',
    command: 'npx',
    args: [
      '-y',
      'slack-mcp-server@latest',
      '--transport',
      'stdio',
      '--enabled-tools',
      'conversations_history,conversations_replies,channels_list',
    ],
    env: ['SLACK_MCP_XOXP_TOKEN', 'SLACK_MCP_XOXB_TOKEN'],
    envAnyOf: true,
    auth: 'env',
    readOnly: true,
    needs: 'Node.js',
    steps: [
      'Create a Slack app approved for your workspace and copy a user token (xoxp) or bot token (xoxb). A bot only sees channels it was invited to.',
      'Export one token in your shell profile and restart Orchevia.',
      '--enabled-tools keeps the server read-only.',
    ],
    tools: [
      { name: 'conversations_history', args: 'channel_id, limit (e.g. "1d")' },
      { name: 'conversations_replies', args: 'channel_id, thread_ts' },
      { name: 'channels_list', args: 'channel_types' },
    ],
    source: 'https://github.com/korotovsky/slack-mcp-server',
    legacy: [
      {
        name: 'Slack',
        command: 'slack-mcp-server',
        args: [
          '--transport',
          'stdio',
          '--enabled-tools',
          'channels_list,conversations_history,conversations_replies',
        ],
      },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Work & docs',
    summary: 'Search pages and read them as Markdown.',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: ['NOTION_TOKEN'],
    auth: 'env',
    readOnly: false,
    needs: 'Node.js',
    steps: [
      'Create an internal integration in Notion, copy its secret and share the pages it may read with it.',
      'Export NOTION_TOKEN in your shell profile and restart Orchevia.',
      'Prefer OAuth? Use npx -y mcp-remote https://mcp.notion.com/mcp instead.',
    ],
    tools: [
      { name: 'API-post-search', args: 'query' },
      { name: 'API-retrieve-page-markdown', args: 'page_id' },
    ],
    source: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id: 'jira',
    name: 'Jira & Confluence',
    category: 'Code & tickets',
    summary: 'Load tickets for Ticket steps, search issues and Confluence pages.',
    command: 'uvx',
    args: ['mcp-atlassian', '--read-only'],
    env: ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN'],
    envOptional: [
      'JIRA_PERSONAL_TOKEN',
      'CONFLUENCE_URL',
      'CONFLUENCE_USERNAME',
      'CONFLUENCE_API_TOKEN',
    ],
    auth: 'env',
    readOnly: true,
    needs: 'uv',
    steps: [
      'Jira Cloud: export JIRA_URL, JIRA_USERNAME and JIRA_API_TOKEN. Server or Data Center: JIRA_URL and JIRA_PERSONAL_TOKEN instead of the username and token.',
      'Add the CONFLUENCE_ variables to search Confluence too.',
      'Ticket steps call jira_get_issue on this server.',
    ],
    tools: [
      { name: 'jira_get_issue', args: 'issue_key' },
      { name: 'jira_search', args: 'jql' },
      { name: 'confluence_search', args: 'query' },
    ],
    ticket: true,
    source: 'https://github.com/sooperset/mcp-atlassian',
    // Up to v0.3.0 this setup was called "Jira" and had no --read-only.
    legacy: [{ name: 'Jira', command: 'uvx', args: ['mcp-atlassian'] }],
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Code & tickets',
    summary: 'Read repositories, issues and pull requests through GitHub’s server.',
    command: 'docker',
    args: [
      'run',
      '-i',
      '--rm',
      '-e',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'ghcr.io/github/github-mcp-server',
      'stdio',
      '--read-only',
      '--toolsets',
      'repos,issues,pull_requests',
    ],
    env: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    auth: 'env',
    readOnly: true,
    needs: 'Docker (or the github-mcp-server binary)',
    steps: [
      'Create a fine-grained personal access token with read access to the repositories you need.',
      'Export GITHUB_PERSONAL_ACCESS_TOKEN and restart Orchevia. Docker passes the variable through by name only.',
      'Without Docker, download github-mcp-server from its releases and use: github-mcp-server stdio --read-only --toolsets repos,issues,pull_requests.',
    ],
    tools: [
      { name: 'issue_read', args: 'method, owner, repo, issue_number' },
      { name: 'pull_request_read', args: 'method, owner, repo, pullNumber' },
      { name: 'get_file_contents', args: 'owner, repo, path' },
      { name: 'search_code', args: 'query' },
    ],
    source: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    category: 'Code & tickets',
    summary: 'Merge requests, pipelines and files from GitLab’s own server.',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://gitlab.com/api/v4/mcp'],
    env: [],
    auth: 'oauth',
    readOnly: false,
    needs: 'Node.js 20+',
    steps: [
      'The first connection opens GitLab sign-in in your browser; mcp-remote keeps the token in ~/.mcp-auth.',
      'Self-managed GitLab: replace gitlab.com with your instance.',
    ],
    tools: [
      { name: 'get_merge_request', args: 'url' },
      { name: 'get_pipeline', args: 'id, pipeline_id' },
      { name: 'get_repository_file', args: 'url' },
    ],
    source: 'https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/',
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'Code & tickets',
    summary: 'Read issues, projects and teams.',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp/readonly'],
    env: [],
    auth: 'oauth',
    readOnly: true,
    needs: 'Node.js',
    steps: [
      'The first connection opens Linear sign-in in your browser.',
      'Use https://mcp.linear.app/mcp instead of /readonly to allow changes.',
    ],
    tools: [
      { name: 'get_issue', args: 'id' },
      { name: 'list_issues', args: 'filters' },
    ],
    source: 'https://linear.app/docs/mcp',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Code & tickets',
    summary: 'Search errors and read issue details for bug-fix workflows.',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server@latest', '--skills=inspect'],
    env: ['SENTRY_AUTH_TOKEN'],
    envOptional: ['SENTRY_HOST'],
    auth: 'env',
    readOnly: true,
    needs: 'Node.js 22.15+',
    steps: [
      'Create a Sentry user auth token with read scopes and export SENTRY_AUTH_TOKEN.',
      'Self-hosted Sentry: also export SENTRY_HOST.',
      '--skills=inspect keeps it to reading issues and events.',
    ],
    tools: [
      { name: 'search_issues', args: 'organizationSlug, query' },
      { name: 'get_issue_details', args: 'issueUrl' },
    ],
    source: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    id: 'fetch',
    name: 'Fetch web pages',
    category: 'Web & research',
    summary: 'Download a web page as Markdown. No account needed.',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: [],
    auth: 'none',
    readOnly: true,
    needs: 'uv',
    steps: [
      'Nothing to sign in to. Private and cloud metadata addresses are refused by default.',
    ],
    tools: [{ name: 'fetch', args: 'url (max_length optional)' }],
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'aws-knowledge',
    name: 'AWS Knowledge',
    category: 'Web & research',
    summary: 'Search and read current AWS documentation. No AWS account needed.',
    command: 'uvx',
    args: ['fastmcp', 'run', 'https://knowledge-mcp.global.api.aws'],
    env: [],
    auth: 'none',
    readOnly: true,
    needs: 'uv',
    steps: ['Nothing to sign in to: this is AWS’s public documentation server.'],
    tools: [
      { name: 'aws___search_documentation', args: 'search_phrase' },
      { name: 'aws___read_documentation', args: 'requests' },
      { name: 'aws___list_regions', args: 'none' },
    ],
    source: 'https://github.com/awslabs/mcp/tree/main/src/aws-knowledge-mcp-server',
  },
  {
    id: 'context7',
    name: 'Context7',
    category: 'Web & research',
    summary: 'Up-to-date library and framework documentation for coding steps.',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: [],
    envOptional: ['CONTEXT7_API_KEY'],
    auth: 'none',
    readOnly: true,
    needs: 'Node.js 20+',
    steps: ['Works without an account. Export CONTEXT7_API_KEY for higher rate limits.'],
    tools: [
      { name: 'resolve-library-id', args: 'query, libraryName' },
      { name: 'query-docs', args: 'libraryId, query' },
    ],
    source: 'https://github.com/upstash/context7',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    category: 'Web & research',
    summary: 'Web and news search results for research steps.',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    env: ['BRAVE_API_KEY'],
    auth: 'env',
    readOnly: true,
    needs: 'Node.js',
    steps: ['Get a Brave Search API key and export BRAVE_API_KEY.'],
    tools: [
      { name: 'brave_web_search', args: 'query' },
      { name: 'brave_llm_context', args: 'query' },
    ],
    source: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs',
    category: 'Web & research',
    summary: 'Search Cloudflare’s developer documentation. No account needed.',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://docs.mcp.cloudflare.com/mcp'],
    env: [],
    auth: 'none',
    readOnly: true,
    needs: 'Node.js',
    steps: ['Nothing to sign in to.'],
    tools: [{ name: 'search_cloudflare_documentation', args: 'query' }],
    source: 'https://github.com/cloudflare/mcp-server-cloudflare',
  },
  {
    id: 'playwright',
    name: 'Playwright browser',
    category: 'Web & research',
    summary: 'Open pages in a headless browser and read their content.',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
    env: [],
    auth: 'none',
    readOnly: false,
    needs: 'Node.js 20+',
    steps: [
      'The first run downloads a browser. --isolated keeps no cookies between runs.',
    ],
    tools: [
      { name: 'browser_navigate', args: 'url' },
      { name: 'browser_snapshot', args: 'none' },
    ],
    source: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Data & cloud',
    summary: 'List tables and run read-only SQL on one project.',
    command: 'npx',
    args: [
      '-y',
      '@supabase/mcp-server-supabase@latest',
      '--read-only',
      '--project-ref=YOUR_PROJECT_REF',
    ],
    env: ['SUPABASE_ACCESS_TOKEN'],
    auth: 'env',
    readOnly: true,
    needs: 'Node.js',
    placeholder: 'YOUR_PROJECT_REF',
    steps: [
      'Create a Supabase personal access token and export SUPABASE_ACCESS_TOKEN.',
      'Replace YOUR_PROJECT_REF with the project reference from its settings.',
    ],
    tools: [
      { name: 'list_tables', args: 'schemas (optional)' },
      { name: 'execute_sql', args: 'query' },
    ],
    source: 'https://github.com/supabase-community/supabase-mcp',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Data & cloud',
    summary: 'Inspect schemas and run restricted SQL on a database.',
    command: 'uvx',
    args: ['postgres-mcp', '--access-mode=restricted'],
    env: ['DATABASE_URI'],
    auth: 'env',
    readOnly: true,
    needs: 'uv (Python 3.12+)',
    steps: [
      'Export DATABASE_URI (postgresql://user@host/db) with a read-only database user.',
      '--access-mode=restricted allows reads only.',
    ],
    tools: [
      { name: 'list_schemas', args: 'none' },
      { name: 'execute_sql', args: 'sql' },
    ],
    source: 'https://github.com/crystaldba/postgres-mcp',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Data & cloud',
    summary: 'Read Stripe objects and docs through Stripe’s hosted server.',
    command: 'npx',
    args: [
      '-y',
      'mcp-remote',
      'https://mcp.stripe.com',
      '--header',
      'Authorization:Bearer ${STRIPE_AGENT_API_KEY}',
    ],
    env: ['STRIPE_AGENT_API_KEY'],
    auth: 'env',
    readOnly: false,
    needs: 'Node.js',
    steps: [
      'Create a Stripe agent API key with read permissions and export STRIPE_AGENT_API_KEY.',
      'The header holds only the variable name; mcp-remote reads the key from your environment.',
      'Or remove the two --header lines to sign in with OAuth in the browser.',
    ],
    tools: [
      { name: 'stripe_api_search', args: 'query' },
      { name: 'search_stripe_documentation', args: 'question' },
    ],
    source: 'https://docs.stripe.com/mcp',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    category: 'Local',
    summary: 'Read files in one folder you choose.',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '--read-only',
      '/path/to/folder',
    ],
    env: [],
    auth: 'none',
    readOnly: true,
    needs: 'Node.js 24+',
    placeholder: '/path/to/folder',
    steps: [
      'Replace /path/to/folder with the folder to share. Add more folders as extra arguments.',
    ],
    tools: [
      { name: 'read_text_file', args: 'path' },
      { name: 'list_directory', args: 'path' },
      { name: 'search_files', args: 'path, pattern' },
    ],
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'git',
    name: 'Git',
    category: 'Local',
    summary: 'Status, log, diffs and commits of one repository.',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '/path/to/repo'],
    env: [],
    auth: 'none',
    readOnly: false,
    needs: 'uv',
    placeholder: '/path/to/repo',
    steps: [
      'Replace /path/to/repo with the repository. Without --repository the server can reach any repository.',
    ],
    tools: [
      { name: 'git_log', args: 'repo_path, max_count' },
      { name: 'git_diff', args: 'repo_path, target' },
    ],
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    id: 'memory',
    name: 'Memory graph',
    category: 'Local',
    summary: 'A local knowledge graph steps can write to and search.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: [],
    envOptional: ['MEMORY_FILE_PATH'],
    auth: 'none',
    readOnly: false,
    needs: 'Node.js 24+',
    steps: ['Export MEMORY_FILE_PATH to keep the graph in a file you choose.'],
    tools: [
      { name: 'search_nodes', args: 'query' },
      { name: 'read_graph', args: 'none' },
    ],
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'Local',
    summary: 'Design context from the Figma desktop app for UI steps.',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'http://127.0.0.1:3845/mcp'],
    env: [],
    auth: 'none',
    readOnly: true,
    needs: 'Figma desktop app with Dev Mode (paid Dev or Full seat)',
    steps: [
      'In Figma desktop, open Dev Mode and turn on the desktop MCP server. It listens only on this computer.',
    ],
    tools: [
      { name: 'get_design_context', args: 'node id' },
      { name: 'get_screenshot', args: 'node id' },
    ],
    source: 'https://developers.figma.com/docs/figma-mcp-server/',
  },
];

/** `pkg@latest` → `pkg`, `@scope/pkg@1` → `@scope/pkg`. */
function withoutVersion(arg: string): string {
  return arg.replace(/(.)@[^/@]*$/, '$1');
}

/** The argument that identifies a preset's server: its package, image or URL. */
function presetSignature(preset: McpPreset): string | undefined {
  return preset.args.find(
    (arg) =>
      !arg.startsWith('-') &&
      !['run', 'mcp-remote', 'stdio', 'fastmcp'].includes(arg) &&
      !/^[A-Z][A-Z0-9_]*$/.test(arg),
  );
}

function sameArgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((arg, i) => arg.trim() === b[i]?.trim());
}

/** The older setup of `preset` this server still runs unchanged, if any. */
function legacySetup(
  preset: McpPreset,
  server: Pick<McpServerConfig, 'command' | 'args'>,
): LegacyMcpSetup | undefined {
  return preset.legacy?.find(
    (old) => old.command === server.command.trim() && sameArgs(old.args, server.args),
  );
}

/**
 * The preset a saved server came from: the same command and the same package,
 * image or URL, or exactly a setup an earlier Orchevia version saved.
 */
export function matchMcpPreset(
  server: Pick<McpServerConfig, 'command' | 'args'>,
): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => {
    const signature = presetSignature(preset);
    return (
      (preset.command === server.command.trim() &&
        signature !== undefined &&
        server.args.some((arg) => withoutVersion(arg) === withoutVersion(signature))) ||
      legacySetup(preset, server) !== undefined
    );
  });
}

/** Each preset already set up, with the names of the saved servers made from it. */
export function presetsInUse(servers: McpServerConfig[]): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const server of servers) {
    const preset = matchMcpPreset(server);
    if (preset === undefined) continue;
    used.set(preset.id, [...(used.get(preset.id) ?? []), server.name]);
  }
  return used;
}

/** One change an update makes: the name, or the command with its arguments. */
export interface McpSetupChange {
  what: 'name' | 'command';
  from: string;
  to: string;
}

/** What updating a server made from an older setup changes. */
export interface McpSetupUpdate {
  preset: McpPreset;
  /** The server with the current setup's name and arguments. */
  updated: McpServerConfig;
  changes: McpSetupChange[];
}

/**
 * The update for a server saved from an earlier version of a setup: the
 * current name when it still has the old one, and the current command and
 * arguments when it still runs the old ones unchanged. Servers the user
 * renamed or changed keep their own name and arguments. `null` when there is
 * nothing to update.
 */
export function mcpSetupUpdate(server: McpServerConfig): McpSetupUpdate | null {
  const preset = matchMcpPreset(server);
  if (preset === undefined) return null;
  const name = server.name.trim();
  const oldName =
    name !== preset.name && (preset.legacy ?? []).some((old) => old.name === name);
  const oldSetup = legacySetup(preset, server) !== undefined;
  const changes: McpSetupChange[] = [];
  if (oldName) changes.push({ what: 'name', from: name, to: preset.name });
  if (oldSetup) {
    const before = [server.command.trim(), ...server.args].join(' ');
    const after = [preset.command, ...preset.args].join(' ');
    if (before !== after) changes.push({ what: 'command', from: before, to: after });
  }
  if (changes.length === 0) return null;
  return {
    preset,
    updated: {
      ...server,
      name: oldName ? preset.name : server.name,
      command: oldSetup ? preset.command : server.command,
      args: oldSetup ? [...preset.args] : [...server.args],
    },
    changes,
  };
}

/** `export NAME="…"` lines for a preset's variables, for the user's shell profile. */
export function mcpEnvSnippet(preset: McpPreset): string {
  const names = [...preset.env, ...(preset.envOptional ?? [])];
  if (names.length === 0) return '';
  return [
    `# ${preset.name}: add to ~/.profile, ~/.zshenv or ~/.bashrc, then restart Orchevia.`,
    ...(preset.envAnyOf === true ? ['# Set one of these:'] : []),
    ...preset.env.map((name) => `export ${name}="…"`),
    ...(preset.envOptional ?? []).map((name) => `# export ${name}="…"  (optional)`),
  ].join('\n');
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** One line of an MCP server check. Mirrors `McpCheckItem`. */
export interface McpCheckItem {
  id: 'found' | 'started' | 'listed' | 'required';
  label: string;
  status: 'passed' | 'warning' | 'failed' | 'skipped';
  detail: string;
  hint?: string;
}

/**
 * A check of one MCP server, run only on request: found, started, tools
 * listed, and the tools saved workflows use. Never calls a tool.
 */
export interface McpCheckReport {
  serverId: string;
  serverName: string;
  status: McpCheckItem['status'];
  items: McpCheckItem[];
  tools: McpToolInfo[];
  durationMs: number;
}

export const MCP_CHECK_LABELS: Record<McpCheckItem['id'], string> = {
  found: 'Program found',
  started: 'Starts and completes the MCP handshake',
  listed: 'Lists its tools',
  required: 'Has the tools your workflows use',
};

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
