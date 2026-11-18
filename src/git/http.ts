import { ZERO, ancestor, reachable, peel, validateReachable } from './objects.ts';
import { readPack, writePack } from './pack.ts';
import { validRef } from './refs.ts';
export function pkt(data) { const b = Buffer.isBuffer(data) ? data : Buffer.from(data); if (b.length > 65516) throw new Error('pkt size'); return Buffer.concat([Buffer.from((b.length+4).toString(16).padStart(4,'0')),b]); }
const FLUSH = Buffer.from('0000'), DELIM = Buffer.from('0001');
export function decode(bytes, stopAtFlush = false) {
  const lines = []; let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length || !/^[0-9a-fA-F]{4}$/.test(bytes.toString('ascii',at,at+4))) throw new Error('invalid pkt-line');
    const n = parseInt(bytes.toString('ascii',at,at+4),16); at += 4;
    if (n < 4) { if (n > 2) throw new Error('invalid control'); if (n === 0 && stopAtFlush) break; continue; }
    if (n > 65520 || at + n - 4 > bytes.length) throw new Error('truncated pkt-line');
    lines.push(bytes.subarray(at,at+n-4)); at += n - 4;
  }
  return { lines, at };
}
function bands(bytes) { const out = []; for (let at=0;at<bytes.length;at+=65515) out.push(pkt(Buffer.concat([Buffer.from([1]),bytes.subarray(at,at+65515)]))); return out; }
export function gitHttp(repo, path, method, url, headers, body) {
  const service = path === 'info/refs' ? url.searchParams.get('service') : path;
  if (!['git-upload-pack','git-receive-pack'].includes(service)) return { status:404,body:{message:'Not Found'} };
  const result = bytes => ({ status:200,headers:{'content-type':`application/x-${service}-${path==='info/refs'?'advertisement':'result'}`,'cache-control':'no-cache'},body:bytes });
  const v2 = headers['git-protocol']?.includes('version=2');
  if (path === 'info/refs' && method === 'GET') {
    if (service === 'git-upload-pack' && v2) return result(Buffer.concat([pkt('version 2\n'),pkt('ls-refs=unborn\n'),pkt('fetch=shallow\n'),pkt('object-format=sha1\n'),FLUSH]));
    const refs = [...repo.refs].sort(([a],[b])=>a.localeCompare(b));
    if (service === 'git-upload-pack' && repo.refs.has(`refs/heads/${repo.default_branch}`)) refs.unshift(['HEAD',repo.refs.get(`refs/heads/${repo.default_branch}`)]);
    const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta' : `multi_ack_detailed side-band-64k shallow ofs-delta symref=HEAD:refs/heads/${repo.default_branch}`;
    if (!refs.length) refs.push(['capabilities^{}',ZERO]);
    return result(Buffer.concat([pkt(`# service=${service}\n`),FLUSH,...refs.map(([ref,sha],i)=>pkt(`${sha} ${ref}${i===0?'\0'+caps:''}\n`)),FLUSH]));
  }
  if (method !== 'POST') return {status:405,body:{message:'Method Not Allowed'}};
  if (service === 'git-receive-pack') {
    const {lines,at} = decode(body,true); const commands = [], statuses = [];
    const caps = lines[0]?.toString().split('\0')[1] ?? '';
    for (const line of lines) { const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) ([^\0\n]+)(?:\0.*)?\n?$/.exec(line.toString()); if (!match) throw new Error('invalid ref command'); commands.push({old:match[1],next:match[2],ref:match[3]}); }
    let unpack = 'ok', incoming;
    try { incoming = at < body.length ? readPack(body.subarray(at),repo.objects) : new Map(); } catch (e) { unpack = 'error '+e.message; incoming = new Map(); }
    repo.validated ??= new Set();
    const view = { ...repo, objects:{get:sha=>incoming.get(sha) ?? repo.objects.get(sha),has:sha=>incoming.has(sha)||repo.objects.has(sha)} };
    for (const cmd of commands) {
      let error, verified = new Set();
      if (unpack !== 'ok') error = 'unpacker error';
      else if (!validRef(cmd.ref)) error = 'invalid ref';
      else if ((repo.refs.get(cmd.ref) ?? ZERO) !== cmd.old) error = 'stale old value';
      else if (cmd.next !== ZERO) {
        try { verified = validateReachable(view,cmd.next); if (cmd.ref.startsWith('refs/heads/') && view.objects.get(cmd.next)?.type !== 'commit') error = 'invalid commit'; } catch { error = 'missing object'; }
        if (!error && cmd.old !== ZERO && cmd.ref.startsWith('refs/heads/') && !ancestor(view,cmd.old,cmd.next)) error = 'non-fast-forward';
      }
      if (!error) {
        for (const [sha,o] of incoming) if(!repo.objects.has(sha))repo.objects.set(sha,o);
        // Trust only committed objects; rejected pushes must never populate the validation cache.
        if(repo.validated.size+verified.size>8192)repo.validated.clear();
        for(const sha of [...verified].slice(-8192))repo.validated.add(sha);
        if (cmd.next === ZERO) repo.refs.delete(cmd.ref); else repo.refs.set(cmd.ref,cmd.next);
      }
      statuses.push(error ? `ng ${cmd.ref} ${error}\n` : `ok ${cmd.ref}\n`);
    }
    const report = Buffer.concat([pkt(`unpack ${unpack}\n`),...statuses.map(pkt),FLUSH]);
    return result(caps.includes('side-band-64k') ? Buffer.concat([...bands(report),FLUSH]) : report);
  }
  const lines = decode(body).lines.map(b=>b.toString().trim());
  if (lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(s=>s.startsWith('ref-prefix ')).map(s=>s.slice(11));
    const refs = [...repo.refs].sort(([a],[b])=>a.localeCompare(b)); const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
    if (head) refs.unshift(['HEAD',head]);
    const answer = refs.filter(([ref])=>!prefixes.length || prefixes.some(p=>ref.startsWith(p))).map(([ref,sha])=> {
      const o = repo.objects.get(sha), peeled = o?.type==='tag' ? peel(repo,sha) : null;
      return pkt(`${sha} ${ref}${ref==='HEAD'?` symref-target:refs/heads/${repo.default_branch}`:''}${peeled?' peeled:'+peeled:''}\n`);
    });
    if (!head && lines.includes('unborn') && (!prefixes.length || prefixes.some(p=>'HEAD'.startsWith(p)))) answer.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    return result(Buffer.concat([...answer,FLUSH]));
  }
  if (v2 && !lines.includes('command=fetch')) throw new Error('unsupported git command');
  const wants = lines.filter(s=>s.startsWith('want ')).map(s=>s.split(' ')[1]), haves = lines.filter(s=>s.startsWith('have ')).map(s=>s.split(' ')[1]);
  const boundaries = new Set(lines.filter(s=>s.startsWith('shallow ')).map(s=>s.slice(8)));
  const deepen = lines.find(s=>s.startsWith('deepen ')), depth = deepen ? Number(deepen.slice(7)) : Infinity;
  if (!wants.length || !(depth > 0)) throw new Error('invalid fetch');
  const wanted = reachable(repo,wants,{depth}), held = reachable(repo,haves.filter(s=>repo.objects.has(s)),{boundaries});
  const pack = writePack([...wanted.seen].filter(sha=>!held.seen.has(sha)).map(sha=>repo.objects.get(sha)));
  const shallow = [...wanted.shallow].map(sha=>pkt(`shallow ${sha}\n`));
  for (const sha of boundaries) if (wanted.seen.has(sha) && !wanted.shallow.has(sha)) shallow.push(pkt(`unshallow ${sha}\n`));
  return result(Buffer.concat(v2 ? [...(shallow.length?[pkt('shallow-info\n'),...shallow,DELIM]:[]),pkt('packfile\n'),...bands(pack),FLUSH] : [...shallow,...(shallow.length?[FLUSH]:[]),pkt('NAK\n'),...bands(pack),FLUSH]));
}
