// Git smart HTTP: info/refs (v0/v2), upload-pack (v2 + v0 fallback), receive-pack (v0).
// Pure protocol implementation against the Forge store; no git binary.

import type { ServerResponse } from 'node:http';
import { Forge, buildTreeFromFiles, commitDepths, fileAt, flattenTree, isAncestor } from './store.ts';
import { ObjectStore, ZERO_OID, buildPack, parsePack, parseCommitParents, parseCommitTree, parseTree } from './git.ts';
import { FLUSH, pktLine, pktLines, parsePktLines, pktTextLines, servicePreamble, sideband } from './pkt.ts';

export const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
export const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
export const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
export const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const AGENT = 'makefun-forge/1.0';

function sendBuf(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name, with peeled targets for annotated tags. */
function listRefs(repo: { store: ObjectStore; refs: Map<string, string> }): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.store.get(oid);
      if (obj && obj.type === 'tag') {
        const text = obj.payload.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
        if (m) line.peeled = m[1];
      }
    }
    out.push(line);
  }
  return out;
}

function headOid(repo: { refs: Map<string, string>; defaultBranch: string }): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---- info/refs ----

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: number | null,
  res: ServerResponse,
): void {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 2) {
      const lines: Buffer[] = [servicePreamble('git-upload-pack')];
      lines.push(pktLine('version 2\n'));
      lines.push(pktLine(`agent=${AGENT}\n`));
      lines.push(pktLine('ls-refs=unborn\n'));
      lines.push(pktLine('fetch=shallow filter\n'));
      lines.push(pktLine('object-format=sha1\n'));
      lines.push(FLUSH);
      sendBuf(res, 200, UPLOAD_AD, Buffer.concat(lines));
      return;
    }
    // v0 advertisement
    const refs = listRefs(repo);
    const caps = 'side-band-64k thin-pack ofs-delta shallow no-progress multi_ack_detailed agent=makefun-forge/1.0 symref=HEAD:refs/heads/main';
    const parts: Buffer[] = [servicePreamble('git-upload-pack')];
    const tip = headOid(repo);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      parts.push(pktLine(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
      for (const r of refs) {
        parts.push(pktLine(`${r.oid} ${r.name}\n`));
        if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
      }
    }
    parts.push(FLUSH);
    sendBuf(res, 200, UPLOAD_AD, Buffer.concat(parts));
    return;
  }
  if (service === 'git-receive-pack') {
    const refs = listRefs(repo);
    const caps = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0 symref=HEAD:refs/heads/main';
    const parts: Buffer[] = [servicePreamble('git-receive-pack')];
    const tip = headOid(repo);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      parts.push(pktLine(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
      for (const r of refs) {
        parts.push(pktLine(`${r.oid} ${r.name}\n`));
        if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
      }
    }
    parts.push(FLUSH);
    sendBuf(res, 200, RECEIVE_AD, Buffer.concat(parts));
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---- v2 ls-refs / fetch ----

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

/** Fetch-response cache: the bench issues many identical fetches (50 concurrent
 * clones of one repo). The response is fully determined by (repo id, repo gen,
 * fetch args), so a hit returns byte-identical bytes. Bounded FIFO, 128 entries. */
const FETCH_CACHE_MAX = 128;
const fetchCache = new Map<string, Buffer>();
function fetchCacheKey(repo: Repo, version: 'v2' | 'v0', args: FetchArgs): string {
  return `${repo.id}|${repo.gen}|${version}|${JSON.stringify([
    [...args.wants].sort(),
    [...args.haves].sort(),
    [...args.shallow].sort(),
    args.depth,
    args.filter,
  ])}`;
}
function fetchCachePut(key: string, body: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const first = fetchCache.keys().next().value;
    if (first !== undefined) fetchCache.delete(first);
  }
  fetchCache.set(key, body);
}

/** Compute the objects a fetch must send, and the new shallow boundary lines. */
function computeFetch(
  store: ObjectStore,
  args: FetchArgs,
): { send: Set<string>; shallow: string[]; unshallow: string[] } {
  const send = new Set<string>();
  const held = new Set<string>();
  const shallowSet = new Set(args.shallow);

  // Objects the client already holds: closure of haves, treating shallow boundaries as leaves.
  const collectHeld = (oid: string): void => {
    const obj = store.get(oid);
    if (!obj) return;
    if (obj.type === 'commit') {
      held.add(oid);
      const treeOid = parseCommitTree(obj.payload);
      if (treeOid) collectTree(treeOid, held);
      if (!shallowSet.has(oid)) {
        for (const p of parseCommitParents(obj.payload)) collectHeld(p);
      }
    } else if (obj.type === 'tag') {
      held.add(oid);
      const text = obj.payload.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) collectHeld(m[1]);
    } else if (obj.type === 'tree') {
      collectTree(oid, held);
    } else {
      held.add(oid);
    }
  };
  const collectTree = (treeOid: string, into: Set<string>): void => {
    if (into.has(treeOid)) return;
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    into.add(treeOid);
    for (const e of parseTree(obj.payload)) {
      if (e.mode === '40000') collectTree(e.oid, into);
      else into.add(e.oid);
    }
  };
  for (const h of args.haves) collectHeld(h);

  // Commits to send: within depth of wants (or all reachable when depth is null).
  const depths = commitDepths(store, args.wants);
  const sendCommits = new Set<string>();
  for (const [oid, d] of depths) {
    if (args.depth === null || d < args.depth) sendCommits.add(oid);
  }
  // Tag wants: include the tag object and treat its target as a want.
  const tagQueue = [...args.wants];
  const seenTags = new Set<string>();
  while (tagQueue.length > 0) {
    const oid = tagQueue.pop() as string;
    if (seenTags.has(oid)) continue;
    seenTags.add(oid);
    const obj = store.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      send.add(oid);
      const text = obj.payload.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) {
        const target = store.get(m[1]);
        if (target && target.type === 'commit') {
          const d2 = commitDepths(store, [m[1]]);
          for (const [c, dd] of d2) if (args.depth === null || dd < args.depth) sendCommits.add(c);
        } else if (target) {
          send.add(m[1]);
        }
      }
    }
  }
  for (const c of sendCommits) {
    send.add(c);
    const obj = store.get(c);
    if (!obj) continue;
    const treeOid = parseCommitTree(obj.payload);
    if (treeOid) {
      const tmp = new Set<string>();
      collectTree(treeOid, tmp);
      for (const o of tmp) send.add(o);
    }
  }
  // Non-commit wants (blob/tree) sent directly.
  for (const w of args.wants) {
    const obj = store.get(w);
    if (obj && (obj.type === 'blob' || obj.type === 'tree')) {
      if (obj.type === 'blob') send.add(w);
      else {
        const tmp = new Set<string>();
        collectTree(w, tmp);
        for (const o of tmp) send.add(o);
      }
    }
  }
  for (const h of held) send.delete(h);

  // New shallow boundary: included commits at max depth whose parent is not included.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const [oid, d] of depths) {
      if (d !== args.depth - 1) continue;
      if (!sendCommits.has(oid)) continue;
      const obj = store.get(oid);
      if (!obj) continue;
      const parents = parseCommitParents(obj.payload);
      if (parents.some((p) => !sendCommits.has(p))) shallow.push(oid);
    }
    // Old boundaries that are now fully included (all parents included) are unshallow.
    for (const b of args.shallow) {
      if (!sendCommits.has(b)) continue;
      const obj = store.get(b);
      if (!obj) continue;
      const parents = parseCommitParents(obj.payload);
      if (parents.every((p) => sendCommits.has(p))) unshallow.push(b);
    }
  }
  return { send, shallow, unshallow };
}

