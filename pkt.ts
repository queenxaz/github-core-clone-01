// Git pkt-line framing (smart HTTP): encode/decode pkt-lines, flush/delim/response-end,
// side-band framing, and parsing of v2 ls-refs / fetch request bodies.

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

/** Split a buffer into pkt-line frames. Each item: {type:'data', data} | {type:'flush'|'delim'|'response-end'}. */
export function parsePktLines(buf: Buffer): Array<{ type: 'data' | 'flush' | 'delim' | 'response-end'; data?: Buffer }> {
  const out: Array<{ type: 'data' | 'flush' | 'delim' | 'response-end'; data?: Buffer }> = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    if (len === 0) {
      out.push({ type: 'flush' });
      i += 4;
    } else if (len === 1) {
      out.push({ type: 'delim' });
      i += 4;
    } else if (len === 2) {
      out.push({ type: 'response-end' });
      i += 4;
    } else {
      if (i + len > buf.length) throw new Error('truncated pkt-line');
      out.push({ type: 'data', data: Buffer.from(buf.subarray(i + 4, i + len)) });
      i += len;
    }
  }
  if (i !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}

/** Concatenate pkt-lines for a list of string lines (each gets a trailing \n if missing). */
export function pktLines(lines: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(pktLine(line.endsWith('\n') ? line : `${line}\n`));
  return Buffer.concat(parts);
}

/** Wrap a payload buffer in side-band channel 1 frames (64 KiB max per frame). */
export function sideband(pack: Buffer, progress?: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65515) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
    const frame = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(frame));
  }
  if (progress) for (const line of progress) parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(line, 'utf8')])));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a side-band stream into {pack, progress[]}. */
export function parseSideband(buf: Buffer): { pack: Buffer; progress: string[] } {
  const frames = parsePktLines(buf);
  const packParts: Buffer[] = [];
  const progress: string[] = [];
  for (const f of frames) {
    if (f.type !== 'data' || !f.data) continue;
    const ch = f.data[0];
    if (ch === 1) packParts.push(f.data.subarray(1));
    else if (ch === 2) progress.push(f.data.subarray(1).toString('utf8'));
    else if (ch === 3) throw new Error(`sideband error: ${f.data.subarray(1).toString('utf8')}`);
  }
  return { pack: Buffer.concat(packParts), progress };
}

/** Parse a v0/v2 request body that is pkt-lines of text commands. Returns text lines (no trailing \n). */
export function pktTextLines(buf: Buffer): string[] {
  const out: string[] = [];
  for (const f of parsePktLines(buf)) {
    if (f.type === 'data' && f.data) {
      const s = f.data.toString('utf8');
      out.push(s.endsWith('\n') ? s.slice(0, -1) : s);
    }
  }
  return out;
}

/** The "# service=..." preamble for an info/refs advertisement (v0). */
export function servicePreamble(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  return Buffer.concat([pktLine(`# service=${service}\n`), FLUSH]);
}
