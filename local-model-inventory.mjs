// Read-only, stat/receipt based monitoring. Never loads a model or hashes weights.
import {readFile,stat,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';

const SHA=/^[a-f0-9]{64}$/i,array=value=>Array.isArray(value)?value:[];
const fail=message=>new Error(message);
function inside(root,target){const part=relative(root,target);if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw fail('本机模型路径越界');return target;}
async function checkedPath(rootDir,dataDir,path){
 if(typeof path!=='string'||!path||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||isAbsolute(path))throw fail('本机模型登记路径无效');
 const data=path.startsWith('data/'),root=await realpath(data?dataDir:rootDir),target=inside(root,resolve(root,data?path.slice(5):path));
 let current=root;for(const part of relative(root,target).split(sep)){current=join(current,part);const info=await lstat(current);if(info.isSymbolicLink())throw fail('本机模型路径包含外部链接');}
 const canonical=await realpath(target);inside(root,canonical);return canonical;
}
async function json(rootDir,dataDir,path){const file=await checkedPath(rootDir,dataDir,path),info=await stat(file);if(!info.isFile()||info.size>512*1024)throw fail('本机模型校验凭据无效或过大');return JSON.parse(await readFile(file,'utf8'));}
const sameFiles=(left,right)=>JSON.stringify(array(left).map(({path,bytes,sha256})=>({path,bytes,sha256})).sort((a,b)=>a.path.localeCompare(b.path)))===JSON.stringify(array(right).map(({path,bytes,sha256})=>({path,bytes,sha256})).sort((a,b)=>a.path.localeCompare(b.path)));
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));

/** Receipt is a prior full hash, current stat is freshness only; it is not a rehash. */
export async function readLocalCpuModel(model,{rootDir,dataDir,checkedAt}){
 let receipt=null,error=null;
 try{receipt=await json(rootDir,dataDir,model.receiptPath);}catch(failure){error=failure.code==='ENOENT'?'本机模型完整校验凭据尚未准备':failure.message;}
 const expectedFiles=[...model.files,...array(model.runtime?.files)],recordedStats=new Map(array(receipt?.fileStats).map(file=>[file.path,file]));
 if(receipt?.modelStat)recordedStats.set(receipt.modelStat.path,receipt.modelStat);
 const sourceMatches=Boolean(receipt&&receipt.id===model.id&&validTime(receipt.verifiedAt)&&receipt.model?.path===model.files[0]?.path&&receipt.model?.revision===model.revision&&receipt.model?.sha256===model.files[0]?.sha256&&receipt.model?.bytes===model.files[0]?.bytes&&receipt.runtime?.engine==='whisper.cpp'&&receipt.runtime?.revision===model.runtime?.revision&&receipt.runtime?.sha256===model.runtime?.sha256&&receipt.runtime?.version===model.version&&sameFiles(receipt.runtimeFiles,model.runtime?.files));
 const files=await Promise.all(expectedFiles.map(async entry=>{
  let info=null,reason=null;
  try{const path=await checkedPath(rootDir,dataDir,entry.path);info=await stat(path);if(!info.isFile())throw fail('登记路径不是文件');}catch(failure){reason=failure.code==='ENOENT'?'本机文件尚未准备':failure.message;}
  const recorded=recordedStats.get(entry.path),exists=Boolean(info?.isFile()),changed=exists&&(info.size!==entry.bytes||sourceMatches&&recorded&&(info.size!==recorded.bytes||info.mtimeMs!==recorded.mtimeMs||info.ctimeMs!==recorded.ctimeMs));
  const passed=exists&&!changed&&sourceMatches&&recorded&&SHA.test(entry.sha256||'')&&Number.isFinite(recorded.mtimeMs)&&Number.isFinite(recorded.ctimeMs);
  return {...entry,actualBytes:exists?info.size:null,exists,mtime:exists?info.mtime.toISOString():null,verification:{status:changed?'changed':passed?'passed':'unknown',checkedAt:passed||changed?receipt?.verifiedAt||null:null,reason:reason||(changed?'文件大小或修改时间已偏离完整校验凭据':passed?null:error||'没有与当前清单和文件 stat 匹配的完整校验凭据'),source:passed?'Windows CPU preparation full-SHA receipt + current stat':null}};
 }));
 const passed=files.length>1&&files.every(file=>file.verification.status==='passed'),changed=files.some(file=>file.verification.status==='changed'),complete=files.every(file=>file.exists&&file.actualBytes===file.bytes),main=array(model.runtime?.files).find(file=>file.path===model.runtime?.executablePath);
 const recognized=Boolean(passed&&main?.sha256===model.runtime?.sha256&&SHA.test(receipt?.helpSha256||'')&&receipt?.reportedVersion===`whisper.cpp version: ${model.version}`);
 const total=expectedFiles.reduce((sum,file)=>sum+file.bytes,0),observed=files.reduce((sum,file)=>sum+(file.actualBytes||0),0);
 return {registered:true,executionHost:'windows-local',device:'cpu',binding:{id:'windows-local',name:'本机 Windows',host:'127.0.0.1',device:'cpu'},bindingMatched:true,checkedAt,reachable:true,state:changed?'changed':passed&&recognized?'ready':'pending',download:{bytes:observed,total,status:complete?'complete':'pending',updatedAt:receipt?.verifiedAt||null},verification:{status:changed?'changed':passed?'passed':'pending',verifiedFiles:files.filter(file=>file.verification.status==='passed').length,totalFiles:files.length,checkedAt:sourceMatches?receipt.verifiedAt:null},engineStatus:{name:'whisper.cpp',version:model.version,recognized,checkedAt,message:recognized?'Windows 本机 CPU；程序/依赖与权重凭据匹配，不占用 GB10 GPU。':'本机程序、依赖或权重校验凭据未就绪；监控不执行识别。'},files,error:error||(!sourceMatches?'完整校验凭据与当前固定部署不匹配':changed?'本机部署文件发生变化，需要重新完整校验':null),lastKnown:null};
}

