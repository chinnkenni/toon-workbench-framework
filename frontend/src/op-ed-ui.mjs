const array=value=>Array.isArray(value)?value:[];
export const OP_ED_LABELS={intro:'片头 OP',outro:'片尾 ED'};
export function opEdVersion(entry,id){return array(entry?.versions).find(version=>version.id===id)||null;}
export function opEdLatest(entry){return array(entry?.versions).reduce((latest,value)=>!latest||value.version>latest.version?value:latest,null);}
export function opEdForm(entry=null,version=opEdLatest(entry),kind='intro'){
 const clip=version?.clip||{};
 return {name:entry?.name||'',kind:entry?.kind||kind,collection:entry?.collection||'',titleMode:version?.titleMode||'literal',type:clip.type||'title',title:clip.title||'',subtitle:clip.subtitle||'',duration:String(clip.duration??2),trimStart:String(clip.trimStart??0),mediaId:clip.mediaId||'',muted:clip.muted===true,enabled:clip.enabled!==false,note:''};
}
export function opEdPayload(form){
 const name=String(form?.name||'').trim(),kind=form?.kind,duration=Number(form?.duration),trimStart=Number(form?.trimStart);
 if(!name||name.length>120)throw new Error('请填写资产名称，最多 120 字。');
 if(!OP_ED_LABELS[kind])throw new Error('请选择片头或片尾。');
 if(!['title','media'].includes(form?.type))throw new Error('请选择文字卡或图片 / 视频。');
 if(String(form.duration).trim()===''||!Number.isFinite(duration)||duration<1/30||duration>600)throw new Error('时长须在 1/30–600 秒之间。');
 if(String(form.trimStart).trim()===''||!Number.isFinite(trimStart)||trimStart<0||trimStart>600)throw new Error('素材入点须在 0–600 秒之间。');
 if(form.type==='media'&&!form.mediaId)throw new Error('先选择或导入片头片尾的图片 / 视频。');
 const clip={type:form.type,title:String(form.title||'').trim(),subtitle:String(form.subtitle||'').trim(),duration,trimStart,muted:form.muted===true,enabled:form.enabled!==false,...(form.type==='media'?{mediaId:form.mediaId}:{})};
 if(clip.title.length>180||clip.subtitle.length>500)throw new Error('画面标题最多 180 字，副标题最多 500 字。');
 return {name,kind,collection:String(form.collection||'').trim(),titleMode:form.titleMode==='template'?'template':'literal',clip};
}
export function opEdGroups(entries,{kind='all',search=''}={}){
 const groups=new Map(),needle=search.trim().toLocaleLowerCase();
 for(const entry of array(entries)){
  if(kind!=='all'&&entry.kind!==kind||needle&&![entry.name,entry.collection].some(value=>String(value||'').toLocaleLowerCase().includes(needle)))continue;
  const name=entry.collection||'未分组';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(entry);
 }
 return [...groups].map(([name,entries])=>({name,entries}));
}
export function opEdEpisode(state,episodeId){return array(state?.episodes).find(item=>item.episodeId===episodeId)||null;}
export async function saveOpEdAsset({api,workId,entry=null,form}){
 const value=opEdPayload(form),path=`/api/works/${encodeURIComponent(workId)}/studio/op-ed/templates`;
 if(!entry)return api(path,{entry:structuredClone(value)});
 const expectedVersion=opEdLatest(entry)?.version;
 if(!Number.isInteger(expectedVersion))throw new Error('资产版本尚未读取，请刷新后再保存。');
 return api(`${path}/${encodeURIComponent(entry.id)}/versions`,{expectedVersion,titleMode:value.titleMode,clip:structuredClone(value.clip),...(form.note?.trim()?{note:form.note.trim()}:{})});
}
export async function applyOpEdVersion({api,workId,episodeId,entry,version}){
 if(!episodeId||!OP_ED_LABELS[entry?.kind]||!opEdVersion(entry,version?.id))throw new Error('先选择本集及该资产的明确版本。');
 return api(`/api/works/${encodeURIComponent(workId)}/studio/op-ed/apply`,{episodeId,role:entry.kind,entryId:entry.id,versionId:version.id});
}
export async function uploadOpEdMedia({workId,file,fetcher=fetch}){
 if(!file||!['image/png','image/jpeg','image/webp','video/mp4'].includes(file.type))throw new Error('请导入 PNG、JPEG、WebP 图片或 MP4 视频。');
 if(file.size<1||file.size>64*1024*1024)throw new Error('导入文件须大于 0 且不超过 64 MB。');
 const response=await fetcher(`/api/works/${encodeURIComponent(workId)}/studio/media?name=${encodeURIComponent(file.name)}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type},body:file});
 let result;try{result=await response.json();}catch{throw new Error('素材导入未返回有效结果，请刷新素材列表核对。');}
 if(!response.ok)throw new Error(result.error||'素材导入失败。');if(!result.media?.id)throw new Error('未取得导入素材编号，请刷新后核对。');return result;
}