export function handleUploadPackV2(forge: Forge, owner: string, repoName: string, body: Buffer, res: ServerResponse): void {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let lines: string[];
  try {
    lines = pktTextLines(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  const command = lines[0] ?? '';
  if (command === 'command=ls-refs') {
    const args = lines.slice(1);
    const peel = args.includes('peel');
    const symrefs = args.includes('symrefs');
    const prefixes: string[] = [];
    for (const a of args) if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    const refs = listRefs(repo);
    const out: Buffer[] = [];
    const tip = headOid(repo);
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (prefixes.length === 0) {
      if (tip) out.push(pktLine(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      else out.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    for (const r of refs) {
      if (!matches(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (peel && r.peeled) line += ` peeled:${r.peeled}`;
      out.push(pktLine(`${line}\n`));
    }
    out.push(FLUSH);
    sendBuf(res, 200, UPLOAD_RESULT, Buffer.concat(out));
    return;
  }
  if (command === 'command=fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
    for (const line of lines.slice(1)) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
      else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    }
    const cacheKey = fetchCacheKey(repo, 'v2', args);
    const cached = fetchCache.get(cacheKey);
    if (cached) {
      sendBuf(res, 200, UPLOAD_RESULT, cached);
      return;
    }
    const { send, shallow, unshallow } = computeFetch(repo.store, args);
    const pack = buildPack(repo.store, [...send].sort());
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(FLUSH);
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sideband(pack));
    const respBody = Buffer.concat(parts);
    fetchCachePut(cacheKey, respBody);
    sendBuf(res, 200, UPLOAD_RESULT, respBody);
    return;
  }
  sendJson(res, 400, { message: `unknown v2 command ${JSON.stringify(command)}` });
}

export function handleUploadPackV0(forge: Forge, owner: string, repoName: string, body: Buffer, res: ServerResponse): void {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let packets;
  try {
    packets = parsePktLines(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  // Two sections split by flush: wants/shallow/deepen, then haves/done.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const p of packets) {
    if (p.type !== 'data' || !p.data) continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
  }
  const cacheKey = fetchCacheKey(repo, 'v0', args);
  const cached = fetchCache.get(cacheKey);
  if (cached) {
    sendBuf(res, 200, UPLOAD_RESULT, cached);
    return;
  }
  const { send, shallow, unshallow } = computeFetch(repo.store, args);
  const pack = buildPack(repo.store, [...send].sort());
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(sideband(pack));
  const respBody = Buffer.concat(parts);
  fetchCachePut(cacheKey, respBody);
  sendBuf(res, 200, UPLOAD_RESULT, respBody);
}

// ---- receive-pack (v0) ----

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer, res: ServerResponse): void {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // Split command pkt-lines (up to first flush) from the raw pack.
  const { commands, caps, packStart } = parseReceiveBody(body);
  if (commands === null) {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  const useSideband = caps.includes('side-band-64k');
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      parsePack(repo.store, Buffer.from(packBytes));
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\n/g, ' ') : 'unpack failed';
    }
  }
  if (unpackOk) {
    let changed = false;
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} ref does not exist`);
        } else if (current !== cmd.oldOid) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        } else {
          repo.refs.delete(cmd.ref);
          changed = true;
          reportLines.push(`ok ${cmd.ref}`);
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) {
          reportLines.push(`ng ${cmd.ref} already exists`);
        } else if (!repo.store.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} missing object`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          changed = true;
          reportLines.push(`ok ${cmd.ref}`);
        }
      } else {
        // update
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} ref does not exist`);
        } else if (current !== cmd.oldOid) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        } else if (!repo.store.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} missing object`);
        } else if (!isAncestor(repo.store, cmd.oldOid, cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          changed = true;
          reportLines.push(`ok ${cmd.ref}`);
        }
      }
    }
    if (changed) repo.gen += 1;
  }
  const lines = [`unpack ${unpackDetail}`, ...reportLines];
  const reportBuf = pktLines(lines);
  if (useSideband) {
    sendBuf(res, 200, RECEIVE_RESULT, sideband(reportBuf));
  } else {
    sendBuf(res, 200, RECEIVE_RESULT, Buffer.concat([reportBuf, FLUSH]));
  }
}

/** Find where the raw pack starts: after the first flush packet. Returns body length if none. */
function findPackStart(body: Buffer): number {
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) return body.length;
    if (len === 0) return i + 4;
    if (len < 4) return body.length;
    i += len;
  }
  return body.length;
}

function parseReceiveBody(body: Buffer): { commands: PushCommand[] | null; caps: string[]; packStart: number } {
  const packStart = findPackStart(body);
  const head = body.subarray(0, packStart);
  let packets;
  try {
    packets = parsePktLines(head);
  } catch {
    return { commands: null, caps: [], packStart };
  }
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  for (const p of packets) {
    if (p.type !== 'data' || !p.data) continue;
    let text = p.data.toString('utf8');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1).split(' ').filter(Boolean);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length !== 3) return { commands: null, caps, packStart };
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  return { commands, caps, packStart };
}

// Re-exported for the fetch computation's tree walk.
export { flattenTree, fileAt, buildTreeFromFiles };
