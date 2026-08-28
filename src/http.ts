#!/usr/bin/env node
/**
 * Streamable HTTP entrypoint.
 *
 * The stdio entrypoint (src/index.ts) is what local MCP clients spawn. A hosted
 * deployment cannot use stdio — nothing feeds the process a stdin pipe — so this
 * entrypoint serves the same MCP server over the Streamable HTTP transport.
 *
 * One `StrudelMCPServer` is created per MCP session: an SDK `Server` can only be
 * connected to a single transport, and each session drives its own browser.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { StrudelMCPServer } from './server/server.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
/** Each session can launch a Chromium instance, so cap concurrency. */
const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS ?? 4);
const MAX_BODY_BYTES = Number(process.env.MCP_MAX_BODY_BYTES ?? 4 * 1024 * 1024);

interface Session {
  transport: StreamableHTTPServerTransport;
  server: StrudelMCPServer;
}

const sessions = new Map<string, Session>();

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
  });
}

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  sessions.delete(sessionId);
  try {
    await session.server.shutdown();
  } catch (error) {
    console.error(`[mcp-http] cleanup failed for session ${sessionId}:`, error);
  }
}

async function startSession(): Promise<StreamableHTTPServerTransport> {
  const server = new StrudelMCPServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { transport, server });
      console.error(`[mcp-http] session ${sessionId} started (${sessions.size} open)`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      void closeSession(transport.sessionId);
    }
  };

  await server.connect(transport);
  return transport;
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

  if (req.method === 'GET' || req.method === 'DELETE') {
    if (!existing) {
      sendRpcError(res, 404, 'Unknown or expired MCP session');
      return;
    }
    await existing.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== 'POST') {
    sendRpcError(res, 405, `Method ${req.method ?? 'unknown'} not allowed`);
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendRpcError(res, 400, error instanceof Error ? error.message : 'Invalid request body');
    return;
  }

  if (existing) {
    await existing.transport.handleRequest(req, res, body);
    return;
  }

  if (typeof sessionId === 'string') {
    sendRpcError(res, 404, 'Unknown or expired MCP session');
    return;
  }

  if (!isInitializeRequest(body)) {
    sendRpcError(res, 400, 'First request on a new session must be `initialize`');
    return;
  }

  if (sessions.size >= MAX_SESSIONS) {
    sendRpcError(res, 503, `Session limit reached (${MAX_SESSIONS}); try again later`);
    return;
  }

  const transport = await startSession();
  await transport.handleRequest(req, res, body);
}

const httpServer = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/health' || path === '/healthz') {
    sendJson(res, 200, { status: 'ok', sessions: sessions.size, mcpPath: MCP_PATH });
    return;
  }

  if (path !== MCP_PATH) {
    sendRpcError(res, 404, `Not found. MCP is served at ${MCP_PATH}`);
    return;
  }

  handleMcpRequest(req, res).catch((error) => {
    console.error('[mcp-http] request failed:', error);
    if (!res.headersSent) {
      sendRpcError(res, 500, 'Internal server error');
    } else {
      res.end();
    }
  });
});

httpServer.listen(PORT, HOST, () => {
  console.error(`[mcp-http] listening on http://${HOST}:${PORT}${MCP_PATH}`);
});

async function shutdown(signal: string): Promise<void> {
  console.error(`[mcp-http] ${signal} received, closing ${sessions.size} session(s)`);
  httpServer.close();
  await Promise.all([...sessions.keys()].map((sessionId) => closeSession(sessionId)));
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