function snapshotMatches(model,snapshot){
 return snapshot?.engine==='whisper.cpp'&&snapshot?.device==='cpu'&&snapshot.model?.revision===model.revision&&snapshot.model?.sha256===model.files[0]?.sha256&&snapshot.runtime?.revision===model.runtime?.revision&&snapshot.runtime?.sha256===model.runtime?.sha256&&snapshot.runtime?.version===model.runtime?.version&&snapshot.runtime?.build===model.runtime?.build&&sameFiles(snapshot.runtime?.files,model.runtime?.files);
}
export function localCpuEvidence(model,jobs=[]){
 const matching=array(jobs).filter(job=>snapshotMatches(model,job.executionSnapshot||job.capabilitySnapshot));
 const proof=matching.findLast(job=>job.status==='succeeded'&&snapshotMatches(model,job.executionSnapshot)&&validTime(job.executionSnapshot.inferenceStartedAt)&&validTime(job.executionSnapshot.finishedAt)&&SHA.test(job.sourceSnapshot?.sha256||'')&&SHA.test(job.audio?.sha256||'')&&SHA.test(job.executionSnapshot.resultSha256||'')&&SHA.test(job.result?.sha256||'')&&typeof job.result?.text==='string'&&Array.isArray(job.result?.segments)&&job.telemetry?.source==='local-cpu-asr');
 const summary=matching.map(job=>({id:job.id,workId:job.workId||null,status:job.status,createdAt:job.createdAt||null,finishedAt:job.finishedAt||null,message:job.error||job.message||null,productionMs:job.telemetry?.productionMs??null})).sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
 return {jobs:summary.slice(0,5),counts:{total:summary.length,active:summary.filter(job=>['queued','running'].includes(job.status)).length,succeeded:summary.filter(job=>job.status==='succeeded').length,failed:summary.filter(job=>['failed','interrupted'].includes(job.status)).length},cpuInference:{validated:Boolean(proof),checkedAt:proof?.finishedAt||null,jobId:proof?.id||null,message:proof?'已有匹配当前固定模型/程序的真实本机 CPU 转写记录；不验证声龄、说话人或口型。':'尚无匹配当前固定部署的真实本机 CPU 转写记录。'},gpuInference:{validated:false,checkedAt:null,jobId:null,message:'Windows 本机 CPU 服务，不使用 GB10 GPU。'}};
}
