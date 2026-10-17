const array=value=>Array.isArray(value)?value:[];
const terminal=status=>['succeeded','failed','interrupted'].includes(status);
export const archiveJobActive=job=>['queued','running'].includes(job?.status);
export const ARCHIVE_STAGES={'source-generation':'原片生成',import:'导入素材',upscale:'AI 超分',review:'审片',publishing:'发布登记'};
export function archiveAutoBackup(profile,draft=null){return typeof draft==='boolean'?draft:profile?profile.autoBackupOnExport===true:true;}
export function archiveProfileView(profile){
 const style=profile?.kind==='style-library'&&profile.sourceMode==='gpt-image-gb10'&&profile.targetResolution==='native',red=!profile||profile.kind==='red-alert'&&(profile.sourceMode===undefined||profile.sourceMode==='cloud-lowres')&&(profile.targetResolution===undefined||profile.targetResolution==='1080p');
 if(style)return {supported:true,kind:'style-library',title:'画风样片档案',description:'保存 GPT 原始首帧、GB10 原生动态与当次生产记录。',steps:[{icon:'image',title:'GPT 设计首帧',text:'保存每种画风的原图、提示词与出图记录。'},{icon:'film',title:'GB10 原生视频',text:'以对应首帧生成动态，单独记录实际尺寸、参数与耗时。'},{icon:'archive',title:'NAS 保存样片',text:'原始图片、原生视频和制作记录按独立快照备份。'},{icon:'library',title:'作品按需引用',text:'作品显式选择参考，不自动超分或发布。'}]};
 if(red)return {supported:true,kind:'red-alert',title:'外部原片制作流',description:'沿用现有素材库、导出与发布中心。',steps:[{icon:'cloud',title:'积分平台生成原片',text:'小云雀等平台生成低分辨率原片，实际请求与积分通过 CLI 登记。'},{icon:'film',title:'导入当前作品',text:'素材、分镜与时间轴继续使用本工作台。'},{icon:'sparkles',title:'GB10 超分至 1080P',text:'审片后显式选择 AI 超分导出，保留原片与生产记录。'},{icon:'send',title:'沿用发布中心',text:'各平台草稿、交接、上传与用户登记状态分别保存。'}]};
 return {supported:false,kind:null,title:'制作档案',description:'当前档案类型尚未由此页面支持，请保留原配置。',steps:[]};
}
export function archiveProfilePayload(workId,profile,draft){
 const view=archiveProfileView(profile);if(!view.supported)throw new Error('当前档案配置尚未由此页面支持，不会替换原制作流。');
 const definition=view.kind==='style-library'?{kind:'style-library',sourceMode:'gpt-image-gb10',targetResolution:'native'}:{kind:'red-alert',sourceMode:'cloud-lowres',targetResolution:'1080p'},auto=typeof draft==='boolean'?{autoBackupOnExport:draft}:!profile?{autoBackupOnExport:true}:typeof profile.autoBackupOnExport==='boolean'?{autoBackupOnExport:profile.autoBackupOnExport}:{};
 return {workId,...definition,...auto};
}
export function archiveStamp(value){return value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';}
export function archiveBytes(value){if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '未记录';const unit=value>=1024**3?'GB':value>=1024**2?'MB':value>=1024?'KB':'B',scale={GB:1024**3,MB:1024**2,KB:1024,B:1}[unit];return `${Number((value/scale).toFixed(2))} ${unit}`;}
export function archiveSummary(state){
 const definitions=state?.summaryDefinitions||{},summary=state?.summary||{};
 return [{key:'originalVideos',label:'原片',description:'本作品登记生成的视频资产及导入的视频素材'}, {key:'flowSnapshots',label:'制作记录',description:'本作品追加保存的制作记录'}, {key:'upscaledExports',label:'AI 超分导出',description:'成功且请求 AI 1080P 超分的导出'}, {key:'publishingRecords',label:'发布草稿',description:'发布中心的草稿数量，不等于发布成功次数'}].map(item=>({...item,count:Number.isSafeInteger(summary[item.key])&&summary[item.key]>=0?summary[item.key]:null,description:typeof definitions[item.key]==='string'?definitions[item.key].replace('append-only制作过程记录数','已保存的制作过程记录数'):item.description}));
}
export function archiveBilling(billing){
 if(!billing||typeof billing.amount!=='number'||!Number.isFinite(billing.amount)||billing.amount<0||billing.unit!=='credits')return null;
 return {amount:billing.amount,label:billing.verification==='provider-receipt'?'附平台回执，未核验扣费':billing.verification==='user-reported'?'用户登记，未核验扣费':'来源未记录'};
}
export function archiveEvidence(job){const saved=job?.archive;return {saved:job?.status==='succeeded'&&Boolean(saved),verified:job?.status==='succeeded'&&typeof saved?.manifestSha256==='string'&&/^[a-f0-9]{64}$/i.test(saved.manifestSha256),archive:saved||null};}
export function mergeArchiveState(previous,next){
 if(previous?.workId!==next?.workId)return next;
 const merge=(before,after)=>{const known=new Map(array(before).map(item=>[item.id,item]));for(const item of array(after)){const old=known.get(item.id);known.set(item.id,old&&terminal(old.status)&&!terminal(item.status)?old:item);}return [...known.values()].sort((a,b)=>(Date.parse(b.createdAt||b.snapshotAt)||0)-(Date.parse(a.createdAt||a.snapshotAt)||0));};
 return {...next,profile:next.profile||previous.profile||null,jobs:merge(previous.jobs,next.jobs),records:merge(previous.records,next.records),archives:merge(previous.archives,next.archives)};
}

/** Each open work owns one reader. It never creates a profile, backup or model job. */
export function createArchiveReader({api,workId,onData,onError,onLoading=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){
 let live=true,started=false,pending=null,timer=null,last=null;
 async function read(){
  if(!live)return null;if(pending)return pending;onLoading(true);
  pending=(async()=>{try{const value=await api(`/api/work-archives/state?workId=${encodeURIComponent(workId)}`);if(value?.workId!==workId||!Array.isArray(value.jobs)||!Array.isArray(value.archives))throw new Error('制作档案返回了不同作品或无效数据，请重新读取。');last=value;if(live){onData(value);onError('');}return value;}catch(error){if(live)onError(error.message||'制作档案暂时无法读取。');return null;}finally{pending=null;if(live)onLoading(false);}})();return pending;
 }
 async function tick(){await read();if(live&&started)timer=setTimer(tick,array(last?.jobs).some(archiveJobActive)?2000:10000);}
 return {read,async readFresh(){if(pending)await pending;return read();},start(){if(started||!live)return;started=true;void tick();},dispose(){live=false;started=false;if(timer!==null)clearTimer(timer);timer=null;}};
}
export function safeLanOrigin(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash?url.origin:null;}catch{return null;}}
