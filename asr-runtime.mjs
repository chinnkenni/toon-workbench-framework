import {readFile,stat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve,dirname,isAbsolute,relative,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

const ROOT=dirname(fileURLToPath(import.meta.url)),verified=new Map();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const ASR_LIMITS={durationSeconds:600,sourceBytes:2*1024*1024*1024,resultBytes:16*1024*1024,expectedLines:200};
export async function asrSha256(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export async function runAsrProcess(executable,args,{timeout=60*60*1000,maxOutput=2*1024*1024,cwd}={}){
 return new Promise((done,reject)=>{
  const child=spawn(executable,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],...(cwd?{cwd}:{})});let stdout='',stderr='',finished=false;
  const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):done({stdout,stderr});};
  const timer=setTimeout(()=>{child.kill();finish(fail('本机转写处理超时',504));},timeout);timer.unref?.();
  child.stdout.on('data',data=>{stdout+=data;if(Buffer.byteLength(stdout)>maxOutput){child.kill();finish(fail('本机转写输出超过限制',502));}});
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-8000);});
  child.on('error',()=>finish(fail('本机转写运行器无法启动',503)));
  child.on('close',code=>finish(code===0?null:fail('本机转写运行器执行失败：'+stderr.slice(-1500),502)));
 });
}
/** whisper.cpp Windows narrow file I/O needs ASCII argv; CreateProcessW handles Unicode cwd. */
export function whisperInvocation({modelPath,audioPath,outputPrefix,threads,cwd=ROOT,platform=process.platform}){
 const paths=platform==='win32'?win32:{resolve,relative,isAbsolute};
 if(typeof cwd!=='string'||!cwd||cwd.includes('\0')||!paths.isAbsolute(cwd))throw fail('转写运行目录必须为绝对路径',503);
 const workingDirectory=paths.resolve(cwd);
 function argument(value){
  if(typeof value!=='string'||!value||value.includes('\0')||!paths.isAbsolute(value))throw fail('转写输入、模型与输出必须是已校验的绝对路径',503);
  const part=paths.relative(workingDirectory,paths.resolve(value));
  if(!part||paths.isAbsolute(part)||platform==='win32'&&!/^[\x20-\x7e]+$/.test(part))throw fail('Windows 转写需要同盘 ASCII 相对路径；请检查既有部署和输出位置',503);
  return part.replaceAll('\\','/');
 }
 return {cwd:workingDirectory,args:['--no-gpu','-l','zh','-ojf','-of',argument(outputPrefix),'-m',argument(modelPath),'-f',argument(audioPath),'-t',String(threads)]};
}
function ffmpeg(context,name){return context[name+'Path']||(process.platform==='win32'?join(context.dataDir,'toonflow/ffmpeg/win32-x64',name+'.exe'):name);}
export async function probeAsrSource(file,context={}){
 const raw=context.probeAsrSource?await context.probeAsrSource(file):JSON.parse((await runAsrProcess(ffmpeg(context,'ffprobe'),['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],{timeout:30000,maxOutput:512*1024})).stdout);
 const audio=raw.streams?.find(stream=>stream.codec_type==='audio'),duration=Number(audio?.duration??raw.format?.duration),sampleRate=Number(audio?.sample_rate),channels=Number(audio?.channels);
 if(!audio||!Number.isFinite(duration)||duration<=0||duration>ASR_LIMITS.durationSeconds||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>384000||!Number.isInteger(channels)||channels<1||channels>32)throw fail('音轨缺失，或真实音频时长/格式超出本机转写限制');
 return {duration,sampleRate,channels,audioCodec:audio.codec_name||null};
}
function pathFrom(value){if(typeof value!=='string'||!value||value.includes('\0'))throw fail('转写部署路径无效',503);return isAbsolute(value)?value:resolve(ROOT,value);}
async function checkedFile(file,expected){
 if(!/^[a-f0-9]{64}$/i.test(expected||''))throw fail('转写部署缺少固定 SHA256',503);
 const path=await realpath(pathFrom(file)),before=await stat(path);if(!before.isFile()||before.size<=0)throw fail('转写部署文件无效',503);
 const cacheKey=path+'|'+before.size+'|'+before.mtimeMs+'|'+before.ctimeMs;
 let hash=verified.get(cacheKey);if(!hash){hash=await asrSha256(path);const after=await stat(path);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw fail('转写部署校验期间文件发生变化',503);verified.set(cacheKey,hash);}
 if(hash.toLowerCase()!==expected.toLowerCase())throw fail('转写部署文件 SHA256 不符',503);return {path,sha256:hash,bytes:before.size};
}
export async function getWhisperCapability(context={}){
 try{
  const manifest=context.asrManifest||JSON.parse(await readFile(join(ROOT,'deployment/asr-model.json'),'utf8'));
  const runtime=manifest.runtime||{},model=manifest.model||manifest;
  if(typeof runtime.revision!=='string'||!runtime.revision||typeof (model.revision||manifest.revision)!=='string'||!(model.revision||manifest.revision)||runtime.engine&&runtime.engine!=='whisper.cpp')throw fail('转写部署缺少固定版本或引擎不匹配',503);
  const executable=await checkedFile(runtime.executablePath||runtime.path,runtime.sha256||runtime.executableSha256),weight=await checkedFile(model.path||model.modelPath,model.sha256);
  const files=[];if(runtime.files!==undefined){if(!Array.isArray(runtime.files)||runtime.files.length>64)throw fail('转写运行器依赖清单无效',503);for(const dependency of runtime.files){const file=await checkedFile(dependency.path,dependency.sha256);files.push({path:dependency.path,sha256:file.sha256,bytes:file.bytes});}}
  return {available:true,ready:true,engine:'whisper.cpp',device:'cpu',model:{id:model.id||manifest.id,name:model.name||manifest.name||'Whisper multilingual small',fileName:model.fileName,revision:model.revision||manifest.revision,sha256:weight.sha256,bytes:weight.bytes},runtime:{engine:'whisper.cpp',revision:runtime.revision,version:runtime.version||null,build:runtime.build||null,sha256:executable.sha256,files},limits:ASR_LIMITS,message:'本机 CPU 转写已就绪；仅检测识别文本，不验证声龄、说话人或口型。',_paths:{executable:executable.path,model:weight.path}};
 }catch(error){return {available:false,ready:false,engine:'whisper.cpp',device:'cpu',model:null,runtime:null,limits:ASR_LIMITS,message:error.code==='ENOENT'?'本机转写模型或运行器尚未准备完成':error.message};}
}
export function parseWhisperResult(raw){
 if(!raw||typeof raw!=='object'||!Array.isArray(raw.transcription))throw fail('Whisper 完整 JSON 未包含真实分段',502);
 if(raw.transcription.length>20000)throw fail('转写分段数量超过限制',502);
 const segments=raw.transcription.map((segment,index)=>{
  const from=segment.offsets?.from,to=segment.offsets?.to,start=from/1000,end=to/1000;
  if(typeof segment.text!=='string'||segment.text.length>100000||typeof from!=='number'||typeof to!=='number'||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>ASR_LIMITS.durationSeconds+5)throw fail('Whisper 分段文本或时码无效',502);
  return {id:index,start,end,text:segment.text,timestamps:segment.timestamps??null};
 });
 return {text:segments.map(segment=>segment.text).join(''),segments,raw};
}
export async function runWhisperAsr({sourcePath,outputDir,sourceSnapshot,context={},capability,onProgress}){
 const ready=await getWhisperCapability(context);if(!ready.ready)throw fail(ready.message,503);
 const identity=value=>JSON.stringify({model:{id:value?.model?.id,revision:value?.model?.revision,sha256:value?.model?.sha256},runtime:{engine:value?.runtime?.engine,revision:value?.runtime?.revision,version:value?.runtime?.version,build:value?.runtime?.build,sha256:value?.runtime?.sha256,files:[...(value?.runtime?.files||[])].map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes})).sort((a,b)=>a.path.localeCompare(b.path))}});
 if(identity(capability)!==identity(ready))throw fail('排队后转写部署已变化，请重新提交',409);
 const audioPath=join(outputDir,'source-16k-mono.wav'),outputPrefix=join(outputDir,'transcript');
 const ffmpegArgs=['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-i',sourcePath,'-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',audioPath];
 const threads=Number.isInteger(context.asrThreads)&&context.asrThreads>=1&&context.asrThreads<=16?context.asrThreads:4;
 const {args,cwd}=whisperInvocation({modelPath:ready._paths.model,audioPath,outputPrefix,threads});
 const execution={engine:'whisper.cpp',device:'cpu',model:ready.model,runtime:ready.runtime,executable:ready._paths.executable,cwd,args,ffmpegArgs,language:'zh',threads,initialPrompt:null,startedAt:new Date().toISOString(),finishedAt:null,conversionMs:null,inferenceMs:null,conversionStartedAt:null,inferenceStartedAt:null,resultSha256:null};let audio=null;
 const run=context.runAsrProcess||runAsrProcess;
 try{
  execution.conversionStartedAt=new Date().toISOString();const conversionStart=performance.now();
  await onProgress?.({execution:structuredClone(execution),audio});
  try{await run(ffmpeg(context,'ffmpeg'),ffmpegArgs,{timeout:120000});}finally{execution.conversionMs=performance.now()-conversionStart;}
  if(await asrSha256(sourcePath)!==sourceSnapshot.sha256)throw fail('提取音轨时源文件发生变化',409);
  const audioProbe=await probeAsrSource(audioPath,context),audioStat=await stat(audioPath);
  if(audioProbe.sampleRate!==16000||audioProbe.channels!==1||audioProbe.audioCodec!=='pcm_s16le')throw fail('转写输入未通过 16k 单声道 PCM 校验',502);
  audio={...audioProbe,sha256:await asrSha256(audioPath),bytes:audioStat.size,relativePath:'source-16k-mono.wav'};
  execution.inferenceStartedAt=new Date().toISOString();const start=performance.now();
  await onProgress?.({execution:structuredClone(execution),audio:structuredClone(audio)});
  try{await run(ready._paths.executable,args,{timeout:context.asrTimeoutMs||60*60*1000,cwd});}finally{execution.inferenceMs=performance.now()-start;}
  const file=join(outputDir,'transcript.json'),info=await stat(file);if(info.size>ASR_LIMITS.resultBytes)throw fail('Whisper JSON 超过限制',502);
  let raw;try{raw=JSON.parse(await readFile(file,'utf8'));}catch{throw fail('Whisper JSON 无效',502);}
  execution.resultSha256=await asrSha256(file);execution.finishedAt=new Date().toISOString();return {transcript:parseWhisperResult(raw),audio,execution};
 }catch(error){execution.finishedAt=new Date().toISOString();error.asrExecution=execution;error.asrAudio=audio;throw error;}
}
