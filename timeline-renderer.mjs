import {spawn} from 'node:child_process';
import {constants,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {mkdir,realpath,stat,writeFile,copyFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';
import {hasAudioAutomation,normalizeAudioAutomation,audioAutomationFilters} from './audio-envelope.mjs';
import {buildStoryboardCaption} from './storyboard-captions.mjs';
import {normalizeClipReframe,clipReframeSource,assertReframeExport} from './clip-reframe.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DURATION=600,MAX_CLIPS=200,MAX_AUDIO=64;
const FONT='C:/Windows/Fonts/msyh.ttc';
const n=value=>typeof value==='number'&&Number.isFinite(value);
const seconds=value=>Number(value.toFixed(6)).toString();
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function bounded(value,min,max,label){if(!n(value)||value<min||value>max)fail(`${label}应在 ${min} 到 ${max} 之间`);return value;}
function within(base,file){const rel=relative(base,file);if(!rel||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))fail('时间轴媒体路径越界');return file;}
function titleText(value,fallback){if(value===undefined||value===null)return fallback;if(typeof value!=='string'||value.length>2000||value.includes('\0'))fail('标题文字最多 2000 字');return value;}
function mediaById(work,id){const item=work.studio?.media?.find(item=>item.id===id);if(!item)fail('时间轴引用的本机素材不存在');return item;}
function framesFor(duration,fps){return Math.max(1,Math.round(duration*fps));}

/** Validate the saved timeline and freeze the selected, registered source versions. */
export function planTimeline(work,episodeId,timelineSnapshot,{mode='video',selectionSnapshot,captionCanvas,compileCaptions=true}={}){
  if(!['video','storyboard'].includes(mode))fail('导出模式须为 video 或 storyboard');
  if(!work||!UUID.test(work.id||''))fail('作品编号无效');
  if(!work.episodes?.some(item=>item.id===episodeId))fail('时间轴所属分集不存在');
  const timeline=timelineSnapshot??work.studio?.timelines?.[episodeId];
  assertReframeExport(timeline,{mode});
  if(!timeline||!Array.isArray(timeline.clips)||!timeline.clips.length)fail('先在时间轴添加分镜、片头或片尾');
  if(timeline.clips.length>MAX_CLIPS)fail(`时间轴最多 ${MAX_CLIPS} 段`);
  const width=timeline.width??1280,height=timeline.height??720,fps=timeline.fps??24;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>1920||height>1920||width%2||height%2)fail('导出宽高须为 64 到 1920 之间的偶数');
  if(![24,30].includes(fps))fail('导出帧率只支持 24 或 30 fps');
  const missing=[],clips=[];
  for(const saved of timeline.clips){
    if(!saved||typeof saved!=='object')fail('时间轴片段格式无效');
    if(saved.enabled===false)continue;
    if(!['title','shot','media'].includes(saved.type))fail('时间轴片段类型无效');
    if(saved.role!==undefined&&saved.role!==null&&!['intro','outro'].includes(saved.role))fail('片头片尾标记无效');
    let record=null,shot=null;
    if(saved.type==='shot'){
      shot=work.shots?.find(item=>item.id===saved.shotId&&item.episodeId===episodeId);
      if(!shot){missing.push(saved.title||'已移除的分镜');continue;}
      if(mode==='storyboard'){
        const frozen=selectionSnapshot?.find(item=>item.clipId===saved.id)??selectionSnapshot?.find(item=>item.shotId===shot.id),firstFrameId=frozen?frozen.firstFrameMediaId:shot.firstFrameMediaId;
        record=firstFrameId?work.studio?.media?.find(item=>item.id===firstFrameId&&item.type==='image'):null;
      }else{
        const selected=saved.assetId||shot.selectedAssetId;
        record=selected?work.assets?.find(item=>item.id===selected&&item.shotId===shot.id&&item.type==='video'):[...(work.assets||[])].reverse().find(item=>item.shotId===shot.id&&item.type==='video');
      }
      if(!record){missing.push(shot.title||saved.title||'未命名分镜');continue;}
    }else if(saved.mediaId){
      record=mediaById(work,saved.mediaId);
      if(!['image','video'].includes(record.type))fail('片头、片尾和画面只能使用图片或视频素材');
    }else if(saved.type==='media')fail('时间轴片段尚未选择本机素材');
    const type=record?(record.type==='image'?'image':'video'):'title';
    const duration=bounded(saved.duration??(saved.type==='title'||saved.role?2:shot?.duration??record?.duration??4),1/fps,MAX_DURATION,'片段时长');
    const frames=framesFor(duration,fps),trimStart=bounded(saved.trimStart??0,0,MAX_DURATION,'片段入点');
    const background=saved.background??saved.color??'101827';
    if(typeof background!=='string'||!/^#?[0-9a-f]{6}$/i.test(background))fail('标题背景色须为六位十六进制颜色');
    const frozen=shot&&(selectionSnapshot?.find(item=>item.clipId===saved.id)??selectionSnapshot?.find(item=>item.shotId===shot.id));
    const reframe=normalizeClipReframe(saved.reframe,{work,clip:saved,mode});
    clips.push({id:saved.id,type,sourceType:saved.type,role:saved.role??null,shotId:shot?.id??null,assetId:saved.type==='shot'&&mode==='video'?record.id:null,mediaId:mode==='storyboard'&&shot?record.id:saved.mediaId??null,...(reframe?{reframe,reframeSourceSnapshot:frozen?.reframeSourceSnapshot??null}:{}),...(mode==='storyboard'&&shot?{firstFrameMediaId:record.id,firstFrameSnapshot:frozen?.firstFrameSnapshot??null,captionSnapshot:frozen?.captionSnapshot??(compileCaptions?buildStoryboardCaption(work,shot,{duration:frames/fps,fps,columns:Math.max(8,Math.floor((captionCanvas?.width??width)*.9/Math.max(10,Math.round((captionCanvas?.height??height)*.038)))),maxLines:3}):null)}:{}),exportMode:mode,record,title:titleText(saved.title,shot?.title||(saved.role==='outro'?'感谢观看':work.title||'')),subtitle:titleText(saved.subtitle,''),duration:frames/fps,frames,trimStart:type==='image'?0:trimStart,muted:saved.muted===true,background:background.replace('#','')});
  }
  if(missing.length)fail(mode==='storyboard'?`以下分镜缺少同作品已绑定的首帧图片，请先绑定：${missing.join('、')}`:`以下分镜还没有可用成片，请先生成或选择版本：${missing.join('、')}`,409);
  if(!clips.length)fail('时间轴没有启用的画面片段');
  if(clips.some((clip,index)=>clip.role==='intro'&&index!==0||clip.role==='outro'&&index!==clips.length-1))fail('片头应位于时间轴开头，片尾应位于末尾');
  const frames=clips.reduce((sum,clip)=>sum+clip.frames,0),duration=frames/fps;
  if(duration>MAX_DURATION)fail(`导出总时长不能超过 ${MAX_DURATION} 秒`);
  const savedAudio=timeline.audio??[];
  if(!Array.isArray(savedAudio)||savedAudio.length>MAX_AUDIO)fail(`时间轴最多 ${MAX_AUDIO} 条声音素材`);
  const audio=savedAudio.filter(item=>item?.enabled!==false).map(item=>{
    if(!item||!['voice','music','sfx'].includes(item.kind))fail('声音轨道类型无效');
    const record=mediaById(work,item.mediaId);
    if(!['audio','video'].includes(record.type))fail('声音轨道只能选择音频或带音轨的视频');
    const start=bounded(item.start??0,0,duration,'声音开始位置');
    if(start>=duration)fail('声音开始位置应早于成片结尾');
    const trimStart=bounded(item.trimStart??0,0,MAX_DURATION,'声音素材入点');
    const requestedDuration=bounded(item.duration??Math.min(record.duration??duration,duration-start),1/48000,MAX_DURATION,'声音时长');
    const actualDuration=Math.min(requestedDuration,duration-start);
    return {id:item.id,kind:item.kind,mediaId:item.mediaId,record,start,trimStart,duration:actualDuration,gain:bounded(item.gain??1,0,2,'音量'),loop:item.loop===true,...(hasAudioAutomation(item)?normalizeAudioAutomation(item,actualDuration):{})};
  });
  return {width,height,fps,frames,duration,clips,audio};
}

/** Export dimensions are independent of the edit snapshot and preview canvas. */
export function normalizeExportOptions(value,timeline){
  if(value===undefined)value={};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['mode','enhance','width','height'].includes(key)))fail('导出选项格式无效');
  const mode=value.mode===undefined?'video':value.mode;if(!['video','storyboard'].includes(mode))fail('导出模式须为 video 或 storyboard');
  const enhance=value.enhance??'none';if(!['none','ai-1080p'].includes(enhance))fail('请选择普通导出或 AI 1080P 超分');
  if(mode==='storyboard'&&enhance==='ai-1080p')fail('故事板静态预演不支持 AI 超分；请使用普通本机预演导出');
  if(('width'in value)!==('height'in value))fail('导出宽高须一并指定');
  const canvasWidth=timeline.width??1280,canvasHeight=timeline.height??720;
  const defaults=enhance==='ai-1080p'?(canvasWidth===canvasHeight?[1080,1080]:canvasWidth>canvasHeight?[1920,1080]:[1080,1920]):[canvasWidth,canvasHeight];
  const width=value.width??defaults[0],height=value.height??defaults[1];
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>1920||height>1920||width%2||height%2)fail('导出宽高须为 64 到 1920 之间的偶数');
  if(enhance==='ai-1080p'&&Math.min(width,height)<1080)fail('AI 发布版的短边至少为 1080 像素');
  return {...('mode'in value?{mode}:{}),enhance,width,height};
}

