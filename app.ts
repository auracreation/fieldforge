import { createServer } from 'node:http';
import { Store, HttpError } from './src/storage/store.ts';
import { rest } from './src/api/rest.ts';
import { graphql } from './src/graphql/executor.ts';
import { mcp } from './src/mcp/transport.ts';
import { gitHttp } from './src/git/http.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const EMPTY_BODY = Buffer.alloc(0);

export function createApp({ store = new Store(), token = process.env.MAKEFUN_SHOP_TOKEN ?? '' } = {}) {
  function send(res, status, body, headers = {}) {
    if (res.destroyed || res.writableEnded) return;
    const binary = Buffer.isBuffer(body), bytes = status === 204 ? '' : binary ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': binary ? 'application/octet-stream' : 'application/json; charset=utf-8', 'content-length': binary ? bytes.length : Buffer.byteLength(bytes), 'x-github-request-id': 'forge', 'x-content-type-options': 'nosniff', ...headers });
    res.end(bytes);
  }
  function fail(res, e) { send(res, e.status ?? 500, { message: e.status ? e.message : 'Internal Server Error' }); }
  function dispatch(req, res, url, body) {
    try {
      const path = url.pathname, method = req.method;
      const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (git) {
        const r = store.repo(decodeURIComponent(git[1]), decodeURIComponent(git[2])); let answer;
        try { answer = gitHttp(r, git[3], method, url, req.headers, body); } catch (e) { throw new HttpError(400, e.message); }
        return send(res, answer.status, answer.body, answer.headers);
      }
      let json = {};
      if (body.length) {
        try { json = JSON.parse(body.toString()); }
        catch {
          if (path === '/mcp') return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          throw new HttpError(400, 'Invalid JSON');
        }
      }
      if (path === '/api/graphql' && method === 'POST') return send(res, 200, graphql(store, json));
      if (path === '/mcp') {
        if (method === 'DELETE') return send(res, 204, null);
        if (method !== 'POST') return send(res, 405, { message: 'Method Not Allowed' });
        const result = mcp(store, json); return send(res, result ? 200 : 202, result);
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) { const answer = rest(store, method, url, json); return send(res, answer.status, answer.body, answer.headers); }
      send(res, 404, { message: 'Not Found' });
    } catch (e) { fail(res, e); }
  }
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://' + req.headers.host), method = req.method;
      if (url.pathname === '/healthz' && method === 'GET') return send(res, 200, { ok: true });
      if (!token || req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: 'Bad credentials' });
      const rejectLargeBody = () => send(res, 413, { message: 'Request body too large' }, { connection: 'close' });
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return rejectLargeBody();
      if (['GET', 'HEAD', 'DELETE'].includes(method) && !Number(req.headers['content-length']) && !req.headers['transfer-encoding']) return dispatch(req, res, url, EMPTY_BODY);
      const chunks = []; let size = 0;
      req.on('data', chunk => {
        if (size > MAX_BODY_BYTES) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { chunks.length = 0; rejectLargeBody(); }
        else chunks.push(chunk);
      });
      req.once('end', () => { if (size <= MAX_BODY_BYTES) dispatch(req, res, url, chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)); });
      req.once('error', e => fail(res, e));
      req.once('close', () => { if (!req.complete) chunks.length = 0; });
    } catch (e) { fail(res, e); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('clientError', (_e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return server;
}
