// GitHub REST v3 API under /api/v3: repos, branches, commits, contents, labels,
// issues, comments, pull requests. All state lives in the Forge store.

import type { ServerResponse } from 'node:http';
import {
  Forge, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, FIXED_ISO,
  commitFiles, commitsFrom, diffTrees, fileAt, flattenTree, squashMerge,
} from './store.ts';
import type { Issue, Label, Pull, Repo } from './store.ts';
import { ObjectStore, parseCommitTree, parseTree } from './git.ts';

export interface RestCtx {
  method: string;
  segments: string[]; // path segments after /api/v3, URI-decoded
  query: URLSearchParams;
  body: unknown;
  host: string;
  authed: boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

function err(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function commitMessageOf(store: ObjectStore, oid: string): string {
  const obj = store.get(oid);
  if (!obj || obj.type !== 'commit') return '';
  const text = obj.payload.toString('utf8');
  const idx = text.indexOf('\n\n');
  return idx >= 0 ? text.slice(idx + 2).replace(/\n+$/, '') : '';
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: `U_${VIEWER_ID}`, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: `U_${VIEWER_ID}`, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    size: 0,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    fork: false,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    stargazers_count: 0,
    forks_count: 0,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `L_${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l ? labelJson(l) : { id: 0, name, color: 'ededed', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: true,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function paginate<T>(items: T[], ctx: RestCtx, path: string): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (totalPages > 1) {
    const base = `http://${ctx.host}${path}`;
    const parts: string[] = [];
    if (pageNum < totalPages) parts.push(`<${base}?per_page=${perPage}&page=${pageNum + 1}>; rel="next"`);
    if (pageNum > 1) parts.push(`<${base}?per_page=${perPage}&page=${pageNum - 1}>; rel="prev"`);
    parts.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
    parts.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
    link = parts.join(', ');
  }
  return { page, link };
}

function bodyObj(ctx: RestCtx): Record<string, unknown> {
  if (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)) return ctx.body as Record<string, unknown>;
  return {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Resolve a repo from /repos/{owner}/{name}/... segments; answers 401/404 itself. */
function resolveRepo(forge: Forge, ctx: RestCtx, res: ServerResponse): Repo | null {
  if (!ctx.authed) {
    err(res, 401, 'Requires authentication');
    return null;
  }
  const owner = ctx.segments[1];
  const name = ctx.segments[2];
  const repo = forge.getRepo(owner, name);
  if (!repo) {
    err(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** The tip commit oid of a branch (name or full ref), or null. */
function branchTip(repo: Repo, branch: string): string | null {
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  return repo.refs.get(ref) ?? null;
}

export function handleRest(forge: Forge, ctx: RestCtx, res: ServerResponse): boolean {
  const seg = ctx.segments;
  const method = ctx.method;

  // API root and meta need no auth (matches the starter's behaviour).
  if (seg.length === 0 && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (!ctx.authed) {
    err(res, 401, 'Requires authentication');
    return true;
  }

  // GET /user
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson());
    return true;
  }

  // /user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = forge.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(repos, ctx, '/api/v3/user/repos');
      sendJson(res, 200, page.map(repoJson), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const name = str(b.name);
      if (!name) {
        err(res, 422, 'name is required');
        return true;
      }
      if (forge.getRepo(VIEWER_LOGIN, name)) {
        err(res, 422, 'Repository already exists');
        return true;
      }
      const repo = forge.createRepo(VIEWER_LOGIN, name, str(b.description), b.private !== false);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    return false;
  }

  // /repos/{owner}/{name}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const repo = resolveRepo(forge, ctx, res);
    if (!repo) return true;
    const rest = seg.slice(3);

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const b = bodyObj(ctx);
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        sendEmpty(res, 204);
        return true;
      }
      return false;
    }

    // /branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) as string, url: '' }, protected: false }));
      sendJson(res, 200, branches);
      return true;
    }

    // /commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = ctx.query.get('sha');
      let tip: string | null = null;
      if (shaParam) {
        tip = branchTip(repo, shaParam) ?? (/^[0-9a-f]{40}$/.test(shaParam) ? shaParam : null);
      } else {
        tip = branchTip(repo, repo.defaultBranch);
      }
      const list = tip ? commitsFrom(repo.store, tip) : [];
      sendJson(res, 200, list.map((oid) => ({
        sha: oid,
        commit: {
          message: commitMessageOf(repo.store, oid),
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID },
      })));
      return true;
    }

