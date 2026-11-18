import { need, HttpError, record } from '../storage/store.ts';
import { commitInfo, validateReachable } from '../git/objects.ts';
import { validRef } from '../git/refs.ts';
export function rest(store,method,url,body) {
  if (['POST','PUT','PATCH'].includes(method)) record(body);
  const parts=[],q=url.searchParams;
  for (const part of url.pathname.slice(7).split('/')) if (part) parts.push(part.includes('%') ? decodeURIComponent(part) : part);
  const ok=(body,status=200,headers={})=>({status,body,headers});
  function page(items) {
    const size=Math.min(100,Math.max(1,Number(q.get('per_page')) || 30)),n=Math.max(1,Number(q.get('page')) || 1),start=(n-1)*size,headers={};
    if(start+size<items.length) { const next=new URL(url);next.searchParams.set('page',String(n+1));headers.link=`<${next.href}>; rel="next"`; }
    return ok(items.slice(start,start+size),200,headers);
  }
  if(!parts.length && method==='GET')return ok({current_user_url:'/api/v3/user' },200,{'x-oauth-scopes':'repo, read:org'});
  if(parts[0]==='meta' && method==='GET')return ok({installed_version:'forge-1.0'});
  if(parts[0]==='user' && parts.length===1 && method==='GET')return ok(store.user());
  if((parts[0]==='user' && parts[1]==='repos') || (parts[0]==='users' && parts[2]==='repos')) {
    if(method==='POST' && parts[0]==='user')return ok(store.repoJson(store.createRepo(body)),201);
    if(method==='GET')return page([...store.repos.values()].filter(r=>parts[0]==='user'||r.owner.login===parts[1]).map(r=>store.repoJson(r)));
  }
  if(parts[0]!=='repos' || parts.length<3)throw new HttpError(404,'Not Found');
  const r=store.repo(parts[1],parts[2]),tail=parts.slice(3),[resource,n,action]=tail;
  if(!resource) {
    if(method==='GET')return ok(store.repoJson(r));
    if(method==='PATCH') { if('description' in body) {need(typeof body.description==='string',422,'Invalid description');r.description=body.description;}return ok(store.repoJson(r)); }
    if(method==='DELETE') {store.repos.delete(r.name);for(const [id,v] of store.ids)if(v.value===r || v.value.repo===r || v.repo===r)store.ids.delete(id);return ok(null,204);}
  }
  if(resource==='contents') {
    const path=tail.slice(1).join('/');
    if(method==='GET')return ok(store.content(r,path,q.get('ref') ?? undefined));
    if(method==='PUT' || method==='DELETE') {const result=store.writeFile(r,path,body,method==='DELETE');return ok(result,method==='DELETE'?200:result.created?201:200);}
  }
  if(resource==='git' && n==='refs') {
    if(method==='POST') {need(validRef(body.ref) && r.objects.has(body.sha) && (!body.ref.startsWith('refs/heads/') || r.objects.get(body.sha).type==='commit'),422,'Invalid ref');need(!r.refs.has(body.ref),422,'Reference already exists');try{validateReachable(r,body.sha);}catch{throw new HttpError(422,'Invalid object graph');}r.refs.set(body.ref,body.sha);return ok({ref:body.ref,object:{sha:body.sha,type:r.objects.get(body.sha).type}},201);}
    if(method==='GET') {const ref='refs/'+tail.slice(2).join('/');return ok({ref,object:{sha:need(r.refs.get(ref)),type:'commit'}});}
  }
  if(resource==='branches' && method==='GET') {
    const list=[...r.refs].filter(([ref])=>ref.startsWith('refs/heads/')).map(([ref,sha])=>({name:ref.slice(11),commit:{sha}}));
    return n?ok(need(list.find(b=>b.name===tail.slice(1).join('/')))):page(list);
  }
  if(resource==='commits' && method==='GET') {
    const sha=store.resolve(r,n ?? q.get('sha') ?? undefined); if(!sha)return n?ok(need(null)):ok([]);
    const list=[],todo=[sha],seen=new Set();while(todo.length) {const current=todo.shift();if(seen.has(current))continue;seen.add(current);const c=commitInfo(r,current);list.push({sha:current,commit:{message:c.message,tree:{sha:c.tree}},parents:c.parents.map(sha=>({sha}))});todo.push(...c.parents);}
    return n?ok(list[0]):page(list);
  }
  if(resource==='labels') {
    if(method==='POST') {need(typeof body.name==='string'&&body.name,422,'Label name required');const label={id:++store.sequence,name:body.name,color:body.color ?? 'ededed'};r.labels.set(label.name,label);return ok(label,201);}
    if(method==='GET')return page([...r.labels.values()]);
  }
  if(resource==='issues') {
    if(!n) {
      if(method==='POST')return ok(store.issueJson(store.createIssue(r,body)),201);
      if(method==='GET') return page(store.listIssues(r,q.get('state') ?? 'open',q.get('direction') ?? 'desc').map(i=>store.issueJson(i)));
    }
    const i=need(r.issues.get(Number(n)));
    if(action==='comments') {if(method==='POST')return ok(store.comment(i,body.body),201);if(method==='GET')return page(i.comments);}
    if(!action && method==='GET')return ok(store.issueJson(i));
    if(!action && method==='PATCH')return ok(store.issueJson(store.updateIssue(i,body)));
  }
  if(resource==='pulls') {
    if(!n) {if(method==='POST')return ok(store.pullJson(store.createPull(r,body)),201);if(method==='GET')return page([...r.pulls.values()].filter(p=>q.get('state')==='all'||p.state===(q.get('state') ?? 'open')).map(p=>store.pullJson(p)));}
    const p=need(r.pulls.get(Number(n)));
    if(action==='merge' && method==='PUT')return ok(store.mergePull(p));
    if(action==='files' && method==='GET')return page(store.pullFiles(p));
    if(!action && method==='GET')return ok(store.pullJson(p));
    if(!action && method==='PATCH') {
      if('title' in body)need(typeof body.title==='string' && body.title.trim(),422,'Invalid title');
      if('body' in body)need(typeof body.body==='string',422,'Invalid body');
      if('state' in body)need(['open','closed'].includes(body.state) && !(p.merged && body.state==='open'),422,'Invalid pull state');
      for(const k of ['title','body','state'])if(k in body)p[k]=body[k];return ok(store.pullJson(p));
    }
  }
  throw new HttpError(404,'Not Found');
}
