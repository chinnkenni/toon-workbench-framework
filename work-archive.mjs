import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,lstat,stat,realpath,rename,rm,unlink} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {performance} from 'node:perf_hooks';
import {getWorkbenchGuide,listWorkbenchLessons} from './workbench-guide.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url)),stores=new Map(),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/i,ACTIVE=new Set(['queued','running']),STAGES=['source-generation','import','upscale','review','publishing'];
const SECRET=/^(?:apiKey|accessToken|refreshToken|idToken|token|tokens|clientSecret|secret|password|authorization|cookie|cookies|setCookie|storageState|privateKey|keyPath|sshKey|sshPrivateKey|vault)$/i;
const SECRET_TEXT=/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{15,}/i;
const secretKey=value=>{const key=value.replaceAll(/[_-]/g,'');return SECRET.test(key)||/apikey|password|privatekey|authorization|cookie|keypath|sshkey|storagestate|(?:access|refresh|oauth|session|client)token|secret$/i.test(key);};
const FORMATS={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a','audio/flac':'flac','audio/ogg':'ogg','audio/aac':'aac','video/mp4':'mp4'};
const PROFILE_TYPES=[{kind:'red-alert',sourceMode:'cloud-lowres',targetResolution:'1080p',autoBackupOnExport:true},{kind:'style-library',sourceMode:'gpt-image-gb10',targetResolution:'native',autoBackupOnExport:false}];
export const ARCHIVE_MARKER='.toon-workbench-archive.json';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),clone=value=>structuredClone(value),now=()=>new Date().toISOString();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function id(value){if(typeof value!=='string'||!UUID.test(value))throw fail('作品或存档编号无效');return value.toLowerCase();}
function fields(value,allowed){if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('存档请求包含不支持的字段');}
function profileType(input){const type=PROFILE_TYPES.find(item=>['kind','sourceMode','targetResolution'].every(key=>item[key]===input[key]));if(!type||input.autoBackupOnExport!==undefined&&typeof input.autoBackupOnExport!=='boolean')throw fail('档案类型须为red-alert/cloud-lowres/1080p或style-library/gpt-image-gb10/native，自动备份须为布尔值');return type;}
function inside(base,target,same=false){const part=relative(base,target);if((!part&&!same)||part==='..'||part.startsWith('..\\')||part.startsWith('../')||isAbsolute(part))throw fail('存档文件路径越界',403);return target;}
function relativePath(value){if(typeof value!=='string'||!value||value.length>700||value.includes('\\')||value.includes(':')||value.includes('\0')||isAbsolute(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))throw fail('存档只接受固定登记的相对路径',403);return value;}
async function basePath(value){if(typeof value!=='string'||!isAbsolute(value))throw fail('存档根目录须为已配置的绝对路径',503);const target=resolve(value),info=await lstat(target);if(info.isSymbolicLink()||!info.isDirectory())throw fail('存档根目录须为正常目录，不能是链接',403);return realpath(target);}
/** Check every existing component, including junctions inside the allowed root. */
async function existing(base,path,kind='file'){
 relativePath(path);let cursor=base;const parts=path.split('/');
 for(let index=0;index<parts.length;index++){cursor=join(cursor,parts[index]);const info=await lstat(cursor);if(info.isSymbolicLink())throw fail('存档源或目标不能经过链接目录或文件',403);if(index<parts.length-1&&!info.isDirectory())throw fail('存档路径祖先不是目录',403);if(index===parts.length-1&&(kind==='file'?!info.isFile():!info.isDirectory()))throw fail('存档路径类型无效',403);inside(base,await realpath(cursor));}
 return cursor;
}
async function directory(base,path){relativePath(path);let current='';for(const part of path.split('/')){current=current?current+'/'+part:part;try{await existing(base,current,'directory');}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(join(base,...current.split('/')));await existing(base,current,'directory');}}return join(base,...path.split('/'));}
const fingerprint=value=>({size:value.size,mtimeMs:value.mtimeMs,ctimeMs:value.ctimeMs,dev:value.dev,ino:value.ino});
const sameStat=(a,b)=>a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.dev===b.dev&&a.ino===b.ino;
async function digest(file){const before=fingerprint(await stat(file)),hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file)){bytes+=chunk.length;hash.update(chunk);}const after=fingerprint(await stat(file));if(bytes!==before.size||!sameStat(before,after))throw fail('存档源文件在读取时发生变化，已中止本次备份',409);return {bytes,sha256:hash.digest('hex'),stat:after};}
async function jsonFile(base,path,empty,max=32*1024*1024){
 let file;try{file=await existing(base,path);}catch(error){if(error.code==='ENOENT'&&empty!==undefined)return clone(empty);throw error;}
 const before=fingerprint(await stat(file));if(before.size>max)throw fail('存档所需索引超过安全大小限制',413);const bytes=await readFile(file),after=fingerprint(await stat(file));if(bytes.length>max||!sameStat(before,after))throw fail('存档所需索引在读取时发生变化，请重试',409);try{return JSON.parse(bytes.toString('utf8'));}catch{throw fail('存档所需索引不是有效 JSON',409);}
}
async function atomic(base,path,value){await directory(base,relative(base,dirname(join(base,path))).replaceAll('\\','/'));const file=join(base,path),temporary=file+'.'+randomUUID()+'.tmp';try{try{await existing(base,path);}catch(error){if(error.code!=='ENOENT')throw error;}await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}}
function serial(store,operation){const next=store.writes.catch(()=>{}).then(operation);store.writes=next.catch(()=>{});return next;}
async function persist(store){const bytes=Buffer.byteLength(JSON.stringify(store.catalog));if(bytes>32*1024*1024)throw fail('作品档案索引超过32MiB上限',413);await atomic(store.root,'work-archives/catalog.json',store.catalog);}
async function getStore(context){
 const key=resolve(context.dataDir);if(!stores.has(key)){const pending=(async()=>{const root=await basePath(key),catalog=await jsonFile(root,'work-archives/catalog.json',{schemaVersion:1,profiles:[],records:[],jobs:[]});if(catalog.schemaVersion!==1||!Array.isArray(catalog.profiles)||!Array.isArray(catalog.records)||!Array.isArray(catalog.jobs))throw fail('作品档案索引格式无效',409);const store={root,catalog,writes:Promise.resolve(),queue:[],running:false,context:{rootDir:ROOT,nasRoot:process.env.NAS_ROOT}};let changed=false;for(const job of catalog.jobs)if(ACTIVE.has(job.status)){job.status='interrupted';job.finishedAt=now();job.message='工作台重启，本次备份状态需核对；未自动重投或覆盖NAS备份。';job.error=job.message;changed=true;}if(changed)await persist(store);return store;})();stores.set(key,pending);pending.catch(()=>stores.delete(key));}
 const store=await stores.get(key);for(const name of ['rootDir','nasRoot','archiveHooks'])if(context[name]!==undefined)store.context[name]=context[name];return store;
}
async function workAt(root,workId){const catalog=await jsonFile(root,'works/catalog.json',{version:1,works:[]});if(catalog.version!==1||!Array.isArray(catalog.works))throw fail('作品索引格式无效',409);const work=catalog.works.find(entry=>entry.id?.toLowerCase()===workId);if(!work)throw fail('作品不存在',404);return work;}
async function publishingAt(root,workId){const value=await jsonFile(root,'publishing/catalog.json',{version:1,drafts:[]});if(value.version!==1||!Array.isArray(value.drafts))throw fail('发布索引格式无效',409);return value.drafts.filter(draft=>draft.workId===workId);}
async function nasTarget(store){
 const configured=typeof store.context.nasRoot==='string'&&!!store.context.nasRoot.trim();if(!configured)return {configured:false,available:false,state:'unconfigured',message:'尚未配置授权的NAS专用目录；不会创建本地替代备份。'};
 try{const root=await basePath(store.context.nasRoot);try{inside(store.root,root,true);throw fail('NAS专用目录不能位于工作台数据目录内',403);}catch(error){if(error.status!==403||error.message!=='存档文件路径越界')throw error;}
  const marker=await jsonFile(root,ARCHIVE_MARKER,undefined,4096);if(marker.schemaVersion!==1||marker.manager!=='toon-workbench-archive')throw fail('NAS专用目录缺少正确的授权标记',503);const markerDigest=await digest(await existing(root,ARCHIVE_MARKER)),info=await stat(root);
  return {configured:true,available:true,state:'ready',message:'NAS专用目录已就绪；每次备份独立提交并核对SHA。',_root:root,_markerSha:markerDigest.sha256,_identity:{dev:info.dev,ino:info.ino}};
 }catch{return {configured:true,available:false,state:'offline',message:'NAS不可访问或专用目录授权标记无效；不会写入本地替代目录。'};}
}
const publicNas=target=>Object.fromEntries(Object.entries(target).filter(([key])=>!key.startsWith('_')));
async function checkNas(store,pinned){const current=await nasTarget(store);if(!current.available||current._root!==pinned._root||current._markerSha!==pinned._markerSha||current._identity.dev!==pinned._identity.dev||current._identity.ino!==pinned._identity.ino)throw fail('NAS离线、目录身份或授权标记已变化，本次备份未提交',503);return current._root;}
function boundedJson(value,{strict=false,depth=0,budget={nodes:0}}={}){
 if(++budget.nodes>(strict?15000:1000000)||depth>(strict?16:100))throw fail('记录 JSON 结构过深或项目过多');
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value))throw fail('记录 JSON 数值须为有限数');return value;}
 if(typeof value==='string'){if(SECRET_TEXT.test(value))throw fail('制作记录或快照含私钥或凭据文本，已拒绝');return value;}
 if(Array.isArray(value))return value.map(item=>boundedJson(item,{strict,depth:depth+1,budget}));
 if(!plain(value))throw fail('记录须为纯 JSON 数据');const result={};
 for(const [key,item]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key)||secretKey(key)){if(strict)throw fail('制作记录不能包含凭据字段');continue;}result[key]=boundedJson(item,{strict,depth:depth+1,budget});}return result;
}
function recordInput(body){
 fields(body,['workId','stage','title','details','billing','sourceIds','evidence']);const workId=id(body.workId);if(!STAGES.includes(body.stage)||typeof body.title!=='string'||!body.title.trim()||body.title.length>180||!plain(body.details))throw fail('制作记录需要有效阶段、标题与 details 对象');
 const details=boundedJson(body.details,{strict:true});if(Buffer.byteLength(JSON.stringify(details))>32*1024)throw fail('制作记录 details 最多32KiB',413);
 const sourceIds=body.sourceIds??[],evidence=body.evidence??[];if(!Array.isArray(sourceIds)||sourceIds.length>200||new Set(sourceIds.map(id)).size!==sourceIds.length)throw fail('制作记录 sourceIds 无效或重复');if(!Array.isArray(evidence)||evidence.length>20||evidence.some(item=>typeof item!=='string'||!item.trim()||item.length>2000||SECRET_TEXT.test(item)))throw fail('制作记录 evidence 须为有界且不含凭据的说明');
 let billing;if(body.billing!==undefined){fields(body.billing,['amount','unit','verification']);if(typeof body.billing.amount!=='number'||!Number.isFinite(body.billing.amount)||body.billing.amount<0||body.billing.amount>1e12||body.billing.unit!=='credits'||!['user-reported','provider-receipt'].includes(body.billing.verification))throw fail('积分记录格式无效');billing=clone(body.billing);}
 if(SECRET_TEXT.test(body.title))throw fail('制作记录不能包含凭据文本');return {workId,stage:body.stage,title:body.title.trim(),details,...(billing?{billing}:{}),sourceIds:sourceIds.map(id),evidence:clone(evidence)};
}
async function sourceEntry(store,path,{kind,expectedSha,expectedBytes,sourceId}={}){let file,actual;try{file=await existing(store.root,path);actual=await digest(file);}catch(error){if(error.status)throw error;throw fail('登记素材、导出或发布包不可读取，已中止备份',409);}if(expectedSha!==undefined&&(!SHA.test(expectedSha)||actual.sha256.toLowerCase()!==expectedSha.toLowerCase())||expectedBytes!==undefined&&actual.bytes!==expectedBytes)throw fail('登记素材或发布包与原始SHA/字节不符，已中止备份',409);return {path:'payload/data/'+path,kind,sourceRoot:'data',sourceRelativePath:path,...(sourceId?{sourceId}:{}),bytes:actual.bytes,sha256:actual.sha256,frozenAt:now(),_file:file,_stat:actual.stat};}
function generated(path,value,sourceRelativePath){const bytes=Buffer.from(JSON.stringify(boundedJson(value),null,2)+'\n');if(bytes.length>32*1024*1024)throw fail('作品快照超过32MiB上限',413);return {path,kind:'metadata-snapshot',sourceRoot:'snapshot',sourceRelativePath,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),frozenAt:now(),_content:bytes};}
async function freezeSources(store,job){
 const work=await workAt(store.root,job.workId),snapshotAt=now(),workspacePath='toonflow/workspaces/works-'+job.workId;await existing(store.root,workspacePath,'directory');
 if(work.workspacePath&&resolve(work.workspacePath)!==resolve(store.root,workspacePath))throw fail('作品工作区登记与当前数据根不符',403);
 const drafts=await publishingAt(store.root,job.workId),guide=await getWorkbenchGuide({dataDir:store.root,rootDir:store.context.rootDir,workId:job.workId}),episodeLessons=[];
 for(const episode of work.episodes||[])episodeLessons.push({episodeId:episode.id,...await listWorkbenchLessons({dataDir:store.root,workId:job.workId,episodeId:episode.id,includeHistory:true})});
 const production={};for(const section of ['tts','music','asr']){const saved=await jsonFile(store.root,section+'/catalog.json',{jobs:[]});if(!Array.isArray(saved.jobs))throw fail('生产任务索引格式无效',409);production[section]=saved.jobs.filter(item=>(item.workId||item.request?.workId)===job.workId);}
 const records=clone(store.catalog.records.filter(item=>item.workId===job.workId)),workSnapshot=clone(work);delete workSnapshot.workspacePath;
 const entries=[generated('metadata/work.json',{schemaVersion:1,snapshotAt,workspaceRelativePath:workspacePath,work:workSnapshot},'works/catalog.json'),generated('metadata/profile.json',job.profileSnapshot,'work-archives/catalog.json'),generated('metadata/records.json',{schemaVersion:1,records,billingVerification:'记录方提供的信息或回执，不代表本工作台核验平台扣费。'},'work-archives/catalog.json'),generated('metadata/guidance.json',{snapshotAt,guide,episodeLessons},'skills/toon-workbench/playbook.json'),generated('metadata/publishing.json',{schemaVersion:1,drafts},'publishing/catalog.json'),{...generated('metadata/production.json',{schemaVersion:1,...production},'tts/catalog.json'),sourceReferences:['tts/catalog.json','music/catalog.json','asr/catalog.json']}],known=new Set();
 const add=async(path,options)=>{if(known.has(path))return;known.add(path);entries.push(await sourceEntry(store,path,options));if(entries.length>20000)throw fail('单作品备份最多20000个文件',413);};
 for(const asset of work.assets||[]){id(asset.id);if(asset.type!=='video'||asset.mimeType!=='video/mp4'||!/^assets\/generated\/video[0-9a-f-]{36}\.mp4$/i.test(asset.relativePath||''))throw fail('生成原片登记路径无效',403);const origin=work.jobs?.find(item=>item.assetId===asset.id||item.id===asset.jobId);await add(workspacePath+'/'+asset.relativePath,{kind:'generated-original',sourceId:asset.id,expectedSha:asset.sha256??origin?.telemetry?.sha256,expectedBytes:asset.bytes});}
 for(const media of work.studio?.media||[]){id(media.id);const extension=FORMATS[media.mimeType];if(!extension||media.relativePath!==`assets/imported/${media.id}.${extension}`)throw fail('导入素材登记路径无效',403);await add(workspacePath+'/'+media.relativePath,{kind:'imported-original',sourceId:media.id,expectedSha:media.sha256,expectedBytes:media.bytes});}
 const exports=new Map();for(const item of work.studio?.exports||[]){if(item.status!=='succeeded')continue;id(item.id);if(item.relativePath!==`exports/export${item.id}.mp4`)throw fail('成功导出登记路径无效',403);exports.set(item.id,item);await add(workspacePath+'/'+item.relativePath,{kind:'completed-export',sourceId:item.id,expectedSha:item.sha256,expectedBytes:item.bytes});}
 for(const draft of drafts){id(draft.id);const packages=[...(draft.attempts||[]).filter(item=>item.kind==='prepare'&&item.status==='succeeded'&&item.package).map(item=>({id:item.id,value:item.package,source:item.sourceSnapshot})),...(draft.prepared?[{id:draft.prepared.attemptId,value:draft.prepared,source:draft.prepared.source}]:[])];
  for(const item of packages){id(item.id);const expected=`packages/${draft.id}/${item.id}.zip`,exportSource=entries.find(entry=>entry.sourceRelativePath===workspacePath+`/exports/export${draft.exportId}.mp4`);if(item.value.relativePath!==expected||!SHA.test(item.value.sha256||'')||!Number.isSafeInteger(item.value.bytes)||!exports.has(draft.exportId)||item.source?.relativePath!==`exports/export${draft.exportId}.mp4`||!exportSource||item.source.sha256!==exportSource.sha256||item.source.bytes!==exportSource.bytes)throw fail('发布包来源或登记路径未经当前作品验证',403);await add('publishing/'+expected,{kind:'prepared-publishing-package',sourceId:draft.id,expectedSha:item.value.sha256,expectedBytes:item.value.bytes});}}
 return {entries,snapshotAt,workTitle:work.title||'',records:records.length};
}
async function update(store,job,values){return serial(store,async()=>{Object.assign(job,values);await persist(store);});}
async function copyEntry(store,pinned,stage,entry){
 await checkNas(store,pinned);await existing(pinned._root,relative(pinned._root,stage).replaceAll('\\','/'),'directory');await directory(stage,entry.path.split('/').slice(0,-1).join('/'));const target=join(stage,...entry.path.split('/'));
 if(entry._content)await writeFile(target,entry._content,{flag:'wx',mode:0o600});
 else{const source=await existing(store.root,entry.sourceRelativePath);if(source!==entry._file||!sameStat(entry._stat,fingerprint(await stat(source))))throw fail('源文件在冻结后发生变化，已中止备份',409);const hash=createHash('sha256');let bytes=0;await pipeline(createReadStream(source),new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}}),createWriteStream(target,{flags:'wx',mode:0o600}));if(bytes!==entry.bytes||hash.digest('hex')!==entry.sha256||!sameStat(entry._stat,fingerprint(await stat(source))))throw fail('源文件在复制中发生变化，已中止备份',409);}
 const copied=await digest(await existing(stage,entry.path));if(copied.bytes!==entry.bytes||copied.sha256!==entry.sha256)throw fail('NAS副本未通过完整SHA/字节核对',409);
}
async function execute(store,job){
 const pinned=await nasTarget(store);if(!pinned.available)throw fail(pinned.message,503);let stage,committed=false;
 try{
  await update(store,job,{phase:'freezing',message:'正在冻结本作品资料与登记素材SHA'});const frozen=await freezeSources(store,job),totalBytes=frozen.entries.reduce((sum,entry)=>sum+entry.bytes,0),workRelative='works-'+job.workId;
  await store.context.archiveHooks?.afterFreeze?.({job:clone(job),entries:frozen.entries.map(({_file,_stat,_content,...entry})=>entry)});
  await checkNas(store,pinned);const workRoot=await directory(pinned._root,workRelative),stageName='.stage-'+job.id;await mkdir(join(workRoot,stageName));stage=await existing(pinned._root,workRelative+'/'+stageName,'directory');
  const progress={files:0,totalFiles:frozen.entries.length,bytes:0,totalBytes};await update(store,job,{phase:'copying',snapshotAt:frozen.snapshotAt,progress:clone(progress),message:'正在复制并读回核对NAS副本'});
  for(const entry of frozen.entries){await copyEntry(store,pinned,stage,entry);progress.files++;progress.bytes+=entry.bytes;await update(store,job,{progress:clone(progress)});}
  await store.context.archiveHooks?.beforeCommit?.({job:clone(job)});
  for(const entry of frozen.entries)if(entry._file){const actual=await existing(store.root,entry.sourceRelativePath);if(!sameStat(entry._stat,fingerprint(await stat(actual))))throw fail('源文件在提交前发生变化，已中止备份',409);}
  await checkNas(store,pinned);await existing(pinned._root,workRelative+'/'+stageName,'directory');
  const manifest={schemaVersion:1,manager:'toon-workbench-archive',id:job.id,workId:job.workId,workTitle:frozen.workTitle,snapshotAt:frozen.snapshotAt,frozenAt:now(),profile:clone(job.profileSnapshot),trigger:clone(job.trigger??null),coalescedExportIds:clone(job.coalescedExportIds||[]),exportTriggers:clone(job.exportTriggers||[]),credentialsIncluded:false,scope:'registered-files-and-selected-work-snapshots-only',hashDefinition:'SHA256 is computed over each archived payload. Metadata files are selected-work JSON snapshots, not copies of shared source catalogs.',files:frozen.entries.map(({_file,_stat,_content,...entry})=>entry)};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),manifestSha256=createHash('sha256').update(manifestBytes).digest('hex'),archive={id:job.id,relativePath:workRelative+'/'+job.id,manifestSha256,files:progress.files,bytes:progress.bytes,snapshotAt:frozen.snapshotAt,committedAt:now()};
  const indexBytes=Buffer.from(JSON.stringify({schemaVersion:1,manager:'toon-workbench-archive',workId:job.workId,...archive},null,2)+'\n');await writeFile(join(stage,'manifest.json'),manifestBytes,{flag:'wx',mode:0o600});await writeFile(join(stage,'index.json'),indexBytes,{flag:'wx',mode:0o600});
  if((await digest(await existing(stage,'manifest.json'))).sha256!==manifestSha256||(await digest(await existing(stage,'index.json'))).sha256!==createHash('sha256').update(indexBytes).digest('hex'))throw fail('NAS清单或索引未通过SHA核对',409);
  await update(store,job,{phase:'committing',message:'正在原子提交本次不可变备份目录'});await checkNas(store,pinned);await existing(pinned._root,workRelative+'/'+stageName,'directory');const final=join(workRoot,job.id);try{await lstat(final);throw fail('不可变备份编号已存在，未覆盖',409);}catch(error){if(error.code!=='ENOENT')throw error;}await rename(stage,final);committed=true;stage=null;
  await update(store,job,{status:'succeeded',phase:'complete',finishedAt:now(),archive,message:'备份已提交；本次清单和副本SHA已核对，原作品未改动。'});
 }catch(error){if(committed){error.archiveCommitUnknown=true;error.message='NAS备份目录已提交，但本机回执未保存完成；请核对，不会覆盖或删除该目录。';}throw error;}
 finally{if(stage)try{await checkNas(store,pinned);const workRoot=await existing(pinned._root,'works-'+job.workId,'directory'),checked=await existing(workRoot,'.stage-'+job.id,'directory');inside(workRoot,checked);if(checked!==stage)throw fail('临时目录身份变化');await rm(checked,{recursive:true,force:true});}catch{/* Offline NAS stages remain uncommitted; never create a local substitute or delete another directory. */}}
}
async function enqueue(store,workId,profile,{trigger,coalescedExportIds}={}){
 const job={id:randomUUID(),workId,status:'queued',phase:'queued',createdAt:now(),startedAt:null,finishedAt:null,profileSnapshot:clone(profile),progress:{files:0,totalFiles:0,bytes:0,totalBytes:0},message:'已加入本机串行NAS备份队列',...(trigger?{trigger}:{}),...(coalescedExportIds?{coalescedExportIds}: {})};store.catalog.jobs.push(job);try{await persist(store);}catch(error){store.catalog.jobs.pop();throw error;}store.queue.push(job.id);return job;
}
async function drainPendingExports(store,job){
 return serial(store,async()=>{const pending=job.pendingExportIds||[];if(!pending.length||job.followupJobId)return;const profile=store.catalog.profiles.find(item=>item.workId===job.workId);if(profile?.autoBackupOnExport!==true)return;let next=store.catalog.jobs.find(item=>item.workId===job.workId&&ACTIVE.has(item.status));
  if(next){next.coalescedExportIds=[...new Set([...(next.coalescedExportIds||[]),...pending])];next.exportTriggers=[...(next.exportTriggers||[]),...pending.map(exportId=>({kind:'export-succeeded',exportId}))];await persist(store);}else next=await enqueue(store,job.workId,profile,{trigger:{kind:'export-succeeded',exportId:pending.at(-1)},coalescedExportIds:[...pending]});job.followupJobId=next.id;await persist(store);
 });
}
async function pump(store){if(store.running)return;store.running=true;try{while(store.queue.length){const jobId=store.queue.shift(),job=store.catalog.jobs.find(item=>item.id===jobId);if(!job||job.status!=='queued')continue;const started=performance.now();try{await update(store,job,{status:'running',phase:'checking-nas',startedAt:now(),message:'正在核对NAS授权专用目录'});await execute(store,job);}catch(error){await update(store,job,{status:'failed',phase:'failed',finishedAt:now(),error:error.status?error.message:'NAS备份文件操作失败；请检查目录可用性与权限后重试。',message:error.status?error.message:'NAS备份失败，未创建本地替代备份。',...(error.archiveCommitUnknown?{archiveCommitUnknown:true}:{})}).catch(()=>{});}finally{await update(store,job,{durationMs:performance.now()-started}).catch(()=>{});await drainPendingExports(store,job).catch(async()=>{await update(store,job,{followupError:'后续导出备份排队回执保存失败，请核对并手动备份。'}).catch(()=>{});});}}}finally{store.running=false;}}
/** Only called after an export succeeded and its work catalog was persisted. */
export async function scheduleArchiveOnExport(context,workId,exportId){
 workId=id(workId);exportId=id(exportId);const store=await getStore(context);const result=await serial(store,async()=>{
  const profile=store.catalog.profiles.find(item=>item.workId===workId);if(profile?.autoBackupOnExport!==true)return {scheduled:false,reason:'not-explicitly-enabled'};
  const work=await workAt(store.root,workId);if(!work.studio?.exports?.some(item=>item.id===exportId&&item.status==='succeeded'))throw fail('只能为当前作品已成功持久化的导出安排备份',409);
  const recorded=store.catalog.jobs.find(item=>item.workId===workId&&(item.trigger?.kind==='export-succeeded'&&item.trigger.exportId===exportId||item.coalescedExportIds?.includes(exportId)||item.pendingExportIds?.includes(exportId)));if(recorded)return {scheduled:false,reused:true,reason:'export-already-recorded',job:clone(recorded)};
  const active=store.catalog.jobs.find(item=>item.workId===workId&&ACTIVE.has(item.status));
  if(active){if(active.status==='queued'){active.coalescedExportIds=[...new Set([...(active.coalescedExportIds||[]),exportId])];active.exportTriggers=[...(active.exportTriggers||[]).filter(item=>item.exportId!==exportId),{kind:'export-succeeded',exportId}];}else active.pendingExportIds=[...new Set([...(active.pendingExportIds||[]),exportId])];await persist(store);return {scheduled:true,reused:true,pending:active.status==='running',job:clone(active)};}
  return {scheduled:true,job:clone(await enqueue(store,workId,profile,{trigger:{kind:'export-succeeded',exportId},coalescedExportIds:[exportId]}))};
 });if(result.scheduled)setImmediate(()=>void pump(store));return result;
}
export async function getActiveArchiveJobs(context){const store=await getStore(context);await store.writes;return Math.max(store.catalog.jobs.filter(job=>ACTIVE.has(job.status)).length,store.running?1:0);}
async function stateFor(store,workId){const work=await workAt(store.root,workId),drafts=await publishingAt(store.root,workId),nas=await nasTarget(store);await store.writes;const jobs=clone(store.catalog.jobs.filter(job=>job.workId===workId).slice().reverse()),records=clone(store.catalog.records.filter(record=>record.workId===workId)),archives=jobs.filter(job=>job.status==='succeeded'&&job.archive).map(job=>job.archive);return {workId,profile:clone(store.catalog.profiles.find(profile=>profile.workId===workId)||null),nas:publicNas(nas),jobs,records,archives,counts:{records:records.length,jobs:jobs.length,archives:archives.length},summary:{originalVideos:(work.assets||[]).filter(item=>item.type==='video').length+(work.studio?.media||[]).filter(item=>item.type==='video').length,flowSnapshots:records.length,upscaledExports:(work.studio?.exports||[]).filter(item=>item.status==='succeeded'&&item.exportOptions?.enhance==='ai-1080p').length,publishingRecords:drafts.length},summaryDefinitions:{originalVideos:'登记生成视频资产与导入视频素材数',flowSnapshots:'append-only制作过程记录数',upscaledExports:'成功的AI超分导出数',publishingRecords:'该作品发布草稿数，不是已发布成功次数'},capabilities:{backup:true,immutable:true,credentialsIncluded:false,recordsAppendOnly:true,billingPlatformVerified:false}};}
function respond(req,res,status,value){const bytes=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);}
async function body(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>64*1024)throw fail('存档请求最多64KiB',413);chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('存档请求需要有效JSON');}if(!plain(value))throw fail('存档请求须为JSON对象');return value;}
/** Attach only after the existing Host/Origin checks. NAS root comes from trusted configuration. */
export async function handleWorkArchives(req,res,url,context){
 if(!url.pathname.startsWith('/api/work-archives'))return false;
 try{
  const store=await getStore(context),read=['GET','HEAD'].includes(req.method);
  if(url.pathname==='/api/work-archives/state'&&read){if([...url.searchParams.keys()].some(key=>key!=='workId')||url.searchParams.getAll('workId').length!==1)throw fail('档案查询需要唯一workId');respond(req,res,200,await stateFor(store,id(url.searchParams.get('workId'))));return true;}
  const match=/^\/api\/work-archives\/jobs\/([^/]+)$/.exec(url.pathname);if(match&&read){if(url.search)throw fail('任务查询不接受额外参数');const jobId=id(match[1]);await store.writes;const job=store.catalog.jobs.find(item=>item.id===jobId);if(!job)throw fail('备份任务不存在',404);respond(req,res,200,{job:clone(job)});return true;}
  if(req.method!=='POST'||url.search)throw fail('未找到作品档案接口',404);const input=await body(req);let value,status=200,queued=false;
  await serial(store,async()=>{
   if(url.pathname==='/api/work-archives/profiles'){fields(input,['workId','kind','sourceMode','targetResolution','autoBackupOnExport']);const workId=id(input.workId);await workAt(store.root,workId);const type=profileType(input);let profile=store.catalog.profiles.find(item=>item.workId===workId);if(profile&&['kind','sourceMode','targetResolution'].some(key=>profile[key]!==type[key]))throw fail('该作品已有不同制作档案类型，不能通过备份设置改写原制作流程',409);if(!profile){profile={workId,kind:input.kind,sourceMode:input.sourceMode,targetResolution:input.targetResolution,autoBackupOnExport:input.autoBackupOnExport??type.autoBackupOnExport,createdAt:now(),updatedAt:now()};store.catalog.profiles.push(profile);try{await persist(store);}catch(error){store.catalog.profiles.pop();throw error;}}else if(input.autoBackupOnExport!==undefined&&profile.autoBackupOnExport!==input.autoBackupOnExport){const previous=clone(profile);Object.assign(profile,{autoBackupOnExport:input.autoBackupOnExport,updatedAt:now()});try{await persist(store);}catch(error){Object.assign(profile,previous);if(!Object.hasOwn(previous,'autoBackupOnExport'))delete profile.autoBackupOnExport;throw error;}}value={profile:clone(profile)};
   }else if(url.pathname==='/api/work-archives/records'){const record={id:randomUUID(),createdAt:now(),...recordInput(input)};await workAt(store.root,record.workId);store.catalog.records.push(record);try{await persist(store);}catch(error){store.catalog.records.pop();throw error;}value={record:clone(record)};status=201;
   }else if(url.pathname==='/api/work-archives/backup'){fields(input,['workId']);const workId=id(input.workId);await workAt(store.root,workId);const profile=store.catalog.profiles.find(item=>item.workId===workId);if(!profile)throw fail('请先启用该作品的制作档案',409);if(store.catalog.jobs.some(job=>job.workId===workId&&ACTIVE.has(job.status)))throw fail('该作品已有进行中的备份任务',409);value={job:clone(await enqueue(store,workId,profile,{trigger:{kind:'manual'}}))};status=202;queued=true;
   }else throw fail('未找到作品档案接口',404);
  });respond(req,res,status,value);if(queued)setImmediate(()=>void pump(store));return true;
 }catch(error){respond(req,res,error.status||(error.code==='ENOENT'?404:500),{error:error.status?error.message:'作品档案读取或保存失败，请检查索引和目录权限。'});return true;}
}
