import { putObject, filesAt, writeTree, writeCommit, commitInfo, treeEntries } from '../git/objects.ts';
import { validRef } from '../git/refs.ts';
import { lineChanges } from '../git/diff.ts';

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function need(value, status = 404, message = 'Not Found') { if (!value) throw new HttpError(status,message); return value; }
export function record(input) { need(input && typeof input === 'object' && !Array.isArray(input),422,'Expected an object'); return input; }
export const gid = (type,id) => Buffer.from(`${type}:${id}`).toString('base64url');
const STAMP = '2025-01-01T00:00:00Z';
export class Store {
  constructor(login = process.env.FORGE_USER || '') { this.login = login; this.repos = new Map(); this.ids = new Map(); this.sequence = 0; }
  id(type, value) { const id = gid(type,++this.sequence); this.ids.set(id,{type,value}); return id; }
  user() { return { id:1,login:this.login || 'forge', type:'User' }; }
  bind(owner) {
    // The runner supplies one opaque token without an account identity; the first addressed repo establishes its namespace.
    if (!this.login) { this.login = owner; for (const r of this.repos.values()) r.owner.login = owner; }
  }
  repo(owner,name) { const r = need(this.repos.get(name)); this.bind(owner); need(owner === this.login); return r; }
  createRepo(input) {
    record(input);
    need(input.private === undefined || typeof input.private === 'boolean',422,'Invalid private flag');
    need(input.description == null || typeof input.description === 'string',422,'Invalid description');
    need(input && typeof input.name === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(input.name),422,'Invalid repository name');
    need(!this.repos.has(input.name),422,'Repository already exists');
    const r = {id:++this.sequence,name:input.name,description:input.description || '',private:input.private ?? false,owner:this.user(),default_branch:'main',objects:new Map(),refs:new Map(),issues:new Map(),issueStates:{open:new Set(),closed:new Set()},pulls:new Map(),labels:new Map(),nextNumber:1};
    r.node_id = this.id('Repository',r); this.repos.set(r.name,r); return r;
  }
  repoJson(r) { return {id:r.id,node_id:r.node_id,name:r.name,full_name:`${r.owner.login}/${r.name}`,owner:r.owner,description:r.description,private:r.private,default_branch:r.default_branch,has_issues:true}; }
  resolve(r, ref = r.default_branch) { return r.refs.get(ref) ?? r.refs.get('refs/heads/'+ref) ?? r.refs.get('refs/tags/'+ref) ?? (r.objects.has(ref)?ref:null); }
  content(r,path,ref) {
    const sha = need(this.resolve(r,ref)); let tree = commitInfo(r,sha).tree, entry;
    const parts = path ? path.replace(/\/$/,'').split('/') : [];
    for (let i=0;i<parts.length;i++) {
      entry = need(treeEntries(need(r.objects.get(tree)).data).find(e=>e.name===parts[i]));
      if (i<parts.length-1) need(entry.mode==='40000');
      tree=entry.sha;
    }
    if (entry && entry.mode!=='40000') { const data = need(r.objects.get(entry.sha)).data; return {type:'file',name:entry.name,path,sha:entry.sha,size:data.length,encoding:'base64',content:data.toString('base64')}; }
    const prefix = parts.length ? parts.join('/')+'/' : '';
    return treeEntries(need(r.objects.get(tree)).data).map(e=>({type:e.mode==='40000'?'dir':'file',name:e.name,path:prefix+e.name,sha:e.sha}));
  }
  writeFile(r,path,input,remove = false) {
    record(input);
    need(typeof path === 'string' && path.length && path.split('/').every(p=>p && p!=='.' && p!=='..') && !path.includes('\0'),422,'Invalid path');
    need(input && typeof input.message === 'string',422,'Missing commit message');
    const branch = input.branch ?? r.default_branch, ref = 'refs/heads/'+branch, previous = r.refs.get(ref);
    need(validRef(ref),422,'Invalid branch');
    if (!previous && r.refs.size) throw new HttpError(404,'Branch not found');
    const files = filesAt(r,previous), old = files.get(path);
    need(![...files.keys()].some(p=>p.startsWith(path+'/') || path.startsWith(p+'/')),422,'File/directory collision');
    if (remove) need(old,404);
    if (old) need(input.sha === old.sha,409,'File SHA does not match');
    else need(!input.sha,409,'File does not exist');
    let sha;
    if (remove) files.delete(path);
    else {
      need(typeof input.content === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content.replace(/\s/g,'')),422,'Invalid base64 content');
      sha = putObject(r,'blob',Buffer.from(input.content,'base64')); files.set(path,{sha,mode:old?.mode ?? '100644'});
    }
    let tree;
    try { tree=writeTree(r,files); } catch(e) { throw new HttpError(422,e.message); }
    const commit = writeCommit(r,tree,previous?[previous]:[],input.message); r.refs.set(ref,commit);
    return {content:remove?null:{...this.content(r,path,branch),encoding:'base64'},commit:{sha:commit},created:!old};
  }
  createIssue(r,input) {
    record(input);
    need(input && typeof input.title === 'string' && input.title.trim(),422,'Title is required');
    need(input.body == null || typeof input.body === 'string',422,'Invalid body');
    const names = input.labels ?? []; need(Array.isArray(names) && names.every(n=>typeof n==='string' && r.labels.has(n)),422,'Unknown label');
    const issue = {id:++this.sequence,number:r.nextNumber++,title:input.title,body:input.body ?? '',state:'open',labels:names.map(n=>r.labels.get(n)),user:this.user(),created_at:STAMP,updated_at:STAMP,closed_at:null,comments:[],repo:r};
    issue.node_id=this.id('Issue',issue); r.issues.set(issue.number,issue); r.issueStates.open.add(issue.number); return issue;
  }
  listIssues(r,state='open',direction='desc') { need(['all','open','closed'].includes(state),422,'Invalid issue state'); const numbers=state==='all'?[...r.issues.keys()]:[...r.issueStates[state]];numbers.sort((a,b)=>direction==='asc'?a-b:b-a);return numbers.map(n=>r.issues.get(n)); }
  issueJson(i) { return {id:i.id,number:i.number,title:i.title,body:i.body,state:i.state,labels:i.labels,user:i.user,created_at:i.created_at,updated_at:i.updated_at,closed_at:i.closed_at,node_id:i.node_id,comments:i.comments.length}; }
  updateIssue(i,input) {
    record(input);
    if ('state' in input) need(['open','closed'].includes(input.state),422,'Invalid issue state');
    if ('title' in input) need(typeof input.title==='string' && input.title.trim(),422,'Title is required');
    if ('body' in input) need(typeof input.body==='string',422,'Invalid body');
    if ('labels' in input) need(Array.isArray(input.labels) && input.labels.every(n=>i.repo.labels.has(n)),422,'Unknown label');
    if ('state' in input) { i.repo.issueStates[i.state].delete(i.number); i.repo.issueStates[input.state].add(i.number); }
    for (const k of ['title','body','state']) if (k in input) i[k]=input[k];
    if ('labels' in input) i.labels=input.labels.map(n=>i.repo.labels.get(n));
    i.closed_at=i.state==='closed'?STAMP:null; return i;
  }
  comment(i,body) { need(typeof body==='string' && body.trim(),422,'Comment body required'); const c={id:++this.sequence,body,user:this.user(),created_at:STAMP,updated_at:STAMP}; c.node_id=this.id('IssueComment',c); i.comments.push(c); this.ids.get(c.node_id).repo=i.repo; return c; }
  createPull(r,input) {
    record(input); need(input.body == null || typeof input.body === 'string',422,'Invalid body');
    need(input && typeof input.title==='string' && input.title.trim(),422,'Title required');
    need(typeof input.head==='string' && typeof input.base==='string' && input.head!==input.base,422,'Invalid pull refs');
    const head=need(this.resolve(r,input.head),422,'Unknown head'), base=need(this.resolve(r,input.base),422,'Unknown base');
    const p={id:++this.sequence,number:r.nextNumber++,state:'open',title:input.title,body:input.body ?? '',head:{ref:input.head,sha:head},base:{ref:input.base,sha:base},merged:false,merged_at:null,merge_commit_sha:null,repo:r,created_at:STAMP};
    p.node_id=this.id('PullRequest',p); r.pulls.set(p.number,p); return p;
  }
  pullJson(p) { const {repo,...out}=p;return {...out,head:{...p.head,sha:this.resolve(repo,p.head.ref) ?? p.head.sha},base:{...p.base,sha:this.resolve(repo,p.base.ref) ?? p.base.sha}}; }
  mergeBase(r,a,b) {
    const seen=new Set(),todo=[a]; while(todo.length) { const sha=todo.pop(); if(seen.has(sha))continue; seen.add(sha); todo.push(...commitInfo(r,sha).parents); }
    const visited=new Set(),other=[b]; for(let at=0;at<other.length;at++) { const sha=other[at]; if(seen.has(sha))return sha; if(visited.has(sha))continue; visited.add(sha); other.push(...commitInfo(r,sha).parents); } return null;
  }
  pullFiles(p) {
    const r=p.repo,head=this.resolve(r,p.head.ref),base=this.resolve(r,p.base.ref),common=this.mergeBase(r,head,base);
    const before=filesAt(r,common), after=filesAt(r,head), changed=[];
    for(const path of new Set([...before.keys(),...after.keys()])) {
      const a=before.get(path),b=after.get(path); if(a?.sha===b?.sha)continue;
      const {additions,deletions}=lineChanges(a?r.objects.get(a.sha).data:Buffer.alloc(0),b?r.objects.get(b.sha).data:Buffer.alloc(0));
      changed.push({filename:path,status:!a?'added':!b?'removed':'modified',additions,deletions,changes:additions+deletions,sha:b?.sha ?? a.sha});
    }
    return changed.sort((a,b)=>a.filename.localeCompare(b.filename));
  }
  mergePull(p) {
    need(p.state==='open' && !p.merged,405,'Pull request is not open');
    const r=p.repo,head=need(this.resolve(r,p.head.ref)),base=need(this.resolve(r,p.base.ref)),common=this.mergeBase(r,head,base);
    const before=filesAt(r,common),after=filesAt(r,head),merged=filesAt(r,base);
    for(const path of new Set([...before.keys(),...after.keys()])) {
      const old=before.get(path),next=after.get(path),current=merged.get(path); if(old?.sha===next?.sha)continue;
      need(current?.sha===old?.sha || current?.sha===next?.sha,405,'Pull request is not mergeable');
      if(next)merged.set(path,next);else merged.delete(path);
    }
    const sha=writeCommit(r,writeTree(r,merged),[base],p.title); r.refs.set('refs/heads/'+p.base.ref,sha);
    p.state='closed';p.merged=true;p.merged_at=STAMP;p.merge_commit_sha=sha;
    return {merged:true,sha,message:'Pull request successfully merged'};
  }
  export() {
    const rows=[...this.repos.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(r=>({
      repository:this.repoJson(r),refs:[...r.refs].sort(),objects:[...r.objects].sort(([a],[b])=>a.localeCompare(b)).map(([sha,o])=>({sha,type:o.type,data:o.data.toString('base64')})),
      issues:[...r.issues.values()].sort((a,b)=>a.number-b.number).map(i=>({...this.issueJson(i),comments:[...i.comments].sort((a,b)=>a.id-b.id)})),pulls:[...r.pulls.values()].sort((a,b)=>a.number-b.number).map(p=>this.pullJson(p)),labels:[...r.labels.values()].sort((a,b)=>a.name.localeCompare(b.name))
    })); return JSON.stringify(rows);
  }
}
