const array=value=>Array.isArray(value)?value:[];
export const PUBLISHING_STATUSES={draft:'草稿',unknown:'官方状态待核对',preparing:'准备发布包',prepared:'发布包已准备',handoff:'已交接创作页','handed-off':'已交接创作页',awaiting_manual_publish:'待平台发布','published-manual':'已人工登记',uploading:'API 上传中',uploaded:'API 已上传',processing:'平台处理中',published:'API 已核实发布',rejected:'平台已拒绝','upload-status-unknown':'上传状态待核对','remote-status-unknown':'官方状态待核对','published-api':'API 已提交',failed:'操作失败',succeeded:'已完成',running:'处理中'};
export function publishingMetadata(draft){
 const source=draft?.metadata||{};
 return {title:source.title||'',description:source.description||'',tags:array(source.tags).join('，'),coverMediaId:source.coverMediaId||'',privacy:source.privacy||'private',categoryId:String(source.categoryId||'1'),madeForKids:source.madeForKids===true,syntheticMedia:source.syntheticMedia!==false};
}
export function publishingPayload(form){
 const tags=[...new Set(String(form.tags||'').split(/[,，\n]/u).map(tag=>tag.trim().replace(/^#+/u,'')).filter(Boolean))];
 if(!form.title?.trim())throw new Error('请填写发布标题。');
 if(tags.length>30)throw new Error('标签请控制在 30 个以内。');
 return {title:form.title.trim(),description:String(form.description||'').trim(),tags,coverMediaId:form.coverMediaId||null,privacy:form.privacy||'private',categoryId:String(form.categoryId||'1'),madeForKids:form.madeForKids===true,syntheticMedia:form.syntheticMedia===true};
}
export function publishingDirty(form,saved){return Boolean(form&&saved&&JSON.stringify(form)!==JSON.stringify(saved));}
export function publishingCopy(form){
 const tags=[...new Set(String(form.tags||'').split(/[,，\n]/u).map(tag=>tag.trim().replace(/^#+/u,'')).filter(Boolean))];
 return [form.title?.trim(),form.description?.trim(),tags.length?tags.map(tag=>'#'+tag).join(' '):''].filter(Boolean).join('\n\n');
}
export function publishingDescriptionBytes(value){return new TextEncoder().encode(String(value||'')).byteLength;}
export function publishingMetadataError(form,platform){
 if(!form?.title?.trim())return '请填写发布标题。';
 if(platform?.limits?.title&&Array.from(form.title).length>platform.limits.title)return `标题最多 ${platform.limits.title} 字。`;
 if(platform?.id==='youtube'&&publishingDescriptionBytes(form.description)>5000)return 'YouTube 简介最多 5,000 字节，请缩短正文。';
 if(platform?.limits?.description&&Array.from(form.description||'').length>platform.limits.description)return `简介最多 ${platform.limits.description} 字。`;
 return '';
}
export function publishingExportLabel(job){
 const seconds=job.durationSeconds??job.duration;
 return [...((job.mode||job.exportOptions?.mode)==='storyboard'?['故事板预演']:[]),job.episodeTitle||job.title||'成片',typeof job.width==='number'&&typeof job.height==='number'?`${job.width} × ${job.height}`:'尺寸未记录',typeof seconds==='number'?`${Number(seconds.toFixed(2))} 秒`:null,job.id?.slice(0,8)].filter(Boolean).join(' · ');
}
export function publishingExports(values){return [...array(values)].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));}
export function publishingDraftSource(draft,exports){
 const snapshot=draft?.prepared?.source||draft?.sourceSnapshot||draft?.source||draft?.exportSnapshot;
 return snapshot||array(exports).find(item=>item.id===draft?.exportId)||null;
}
export function publishingPackageUrl(draft){return draft?.id?`/api/publishing/drafts/${encodeURIComponent(draft.id)}/package`:null;}
export function publishingStatus(draft){return PUBLISHING_STATUSES[draft?.status]||draft?.status||'草稿';}
export function publishingStamp(value){return value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';}
export function reconcilePublishingState(previous,next){
 const known=new Map(array(previous?.drafts).map(draft=>[draft.id,draft]));
 const incoming=new Set(array(next.drafts).map(draft=>draft.id));
 return {...next,drafts:[...array(next.drafts).map(draft=>{const prior=known.get(draft.id);return prior&&prior.revision>draft.revision?prior:draft;}),...array(previous?.drafts).filter(draft=>!incoming.has(draft.id))]};
}

/** One open publishing dialog owns a cancellable, non-overlapping state reader. */
export function createPublishingReader({workId,onData,onError,onLoading=()=>{},fetcher=fetch,setTimer=setInterval,clearTimer=clearInterval,isVisible=()=>true,intervalMs=8000}){
 let live=true,pending=null,controller=null,timer=null;
 async function read(){
  if(!live)return null;if(pending)return pending;
  controller=new AbortController();const current=controller;onLoading(true);
  pending=(async()=>{try{
   const response=await fetcher('/api/publishing/state?workId='+encodeURIComponent(workId),{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:current.signal});
   let value;try{value=await response.json();}catch{throw new Error('发布中心没有返回有效结果，请重试。');}
   if(!response.ok)throw new Error(value.error||'发布中心暂时无法读取。');
   if(!Array.isArray(value.platforms)||!Array.isArray(value.drafts)||!Array.isArray(value.exports))throw new Error('发布中心数据格式无效。');
   if(live&&!current.signal.aborted){onData(value);onError('');}return value;
  }catch(error){if(live&&!current.signal.aborted)onError(error.message);return null;}
  finally{pending=null;if(controller===current)controller=null;if(live)onLoading(false);}})();return pending;
 }
 return {read,start(){if(timer===null){void read();timer=setTimer(()=>{if(isVisible())void read();},intervalMs);}},dispose(){live=false;controller?.abort();if(timer!==null)clearTimer(timer);timer=null;}};
}

/** Capture identity and revision before awaiting. No action can accidentally target a newly selected draft. */
export async function updatePublishingDraft({api,draft,form,accountId}){
 if(!draft?.id||!Number.isInteger(draft.revision))throw new Error('请先选择有效的发布草稿。');
 const id=draft.id,revision=draft.revision,metadata=publishingPayload(form);
 return api(`/api/publishing/drafts/${encodeURIComponent(id)}/update`,{revision,metadata,...(accountId?{accountId}:{})});
}
