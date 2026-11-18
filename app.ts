import { createServer } from 'node:http';
import { Store, HttpError } from './src/storage/store.ts';
import { rest } from './src/api/rest.ts';
import { graphql } from './src/graphql/executor.ts';
import { mcp } from './src/mcp/transport.ts';
import { gitHttp } from './src/git/http.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp({ store = new Store(), token = process.env.MAKEFUN_SHOP_TOKEN ?? '' } = {}) {
  function send(res, status, body, headers = {}) {
    if (res.destroyed) return;
    const binary = Buffer.isBuffer(body), bytes = status === 204 ? Buffer.alloc(0) : binary ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': binary ? 'application/octet-stream' : 'application/json; charset=utf-8', 'content-length': bytes.length, 'x-github-request-id': 'forge', 'x-content-type-options': 'nosniff', ...headers });
    res.end(bytes);
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + req.headers.host), path = url.pathname, method = req.method;
      if (path === '/healthz' && method === 'GET') return send(res, 200, { ok: true });
      if (!token || req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: 'Bad credentials' });
      const rejectLargeBody = () => send(res, 413, { message: 'Request body too large' }, { connection: 'close' });
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return rejectLargeBody();
      let body = Buffer.alloc(0);
      if (!['GET', 'HEAD', 'DELETE'].includes(method) || Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']) {
        const chunks = []; let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) return rejectLargeBody();
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks, size);
      }
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
    } catch (e) { send(res, e.status ?? 500, { message: e.status ? e.message : 'Internal Server Error' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('clientError', (_e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return server;
}
