import {useCallback,useEffect,useRef,useState} from 'react';
import {Badge,Button,Callout,Card,Flex,Slider,Spinner,Text,TextArea,TextField} from '@radix-ui/themes';
import {AudioLines,Check,Clock3,Download,FileText,Music2,Plus,RefreshCw,Sparkles} from 'lucide-react';
import './music-studio.css';

const ACTIVE=new Set(['queued','running']),STATUS={queued:'排队中',running:'正在制作',succeeded:'已完成',failed:'生成失败',interrupted:'待核对'};
const DRAFT='rack-music-draft-v1/',array=value=>Array.isArray(value)?value:[];
const decimal=value=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
const validNumber=value=>typeof value==='number'&&Number.isFinite(value);
const gainFraction=value=>String(value??'').trim()===''?NaN:Number(value)/100;
const STYLES=[{name:'温暖叙事',prompt:'温暖、克制的漫剧背景音乐，柔和钢琴与轻弦乐，带一点希望和怀念，旋律有留白，给对白留出空间。纯器乐，无人声、无吟唱、无对白。'},{name:'悬疑推进',prompt:'悬疑漫剧的推进配乐，低音弦乐与轻微脉冲节奏，神秘、紧张但不过度喧闹，结尾保留悬念。纯器乐，无人声、无吟唱、无对白。'},{name:'东方意境',prompt:'东方幻想漫剧配乐，古筝、竹笛与柔和弦乐，空灵、细腻、有画面感，旋律缓缓展开，适合叙事背景。纯器乐，无人声、无吟唱、无对白。'},{name:'轻快日常',prompt:'轻松日常漫剧配乐，木吉他、钢琴与轻打击乐，明亮、俏皮、自然，节奏轻巧，适合角色互动。纯器乐，无人声、无吟唱、无对白。'}];
function loadDraft(workId){try{return JSON.parse(localStorage.getItem(DRAFT+workId)||'{}')||{};}catch{return {};}}
function mediaForJob(work,job){const id=typeof job.media==='string'?job.media:job.media?.id;return array(work?.studio?.media).find(media=>media.id===id)||(job.media&&typeof job.media==='object'?job.media:null);}
export function mergeMusicJobs(previous,incoming){
 const rank={queued:1,running:2,succeeded:3,failed:3,interrupted:3},known=new Map(array(previous).map(job=>[job.id,job]));
 for(const job of array(incoming)){const old=known.get(job.id);if(old&&(rank[old.status]||0)>(rank[job.status]||0))continue;known.set(job.id,old?{...old,...job,media:job.media??old.media}:job);}
 return [...known.values()].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
}
export function musicPlacement(timeline,media,startValue,gainValue,loop=false){
 const total=array(timeline?.clips).filter(clip=>clip.enabled!==false).reduce((sum,clip)=>sum+Number(clip.duration||0),0);
 if(!Number.isFinite(total)||total<=0)throw new Error('先保存当前集的画面时间轴，再加入配乐。');
 const start=Number(startValue),gain=Number(gainValue),sourceDuration=Number(media?.duration);
 if(String(startValue??'').trim()===''||!Number.isFinite(start)||start<0||start>=total)throw new Error('配乐起点须在片头至片尾之间。');
 if(String(gainValue??'').trim()===''||!Number.isFinite(gain)||gain<0||gain>2)throw new Error('配乐音量须在 0–200% 之间。');
 if(!Number.isFinite(sourceDuration)||sourceDuration<=0)throw new Error('等待配乐归档并取得实际时长后，再加入时间轴。');
 const duration=loop?total-start:Math.min(sourceDuration,total-start);if(duration<1/48000)throw new Error('片尾剩余时间太短，请把起点提前。');
 return {start,duration,gain,loop:Boolean(loop),total,trimmed:!loop&&duration<sourceDuration-1e-6};
}

