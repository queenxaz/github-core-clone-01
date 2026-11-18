// The forge's HTTP server: routing, auth, body reading, request ids.
// Surfaces: git smart HTTP at /{owner}/{repo}.git, REST v3 at /api/v3,
// GraphQL at /api/graphql, MCP at /mcp, health at /healthz.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import type { RestCtx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPackV0, handleUploadPackV2, sendJson } from './gitproto.ts';

const ENV_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (ENV_TOKEN !== '') return token === ENV_TOKEN;
  return true;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `req-${requestCounter}`);
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const segments = path.split('/').filter((s) => s !== '').map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        });

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // MCP
        if (path === '/mcp' && (method === 'POST' || method === 'DELETE')) {
          if (method === 'DELETE') {
            res.writeHead(200);
            res.end();
            return;
          }
          const body = await readBody(req);
          handleMcp(forge, body, isAuthed(req), res);
          return;
        }

        // GraphQL
        if (path === '/api/graphql' && method === 'POST') {
          const body = await readBody(req);
          handleGraphQL(forge, body, isAuthed(req), res);
          return;
        }

        // REST v3
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const restSeg = segments.slice(2);
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          let parsedBody: unknown = undefined;
          if (body.length > 0) {
            try {
              parsedBody = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Request body is not valid JSON.' });
              return;
            }
          }
          const ctx: RestCtx = {
            method,
            segments: restSeg,
            query: queryOf(req),
            body: parsedBody,
            host: req.headers.host ?? 'localhost',
            authed: isAuthed(req),
          };
          const handled = handleRest(forge, ctx, res);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = gitMatch[1];
          const repoName = gitMatch[2];
          const action = gitMatch[3];
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (action === 'info/refs' && method === 'GET') {
            const service = queryOf(req).get('service') ?? '';
            const gitProtocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
            handleInfoRefs(forge, owner, repoName, service, gitProtocol, res);
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const gitProtocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
            try {
              if (gitProtocol === 2) handleUploadPackV2(forge, owner, repoName, body, res);
              else handleUploadPackV0(forge, owner, repoName, body, res);
            } catch {
              if (!res.writableEnded) sendJson(res, 400, { message: 'malformed request' });
            }
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            try {
              handleReceivePack(forge, owner, repoName, body, res);
            } catch {
              if (!res.writableEnded) sendJson(res, 400, { message: 'malformed request' });
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
      }
    })();
  });
}
