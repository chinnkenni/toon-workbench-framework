/** Same-origin JSON transport. Raw media uploads remain with the media editor. */
export async function api(path,body){
 const response=await fetch(path,{
  method:body===undefined?'GET':'POST',
  credentials:'same-origin',
  cache:'no-store',
  headers:body===undefined?{Accept:'application/json'}:{Accept:'application/json','Content-Type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
 });
 let value;try{value=await response.json();}catch{throw Object.assign(new Error('本机服务未返回有效结果，请检查连接后重试。'),{status:response.status});}
 if(!response.ok)throw Object.assign(new Error(value.error||'操作未完成，请稍后重试。'),{status:response.status});
 return value;
}

/** Keep unchanged work identities so polling cannot remount a playing editor. */
export function reconcileCatalog(previous,next){
 if(!previous)return next;
 const known=new Map((previous.works||[]).map(work=>[work.id,work]));
 const works=(next.works||[]).map(work=>{const prior=known.get(work.id);return prior&&JSON.stringify(prior)===JSON.stringify(work)?prior:work;});
 const sameWorks=works.length===(previous.works||[]).length&&works.every((work,index)=>work===previous.works[index]);
 const result={...next,works:sameWorks?previous.works:works};
 for(const key of ['models','jobs','textModel'])if(Object.hasOwn(next,key)&&JSON.stringify(previous[key])===JSON.stringify(next[key]))result[key]=previous[key];
 return Object.keys(result).length===Object.keys(previous).length&&Object.keys(result).every(key=>result[key]===previous[key])?previous:result;
}

export default api;