export default function MusicStudio({work,episodeId,api,toast,refresh}){
 const initial=useRef(null);if(!initial.current)initial.current=loadDraft(work.id);
 const [name,setName]=useState(initial.current.name||''),[prompt,setPrompt]=useState(initial.current.prompt||''),[duration,setDuration]=useState(initial.current.duration||'30'),[bpm,setBpm]=useState(initial.current.bpm||'90'),[seed,setSeed]=useState(initial.current.seed||'');
 const [capability,setCapability]=useState({available:false,message:'正在检查配乐服务…'}),[checking,setChecking]=useState(true),[jobs,setJobs]=useState([]),[submitting,setSubmitting]=useState(false),[importing,setImporting]=useState(null),[adding,setAdding]=useState(null),[placements,setPlacements]=useState({}),[error,setError]=useState(''),[jobsError,setJobsError]=useState('');
 const host=useRef(null),mounted=useRef(false),currentWork=useRef(work),capabilityRef=useRef(capability),capRead=useRef(null),jobRead=useRef(null),lastCheck=useRef(0),epoch=useRef(0),submissionLock=useRef(false),additionLock=useRef(false),importLock=useRef(false),synced=useRef(new Set());
 currentWork.current=work;capabilityRef.current=capability;
 const activeEpisodeId=episodeId||work.episodes?.[0]?.id,timeline=work.studio?.timelines?.[activeEpisodeId],total=array(timeline?.clips).filter(clip=>clip.enabled!==false).reduce((sum,clip)=>sum+Number(clip.duration||0),0),activeCount=jobs.filter(job=>ACTIVE.has(job.status)).length;
 const loadCapability=useCallback(async()=>{
  if(capRead.current)return capRead.current;
  const pending=(async()=>{if(mounted.current)setChecking(true);try{const value=await api('/api/music/capability');if(mounted.current)setCapability(value.capability||value);}catch(problem){if(mounted.current)setCapability({available:false,message:'配乐服务暂不可用：'+problem.message});}finally{lastCheck.current=Date.now();capRead.current=null;if(mounted.current)setChecking(false);}})();capRead.current=pending;return pending;
 },[api]);
 const loadJobs=useCallback(async()=>{
  if(jobRead.current)return jobRead.current;
  const version=epoch.current,pending=(async()=>{try{
   const result=await api('/api/music/jobs?workId='+encodeURIComponent(work.id));if(!mounted.current||version!==epoch.current)return;
   const incoming=array(result.jobs).filter(job=>(job.workId||job.request?.workId)===work.id);setJobs(previous=>{const next=mergeMusicJobs(previous,incoming);return JSON.stringify(next)===JSON.stringify(previous)?previous:next;});setJobsError('');
   const completed=incoming.filter(job=>job.status==='succeeded'&&job.media?.id&&!synced.current.has(job.id)&&!array(currentWork.current.studio?.media).some(media=>media.id===job.media.id));
   if(completed.length)try{await refresh(true);completed.forEach(job=>synced.current.add(job.id));}catch(problem){if(mounted.current)setJobsError('配乐已完成，作品素材同步暂时中断：'+problem.message);}
  }catch(problem){if(mounted.current)setJobsError('配乐任务暂时无法同步：'+problem.message);}finally{jobRead.current=null;}})();jobRead.current=pending;return pending;
 },[api,refresh,work.id]);
 useEffect(()=>{
  mounted.current=true;const node=host.current;void Promise.allSettled([loadCapability(),loadJobs()]);const timer=setInterval(()=>{if(document.hidden)return;void loadJobs();if(!capabilityRef.current.available&&Date.now()-lastCheck.current>=10000)void loadCapability();},2000);
  return()=>{mounted.current=false;clearInterval(timer);node?.querySelectorAll('audio').forEach(player=>player.pause());};
 },[loadCapability,loadJobs]);
 useEffect(()=>{try{localStorage.setItem(DRAFT+work.id,JSON.stringify({name,prompt,duration,bpm,seed}));}catch{}},[work.id,name,prompt,duration,bpm,seed]);
 function placementFor(id){return placements[id]||{start:'0',gain:'25',loop:false};}
 function updatePlacement(id,key,value){setPlacements(previous=>({...previous,[id]:{...placementFor(id),[key]:value}}));}
 async function generate(event){
  event.preventDefault();if(submissionLock.current)return;setError('');
  if(!capability.available){setError(capability.message||'配乐模型尚未就绪。');return;}
  const seconds=Number(duration),tempo=Number(bpm),randomSeed=seed.trim()===''?undefined:Number(seed);
  if(!prompt.trim()||!Number.isFinite(seconds)||seconds<10||seconds>120||!Number.isInteger(tempo)||tempo<10||tempo>300||randomSeed!==undefined&&(!Number.isSafeInteger(randomSeed)||randomSeed<0)){setError('请填写配乐描述，时长 10–120 秒、BPM 10–300；种子可留空随机。');return;}
  submissionLock.current=true;setSubmitting(true);
  try{const result=await api('/api/music/generate',{workId:work.id,name:name.trim()||'漫剧配乐',prompt:prompt.trim(),duration:seconds,bpm:tempo,...(randomSeed===undefined?{}:{seed:randomSeed})});if(!result.job?.id)throw new Error('未取得配乐任务编号，请刷新列表核对。');epoch.current++;if(mounted.current){setJobs(previous=>mergeMusicJobs(previous,[result.job]));toast('配乐已加入 GB10 队列，完成后可试听并铺入当前集。');}}
  catch(problem){if(mounted.current)setError(problem.message);}finally{submissionLock.current=false;if(mounted.current)setSubmitting(false);}
 }
 async function retryImport(job){
  if(importLock.current)return;importLock.current=true;setImporting(job.id);setError('');
  try{const result=await api(`/api/music/jobs/${job.id}/import`,{});epoch.current++;if(mounted.current)setJobs(previous=>mergeMusicJobs(previous,[result.job]));await refresh(true);if(mounted.current)toast('已将现有配乐导入音乐库，没有重新生成。');}catch(problem){if(mounted.current)setError(problem.message);}finally{importLock.current=false;if(mounted.current)setImporting(null);}
 }
 async function addToTimeline(job){
  if(additionLock.current)return;additionLock.current=true;setAdding(job.id);setError('');
  try{
   const workId=work.id,episode=activeEpisodeId,placementSettings={...placementFor(job.id)},catalog=await refresh(true),current=array(catalog?.works).find(item=>item.id===workId)||currentWork.current;
   if(current?.id!==workId||(job.workId||job.request?.workId)!==workId)throw new Error('当前作品已变化，请重新选择配乐。');
   const media=mediaForJob(current,job),existing=current.studio?.timelines?.[episode];if(!media?.id)throw new Error('请先把已生成的配乐导入作品音乐库。');
   const placement=musicPlacement(existing,media,placementSettings.start,gainFraction(placementSettings.gain),placementSettings.loop),next=structuredClone(existing);next.audio=array(next.audio);
   if(next.audio.length>=64)throw new Error('当前集已有 64 条声音，请先整理时间轴。');next.audio.push({id:crypto.randomUUID(),kind:'music',mediaId:media.id,start:placement.start,trimStart:0,duration:placement.duration,gain:placement.gain,loop:placement.loop,enabled:true});
   await api(`/api/works/${workId}/studio/timeline`,{episodeId:episode,timeline:next});await refresh(true).catch(()=>{});if(mounted.current)toast(`配乐已加入当前集，从 ${decimal(placement.start)} 秒开始${placement.loop?'，循环铺至片尾':placement.trimmed?'，时间轴已裁至片尾，原音频保留':''}。`);
  }catch(problem){if(mounted.current)setError(problem.message);}finally{additionLock.current=false;if(mounted.current)setAdding(null);}
 }
 return <section className="music-studio" ref={host}>
  <div className="music-studio-heading"><div><Text size="1" color="gray">声音库 / 配乐生成</Text><h2>让故事拥有自己的旋律</h2><Text size="2" color="gray">写下情绪、乐器与节奏，制作纯配乐，试听后铺入当前集。</Text></div><Flex gap="2" align="center"><Badge color={capability.available?'jade':'gray'}>{capability.available?'配乐服务已就绪':'配乐服务准备中'}</Badge><Button size="1" variant="soft" color="gray" loading={checking} onClick={()=>void loadCapability()}><RefreshCw size={13}/>检查服务</Button></Flex></div>
  {!capability.available?<Callout.Root size="1" color="amber"><Callout.Icon>{checking?<Spinner size="1"/>:<Music2 size={16}/>}</Callout.Icon><Callout.Text>{capability.message||'模型准备完成后即可生成，描述草稿会保留。'}</Callout.Text></Callout.Root>:null}
  {error?<Callout.Root size="1" color="red" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root>:null}
  <div className="music-studio-columns"><Card className="music-studio-form"><form onSubmit={generate}>
   <div className="music-form-title"><Music2 size={19}/><h3>为这一幕写一段配乐</h3><Badge color="gray">纯音乐</Badge></div>
   <label><Text size="2" weight="medium">配乐名称</Text><TextField.Root value={name} onChange={event=>setName(event.target.value)} maxLength={120} placeholder="例如：星灯邮差 · 雨夜前行" disabled={submitting}/></label>
   <div className="music-style-starts" aria-label="配乐描述起点">{STYLES.map(style=><Button key={style.name} type="button" size="1" variant="soft" color="gray" disabled={submitting} onClick={()=>setPrompt(style.prompt)}>{style.name}</Button>)}</div>
   <label><Text size="2" weight="medium">情绪、乐器与画面</Text><TextArea value={prompt} onChange={event=>setPrompt(event.target.value)} rows={6} maxLength={5000} placeholder="例如：雨夜街头，邮差读完一封旧信。柔和钢琴与弦乐，温暖又有一点惆怅，节奏克制，给对白留出空间。" required disabled={submitting}/></label><Text size="1" color="gray">只描述器乐与情绪，系统按纯配乐方式生成；对白请到角色配音制作。</Text>
   <div className="music-form-grid"><label><Text size="2" weight="medium">时长 / 秒</Text><TextField.Root type="number" min="10" max="120" step="1" value={duration} onChange={event=>setDuration(event.target.value)} required disabled={submitting} aria-label="配乐生成时长"/></label><label><Text size="2" weight="medium">节奏 / BPM</Text><TextField.Root type="number" min="10" max="300" step="1" value={bpm} onChange={event=>setBpm(event.target.value)} required disabled={submitting} aria-label="配乐节奏BPM"/></label><label><Text size="2" weight="medium">随机种子</Text><TextField.Root type="number" min="0" step="1" value={seed} onChange={event=>setSeed(event.target.value)} disabled={submitting} placeholder="留空随机" aria-label="配乐随机种子"/></label></div>
   <div className="music-duration-slider"><Slider min={10} max={120} step={1} value={[Math.max(10,Math.min(120,Number(duration)||10))]} onValueChange={([value])=>setDuration(String(value))} disabled={submitting} aria-label="调整配乐时长"/><span>10 秒</span><span>120 秒</span></div>
   <div className="music-model-caption"><AudioLines size={15}/><Text size="1" color="gray">{capability.model?.name||'ACE-Step 1.5 Turbo'} · 本机留存原始参数与实际生产时间，音频自动归档到当前作品。</Text></div><Button type="submit" className="music-generate-button" disabled={!capability.available||!prompt.trim()||submitting||activeCount>0} loading={submitting}><Sparkles size={16}/>{submitting?'正在提交…':activeCount?'本作品配乐正在制作':'生成这一段配乐'}</Button>
  </form></Card><div className="music-studio-jobs"><div className="music-jobs-heading"><h3>作品配乐</h3><Badge color={activeCount?'jade':'gray'}>{activeCount} 条进行中</Badge></div>
   {jobsError?<Callout.Root size="1" color="amber"><Callout.Text>{jobsError}</Callout.Text></Callout.Root>:null}
   {jobs.length===0?<div className="music-studio-empty"><Music2 size={35}/><Text size="2">故事的第一段旋律，会留在这里</Text><Text size="1" color="gray">提交后显示真实队列状态，完成后可试听 WAV、查看参数与生产耗时。</Text></div>:jobs.map(job=>{
    const media=mediaForJob(work,job),output=job.telemetry?.output||{},settings=placementFor(job.id),inLibrary=media?.id&&array(work.studio?.libraries?.music).some(entry=>array(entry.mediaIds).includes(media.id));let placement=null,placementError='';
    if(job.status==='succeeded')try{placement=musicPlacement(timeline,media,settings.start,gainFraction(settings.gain),settings.loop);}catch(problem){placementError=problem.message;}
    return <Card key={job.id} className="music-job-card"><Flex justify="between" align="center" gap="2"><Text size="2" weight="medium">{job.name||job.request?.name||'漫剧配乐'}</Text><Badge color={job.status==='succeeded'?'jade':job.status==='failed'?'red':'gray'}>{ACTIVE.has(job.status)?<Spinner size="1"/>:null}{STATUS[job.status]||job.status}</Badge></Flex><Text as="p" size="2" className="music-job-prompt">{job.request?.prompt}</Text>{job.message||job.error?<Text as="p" size="1" color={job.error?'red':'gray'}>{job.error||job.message}</Text>:null}
     {job.status==='succeeded'?<><audio controls preload="metadata" src={job.audioUrl||`/api/music/jobs/${job.id}/audio`} aria-label={`试听 ${job.name||'配乐'}`}/><Flex align="center" gap="3" wrap="wrap" className="music-job-metrics"><Text size="1" color="gray"><Clock3 size={12}/>{validNumber(output.duration)?decimal(output.duration)+' 秒':'实际时长待记录'}</Text><Text size="1" color="gray">实际生产 {validNumber(job.telemetry?.productionMs)?decimal(job.telemetry.productionMs/1000)+' 秒':'待记录'}</Text><Button size="1" variant="ghost" asChild><a href={job.audioUrl||`/api/music/jobs/${job.id}/audio`} download><Download size={13}/>WAV</a></Button></Flex>
      {job.registrationError?<Callout.Root size="1" color="amber"><Callout.Text>音频已完成，作品归档未完成：{job.registrationError}<Button size="1" variant="soft" disabled={importing!==null} loading={importing===job.id} onClick={()=>void retryImport(job)}><RefreshCw size={12}/>重试导入音乐库</Button></Callout.Text></Callout.Root>:media?.id?<Text as="p" size="1" color="jade" className="music-registered"><Check size={12}/>{inLibrary?'已归入作品音乐库':'已保存到作品音频素材'}</Text>:null}
      <div className="music-placement-grid"><label><Text size="1" color="gray">从整片第几秒开始</Text><TextField.Root type="number" min="0" max={total||undefined} step=".01" value={settings.start} onChange={event=>updatePlacement(job.id,'start',event.target.value)} disabled={adding===job.id} aria-label={`配乐 ${job.name} 的时间轴起点`}/></label><label><Text size="1" color="gray">音量 / %</Text><TextField.Root type="number" min="0" max="200" step="1" value={settings.gain} onChange={event=>updatePlacement(job.id,'gain',event.target.value)} disabled={adding===job.id} aria-label={`配乐 ${job.name} 的音量`}/></label><label className="music-loop"><input type="checkbox" checked={settings.loop} onChange={event=>updatePlacement(job.id,'loop',event.target.checked)} disabled={adding===job.id}/>循环至片尾</label></div>
      <Button variant="soft" disabled={!media?.id||!placement||adding!==null} loading={adding===job.id} onClick={()=>void addToTimeline(job)} className="music-add-button"><Plus size={15}/>加入当前集配乐轨</Button><Text as="p" size="1" color={placementError?'amber':'gray'}>{placementError||`当前集 ${decimal(total)} 秒 · 放入 ${decimal(placement.duration)} 秒${placement.loop?'，循环铺满剩余时间':placement.trimmed?'，裁至片尾，原音频保留':''}`}</Text>
     </>:null}
     <details className="music-job-details"><summary><FileText size={13}/>本次参数与生产记录</summary><dl><div><dt>任务编号</dt><dd>{job.id}</dd></div><div><dt>模型</dt><dd>{job.modelSnapshot?.name||'ACE-Step 1.5 Turbo'}</dd></div><div><dt>原始请求</dt><dd>{job.request?.duration} 秒 · {job.request?.bpm} BPM · seed {job.request?.seed}</dd></div><div><dt>实际音频</dt><dd>{validNumber(output.duration)?decimal(output.duration)+' 秒':'—'} · {output.sampleRate||'—'} Hz · {output.channels||'—'} 声道</dd></div><div><dt>排队 / 生产</dt><dd>{validNumber(job.telemetry?.queueMs)?decimal(job.telemetry.queueMs/1000):'—'} / {validNumber(job.telemetry?.productionMs)?decimal(job.telemetry.productionMs/1000):'—'} 秒</dd></div><div><dt>服务器工作流</dt><dd>{validNumber(job.telemetry?.serverExecutionMs)?decimal(job.telemetry.serverExecutionMs/1000)+' 秒':'—'}</dd></div></dl><p>生产耗时包含模型加载、生成、回传与本机媒体转换；服务器工作流耗时不等同于纯 GPU 内核时间。</p><pre>{JSON.stringify({request:job.request,modelSha256:job.modelSnapshot?.sha256,promptId:job.promptId,telemetry:job.telemetry},null,2)}</pre></details>
    </Card>;
   })}
   {jobs.length?<Button size="1" variant="ghost" asChild><a href={`/api/music/jobs?workId=${work.id}`} download={`music-log-${work.id}.json`}><Download size={13}/>导出本作品配乐记录 JSON</a></Button>:null}
  </div></div>
 </section>;
}
