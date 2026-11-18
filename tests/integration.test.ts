import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { Store } from '../src/storage/store.ts';
import { createApp } from '../app.ts';
import { putObject, writeTree, writeCommit, ZERO } from '../src/git/objects.ts';
import { pkt, decode } from '../src/git/http.ts';
import { writePack, readPack } from '../src/git/pack.ts';
async function fixture(t) {
  const store = new Store('alice'), server = createApp({ store, token: 'local-test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', body, authenticated = true) {
    const response = await fetch(origin + path, { method, headers: { ...(authenticated ? { authorization: 'Bearer local-test' } : {}), 'content-type': 'application/json', ...(path.endsWith('/git-upload-pack') ? {'git-protocol':'version=2'} : {}) }, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
    const data = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') && data.length ? JSON.parse(data) : data };
  }
  return { store, origin, request, server };
}
async function scenario(t) {
  const f = await fixture(t), { store, request } = f;
  assert.equal((await request('/api/v3/user/repos', 'POST', { name: 'roundtrip' })).status, 201);
  const local = { objects: new Map(), refs: new Map(), default_branch: 'main' }, binary = Buffer.from([0, 255, 13, 10, 128, 42]);
  const blob = putObject(local, 'blob', binary), tree = writeTree(local, new Map([['deep/binary.dat', { sha: blob, mode: '100644' }]]));
  const first = writeCommit(local, tree, [], 'first'), second = writeCommit(local, tree, [first], 'second');
  for (const [old, next] of [[ZERO, first], [first, second]]) {
    const body = Buffer.concat([pkt(`${old} ${next} refs/heads/main\0report-status\n`), Buffer.from('0000'), writePack([...local.objects.values()])]);
    const pushed = await request('/alice/roundtrip.git/git-receive-pack', 'POST', body); assert.equal(pushed.status, 200);
    assert(decode(pushed.body).lines.some(b => b.toString() === 'ok refs/heads/main\n'));
  }
  const file = await request('/api/v3/repos/alice/roundtrip/contents/deep/binary.dat');
  assert.deepEqual(Buffer.from(file.body.content, 'base64'), binary);
  const query = 'query($name:String!){repo:repository(owner:"alice",name:$name){...Identity defaultBranchRef{name target{oid}}}} fragment Identity on Repository{id name nameWithOwner}';
  const graph = await request('/api/graphql', 'POST', { query, variables: { name: 'roundtrip' } });
  assert.equal(graph.body.data.repo.defaultBranchRef.target.oid, second);
  const mcp = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 'repo-read', method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'alice', repo: 'roundtrip' } } });
  assert.equal(mcp.body.id, 'repo-read'); assert.equal(mcp.body.result.structuredContent.node_id, graph.body.data.repo.id);
  const repo = store.repo('alice', 'roundtrip');
  const gqlWrite = await request('/api/graphql', 'POST', { query: 'mutation($input:CreateIssueInput!){createIssue(input:$input){issue{number}}}', variables: { input: { repositoryId: repo.node_id, title: 'shared issue', body: 'one store' } } });
  const issueNumber = gqlWrite.body.data.createIssue.issue.number;
  assert.equal((await request(`/api/v3/repos/alice/roundtrip/issues/${issueNumber}`)).body.body, 'one store');
  await Promise.all(Array.from({ length: 20 }, () => request('/api/v3/repos/alice/roundtrip/issues', 'POST', { title: 'concurrent identical issue', body: 'deterministic arrival-independent payload' })));
  await Promise.all(Array.from({ length: 20 }, () => request(`/api/v3/repos/alice/roundtrip/issues/${issueNumber}`, 'PATCH', { state: 'closed' })));
  assert.equal(repo.issues.size, 21); assert.equal(repo.issueStates.closed.size, 1);
  const fetchBody = Buffer.concat([pkt('command=fetch\n'), Buffer.from('0001'), pkt(`want ${second}\n`), pkt('deepen 1\n'), pkt('done\n'), Buffer.from('0000')]);
  const clones = await Promise.all(Array.from({ length: 50 }, () => request('/alice/roundtrip.git/git-upload-pack', 'POST', fetchBody)));
  for (const result of clones) {
    assert.equal(result.status, 200);
    const packets = decode(result.body).lines, packAt = packets.findIndex(b => b.toString() === 'packfile\n');
    assert(packAt >= 0); const pack = Buffer.concat(packets.slice(packAt + 1).map(b => { assert.equal(b[0], 1); return b.subarray(1); }));
    assert.deepEqual(createHash('sha1').update(pack.subarray(0, -20)).digest(), pack.subarray(-20));
    const objects = readPack(pack); assert(objects.has(second)); assert(!objects.has(first)); assert.deepEqual(objects.get(blob).data, binary);
    for (const [sha, object] of objects) assert.equal(createHash('sha1').update(`${object.type} ${object.data.length}\0`).update(object.data).digest('hex'), sha);
    assert.deepEqual(result.body, clones[0].body);
  }
  return f;
}
test('Git REST GraphQL MCP share state during concurrent workloads', async t => { await scenario(t); });
test('full canonical state is byte-identical across two fresh servers', async t => {
  const a = await scenario(t), b = await scenario(t); const first = a.store.export(), second = b.store.export();
  assert.equal(first, second); assert.equal(createHash('sha256').update(first).digest('hex'), createHash('sha256').update(second).digest('hex'));
});
test('faulty inputs and client disconnects preserve healthy serving', async t => {
  const { request, server } = await fixture(t);
  assert.equal((await request('/api/v3/user', 'GET', undefined, false)).status, 401);
  assert.equal((await request('/api/v3/user/repos', 'POST', Buffer.from('{'))).status, 400);
  assert.equal((await request('/api/graphql', 'POST', { query: '{viewer{' })).body.data, null);
  assert.equal((await request('/mcp', 'POST', Buffer.from('{'))).body.error.code, -32700);
  assert.equal((await request('/mcp', 'POST', { jsonrpc: '2.0', id: 3, method: 'unknown' })).body.error.code, -32601);
  await request('/api/v3/user/repos', 'POST', { name: 'faults' });
  assert.equal((await request('/alice/faults.git/git-upload-pack', 'POST', Buffer.from('zzzzbad'))).status, 400);
  const socket = createConnection({ host: '127.0.0.1', port: server.address().port });
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('POST /api/v3/user/repos HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer local-test\r\nContent-Length: 100\r\n\r\n{'); socket.destroy();
  assert.equal((await request('/healthz')).status, 200);
});
test('oversized content length is refused before waiting for the body', async t => {
  const { request, server } = await fixture(t);
  const socket = createConnection({ host: '127.0.0.1', port: server.address().port });
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('POST /api/v3/user/repos HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer local-test\r\nContent-Length: 67108865\r\n\r\n');
  const response = await new Promise((resolve,reject) => {
    socket.setTimeout(1000, () => reject(new Error('server waited for an oversized body')));
    socket.once('data', resolve);
    socket.once('error', reject);
  });
  assert.match(response.toString(), /^HTTP\/1.1 413 /);
  assert.equal((await request('/healthz')).status, 200);
});