    // /git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const b = bodyObj(ctx);
      const ref = str(b.ref);
      const sha = str(b.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.store.has(sha)) {
        err(res, 422, 'Invalid ref or sha');
        return true;
      }
      repo.refs.set(ref, sha);
      repo.gen += 1;
      sendJson(res, 201, { ref, object: { sha }, url: '' });
      return true;
    }
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') {
      const branch = rest[3];
      const tip = branchTip(repo, branch);
      if (!tip) {
        err(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip }, url: '' });
      return true;
    }

    // /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        const b = bodyObj(ctx);
        const name = str(b.name);
        if (!name) {
          err(res, 422, 'name is required');
          return true;
        }
        let label = repo.labels.get(name);
        if (!label) {
          label = { id: repo.nextLabelId, name, color: str(b.color) || 'ededed', description: str(b.description) };
          repo.nextLabelId += 1;
          repo.labels.set(name, label);
        }
        sendJson(res, 201, labelJson(label));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return true;
      }
      return false;
    }

    // /contents/{path...}
    if (rest.length >= 2 && rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      return handleContents(repo, ctx, res, path);
    }

    // /issues...
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(forge, repo, ctx, res);
    }

    // /pulls...
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(forge, repo, ctx, res);
    }

    return false;
  }

  return false;
}

// ---- contents ----

function treeOidAtPath(store: ObjectStore, rootTreeOid: string, dirPath: string): string | null {
  if (dirPath === '' || dirPath === '/') return rootTreeOid;
  const parts = dirPath.split('/').filter(Boolean);
  let current = rootTreeOid;
  for (const part of parts) {
    const obj = store.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.payload).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function handleContents(repo: Repo, ctx: RestCtx, res: ServerResponse, path: string): boolean {
  const method = ctx.method;
  const refParam = ctx.query.get('ref');
  // GET reads ?ref=<branch>; PUT/DELETE carry the branch in the JSON body.
  const bodyBranch = (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) && typeof (ctx.body as Record<string, unknown>).branch === 'string')
    ? (ctx.body as Record<string, unknown>).branch as string
    : undefined;
  const branch = method === 'GET' ? (refParam ?? repo.defaultBranch) : (bodyBranch ?? refParam ?? repo.defaultBranch);
  const tip = branchTip(repo, branch);

  if (method === 'GET') {
    if (!tip) {
      err(res, 404, 'Not Found');
      return true;
    }
    const commit = repo.store.get(tip);
    const treeOid = commit ? parseCommitTree(commit.payload) : null;
    if (!treeOid) {
      err(res, 404, 'Not Found');
      return true;
    }
    const file = fileAt(repo.store, tip, path);
    if (file) {
      const parts = path.split('/');
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: file.bytes.length,
        name: parts[parts.length - 1],
        path,
        content: file.bytes.toString('base64'),
        sha: file.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: '',
        git_url: '',
        download_url: '',
        _links: {},
      });
      return true;
    }
    const dirTree = treeOidAtPath(repo.store, treeOid, path);
    if (dirTree) {
      const obj = repo.store.get(dirTree);
      const entries = obj && obj.type === 'tree' ? parseTree(obj.payload) : [];
      const flat = flattenTree(repo.store, treeOid);
      sendJson(res, 200, entries.map((e) => {
        const childPath = `${path}/${e.name}`;
        const isDir = e.mode === '40000';
        let size = 0;
        if (!isDir) {
          const f = flat.get(childPath);
          const blob = f ? repo.store.get(f.oid) : undefined;
          size = blob ? blob.payload.length : 0;
        }
        return { type: isDir ? 'dir' : 'file', name: e.name, path: childPath, sha: e.oid, size, url: '' };
      }));
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const b = bodyObj(ctx);
    const contentB64 = str(b.content);
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      err(res, 400, 'content is not valid base64');
      return true;
    }
    const branchRef = `refs/heads/${branch}`;
    const existing = tip ? fileAt(repo.store, tip, path) : null;
    const sha = str(b.sha);
    if (sha) {
      if (!existing || existing.oid.toLowerCase() !== sha.toLowerCase()) {
        err(res, 409, 'sha does not match the current blob');
        return true;
      }
    }
    const isCreate = !existing;
    const message = str(b.message) || (isCreate ? `Create ${path}` : `Update ${path}`);
    const changes = new Map<string, Buffer | null>([[path, content]]);
    const commitOid = commitFiles(repo, branchRef, message, changes);
    const blob = fileAt(repo.store, commitOid, path);
    sendJson(res, isCreate ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blob?.oid ?? '', size: content.length, encoding: 'base64' },
      commit: { sha: commitOid },
    });
    return true;
  }

  if (method === 'DELETE') {
    const b = bodyObj(ctx);
    const existing = tip ? fileAt(repo.store, tip, path) : null;
    if (!existing) {
      err(res, 404, 'Not Found');
      return true;
    }
    const message = str(b.message) || `Delete ${path}`;
    const branchRef = `refs/heads/${branch}`;
    const changes = new Map<string, Buffer | null>([[path, null]]);
    const commitOid = commitFiles(repo, branchRef, message, changes);
    sendJson(res, 200, { commit: { sha: commitOid } });
    return true;
  }

  return false;
}

