import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { putObject, writeTree, writeCommit, reachable, ZERO } from '../src/git/objects.ts';
import { gitHttp, pkt, decode } from '../src/git/http.ts';
import { writePack, readPack, applyDelta } from '../src/git/pack.ts';
const fresh = () => ({ objects: new Map(), refs: new Map(), default_branch: 'main' });
const sha1 = b => createHash('sha1').update(b).digest();
function chain() { const r = fresh(), tree = writeTree(r, new Map()); const a = writeCommit(r, tree, [], 'one'), b = writeCommit(r, tree, [a], 'two'), c = writeCommit(r, tree, [b], 'three'); return { r, a, b, c }; }
function push(r, objects, next, old = ZERO, ref = 'refs/heads/main') {
  const body = Buffer.concat([pkt(`${old} ${next} ${ref}\0report-status\n`), Buffer.from('0000'), writePack(objects)]);
  return decode(gitHttp(r, 'git-receive-pack', 'POST', new URL('http://localhost'), {}, body).body).lines.map(b => b.toString()).join('');
}
test('nested annotated tags peel fully', () => {
  const { r, c } = chain();
  const inner = putObject(r, 'tag', Buffer.from(`object ${c}\ntype commit\ntag inner\n\ninner\n`));
  const outer = putObject(r, 'tag', Buffer.from(`object ${inner}\ntype tag\ntag outer\n\nouter\n`)); r.refs.set('refs/tags/outer', outer);
  const request = Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0001'), pkt('peel\n'), Buffer.from('0000')]);
  const result = gitHttp(r, 'git-upload-pack', 'POST', new URL('http://localhost'), { 'git-protocol': 'version=2' }, request);
  const line = decode(result.body).lines.map(b => b.toString()).find(s => s.includes('refs/tags/outer'));
  assert.match(line, new RegExp(`${outer} refs/tags/outer peeled:${c}`));
});
test('multi-tip shallow boundaries do not depend on want ordering', () => {
  const { r, a, b, c } = chain();
  for (const tips of [[b, c], [c, b]]) { const result = reachable(r, tips, { depth: 2 }); assert(result.seen.has(a)); assert(!result.shallow.has(b)); }
});
test('push rejects wrong object types in commit edges without moving ref', () => {
  const { r, a } = chain(); r.refs.set('refs/heads/main', a);
  const data = Buffer.from(`tree ${a}\nparent ${a}\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\ninvalid\n`);
  const next = createHash('sha1').update(`commit ${data.length}\0`).update(data).digest('hex');
  assert.match(push(r, [{ type: 'commit', data }], next, a), /ng refs\/heads\/main/); assert.equal(r.refs.get('refs/heads/main'), a);
});
test('binary pack roundtrip uses canonical SHA and catches corruption', () => {
  const data = Buffer.from([0, 255, 128, 13, 10, 0, 42]); const pack = writePack([{ type: 'blob', data }]);
  assert.equal(pack.toString('ascii', 0, 4), 'PACK'); assert.equal(pack.readUInt32BE(8), 1);
  assert.deepEqual(pack.subarray(-20), sha1(pack.subarray(0, -20)));
  const expected = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  assert.deepEqual(readPack(pack).get(expected).data, data);
  const corrupt = Buffer.from(pack); corrupt[13] ^= 1; assert.throws(() => readPack(corrupt), /checksum/);
  assert.throws(() => readPack(pack.subarray(0, -2)));
});
test('pack resolves REF_DELTA and OFS_DELTA and rejects unresolved references', () => {
  const base = Buffer.from('hello'), delta = Buffer.from([5, 6, 0x90, 5, 1, 33]);
  assert.equal(applyDelta(base, delta).toString(), 'hello!');
  const id = createHash('sha1').update('blob 5\0').update(base).digest();
  const first = Buffer.concat([Buffer.from([0x35]), deflateSync(base)]);
  for (const type of [6, 7]) {
    const prefix = Buffer.alloc(12); prefix.write('PACK'); prefix.writeUInt32BE(2, 4); prefix.writeUInt32BE(2, 8);
    const reference = type === 6 ? Buffer.from([first.length]) : id;
    const bytes = Buffer.concat([prefix, first, Buffer.from([(type << 4) | delta.length]), reference, deflateSync(delta)]);
    const objects = readPack(Buffer.concat([bytes, sha1(bytes)])); assert.equal(objects.size, 2); assert([...objects.values()].some(o => o.data.toString() === 'hello!'));
  }
  assert.throws(() => applyDelta(base, Buffer.from([5, 1, 0x90, 5])), /bounds/);
  const prefix = Buffer.alloc(12); prefix.write('PACK'); prefix.writeUInt32BE(2, 4); prefix.writeUInt32BE(1, 8);
  const bad = Buffer.concat([prefix, Buffer.from([0x76]), Buffer.alloc(20, 1), deflateSync(delta)]);
  assert.throws(() => readPack(Buffer.concat([bad, sha1(bad)])), /unresolved/);
});
test('malformed pkt lines and invalid refs leave repository healthy', () => {
  const { r, a } = chain(); r.refs.set('refs/heads/main', a);
  assert.throws(() => decode(Buffer.from('zzzzbad')));
  assert.throws(() => decode(Buffer.from('0010x')));
  assert.match(push(r, [], a, ZERO, 'refs/heads/../escape'), /ng /); assert.equal(r.refs.size, 1);
});
test('aggregate pack limit accounts for expanded deltas', () => {
  const base = Buffer.alloc(2 * 1024 * 1024, 65), length = Buffer.from([128, 128, 128, 1]);
  const delta = Buffer.concat([length, length, Buffer.from([0xc0, 0x20])]);
  const id = createHash('sha1').update(`blob ${base.length}\0`).update(base).digest();
  const prefix = Buffer.alloc(12); prefix.write('PACK'); prefix.writeUInt32BE(2, 4); prefix.writeUInt32BE(66, 8);
  const entries = [Buffer.from([0xb0, 0x80, 0x80, 8]), deflateSync(base)];
  for (let i = 0; i < 65; i++) entries.push(Buffer.from([0x70 | delta.length]), id, deflateSync(delta));
  const bytes = Buffer.concat([prefix, ...entries]);
  assert.throws(() => readPack(Buffer.concat([bytes, sha1(bytes)])), /expanded size limit/);
});
test('rejected push cannot prime trust for objects that were never stored', () => {
  const { r, a, c } = chain(); r.refs.set('refs/heads/main', c);
  const staged = { objects: new Map(r.objects) }, blob = putObject(staged, 'blob', Buffer.from('rejected bytes'));
  const tree = writeTree(staged, new Map([['new.txt', {sha:blob,mode:'100644'}]])), next = writeCommit(staged,tree,[a],'divergent');
  const incoming = [...staged.objects].filter(([sha])=>!r.objects.has(sha)).map(([,o])=>o);
  assert.match(push(r,incoming,next,c),/non-fast-forward/); assert(!r.objects.has(tree));
  assert.match(push(r,[staged.objects.get(next)],next,ZERO,'refs/heads/missing-objects'),/ng /);
  assert(!r.refs.has('refs/heads/missing-objects'));
});
test('large packs remain canonical across compressed-cache turnover', () => {
  const objects = Array.from({length:6},()=>({type:'blob',data:randomBytes(2*1024*1024)}));
  const first=writePack(objects),again=writePack(objects);
  assert.deepEqual(again,first);
  const decoded=readPack(again);
  for(const o of objects)assert.deepEqual(decoded.get(createHash('sha1').update(`blob ${o.data.length}\0`).update(o.data).digest('hex')).data,o.data);
  const big={type:'blob',data:randomBytes(9*1024*1024)};
  assert.deepEqual(readPack(writePack([big])).values().next().value.data,big.data);
});
test('pack inflation preserves empty and slab-boundary objects and size validation', () => {
  for (const size of [0, 1, 63, 64, 65, 16383, 16384, 16385]) {
    const data = randomBytes(size), pack = writePack([{ type: 'blob', data }]);
    assert.deepEqual([...readPack(pack).values()][0].data, data);
  }
  const prefix = Buffer.alloc(12); prefix.write('PACK'); prefix.writeUInt32BE(2, 4); prefix.writeUInt32BE(1, 8);
  const bytes = Buffer.concat([prefix, Buffer.from([0x30]), deflateSync(Buffer.from('x'))]);
  assert.throws(() => readPack(Buffer.concat([bytes, sha1(bytes)])), /pack object size/);
});

test('small decoded blobs do not retain default inflate slabs', () => {
  const data = Buffer.alloc(100, 65);
  const decoded = [...readPack(writePack([{type:'blob',data}])).values()][0].data;
  assert.deepEqual(decoded, data);
  assert(decoded.buffer.byteLength < 16384);
});
