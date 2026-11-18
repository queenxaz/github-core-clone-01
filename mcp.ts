// MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP (plain JSON answers).
// Speaks the modern era (server/discover, 2026-07-28) with the legacy initialize
// handshake as a fallback. Tools act on the same Forge store as REST.

import type { ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN, diffTrees, squashMerge } from './store.ts';
import type { Repo } from './store.ts';
import { parseCommitTree } from './git.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResult(obj: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve owner/repo from tool arguments (owner+repo, or full_name "owner/repo"). */
function resolveRepoArgs(forge: Forge, args: Record<string, unknown>): { repo: Repo | null; owner: string; name: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !name) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner || parts[0];
      name = name || parts[1];
    }
  }
  if (!owner) owner = VIEWER_LOGIN;
  const repo = name ? forge.getRepo(owner, name) ?? null : null;
  return { repo, owner, name };
}

function dispatchTool(forge: Forge, name: string, args: Record<string, unknown>): { ok: boolean; result?: Record<string, unknown>; error?: string; code?: number } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, code: -32601, error: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    const v = args[required];
    if (v === undefined || v === null || v === '') {
      return { ok: false, code: -32602, error: `Missing required argument: ${required}` };
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        const owner = typeof args.owner === 'string' && args.owner ? args.owner : VIEWER_LOGIN;
        let repo = forge.getRepo(owner, repoName);
        if (!repo) {
          repo = forge.createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
        }
        return {
          ok: true,
          result: toolResult({
            id: repo.id,
            name: repo.name,
            full_name: `${repo.owner}/${repo.name}`,
            owner: repo.owner,
            private: repo.private,
            description: repo.description,
            default_branch: repo.defaultBranch,
          }),
        };
      }
      case 'get_repo': {
        const { repo, owner, name: repoName } = resolveRepoArgs(forge, args);
        if (!repo) return { ok: true, result: toolError(`Repository not found: ${owner}/${repoName}`) };
        return {
          ok: true,
          result: toolResult({
            id: repo.id,
            name: repo.name,
            full_name: `${repo.owner}/${repo.name}`,
            owner: repo.owner,
            private: repo.private,
            description: repo.description,
            default_branch: repo.defaultBranch,
          }),
        };
      }
      case 'create_issue': {
        const { repo, owner, name: repoName } = resolveRepoArgs(forge, args);
        if (!repo) return { ok: true, result: toolError(`Repository not found: ${owner}/${repoName}`) };
        const issue = forge.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
        return {
          ok: true,
          result: toolResult({
            id: repo.id * 1_000_000 + issue.number,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            full_name: `${repo.owner}/${repo.name}`,
          }),
        };
      }
      case 'list_issues': {
        const { repo, owner, name: repoName } = resolveRepoArgs(forge, args);
        if (!repo) return { ok: true, result: toolError(`Repository not found: ${owner}/${repoName}`) };
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.issues.filter((i) => state === 'all' || i.state === state);
        return {
          ok: true,
          result: toolResult({
            issues: list.map((i) => ({
              id: repo.id * 1_000_000 + i.number,
              number: i.number,
              title: i.title,
              body: i.body,
              state: i.state,
            })),
          }),
        };
      }
      case 'create_pull_request': {
        const { repo, owner, name: repoName } = resolveRepoArgs(forge, args);
        if (!repo) return { ok: true, result: toolError(`Repository not found: ${owner}/${repoName}`) };
        const headRef = String(args.head);
        const baseRef = String(args.base);
        const headTip = repo.refs.get(`refs/heads/${headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
        if (!headTip || !baseTip) return { ok: true, result: toolError('Head or base branch does not exist.') };
        const headCommit = repo.store.get(headTip);
        const baseCommit = repo.store.get(baseTip);
        const headTree = headCommit ? parseCommitTree(headCommit.payload) : null;
        const baseTree = baseCommit ? parseCommitTree(baseCommit.payload) : null;
        const files = diffTrees(repo.store, baseTree, headTree);
        const pull = forge.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', headRef, baseRef, baseTip, files);
        return {
          ok: true,
          result: toolResult({
            id: repo.id * 1_000_000 + pull.number,
            number: pull.number,
            pull_number: pull.number,
            title: pull.title,
            body: pull.body,
            state: pull.state,
            head: headRef,
            base: baseRef,
            full_name: `${repo.owner}/${repo.name}`,
          }),
        };
      }
      case 'merge_pull_request': {
        const { repo, owner, name: repoName } = resolveRepoArgs(forge, args);
        if (!repo) return { ok: true, result: toolError(`Repository not found: ${owner}/${repoName}`) };
        const number = Number(args.pull_number);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return { ok: true, result: toolError(`Pull request not found: ${number}`) };
        const result = squashMerge(repo, pull);
        if (!result.merged) return { ok: true, result: toolError('Pull request cannot be merged.') };
        return {
          ok: true,
          result: toolResult({
            number: pull.number,
            pull_number: pull.number,
            merged: true,
            sha: result.sha,
            state: pull.state,
          }),
        };
      }
      default:
        return { ok: false, code: -32601, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: true, result: toolError(err instanceof Error ? err.message : 'Tool failed.') };
  }
}

export function handleMcp(forge: Forge, bodyRaw: Buffer, authed: boolean, res: ServerResponse): void {
  if (!authed) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRaw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const req = parsed as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {}) as Record<string, unknown>;

  // Notifications carry no id and get no reply.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    }));
    return;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
    const out = dispatchTool(forge, toolName, args);
    if (!out.ok) {
      sendJson(res, 200, rpcError(id, out.code ?? -32602, out.error ?? 'Tool call failed.'));
      return;
    }
    sendJson(res, 200, rpcResult(id, out.result));
    return;
  }

  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}
