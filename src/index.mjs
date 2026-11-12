#!/usr/bin/env node
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.mjs';
import { createContext, defineTools } from './context.mjs';
import { registerBucketTools } from './tools/buckets.mjs';
import { registerObjectTools } from './tools/objects.mjs';

const VERSION = '0.1.0';
const transportMode = process.argv.includes('--stdio') || process.env.MCP_TRANSPORT === 'stdio' ? 'stdio' : 'http';
const cfg = loadConfig({ transport: transportMode });
const ctx = createContext(cfg);

function buildServer() {
  const server = new McpServer(
    { name: 's3-gateway-mcp', version: VERSION },
    { instructions: 'S3-compatible storage tools. Use upload_file to turn a local file into a public URL. bucket defaults to S3_BUCKET.' },
  );
  const reg = defineTools(server, ctx);
  registerBucketTools(reg, ctx);
  registerObjectTools(reg, ctx);
  return { server, tools: reg.registered };
}

const log = (...a) => console.error(new Date().toISOString(), ...a);

if (transportMode === 'stdio') {
  const { server } = buildServer();
  await server.connect(new StdioServerTransport());
} else {
  if (!cfg.token && !cfg.authDisabled) {
    throw new Error('MCP_TOKEN is required in HTTP mode (or set MCP_AUTH_DISABLED=true for trusted local use)');
  }
  const tokenBuf = cfg.token ? Buffer.from(cfg.token) : null;
  const authorized = (req) => {
    if (cfg.authDisabled) return true;
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    const b = Buffer.from(m[1].trim());
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };
  const limit = cfg.maxBytes * 1.4 + 1e6; // base64 업로드 여유분
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const sendJson = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const rpcError = (res, status, code, message) => sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });

  const { tools } = buildServer();

  http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') return sendJson(res, 200, { ok: true, version: VERSION, tools: tools.length, read_only: cfg.readOnly });
    if (pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' });
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    // stateless 모드: 서버→클라이언트 SSE(GET)와 세션 종료(DELETE)는 쓰지 않는다
    if (req.method !== 'POST') return rpcError(res, 405, -32000, 'Method not allowed');
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return rpcError(res, e.status ?? 400, -32700, e.message); }
    const { server } = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log('request failed', e);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
    }
  }).listen(cfg.port, cfg.host, () => {
    log(`s3-gateway-mcp ${VERSION} http://${cfg.host}:${cfg.port}/mcp tools=${tools.length} read_only=${cfg.readOnly} endpoint=${cfg.endpoint ?? 'aws'} default_bucket=${cfg.defaultBucket ?? '-'}`);
  });
}
