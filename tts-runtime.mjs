import {readFrameworkGpuConfig} from './framework-config.mjs';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {randomBytes,createHash} from 'node:crypto';
import {withGpuLease} from './gpu-lease.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMOTE='docker exec -i rack-h3 /data/tts/venv/bin/python /data/tts/worker.py';
const fail=(message,status=502)=>Object.assign(new Error(message),{status});
let cached=null,pending=null;
function ssh(command,{input='',onEvent,raw=false,timeout=30000,maxBytes=512*1024}={}){
 return new Promise((resolve,reject)=>{
  const config=readFrameworkGpuConfig();
  const args=['-T','-i',config.keyPath,'-p',String(config.port),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlias='+config.host,'-o','ConnectTimeout=8',config.user+'@'+config.connectHost,command];
  const child=spawn('ssh',args,{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});const chunks=[];let total=0,error='',lines='',settled=false;
  const timer=setTimeout(()=>{child.kill();finish(fail('GB10 配音连接或处理超时，未自动重新提交',504));},timeout);
  function finish(err){if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(raw?Buffer.concat(chunks):Buffer.concat(chunks).toString('utf8'));}
  child.stdout.on('data',bytes=>{total+=bytes.length;if(total>maxBytes){child.kill();finish(fail('GB10 配音返回数据超过限制'));return;}chunks.push(bytes);if(onEvent){lines+=bytes.toString('utf8');let end;while((end=lines.indexOf('\n'))!==-1){const line=lines.slice(0,end);lines=lines.slice(end+1);try{onEvent(JSON.parse(line));}catch{}}}});
  child.stderr.on('data',bytes=>{error=(error+bytes).slice(-5000);});child.on('error',finish);child.on('close',code=>finish(code===0?null:fail('GB10 配音执行失败：'+error.slice(-2000))));child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
export async function getTtsCapability({force=false}={}){
 if(!force&&cached&&Date.now()-cached.at<10000)return cached.value;
 if(pending)return pending;
 pending=(async()=>{let value;try{value=JSON.parse(await ssh(REMOTE+' --capability',{timeout:15000}));}catch(error){value={available:false,reason:error.message};}cached={at:Date.now(),value};return value;})().finally(()=>{pending=null;});return pending;
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForComfy(onProgress){const started=performance.now();while(true){let queue;try{const response=await fetch('http://127.0.0.1:19188/queue',{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw new Error('HTTP '+response.status);queue=await response.json();if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending))throw new Error('队列格式无效');}catch(error){throw fail('无法核对 GB10 视频队列，暂不启动配音：'+error.message,503);}if(!queue.queue_running.length&&!queue.queue_pending.length)return performance.now()-started;if(performance.now()-started>60*60*1000)throw fail('等待视频队列空闲超过60分钟，未提交配音',504);await onProgress?.({phase:'waiting-comfy',message:'视频或超分仍在运行，配音等待 GB10 空闲'});await delay(3000);}}
export async function runRemoteTts({dataDir,jobId,text,speaker,language,instruct,voiceDescription,mode='preset',sourceVoice,onProgress}){
 if(!UUID.test(jobId||''))throw fail('配音任务编号无效',400);
 if(!['preset','design','clone'].includes(mode))throw fail('配音生成模式无效',400);
 if(mode==='clone'&&(!UUID.test(sourceVoice?.jobId||'')||!/^([a-f0-9]{64})$/.test(sourceVoice?.sha256||'')))throw fail('设计声线参考登记无效',400);
 const requested=performance.now();await onProgress?.({phase:'waiting-gpu',message:'配音排队等待 GPU 工作完成'});
 return withGpuLease(async()=>{
  const leaseWaitMs=performance.now()-requested,comfyQueueWaitMs=await waitForComfy(onProgress),capability=await getTtsCapability({force:true}),ready=mode==='design'?capability.voiceDesign:mode==='clone'?capability.referenceVoice:capability;if(!ready?.available)throw fail(ready?.reason||'配音引擎未就绪',503);
  const seed=randomBytes(4).readUInt32LE(),events=[];const output=await ssh(REMOTE,{input:JSON.stringify({jobId,text,speaker,language,...(mode==='preset'?{instruct}:{}),voiceDescription,mode,sourceVoice,seed}),timeout:15*60*1000,onEvent:value=>{events.push(value);if(value.event==='progress')Promise.resolve(onProgress?.(value)).catch(()=>{});}});
  const messages=output.trim().split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean),result=messages.findLast(item=>item.event==='result');
  if(!result||result.jobId!==jobId||!/^[a-f0-9]{64}$/.test(result.sha256||''))throw fail(messages.findLast(item=>item.event==='error')?.error||'GB10 未返回有效配音结果');
  await onProgress?.({phase:'transferring',message:'正在回传并核对原始角色配音 WAV'});const transferStarted=performance.now(),bytes=await ssh('docker exec rack-h3 cat /data/tts/outputs/'+jobId+'.wav',{raw:true,timeout:120000,maxBytes:64*1024*1024});if(bytes.length!==result.bytes||createHash('sha256').update(bytes).digest('hex')!==result.sha256)throw fail('配音回传字节数或SHA256不匹配');
  const directory=join(dataDir,'tts','outputs');await mkdir(directory,{recursive:true});const file=join(directory,jobId+'.wav');await writeFile(file,bytes,{flag:'wx'});
  return {file,...result,telemetry:{...result.telemetry,leaseWaitMs,comfyQueueWaitMs,transferMs:performance.now()-transferStarted,totalProductionMs:performance.now()-requested,remoteEvents:events.filter(value=>value.event==='progress')}};
 });
}