/** Resolve only an already registered relative media path, rejecting symlink escapes. */
export async function resolveTimelineMedia(workspaceDirectory,record){
  const path=record?.relativePath;
  if(typeof path!=='string'||!path.startsWith('assets/')||path.includes('\\')||path.includes('\0')||path.split('/').some(part=>!part||part==='.'||part==='..')||isAbsolute(path)||/^[a-z][a-z0-9+.-]*:/i.test(path))fail('时间轴素材路径无效');
  const directory=await realpath(workspaceDirectory),file=await realpath(within(directory,resolve(directory,path)));
  within(directory,file);
  const info=await stat(file);if(!info.isFile()||info.size<1)fail('时间轴素材文件为空或不是普通文件',409);
  return file;
}

async function run(executable,args,{cwd,timeout=60_000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',finished=false;
    const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(stdout);};
    const timer=setTimeout(()=>{child.kill();finish(Object.assign(new Error('本机视频导出超时，请缩短时间轴后重试'),{status:504}));},Math.min(900_000,timeout));
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024){child.kill();finish(new Error('媒体分析输出超过限制'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-5000);});
    child.on('error',error=>finish(error.code==='ENOENT'?Object.assign(new Error('本机 FFmpeg/FFprobe 尚未安装'),{status:503}):error));
    child.on('close',code=>finish(code===0?null:Object.assign(new Error(`本机视频处理失败${stderr?'：'+stderr:''}`),{status:502})));
  });
}
async function probe(executable,file,{countFrames=false}={}){
  const args=['-v','error','-protocol_whitelist','file,pipe',...(countFrames?['-count_frames']:[]),'-show_entries','stream=codec_type,codec_name,width,height,nb_frames,nb_read_frames,avg_frame_rate,r_frame_rate,duration,sample_rate,channels:format=duration','-of','json',file];
  const value=JSON.parse(await run(executable,args,{timeout:60_000}));
  const video=value.streams?.find(item=>item.codec_type==='video'),audio=value.streams?.find(item=>item.codec_type==='audio');
  const fraction=value=>{const [n,d]=String(value??'0').split('/').map(Number);const result=d?n/d:n;return Number.isFinite(result)&&result>0?result:null;};
  const frames=Number(video?.nb_read_frames)||Number(video?.nb_frames)||null,fps=fraction(video?.avg_frame_rate)||fraction(video?.r_frame_rate),duration=Number(video?.duration)||(frames&&fps?frames/fps:null)||Number(value.format?.duration)||null;
  return {width:Number(video?.width)||null,height:Number(video?.height)||null,frames,fps,duration,containerDuration:Number(value.format?.duration)||null,hasVideo:Boolean(video),hasAudio:Boolean(audio),audioSampleRate:Number(audio?.sample_rate)||null,audioChannels:Number(audio?.channels)||null,videoCodec:video?.codec_name??null,audioCodec:audio?.codec_name??null};
}
const globals=['-nostdin','-hide_banner','-loglevel','error','-filter_complex_threads','2','-y'];
const localInput=file=>['-protocol_whitelist','file,pipe','-i',file];
const encoder=['-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-threads:v','4','-c:a','aac','-b:a','192k','-ar','48000','-ac','2'];

