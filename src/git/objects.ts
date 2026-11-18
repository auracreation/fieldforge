import { createHash } from 'node:crypto';

export const ZERO = '0'.repeat(40);
export const hash = data => createHash('sha1').update(data).digest('hex');
export function objectId(type, data) {
  if (!['blob','tree','commit','tag'].includes(type) || !Buffer.isBuffer(data) || data.length > 32 * 1024 * 1024) throw new Error('invalid object');
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}
export function putObject(repo, type, data) {
  const sha = objectId(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}
export function treeEntries(data) {
  const entries = [];
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(32, at), nul = data.indexOf(0, space + 1);
    if (space < at || nul < space || nul + 21 > data.length) throw new Error('malformed tree');
    const mode = data.toString('ascii', at, space), name = data.toString('utf8', space + 1, nul);
    if (!/^(40000|100644|100755|120000|160000)$/.test(mode) || !name || name.includes('/') || name === '.' || name === '..') throw new Error('invalid tree entry');
    entries.push({ mode, name, sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return entries;
}
export function commitInfo(repo, sha) {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') throw new Error('missing commit');
  const text = obj.data.toString('utf8'), split = text.indexOf('\n\n');
  if (split < 0) throw new Error('invalid commit headers');
  const lines = text.slice(0, split).split('\n');
  const trees = lines.filter(s => s.startsWith('tree ')), parents = lines.filter(s => s.startsWith('parent ')).map(s => s.slice(7));
  if (trees.length !== 1 || !/^tree [0-9a-f]{40}$/.test(trees[0]) || parents.some(p => !/^[0-9a-f]{40}$/.test(p))) throw new Error('invalid commit edges');
  return { sha, tree: trees[0].slice(5), parents, message: text.slice(split + 2).replace(/\n$/, '') };
}
function requireType(repo, sha, type) { if (repo.objects.get(sha)?.type !== type) throw new Error(`missing or invalid ${type} ${sha}`); }
export function descendants(repo, sha) {
  const obj = repo.objects.get(sha);
  if (!obj) throw new Error(`missing object ${sha}`);
  if (obj.type === 'commit') { const c = commitInfo(repo, sha); requireType(repo,c.tree,'tree'); for (const parent of c.parents) requireType(repo,parent,'commit'); return [c.tree, ...c.parents]; }
  if (obj.type === 'tree') return treeEntries(obj.data).filter(e => e.mode !== '160000').map(e => { requireType(repo,e.sha,e.mode === '40000' ? 'tree' : 'blob'); return e.sha; });
  if (obj.type === 'tag') { const match = /^object ([0-9a-f]{40})\ntype (blob|tree|commit|tag)\n/.exec(obj.data.toString()); if (!match) throw new Error('invalid tag'); requireType(repo,match[1],match[2]); return [match[1]]; }
  return [];
}
export function peel(repo, sha) {
  const seen = new Set();
  while (repo.objects.get(sha)?.type === 'tag') { if (seen.has(sha)) throw new Error('tag cycle'); seen.add(sha); [sha] = descendants(repo,sha); }
  if (!repo.objects.has(sha)) throw new Error('missing tag target');
  return sha;
}
export function validateReachable(repo, tip) {
  const trusted = repo.validated ??= new Set(), seen = new Set(), todo = [tip];
  while (todo.length) {
    const sha = todo.pop();
    if (trusted.has(sha) || seen.has(sha)) continue;
    seen.add(sha); todo.push(...descendants(repo,sha));
  }
  return seen;
}
export function reachable(repo, tips, { depth = Infinity, boundaries = new Set() } = {}) {
  const seen = new Set(), shallow = new Set(), best = new Map(), queue = tips.map(sha => [sha, depth]);
  while (queue.length) {
    const [sha, left] = queue.pop();
    if ((best.get(sha) ?? -1) >= left) continue;
    best.set(sha, left); seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) throw new Error(`missing object ${sha}`);
    if (obj.type === 'commit') {
      const c = commitInfo(repo, sha); descendants(repo,sha); queue.push([c.tree, Infinity]);
      if (left <= 1 || boundaries.has(sha)) { if (c.parents.length) shallow.add(sha); }
      else { shallow.delete(sha); for (const p of c.parents) queue.push([p, left - 1]); }
    } else for (const child of descendants(repo, sha)) queue.push([child, left]);
  }
  return { seen, shallow };
}
export function ancestor(repo, old, next) {
  const seen = new Set(), todo = [next];
  while (todo.length) { const sha = todo.pop(); if (sha === old) return true; if (seen.has(sha)) continue; seen.add(sha); const o = repo.objects.get(sha); if (o?.type === 'commit') todo.push(...commitInfo(repo, sha).parents); }
  return false;
}
export function filesAt(repo, sha) {
  const files = new Map();
  if (!sha) return files;
  const root = commitInfo(repo, sha).tree, todo = [[root, '', 0]];
  while (todo.length) {
    const [tree, prefix, depth] = todo.pop();
    if (depth > 128) throw new Error('tree nesting limit');
    const obj = repo.objects.get(tree); if (obj?.type !== 'tree') throw new Error('missing tree');
    for (const e of treeEntries(obj.data)) {
      if (e.mode === '40000') todo.push([e.sha, prefix + e.name + '/', depth + 1]);
      else files.set(prefix + e.name, { sha: e.sha, mode: e.mode });
    }
  }
  return files;
}
export function writeTree(repo, files) {
  const root = new Map();
  for (const [path, file] of files) {
    let node = root; const parts = path.split('/');
    for (const part of parts.slice(0, -1)) { if (!node.has(part)) node.set(part, new Map()); const next = node.get(part); if (!(next instanceof Map)) throw new Error('file/directory collision'); node = next; }
    if (node.get(parts.at(-1)) instanceof Map) throw new Error('directory/file collision');
    node.set(parts.at(-1), file);
  }
  function encode(node) {
    const entries = [...node].map(([name, value]) => value instanceof Map ? { name, mode: '40000', sha: encode(value) } : { name, ...value });
    entries.sort((a,b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    return putObject(repo, 'tree', Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')]))));
  }
  return encode(root);
}
export function writeCommit(repo, tree, parents, message) {
  const identity = 'Forge <forge@example.invalid> 1735689600 +0000';
  return putObject(repo, 'commit', Buffer.from(`tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${message}\n`));
}
