// In-memory data model for the forge: repos, refs, issues, PRs, labels, comments.
// Everything is deterministic: no wall-clock timestamps anywhere (fixed epoch),
// ordering by monotonic creation sequence numbers so live and replay runs agree.

import { ObjectStore, ZERO_OID, buildCommit, buildTree, parseCommitParents, parseCommitTree, parseTree } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FIXED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const IDENT = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  createdSeq: number;
}

export interface Issue {
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  baseSha: string; // base tip at creation
  files: PullFile[];
  createdSeq: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  store: ObjectStore;
  refs: Map<string, string>; // refname -> oid
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number; // shared issue+PR numbering, GitHub-style
  nextCommentId: number;
  nextLabelId: number;
  seq: number; // creation-order counter for this repo
  gen: number; // bumped on every ref/object mutation; invalidates the fetch cache
}

export class Forge {
  readonly repos = new Map<string, Repo>(); // "owner/name" -> Repo
  private repoIdCounter = 0;
  private globalSeq = 0;
  readonly globals = new Map<string, { kind: 'repo' | 'issue' | 'pull' | 'comment'; repo: Repo; number?: number; commentId?: number }>();

  nextSeq(): number {
    this.globalSeq += 1;
    return this.globalSeq;
  }

  globalId(kind: string, ref: string): string {
    return `gid_${Buffer.from(`${kind}:${ref}`, 'utf8').toString('base64url')}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const key = `${owner}/${name}`;
    this.repoIdCounter += 1;
    const repo: Repo = {
      id: this.repoIdCounter,
      globalId: this.globalId('repo', key),
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      store: new ObjectStore(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      seq: 0,
      gen: 0,
    };
    this.repos.set(key, repo);
    this.globals.set(repo.globalId, { kind: 'repo', repo });
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      globalId: this.globalId('issue', `${repo.owner}/${repo.name}#${number}`),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      comments: [],
    };
    repo.issues.push(issue);
    this.globals.set(issue.globalId, { kind: 'issue', repo, number });
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, baseSha: string, files: PullFile[]): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      globalId: this.globalId('pull', `${repo.owner}/${repo.name}#${number}`),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      baseSha,
      files,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    this.globals.set(pull.globalId, { kind: 'pull', repo, number });
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const id = repo.nextCommentId;
    repo.nextCommentId += 1;
    const comment: Comment = {
      id,
      globalId: this.globalId('comment', `${repo.owner}/${repo.name}#${issue.number}:${id}`),
      body,
      createdSeq: this.nextSeq(),
    };
    issue.comments.push(comment);
    this.globals.set(comment.globalId, { kind: 'comment', repo, number: issue.number, commentId: id });
    return comment;
  }
}

// ---- git tree helpers ----

export interface FlatFile {
  mode: string;
  oid: string;
}

/** Flatten a tree (recursively) into path -> {mode, oid}. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, FlatFile> {
  const out = new Map<string, FlatFile>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.payload)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build nested trees from a flat file map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, FlatFile>): string {
  // Group by directory depth: build bottom-up.
  interface Dir {
    files: Map<string, FlatFile>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, f] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1], f);
  }
  const build = (dir: Dir): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, f] of dir.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** Read one file's blob from a commit. Returns null when absent. */
export function fileAt(store: ObjectStore, commitOid: string, path: string): { oid: string; bytes: Buffer } | null {
  const commit = store.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const treeOid = parseCommitTree(commit.payload);
  if (!treeOid) return null;
  const flat = flattenTree(store, treeOid);
  const f = flat.get(path);
  if (!f) return null;
  const blob = store.get(f.oid);
  if (!blob) return null;
  return { oid: f.oid, bytes: Buffer.from(blob.payload) };
}