// ---- issues ----

function handleIssues(forge: Forge, repo: Repo, ctx: RestCtx, res: ServerResponse): boolean {
  const method = ctx.method;
  const rest = ctx.segments.slice(4); // after /repos/{o}/{r}/issues

  if (rest.length === 0) {
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const labels: string[] = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          err(res, 422, `label ${JSON.stringify(name)} does not exist`);
          return true;
        }
      }
      const issue = forge.createIssue(repo, str(b.title), str(b.body), labels);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, link } = paginate(list, ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      sendJson(res, 200, page.map((i) => issueJson(repo, i)), link ? { link } : {});
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return false;
  const issue = repo.issues.find((i) => i.number === number);

  if (rest.length === 1) {
    if (!issue) {
      err(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const b = bodyObj(ctx);
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
      if (Array.isArray(b.labels)) {
        const labels = b.labels.filter((l): l is string => typeof l === 'string');
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            err(res, 422, `label ${JSON.stringify(name)} does not exist`);
            return true;
          }
        }
        issue.labels = labels;
      }
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) {
      err(res, 404, 'Not Found');
      return true;
    }
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const comment = forge.addComment(repo, issue, str(b.body));
      sendJson(res, 201, {
        id: comment.id,
        node_id: comment.globalId,
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        created_at: FIXED_ISO,
        updated_at: FIXED_ISO,
      });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({
        id: c.id,
        node_id: c.globalId,
        body: c.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        created_at: FIXED_ISO,
        updated_at: FIXED_ISO,
      })));
      return true;
    }
    return false;
  }

  return false;
}

// ---- pulls ----

function handlePulls(forge: Forge, repo: Repo, ctx: RestCtx, res: ServerResponse): boolean {
  const method = ctx.method;
  const rest = ctx.segments.slice(4); // after /repos/{o}/{r}/pulls

  if (rest.length === 0) {
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const headRef = str(b.head);
      const baseRef = str(b.base) || repo.defaultBranch;
      const headTip = branchTip(repo, headRef);
      const baseTip = branchTip(repo, baseRef);
      if (!headTip || !baseTip) {
        err(res, 422, 'head or base branch does not exist');
        return true;
      }
      const headCommit = repo.store.get(headTip);
      const baseCommit = repo.store.get(baseTip);
      const headTree = headCommit ? parseCommitTree(headCommit.payload) : null;
      const baseTree = baseCommit ? parseCommitTree(baseCommit.payload) : null;
      const files = diffTrees(repo.store, baseTree, headTree);
      const pull = forge.createPull(repo, str(b.title), str(b.body), headRef, baseRef, baseTip, files);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      const { page, link } = paginate(list, ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      sendJson(res, 200, page.map((p) => pullJson(repo, p)), link ? { link } : {});
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return false;
  const pull = repo.pulls.find((p) => p.number === number);

  if (rest.length === 1) {
    if (!pull) {
      err(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) {
      err(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, pull.files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    })));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) {
      err(res, 404, 'Not Found');
      return true;
    }
    if (pull.state === 'closed') {
      err(res, 405, 'Pull request is already closed');
      return true;
    }
    const result = squashMerge(repo, pull);
    if (!result.merged) {
      if (result.conflict) err(res, 405, 'Merge conflict');
      else err(res, 405, 'Head or base branch is missing');
      return true;
    }
    sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
    return true;
  }

  return false;
}
