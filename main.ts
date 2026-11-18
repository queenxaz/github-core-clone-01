// Entrypoint for the makefun-forge entry (github-core-clone-01).
//
// Lifecycle the trial expects:
//   1. Read the suite's base URL from MAKEFUN_ENV_URL (fail fast when unset).
//   2. Build the forge server and bind an ephemeral port (port 0). The
//      suite owns 8080, so this process must never bind it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register so the suite knows
//      where to dial. A 409 means another entry registered first; that is
//      not fatal, we just keep waiting for the trial to finish.
//   4. Long-poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//      then shut the server down and exit 0.
//
// Only the Node standard library is used: the app itself lives in app.ts
// and is reached through its createApp export.

import { createApp } from './app.ts';

/** How long to wait between /done polls while the trial is still running. */
const POLL_INTERVAL_MS = 500;
/** First backoff step after a failed request; doubles on each failure. */
const BACKOFF_START_MS = 250;
/** Longest backoff step; a failed request never waits longer than this. */
const BACKOFF_MAX_MS = 10_000;
/** How long registration is retried before giving up. */
const REGISTER_BUDGET_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Next backoff step, doubled from the previous one and capped. */
function nextBackoff(currentMs: number): number {
  return Math.min(BACKOFF_MAX_MS, currentMs * 2);
}

function envBaseUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    process.stderr.write('error: MAKEFUN_ENV_URL is not set; cannot register with the trial suite\n');
    process.exit(1);
  }
  return raw.replace(/\/+$/, '');
}

/** POST {"port": port} to the suite's /register endpoint. */
async function registerPort(baseUrl: string, port: number): Promise<number> {
  const response = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
}

/**
 * Register the bound port, retrying transient failures with backoff.
 * Returns true once the suite knows our port (or a 409 told us another
 * entry already registered, in which case we simply wait out the trial).
 */
async function registerWithRetry(baseUrl: string, port: number): Promise<boolean> {
  const started = Date.now();
  let backoffMs = BACKOFF_START_MS;
  for (;;) {
    try {
      const status = await registerPort(baseUrl, port);
      if (status >= 200 && status < 300) return true;
      if (status === 409) {
        process.stderr.write('register: another entry already registered (409); waiting for the trial to finish\n');
        return true;
      }
      process.stderr.write(`register: suite answered HTTP ${status}; retrying\n`);
    } catch (err) {
      process.stderr.write(`register: ${err instanceof Error ? err.message : String(err)}; retrying\n`);
    }
    if (Date.now() - started > REGISTER_BUDGET_MS) return false;
    await sleep(backoffMs);
    backoffMs = nextBackoff(backoffMs);
  }
}

/** Ask the suite whether the trial is over; true only on {"done": true}. */
async function fetchDone(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/done`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GET /done answered HTTP ${response.status}`);
  const body: unknown = await response.json();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { done?: unknown }).done === true
  );
}

/** Poll /done until the suite reports the trial finished. */
async function waitForDone(baseUrl: string): Promise<void> {
  let backoffMs = BACKOFF_START_MS;
  for (;;) {
    try {
      if (await fetchDone(baseUrl)) return;
      backoffMs = BACKOFF_START_MS;
      await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      process.stderr.write(`poll /done: ${err instanceof Error ? err.message : String(err)}; retrying in ${backoffMs} ms\n`);
      await sleep(backoffMs);
      backoffMs = nextBackoff(backoffMs);
    }
  }
}

/** The running forge server, kept so main() can close it at the end. */
let activeServer: ReturnType<typeof createApp> | null = null;

/** Bind the forge to an ephemeral port and return the chosen port number. */
function listenEphemeral(): Promise<number> {
  const server = createApp();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server bound to an unexpected address'));
        return;
      }
      activeServer = server;
      resolve(address.port);
    });
  });
}

function closeServer(): Promise<void> {
  const server = activeServer;
  activeServer = null;
  if (server === null) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function main(): Promise<number> {
  const baseUrl = envBaseUrl();
  const port = await listenEphemeral();
  const registered = await registerWithRetry(baseUrl, port);
  if (!registered) {
    process.stderr.write('error: could not register with the trial suite; giving up\n');
    await closeServer();
    return 1;
  }
  await waitForDone(baseUrl);
  await closeServer();
  return 0;
}

const code = await main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
});
await closeServer().catch(() => undefined);
process.exit(code);