/** Diff two trees (by root oid, null = empty) into PR file entries. */
export function diffTrees(store: ObjectStore, oldTreeOid: string | null, newTreeOid: string | null): PullFile[] {
  const oldFiles = oldTreeOid ? flattenTree(store, oldTreeOid) : new Map<string, FlatFile>();
  const newFiles = newTreeOid ? flattenTree(store, newTreeOid) : new Map<string, FlatFile>();
  const out: PullFile[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const o = oldFiles.get(path);
    const n = newFiles.get(path);
    if (o && !n) {
      out.push({ filename: path, status: 'removed', additions: 0, deletions: countLines(store, o.oid), changes: countLines(store, o.oid) });
    } else if (!o && n) {
      const adds = countLines(store, n.oid);
      out.push({ filename: path, status: 'added', additions: Math.max(1, adds), deletions: 0, changes: Math.max(1, adds) });
    } else if (o && n && o.oid !== n.oid) {
      const { additions, deletions } = lineDiff(store, o.oid, n.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

function blobLines(store: ObjectStore, oid: string): string[] {
  const blob = store.get(oid);
  if (!blob) return [];
  const text = blob.payload.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(store: ObjectStore, oid: string): number {
  return blobLines(store, oid).length;
}

/** Line multiset diff: additions = lines in new not in old; deletions = lines in old not in new. */
function lineDiff(store: ObjectStore, oldOid: string, newOid: string): { additions: number; deletions: number } {
  const oldLines = blobLines(store, oldOid);
  const newLines = blobLines(store, newOid);
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  const remaining = new Map(oldCount);
  for (const l of newLines) {
    const c = remaining.get(l) ?? 0;
    if (c > 0) remaining.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of remaining.values()) deletions += c;
  if (additions === 0 && deletions === 0) {
    // Blobs differ but lines coincide (e.g. reordered): count something.
    additions = 1;
    deletions = 1;
  }
  return { additions, deletions };
}

/** Create a commit on a branch from file changes (path -> Buffer to write, null to delete). */
export function commitFiles(
  repo: Repo,
  branchRef: string,
  message: string,
  changes: Map<string, Buffer | null>,
): string {
  const store = repo.store;
  const tip = repo.refs.get(branchRef);
  let files = new Map<string, FlatFile>();
  const parents: string[] = [];
  if (tip && tip !== ZERO_OID) {
    const commit = store.get(tip);
    if (commit && commit.type === 'commit') {
      const treeOid = parseCommitTree(commit.payload);
      if (treeOid) files = flattenTree(store, treeOid);
      parents.push(tip);
    }
  }
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, { mode: '100644', oid: store.put('blob', content) });
  }
  const treeOid = buildTreeFromFiles(store, files);
  const payload = buildCommit({ tree: treeOid, parents, author: IDENT, committer: IDENT, message: message.endsWith('\n') ? message : `${message}\n` });
  const oid = store.put('commit', payload);
  repo.refs.set(branchRef, oid);
  repo.gen += 1;
  return oid;
}

/** Squash-merge a pull request onto its base branch. Returns {merged:true, sha} on
 * success, {merged:false, conflict:true} when the base moved and changed a file the
 * PR touches, {merged:false} when head/base are missing. */
export function squashMerge(repo: Repo, pull: Pull): { merged: boolean; sha?: string; conflict?: boolean } {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef) ?? null;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  if (!baseTip || !headTip) return { merged: false };
  if (baseTip !== pull.baseSha) {
    const baseAtCreate = repo.store.get(pull.baseSha);
    const baseNow = repo.store.get(baseTip);
    const oldTree = baseAtCreate ? parseCommitTree(baseAtCreate.payload) : null;
    const newTree = baseNow ? parseCommitTree(baseNow.payload) : null;
    const changedOnBase = new Set(diffTrees(repo.store, oldTree, newTree).map((f) => f.filename));
    const prFiles = new Set(pull.files.map((f) => f.filename));
    if ([...changedOnBase].some((f) => prFiles.has(f))) return { merged: false, conflict: true };
  }
  const baseCommit = repo.store.get(baseTip);
  const baseTree = baseCommit ? parseCommitTree(baseCommit.payload) : null;
  const files = baseTree ? flattenTree(repo.store, baseTree) : new Map<string, FlatFile>();
  const headCommit = repo.store.get(headTip);
  const headTree = headCommit ? parseCommitTree(headCommit.payload) : null;
  const headFiles = headTree ? flattenTree(repo.store, headTree) : new Map<string, FlatFile>();
  for (const f of pull.files) {
    if (f.status === 'removed') files.delete(f.filename);
    else {
      const hf = headFiles.get(f.filename);
      if (hf) files.set(f.filename, hf);
    }
  }
  const treeOid = buildTreeFromFiles(repo.store, files);
  const payload = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: IDENT,
    committer: IDENT,
    message: `Merge pull request #${pull.number} (${pull.title})\n`,
  });
  const mergeOid = repo.store.put('commit', payload);
  repo.refs.set(baseRef, mergeOid);
  repo.gen += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeOid;
  return { merged: true, sha: mergeOid };
}

/** 'MERGEABLE' unless the PR would conflict on merge. */
export function mergeableState(repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  if (!baseTip || baseTip === pull.baseSha) return 'MERGEABLE';
  const baseAtCreate = repo.store.get(pull.baseSha);
  const baseNow = repo.store.get(baseTip);
  const oldTree = baseAtCreate ? parseCommitTree(baseAtCreate.payload) : null;
  const newTree = baseNow ? parseCommitTree(baseNow.payload) : null;
  const changedOnBase = new Set(diffTrees(repo.store, oldTree, newTree).map((f) => f.filename));
  const prFiles = new Set(pull.files.map((f) => f.filename));
  return [...changedOnBase].some((f) => prFiles.has(f)) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Commits reachable from a tip, newest first (linear histories: the chain). */export function commitsFrom(store: ObjectStore, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommitParents(obj.payload)) queue.push(p);
  }
  return out;
}

/** True when `ancestor` is an ancestor of (or equal to) `tip`. */
export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommitParents(obj.payload)) stack.push(p);
  }
  return false;
}

/** Commit depth map: distance from any of `tips` (BFS). */
export function commitDepths(store: ObjectStore, tips: readonly string[]): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((t) => [t, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, d] = queue.shift() as [string, number];
    if (depths.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    depths.set(oid, d);
    for (const p of parseCommitParents(obj.payload)) queue.push([p, d + 1]);
  }
  return depths;
}