/** Pure command builder: user text is stored separately, never interpolated into filters. */
export function buildSegmentArguments(clip,plan,index){
  const {width,height,fps}=plan,duration=seconds(clip.duration),args=[...globals];
  if(clip.reframe){const r=clip.reframe;if(!['sourceWidth','sourceHeight','x','y','width','height'].every(key=>Number.isSafeInteger(r[key]))||r.x<0||r.y<0||r.width<2||r.height<2||r.x+r.width>r.sourceWidth||r.y+r.height>r.sourceHeight)fail('重构图滤镜仅接受有效整数源像素矩形');}
  if(clip.type==='title')args.push('-f','lavfi','-i',`color=c=0x${clip.background}:s=${width}x${height}:r=${fps}:d=${duration}`);
  else if(clip.type==='image')args.push('-loop','1','-framerate',String(fps),...localInput(clip.file));
  else args.push('-ss',seconds(clip.trimStart),...localInput(clip.file));
  const originalAudio=clip.type==='video'&&!clip.muted&&clip.probe?.hasAudio;
  if(!originalAudio)args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
  const crop=clip.reframe?`crop=${clip.reframe.width}:${clip.reframe.height}:${clip.reframe.x}:${clip.reframe.y}:exact=1,`:'';
  const video=[`[0:v:0]${crop}scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,'setsar=1',`fps=${fps}`,`tpad=stop_mode=clone:stop_duration=${duration}`,`trim=duration=${duration}`,'setpts=PTS-STARTPTS','format=yuv420p'];
  if(clip.type==='title'){
    const titleSize=Math.max(20,Math.round(height*.07)),subtitleSize=Math.max(14,Math.round(height*.035));
    video.push(`drawtext=fontfile=font.ttc:textfile=title-${index}.txt:expansion=none:fontcolor=white:fontsize=${titleSize}:line_spacing=12:x=(w-text_w)/2:y=(h-text_h)/2`);
    if(clip.subtitle)video.push(`drawtext=fontfile=font.ttc:textfile=subtitle-${index}.txt:expansion=none:fontcolor=0xc5cddd:fontsize=${subtitleSize}:line_spacing=8:x=(w-text_w)/2:y=h*0.7`);
  }
  if(clip.exportMode==='storyboard'&&clip.sourceType==='shot'){
    const fontSize=Math.max(10,Math.round(height*.038)),labelSize=Math.max(10,Math.round(height*.03)),margin=Math.max(3,Math.round(height*.035));
    video.push(`drawtext=fontfile=font.ttc:textfile=storyboard-label-${index}.txt:expansion=none:fontcolor=white:fontsize=${labelSize}:box=1:boxcolor=black@0.65:boxborderw=3:x=${margin}:y=${margin}`);
    for(let eventIndex=0;eventIndex<(clip.captionSnapshot?.events?.length||0);eventIndex++){
      const event=clip.captionSnapshot.events[eventIndex];
      if(!n(event.start)||!n(event.end)||event.start<0||event.end<=event.start||event.end>clip.duration+.001)fail('计划对白的字幕时段无效');
      video.push(`drawtext=fontfile=font.ttc:textfile=storyboard-caption-${index}-${eventIndex}.txt:expansion=none:fontcolor=white:fontsize=${fontSize}:line_spacing=2:box=1:boxcolor=black@0.7:boxborderw=3:x=(w-text_w)/2:y=h-text_h-${margin}:enable='gte(t,${seconds(event.start)})*lt(t,${seconds(event.end)})'`);
    }
  }
  const audio=`[${originalAudio?0:1}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a]`;
  args.push('-filter_complex',video.join(',')+'[v];'+audio,'-map','[v]','-map','[a]',...encoder,'-r',String(fps),'-frames:v',String(clip.frames),'-t',duration,'-movflags','+faststart',`segment-${index}.mp4`);
  return args;
}

export function buildMixArguments(plan){
  const args=[...globals,...localInput('concatenated.mp4')],filters=[`[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${seconds(plan.duration)},asetpts=PTS-STARTPTS[base]`],labels=['[base]'];
  for(let i=0;i<plan.audio.length;i++){
    const track=plan.audio[i],label=`a${i}`;
    if(track.loop)args.push('-stream_loop','-1');
    args.push('-ss',seconds(track.trimStart),...localInput(track.file));
    const duration=seconds(track.duration),delay=Math.round(track.start*48000);
    const automation=hasAudioAutomation(track)?audioAutomationFilters(track,track.duration,track.gain):null;
    filters.push(`[${i+1}:a:0]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${automation?.[0]??'volume='+track.gain},apad,atrim=duration=${duration},${automation&&automation.length>1?automation.slice(1).join(',')+',':''}adelay=${delay}S:all=1[${label}]`);
    labels.push(`[${label}]`);
  }
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false:latency=true,atrim=duration=${seconds(plan.duration)},asetpts=PTS-STARTPTS[mix]`);
  args.push('-filter_complex',filters.join(';'),'-map','0:v:0','-map','[mix]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-t',seconds(plan.duration),'-movflags','+faststart','finished.mp4');
  return args;
}

function wrapText(value,columns){return value.split(/\r?\n/).map(line=>{const words=[...line];let result='',width=0;for(const char of words){const size=char.codePointAt(0)>255?2:1;if(width+size>columns){result+='\n';width=0;}result+=char;width+=size;}return result;}).join('\n');}
async function safeDirectory(workspace,name){const directory=join(workspace,name);await mkdir(directory,{recursive:true});const canonical=await realpath(directory);within(workspace,canonical);return canonical;}

/** Render registered local media; no network, shell, GPU, or catalog mutation. */
export async function renderTimeline({work,episodeId,timelineSnapshot,selectionSnapshot,workspaceDirectory,dataDir,exportId,onProgress,exportOptions,upscaleSource}){
  if(!UUID.test(exportId||''))fail('导出编号无效');
  const options=normalizeExportOptions(exportOptions,timelineSnapshot??work.studio?.timelines?.[episodeId]??{}),mode=options.mode??'video',plan=planTimeline(work,episodeId,timelineSnapshot,{mode,selectionSnapshot,captionCanvas:options}),startedAt=new Date().toISOString(),start=performance.now();
  assertReframeExport(timelineSnapshot??work.studio?.timelines?.[episodeId],options);
  plan.width=options.width;plan.height=options.height;
  const report=async value=>{if(onProgress)await onProgress(value);};
  await report({phase:'validating',message:'正在核对时间轴素材与本机编码器'});
  const workspace=await realpath(workspaceDirectory),root=await realpath(join(dataDir,'toonflow','workspaces'));
  within(root,workspace);
  if(workspace!==await realpath(join(root,'works-'+work.id)))fail('导出目录与作品不一致');
  const executable=resolve(dataDir,'toonflow','ffmpeg','win32-x64','ffmpeg.exe'),ffprobe=resolve(dataDir,'toonflow','ffmpeg','win32-x64','ffprobe.exe');
  for(const file of [executable,ffprobe])if(!(await stat(file)).isFile())fail('本机编码器不可用',503);
  const known=new Map(),enhancedSources=[],imageSources=[],nativeVideoSources=[];
  const upscaler=options.enhance==='ai-1080p'?(upscaleSource||(await import('./ai-upscale.mjs')).upscaleTimelineSource):null;
  const resolveSource=async(record,forPicture=false)=>{
    const file=await resolveTimelineMedia(workspace,record);
    if(!known.has(file)){
      const original=await probe(ffprobe,file);let selected={file,probe:original};
      const needsLargerVideo=forPicture&&record.type==='video'&&original.hasVideo&&Math.min(plan.width/original.width,plan.height/original.height)>1;
      if(upscaler&&needsLargerVideo){
        await report({phase:'upscaling',message:'正在用 AI 超分原生视频素材：'+(record.name||record.id||'画面')});
        const result=await upscaler({file,record:structuredClone(record),probe:structuredClone(original),workId:work.id,exportId,dataDir,workspaceDirectory:workspace,onProgress:report});
        if(!result||typeof result.file!=='string'||!result.telemetry)fail('AI 超分未返回可验证的素材与执行记录',502);
        const actualFile=within(workspace,await realpath(result.file));if(!(await stat(actualFile)).isFile())fail('AI 超分输出不是当前作品的普通文件',502);
        const actual=await probe(ffprobe,actualFile,{countFrames:true});
        if(!actual.hasVideo||actual.width<=original.width||actual.height<=original.height||original.frames&&actual.frames!==original.frames||original.fps&&Math.abs(actual.fps-original.fps)>0.001||original.hasAudio&&!actual.hasAudio||original.duration&&Math.abs(actual.duration-original.duration)>1/(original.fps||24)+0.01)fail('AI 超分输出未保持实际帧数、帧率、时长或原声',502);
        selected={file:actualFile,probe:actual};enhancedSources.push({...structuredClone(result.telemetry),sourceId:record.id??null,sourcePath:record.relativePath,inputWidth:original.width,inputHeight:original.height,outputWidth:actual.width,outputHeight:actual.height});
      }else if(upscaler&&forPicture&&record.type==='image')imageSources.push({sourceId:record.id??null,sourcePath:record.relativePath,method:'ordinary-resize',reason:'当前 AI 超分仅处理视频，图片按导出画布普通适配'});
      else if(upscaler&&forPicture&&record.type==='video')nativeVideoSources.push({sourceId:record.id??null,sourcePath:record.relativePath,width:original.width,height:original.height,reason:'按实际画幅适配不需要放大'});
      known.set(file,selected);
    }
    return known.get(file);
  };
  for(const clip of plan.clips)if(clip.record){Object.assign(clip,await resolveSource(clip.record,true));if(!clip.probe.hasVideo)fail(`画面素材没有视频或图片轨：${clip.record.name||clip.title}`,409);if(clip.type==='video'&&clip.probe.duration&&clip.trimStart>=clip.probe.duration)fail(`片段入点已超过素材结尾：${clip.title}`,409);if(mode==='storyboard'){const hash=createHash('sha256');for await(const chunk of createReadStream(clip.file))hash.update(chunk);clip.sourceSha256=hash.digest('hex');if(clip.firstFrameSnapshot&&clip.firstFrameSnapshot.sha256!==clip.sourceSha256)fail(`故事板首帧在提交后发生变化：${clip.title}`,409);}}
  for(const track of plan.audio){Object.assign(track,await resolveSource(track.record));if(!track.probe.hasAudio)fail(`声音素材没有可用音轨：${track.record.name||track.kind}`,409);if(track.probe.duration&&track.trimStart>=track.probe.duration)fail(`声音入点已超过素材结尾：${track.record.name||track.kind}`,409);}
  for(const clip of plan.clips)if(clip.reframe){
    normalizeClipReframe(clip.reframe,{work,clip:{...clip,type:clip.sourceType},actualSource:clip.probe});
    const source=clipReframeSource(work,{...clip,type:clip.sourceType}),before=await stat(clip.file),hash=createHash('sha256');for await(const chunk of createReadStream(clip.file))hash.update(chunk);const after=await stat(clip.file),sha256=hash.digest('hex'),expectedSha=clip.reframeSourceSnapshot?.sha256||source.asset.sha256||source.job?.telemetry?.sha256;
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||expectedSha&&expectedSha!==sha256)fail('重构图源视频在提交后发生变化，未执行裁切：'+clip.title,409);
    clip.reframeSource={assetId:clip.assetId,sha256,bytes:before.size,width:clip.probe.width,height:clip.probe.height,appliedRect:{x:clip.reframe.x,y:clip.reframe.y,width:clip.reframe.width,height:clip.reframe.height},coordinateSpace:'original-source-pixels',method:'crop-before-scale',sourcePath:clip.record.relativePath};
  }
  if(mode==='storyboard')for(const clip of plan.clips)if(clip.firstFrameMediaId&&!['png','mjpeg','webp'].includes(clip.probe?.videoCodec))fail('故事板绑定文件不是真实 PNG/JPEG/WebP 首帧图片：'+clip.title,409);
  const temporaryRoot=await safeDirectory(workspace,'.rack-renders'),exports=await safeDirectory(workspace,'exports'),renderDirectory=join(temporaryRoot,exportId);
  try{await mkdir(renderDirectory,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('相同导出任务已在处理或存在临时文件',409);throw error;}
  within(workspace,await realpath(renderDirectory));
  const output=join(exports,'export'+exportId+'.mp4');
  try{
    if(plan.clips.some(clip=>clip.type==='title'||clip.exportMode==='storyboard'&&clip.sourceType==='shot'))await copyFile(FONT,join(renderDirectory,'font.ttc'));
    for(let index=0;index<plan.clips.length;index++){
      const clip=plan.clips[index];
      if(clip.type==='title'){
        await writeFile(join(renderDirectory,`title-${index}.txt`),wrapText(clip.title,36),'utf8');
        await writeFile(join(renderDirectory,`subtitle-${index}.txt`),wrapText(clip.subtitle,64),'utf8');
      }
      if(clip.exportMode==='storyboard'&&clip.sourceType==='shot'){
        await writeFile(join(renderDirectory,`storyboard-label-${index}.txt`),(clip.captionSnapshot?.shotLabel||clip.title)+' · 静态首帧预演','utf8');
        for(let eventIndex=0;eventIndex<(clip.captionSnapshot?.events?.length||0);eventIndex++)await writeFile(join(renderDirectory,`storyboard-caption-${index}-${eventIndex}.txt`),clip.captionSnapshot.events[eventIndex].text,'utf8');
      }
      await report({phase:'segments',completed:index,total:plan.clips.length,message:`正在渲染第 ${index+1} / ${plan.clips.length} 段：${clip.title||'画面'}`});
      await run(executable,buildSegmentArguments(clip,plan,index),{cwd:renderDirectory,timeout:Math.max(60_000,clip.duration*10_000+30_000)});
      await report({phase:'segments',completed:index+1,total:plan.clips.length,message:`已完成 ${index+1} / ${plan.clips.length} 段画面`});
    }
    await writeFile(join(renderDirectory,'segments.ffconcat'),'ffconcat version 1.0\n'+plan.clips.map((clip,index)=>`file 'segment-${index}.mp4'\nduration ${seconds(clip.duration)}\n`).join(''),'utf8');
    await report({phase:'joining',message:'正在按时间轴顺序拼接画面'});
    await run(executable,[...globals,'-protocol_whitelist','file,pipe','-f','concat','-safe','1','-i','segments.ffconcat','-map','0:v:0','-map','0:a:0','-c','copy','-t',seconds(plan.duration),'-movflags','+faststart','concatenated.mp4'],{cwd:renderDirectory,timeout:Math.max(60_000,plan.duration*2000)});
    await report({phase:'audio',message:plan.audio.length?'正在混合配音、配乐和音效':'正在保留原声并完成音轨编码'});
    await run(executable,buildMixArguments(plan),{cwd:renderDirectory,timeout:Math.max(60_000,plan.duration*5000)});
    await report({phase:'checking',message:'正在核对实际成片时长、画面尺寸和音轨'});
    const finished=join(renderDirectory,'finished.mp4'),actual=await probe(ffprobe,finished,{countFrames:true});
    if(!actual.hasVideo||!actual.hasAudio||actual.width!==plan.width||actual.height!==plan.height||!actual.duration||actual.frames!==plan.frames)fail('导出文件未通过视频、帧数或音轨检查',502);
    if(mode==='storyboard')for(const clip of plan.clips)if(clip.file){const hash=createHash('sha256');for await(const chunk of createReadStream(clip.file))hash.update(chunk);if(hash.digest('hex')!==clip.sourceSha256)fail('故事板源素材在渲染中发生变化：'+clip.title,409);}
    for(const clip of plan.clips)if(clip.reframeSource){const hash=createHash('sha256');for await(const chunk of createReadStream(clip.file))hash.update(chunk);if(hash.digest('hex')!==clip.reframeSource.sha256)fail('重构图源视频在渲染中发生变化：'+clip.title,409);}
    await copyFile(finished,output,constants.COPYFILE_EXCL);
    const result={relativePath:'exports/export'+exportId+'.mp4',filename:'export'+exportId+'.mp4',mimeType:'video/mp4',bytes:(await stat(output)).size,...actual,durationSeconds:actual.duration,plannedDuration:plan.duration,exportMode:mode,exportOptions:options,...(upscaler?{enhancement:{requested:'ai-1080p',method:enhancedSources.length?'real-esrgan':'not-required',model:enhancedSources[0]?.model??null,sources:enhancedSources,imageSources,nativeVideoSources,postResize:{method:'ordinary-resize',width:plan.width,height:plan.height},sourceAudioPreserved:true}}:{}),renderStartedAt:startedAt,renderFinishedAt:new Date().toISOString(),renderMs:performance.now()-start,sourceClips:plan.clips.map(({id,type,sourceType,role,shotId,assetId,mediaId,duration,trimStart,muted,firstFrameMediaId,sourceSha256,captionSnapshot,reframe,reframeSource})=>({id,type:sourceType,renderedType:type,role,shotId,assetId,mediaId,duration,trimStart,muted,exportMode:mode,...(reframe?{reframe,reframeSource,originalSourceSha256:reframeSource.sha256,originalSourceDimensions:{width:reframeSource.width,height:reframeSource.height},appliedRect:reframeSource.appliedRect}:{}),...(mode==='storyboard'?{mode,firstFrameMediaId:firstFrameMediaId??null,sourceSha256:sourceSha256??null,cueSnapshot:captionSnapshot??null}:{})})),audioTracks:plan.audio.map(track=>{const {id,kind,mediaId,start,trimStart,duration,gain,loop}=track;return {id,kind,mediaId,start,trimStart,duration,gain,loop,...(hasAudioAutomation(track)?normalizeAudioAutomation(track,duration):{})};})};
    await report({phase:'completed',message:'成片已导出并通过实际媒体检查'});
    return result;
  }finally{
    // This exact newly-created, canonical directory belongs only to this render.
    within(temporaryRoot,renderDirectory);await rm(renderDirectory,{recursive:true,force:true});
  }
}
