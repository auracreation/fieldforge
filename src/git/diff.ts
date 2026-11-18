import { HttpError } from '../storage/store.ts';
export function lineChanges(before, after) {
  if (before.includes(0) || after.includes(0)) return { additions: 0, deletions: 0 };
  const a=before.toString().match(/[^\n]*\n|[^\n]+$/g) ?? [],b=after.toString().match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let prefix=0;while(prefix<a.length && prefix<b.length && a[prefix]===b[prefix])prefix++;
  let endA=a.length,endB=b.length;while(endA>prefix && endB>prefix && a[endA-1]===b[endB-1]){endA--;endB--;}
  const n=endA-prefix,m=endB-prefix;
  if(!n||!m)return {additions:m,deletions:n};
  const max=n+m,offset=max+1,frontier=new Int32Array(2*max+3);frontier.fill(-1);frontier[offset+1]=0;
  let steps=0;
  for(let d=0;d<=max;d++)for(let k=-d;k<=d;k+=2){
    if(++steps>1000000)throw new HttpError(422,'Diff complexity limit');
    let x=(k===-d || (k!==d && frontier[offset+k-1]<frontier[offset+k+1]))?frontier[offset+k+1]:frontier[offset+k-1]+1;
    let y=x-k;while(x<n && y<m && a[prefix+x]===b[prefix+y]){x++;y++;}
    frontier[offset+k]=x;
    if(x>=n && y>=m){const common=(n+m-d)/2;return {additions:m-common,deletions:n-common};}
  }
  throw new Error('Diff failed');
}
