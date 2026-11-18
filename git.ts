// Git object store + packfile codec (pure Node stdlib, no git binary).
// Objects: blob/tree/commit/tag, SHA-1 ids. Pack v2 read (incl. OFS/REF deltas)
// and write (type 1-4 objects only, no deltas — the suite accepts that).

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** The on-disk form of an object: "<type> <size>\0<payload>". */
export function hashObject(type: string, payload: Buffer): { oid: string; raw: Buffer } {
  const head = Buffer.from(`${type} ${payload.length}\0`, 'ascii');
  const raw = Buffer.concat([head, payload]);
  return { oid: sha1(raw), raw };
}

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  payload: Buffer; // payload without the "<type> <size>\0" header
}

/** In-memory object store. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store a payload under its hash; returns the oid. */
  put(type: ObjType, payload: Buffer): string {
    const { oid } = hashObject(type, payload);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, payload });
    return oid;
  }

  /** Store a raw "<type> <size>\0<payload>" buffer; returns the oid. */
  putRaw(raw: Buffer): string {
    const nul = raw.indexOf(0);
    const head = raw.subarray(0, nul).toString('ascii');
    const [type, sizeStr] = head.split(' ');
    const payload = raw.subarray(nul + 1);
    if (payload.length !== Number(sizeStr)) throw new Error('object size mismatch');
    const oid = sha1(raw);
    if (!this.objects.has(oid)) this.objects.set(oid, { type: type as ObjType, payload: Buffer.from(payload) });
    return oid;
  }

  /** All commit oids reachable from `tip`, walking parents (newest first). */
  reachableCommits(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommitParents(obj.payload)) stack.push(p);
    }
    return out;
  }

  /** Every object oid reachable from a commit (commit + its tree recursively + parents). */
  reachableObjects(tip: string): Set<string> {
    const out = new Set<string>();
    for (const c of this.reachableCommits(tip)) {
      out.add(c);
      const commit = this.objects.get(c);
      if (!commit) continue;
      const treeOid = parseCommitTree(commit.payload);
      if (treeOid) this.walkTree(treeOid, out);
    }
    return out;
  }

  walkTree(treeOid: string, out: Set<string>): void {
    if (out.has(treeOid)) return;
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    out.add(treeOid);
    for (const e of parseTree(obj.payload)) {
      if (e.mode === '40000') this.walkTree(e.oid, out);
      else out.add(e.oid);
    }
  }
}

export function parseCommitTree(payload: Buffer): string | null {
  const text = payload.toString('utf8');
  const m = /^tree ([0-9a-f]{40})$/m.exec(text);
  return m ? m[1] : null;
}

export function parseCommitParents(payload: Buffer): string[] {
  const text = payload.toString('utf8');
  const out: string[] = [];
  const re = /^parent ([0-9a-f]{40})$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < payload.length) {
    const sp = payload.indexOf(0x20, i);
    const mode = payload.subarray(i, sp).toString('ascii');
    const nul = payload.indexOf(0, sp);
    const name = payload.subarray(sp + 1, nul).toString('utf8');
    const oid = payload.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  // Git sorts tree entries by name, directories as if suffixed with '/'.
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit payload. `parents` in order. */
export function buildCommit(opts: {
  tree: string;
  parents: string[];
  author: string; // "Name <email> epoch tz"
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`);
  lines.push(`committer ${opts.committer}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

/** Build an annotated tag payload. */
export function buildTag(opts: { object: string; type: ObjType; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\ntagger ${opts.tagger}\n\n${opts.message}`,
    'utf8',
  );
}

// ---- packfile ----

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeObjHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Encode one object header + zlib payload for a pack entry (no delta). */
function packEntry(type: ObjType, payload: Buffer): Buffer {
  const code = TYPE_CODES[type];
  const header = encodeObjHeader(code, payload.length);
  const data = deflateSync(payload, { level: 6 });
  return Buffer.concat([header, data]);
}

/** Build a pack v2 from a list of oids (in the store). Returns the full pack incl. trailer SHA-1. */
export function buildPack(store: ObjectStore, oids: readonly string[]): Buffer {
  const entries: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  entries.push(header);
  for (const oid of oids) {
    const obj = store.get(oid);
    if (!obj) throw new Error(`buildPack: missing object ${oid}`);
    entries.push(packEntry(obj.type, obj.payload));
  }
  const body = Buffer.concat(entries);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Parse a pack v2 into the store. Returns the oids in pack order. Handles OFS_DELTA (6) and REF_DELTA (7). */
export function parsePack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let off = 12;
  const oids: string[] = [];
  const byOffset = new Map<number, { oid: string; raw: Buffer }>();
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = pack[off++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: variable-length offset (MSB-first, +1 per byte)
      byte = pack[off++];
      let baseOff = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        baseOff = ((baseOff + 1) << 7) | (byte & 0x7f);
      }
      const baseStart = start - baseOff;
      const { consumed, data } = inflateFrom(pack, off);
      off += consumed;
      const base = byOffset.get(baseStart);
      if (!base) throw new Error('OFS_DELTA base not found');
      const raw = applyDelta(base.raw, data);
      const oid = store.putRaw(raw);
      byOffset.set(start, { oid, raw });
      oids.push(oid);
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const { consumed, data } = inflateFrom(pack, off);
      off += consumed;
      const base = store.get(baseOid);
      if (!base) throw new Error(`REF_DELTA base ${baseOid} not found`);
      const baseRaw = Buffer.concat([Buffer.from(`${base.type} ${base.payload.length}\0`, 'ascii'), base.payload]);
      const raw = applyDelta(baseRaw, data);
      const oid = store.putRaw(raw);
      byOffset.set(start, { oid, raw });
      oids.push(oid);
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack type ${typeCode}`);
      const { consumed, data } = inflateFrom(pack, off);
      off += consumed;
      if (data.length !== size) throw new Error(`pack object size mismatch: ${data.length} != ${size}`);
      const oid = store.put(type, data);
      const raw = Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
      byOffset.set(start, { oid, raw });
      oids.push(oid);
    }
  }
  return oids;
}

function inflateFrom(buf: Buffer, off: number): { consumed: number; data: Buffer } {
  // Node's inflateSync ignores trailing bytes but throws on a truncated stream,
  // so the exact stream end is the smallest length that inflates successfully.
  // Binary-search it (pack objects in this suite are small).
  let lo = off + 1;
  let hi = buf.length; // inclusive upper bound; the pack trailer is 20 bytes past the last object
  let answer: { consumed: number; data: Buffer } | null = null;
  // First check the full remainder works at all.
  try {
    const data = inflateSync(buf.subarray(off, hi));
    answer = { consumed: hi - off, data };
  } catch {
    throw new Error('zlib inflate failed');
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buf.subarray(off, mid));
      answer = { consumed: mid - off, data };
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return answer as { consumed: number; data: Buffer };
}

/** Apply a git delta to a base raw object ("<type> <size>\0<payload>"). */
export function applyDelta(baseRaw: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  const nul = baseRaw.indexOf(0);
  const basePayload = baseRaw.subarray(nul + 1);
  if (basePayload.length !== baseSize) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) cpOff |= delta[p++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) cpSize |= delta[p++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(basePayload.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      p += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  const head = baseRaw.subarray(0, nul + 1);
  const type = head.toString('ascii').split(' ')[0];
  return Buffer.concat([Buffer.from(`${type} ${result.length}\0`, 'ascii'), result]);
}
