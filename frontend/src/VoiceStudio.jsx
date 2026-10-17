import {useCallback,useEffect,useRef,useState} from 'react';
import {Badge,Button,Callout,Card,Flex,Select,Spinner,Tabs,Text,TextArea,TextField} from '@radix-ui/themes';
import {AudioLines,Check,Clock3,Download,Mic2,Plus,RefreshCw,Save,Sparkles,UserRound,Volume2} from 'lucide-react';
import './voice-studio.css';

const NONE='__none__',ACTIVE=new Set(['queued','running']);
const STATUS={queued:'排队中',running:'正在生成',succeeded:'已完成',failed:'生成失败',interrupted:'已中断'};
const DRAFT_PREFIX='rack-tts-dialogue-draft-v1/';
const array=value=>Array.isArray(value)?value:[];
const numeric=value=>value!==undefined&&value!==null&&Number.isFinite(Number(value))?Number(value):null;
const decimal=value=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});

export function voicePlacement(timeline,media,startValue){
 if(!timeline||!Array.isArray(timeline.clips))throw new Error('请先保存当前集的时间轴。');
 const total=timeline.clips.filter(clip=>clip.enabled!==false).reduce((sum,clip)=>sum+Number(clip.duration||0),0);
 if(!Number.isFinite(total)||total<=0)throw new Error('先在时间轴启用画面，再加入配音。');
 if(String(startValue??'').trim()==='')throw new Error('请填写配音开始时间。');
 const start=Number(startValue),sourceDuration=Number(media?.duration);
 if(!Number.isFinite(start)||start<0||start>=total)throw new Error('配音起点须在片头至片尾之间，不能到达或超过片尾。');
 if(!Number.isFinite(sourceDuration)||sourceDuration<=0)throw new Error('配音实际时长尚未就绪，请等待归档完成。');
 const duration=Math.min(sourceDuration,total-start);
 if(duration<1/48000)throw new Error('片尾剩余时长太短，请把配音起点提前。');
 return {start,duration,total,trimmed:duration<sourceDuration-0.000001};
}

export function mergeVoiceJobs(previous,incoming){
 const rank={queued:1,running:2,succeeded:3,failed:3,interrupted:3},known=new Map(array(previous).map(job=>[job.id,job]));
 for(const next of array(incoming)){
  if(!next?.id)continue;const prior=known.get(next.id);
  if(prior&&(rank[prior.status]||0)>(rank[next.status]||0))continue;
  known.set(next.id,prior?{...prior,...next,media:next.media??prior.media}:next);
 }
 return [...known.values()].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
}

function loadDraft(workId){try{return JSON.parse(localStorage.getItem(DRAFT_PREFIX+workId)||'{}')||{};}catch{return {};}}
function mediaForJob(work,job){
 const id=typeof job.media==='string'?job.media:job.media?.id;
 const saved=array(work?.studio?.media).find(item=>item.id===id);
 return saved||(job.media&&typeof job.media==='object'?job.media:null);
}
function jobDuration(job,media){const duration=numeric(job.output?.duration)??numeric(job.duration)??numeric(job.durationSeconds)??numeric(media?.duration);return duration&&duration>0?duration:null;}
const jobWorkId=job=>job.request?.workId||job.workId;
const jobName=job=>job.request?.name||job.name||job.title||'角色配音';
const jobText=job=>job.request?.text||job.text;
export function voiceProfileEntry(character,speaker,instruct){
 if(!character?.id)throw new Error('请先选择要保存声音的角色。');
 if(!speaker)throw new Error('请选择服务提供的真实预置音色。');
 if(typeof instruct!=='string'||instruct.length>500)throw new Error('情绪与说话方式最多 500 字。');
 return {...structuredClone(character),voiceProfile:{engine:'qwen3-tts',speaker,instruct:instruct.trim(),language:'Chinese'}};
}
export function designedVoiceProfileEntry(character,job,description,performanceInstruction){
 if(!character?.id)throw new Error('请先选择要保存声音的角色。');
 if(!job?.id||job.kind!=='voice-design'||job.status!=='succeeded')throw new Error('请先生成并试听一条成功的人物声线。');
 if(typeof description!=='string'||description.length>2000||typeof performanceInstruction!=='string'||performanceInstruction.length>500)throw new Error('声线描述最多 2000 字，表演备注最多 500 字。');
 return {...structuredClone(character),voiceProfile:{engine:'qwen3-tts',mode:'designed',voiceDesignJobId:job.id,description:description.trim(),performanceInstruction:performanceInstruction.trim(),language:'Chinese'}};
}

export default function VoiceStudio({work,episodeId,api,toast,refresh}){
 const initial=useRef(null);if(!initial.current)initial.current=loadDraft(work.id);
 const [characterId,setCharacterId]=useState(initial.current.characterId||NONE),[voiceId,setVoiceId]=useState(initial.current.voiceId||NONE),[name,setName]=useState(initial.current.name||''),[speaker,setSpeaker]=useState(initial.current.speaker||''),[instruct,setInstruct]=useState(initial.current.instruct||''),[text,setText]=useState(initial.current.text||'');
 const [formMode,setFormMode]=useState(initial.current.formMode==='design'?'design':'dialogue'),[voiceMode,setVoiceMode]=useState(initial.current.voiceMode==='designed'?'designed':'preset'),[designJobId,setDesignJobId]=useState(initial.current.designJobId||''),[voiceDescription,setVoiceDescription]=useState(initial.current.voiceDescription||''),[designText,setDesignText]=useState(initial.current.designText||'');
 const [capability,setCapability]=useState({available:false,speakers:[],message:'正在检查语音服务…'}),[checking,setChecking]=useState(true),[jobs,setJobs]=useState([]),[submitting,setSubmitting]=useState(false),[profileSaving,setProfileSaving]=useState(false),[adding,setAdding]=useState(null),[starts,setStarts]=useState({}),[error,setError]=useState(''),[jobsError,setJobsError]=useState('');
 const workRef=useRef(work),mounted=useRef(false),host=useRef(null),jobRead=useRef(null),capRead=useRef(null),capCheckedAt=useRef(0),capRef=useRef(capability),previousStates=useRef(new Map()),synced=useRef(new Set()),submissionLock=useRef(false),additionLock=useRef(false);
 workRef.current=work;capRef.current=capability;
 const characters=array(work.studio?.libraries?.characters),voices=array(work.studio?.libraries?.voices),speakers=array(capability.speakers),speakerKnown=speakers.some(item=>item.id===speaker),formBusy=submitting||profileSaving,selectedCharacter=characters.find(item=>item.id===characterId);
 const designedJobs=jobs.filter(job=>job.kind==='voice-design'&&job.status==='succeeded'&&jobWorkId(job)===work.id),selectedDesign=designedJobs.find(job=>job.id===designJobId),designCapability=capability.voiceDesign||{},referenceCapability=capability.referenceVoice||{};
 const designReady=designCapability.available===true,ready=voiceMode==='designed'?referenceCapability.available===true&&Boolean(selectedDesign):capability.available===true&&speakerKnown;
 const stepAvailable=formMode==='design'?designReady:voiceMode==='designed'?referenceCapability.available===true:capability.available===true;
 const instructionSupported=voiceMode==='preset'||referenceCapability.instructionControl===true;
 const activeEpisodeId=episodeId??work.episodes?.[0]?.id,timeline=work.studio?.timelines?.[activeEpisodeId],total=array(timeline?.clips).filter(clip=>clip.enabled!==false).reduce((sum,clip)=>sum+Number(clip.duration||0),0);
 const model=typeof capability.model==='string'?capability.model:capability.model?.name||capability.model?.id;

 const loadCapability=useCallback(async()=>{
  if(capRead.current)return capRead.current;
  const pending=(async()=>{if(mounted.current)setChecking(true);try{
   const result=await api('/api/tts/capability'),status=result.capability||result;
   if(!mounted.current)return;const available=array(status.speakers);setCapability({...status,speakers:available});setSpeaker(current=>available.some(item=>item.id===current)?current:available[0]?.id||'');
  }catch(failure){if(mounted.current)setCapability({available:false,speakers:[],message:'语音服务暂不可用：'+failure.message});}finally{capCheckedAt.current=Date.now();if(mounted.current)setChecking(false);capRead.current=null;}})();capRead.current=pending;return pending;
 },[api]);

 const loadJobs=useCallback(async()=>{
  if(jobRead.current)return jobRead.current;
  const pending=(async()=>{try{
   const result=await api('/api/tts/jobs?workId='+encodeURIComponent(work.id));if(!mounted.current)return;
   const incoming=array(result.jobs).filter(job=>!jobWorkId(job)||jobWorkId(job)===work.id);setJobs(previous=>{const next=mergeVoiceJobs(previous,incoming);return JSON.stringify(previous)===JSON.stringify(next)?previous:next;});setJobsError('');
   const sync=[];
   for(const job of incoming){const id=typeof job.media==='string'?job.media:job.media?.id,prior=previousStates.current.get(job.id);previousStates.current.set(job.id,job.status);
    if(job.status==='succeeded'&&id&&!synced.current.has(job.id)&&(prior&&prior!=='succeeded'||!array(workRef.current.studio?.media).some(media=>media.id===id)))sync.push(job.id);
   }
   if(sync.length)try{await refresh(true);sync.forEach(id=>synced.current.add(id));}catch(failure){if(mounted.current)setJobsError('配音已生成，素材同步暂时中断：'+failure.message);}
  }catch(failure){if(mounted.current)setJobsError('配音任务暂时无法同步：'+failure.message);}finally{jobRead.current=null;}})();jobRead.current=pending;return pending;
 },[api,refresh,work.id]);

 useEffect(()=>{
  mounted.current=true;const node=host.current;void Promise.allSettled([loadCapability(),loadJobs()]);
  const timer=setInterval(()=>{if(document.hidden)return;void loadJobs();if((!capRef.current.available||!capRef.current.voiceDesign?.available||!capRef.current.referenceVoice?.available)&&Date.now()-capCheckedAt.current>=10000)void loadCapability();},2000);
  return()=>{mounted.current=false;clearInterval(timer);node?.querySelectorAll('audio').forEach(player=>player.pause());};
 },[loadCapability,loadJobs]);
 useEffect(()=>{try{localStorage.setItem(DRAFT_PREFIX+work.id,JSON.stringify({characterId,voiceId,name,speaker,instruct,text,formMode,voiceMode,designJobId,voiceDescription,designText}));}catch{}},[work.id,characterId,voiceId,name,speaker,instruct,text,formMode,voiceMode,designJobId,voiceDescription,designText]);

 function chooseCharacter(id){setCharacterId(id);const entry=characters.find(item=>item.id===id);if(entry){const profile=entry.voiceProfile;setName(entry.name+' · 配音');setVoiceId(NONE);setVoiceMode(profile?.mode==='designed'?'designed':'preset');setDesignJobId(profile?.voiceDesignJobId||'');setVoiceDescription(profile?.description||'');if(profile?.speaker)setSpeaker(profile.speaker);setInstruct(String(profile?.performanceInstruction??profile?.instruct??entry.voiceStyle??'').slice(0,500));}}
 function chooseVoice(id){setVoiceId(id);const entry=voices.find(item=>item.id===id);if(entry){setInstruct(String(entry.voiceStyle||entry.lockedTraits||entry.description||'').slice(0,500));if(!name.trim())setName(entry.name+' · 对白');}}
 async function saveProfile(){
  if(submissionLock.current||formBusy)return;setError('');
  try{
   if(voiceMode==='preset'&&!speakerKnown)throw new Error('请选择服务提供的真实预置音色。');
   const workId=work.id,entry=voiceMode==='designed'?designedVoiceProfileEntry(selectedCharacter,selectedDesign,voiceDescription||selectedDesign?.request?.voiceDescription||'',instruct):voiceProfileEntry(selectedCharacter,speaker,instruct);
   submissionLock.current=true;setProfileSaving(true);
   await api(`/api/works/${workId}/studio/libraries/characters`,{entry});await refresh(true).catch(()=>{});
   if(mounted.current)toast(`已保存「${entry.name}」的声音设定，下次选择角色会自动带入。`);
  }catch(failure){if(mounted.current)setError(failure.message);}finally{submissionLock.current=false;if(mounted.current)setProfileSaving(false);}
 }
 async function generate(event){
  event.preventDefault();if(submissionLock.current||formBusy)return;setError('');
  if(formMode==='design'){await generateDesign();return;}
  if(!ready){setError(capability.message||capability.reason||'语音模型或音色尚未就绪。');return;}if(!text.trim()){setError('先填写本镜对白，再生成角色配音。');return;}
  submissionLock.current=true;setSubmitting(true);
  try{
   const payload={workId:work.id,text:text.trim(),language:'Chinese',name:name.trim()||'角色对白',...(voiceMode==='designed'?{voiceDesignJobId:selectedDesign.id,performanceInstruction:instruct.trim()}:{speaker,instruct:instruct.trim()})};
   const result=await api('/api/tts/generate',payload);if(!result.job?.id)throw new Error('没有取得配音任务编号，请刷新任务列表后核对。');
   if(mounted.current){setJobs(previous=>mergeVoiceJobs(previous,[result.job]));toast('配音已加入生成队列，完成后可试听并铺入时间轴。');void loadJobs();}
  }catch(failure){if(mounted.current)setError(failure.message);}finally{submissionLock.current=false;if(mounted.current)setSubmitting(false);}
 }
 async function generateDesign(){
  if(!designReady){setError(designCapability.reason||designCapability.message||'人物声线设计模型尚未就绪。');return;}
  if(!voiceDescription.trim()||!designText.trim()){setError('填写人物的声音性格与试音台词，再生成候选声线。');return;}
  submissionLock.current=true;setSubmitting(true);
  try{
   const result=await api('/api/tts/design',{workId:work.id,name:name.trim()||(selectedCharacter?selectedCharacter.name+' · 声线候选':'人物声线候选'),voiceDescription:voiceDescription.trim(),text:designText.trim(),language:'Chinese'});
   if(!result.job?.id)throw new Error('没有取得声线设计任务编号，请刷新后核对。');
   if(mounted.current){setJobs(previous=>mergeVoiceJobs(previous,[result.job]));toast('人物声线设计已排队，完成后请试听，再保存为角色声音。');void loadJobs();}
  }catch(failure){if(mounted.current)setError(failure.message);}finally{submissionLock.current=false;if(mounted.current)setSubmitting(false);}
 }
 function useDesignedVoice(job){setDesignJobId(job.id);setVoiceMode('designed');setVoiceDescription(job.request?.voiceDescription||'');setFormMode('dialogue');setError('');toast('已选用这条设计声线，填写台词后可保持声线继续配音。');}
 async function addToTimeline(job){
  if(additionLock.current)return;additionLock.current=true;setAdding(job.id);setError('');
  try{
   const workId=work.id,episode=activeEpisodeId;if(jobWorkId(job)&&jobWorkId(job)!==workId)throw new Error('这条配音不属于当前作品。');
   const catalog=await refresh(true),current=Array.isArray(catalog?.works)?catalog.works.find(item=>item.id===workId):workRef.current;
   if(!current||current.id!==workId)throw new Error('当前作品已变化，请重新选择配音。');
   const media=mediaForJob(current,job),existing=current.studio?.timelines?.[episode];
   if(!media?.id)throw new Error('配音尚未登记为作品素材，请等待任务归档。');
   const duration=jobDuration(job,media),placement=voicePlacement(existing,{...media,duration},starts[job.id]??'0'),next=structuredClone(existing);
   if(array(next.audio).length>=64)throw new Error('当前集已有 64 条声音，请先整理时间轴再添加。');
   next.audio=array(next.audio);next.audio.push({id:crypto.randomUUID(),kind:'voice',mediaId:media.id,start:placement.start,trimStart:0,duration:placement.duration,gain:1,loop:false,enabled:true});
   await api(`/api/works/${current.id}/studio/timeline`,{episodeId:episode,timeline:next});await refresh(true).catch(()=>{});
   if(mounted.current)toast(`配音已加入当前集，从 ${decimal(placement.start)} 秒开始${placement.trimmed?'，超出片尾的部分已在时间轴裁短，原音频保留':''}。`);
  }catch(failure){if(mounted.current)setError(failure.message);}finally{additionLock.current=false;if(mounted.current)setAdding(null);}
 }

 return <section className="voice-studio" ref={host}>
  <div className="voice-studio-heading"><div><Text size="1" color="gray">声音库 / 角色配音</Text><h2>让角色拥有自己的声音</h2><Text size="2" color="gray">按人物性格设计声线，试听满意后保存给角色，再保持声线制作对白。</Text></div><Flex gap="2" align="center"><Badge color={stepAvailable?'jade':'gray'}>{stepAvailable?'当前模型已就绪':'当前模型未就绪'}</Badge><Button size="1" variant="soft" color="gray" loading={checking} onClick={()=>void loadCapability()}><RefreshCw size={13}/>检查服务</Button></Flex></div>
  {formMode==='dialogue'&&voiceMode==='preset'&&!capability.available?<Callout.Root size="1" color="amber"><Callout.Icon>{checking?<Spinner size="1"/>:<Volume2 size={16}/>}</Callout.Icon><Callout.Text>{capability.message||capability.reason||'预置配音模型尚未就绪，完成部署后再生成。'}</Callout.Text></Callout.Root>:null}
  {error?<Callout.Root size="1" color="red" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root>:null}
  <Tabs.Root value={formMode} onValueChange={next=>{if(!formBusy){setFormMode(next);setError('');}}} className="voice-mode-tabs"><Tabs.List aria-label="角色声音制作步骤"><Tabs.Trigger value="design"><Sparkles size={14}/>人物声线设计</Tabs.Trigger><Tabs.Trigger value="dialogue"><Mic2 size={14}/>台词配音</Tabs.Trigger></Tabs.List></Tabs.Root>
  <div className="voice-studio-columns"><Card className="voice-studio-form"><form onSubmit={generate}>
   <div className="voice-form-title"><Mic2 size={19}/><h3>{formMode==='design'?'设计人物的声音性格':'本镜对白'}</h3><Badge color="gray" size="1">中文</Badge></div>
   <div className="voice-form-grid"><label><Text size="2" weight="medium">角色</Text><Select.Root value={characters.some(item=>item.id===characterId)?characterId:NONE} onValueChange={chooseCharacter} disabled={formBusy}><Select.Trigger placeholder="选择角色" aria-label="配音所属角色"/><Select.Content><Select.Item value={NONE}>不绑定角色</Select.Item>{characters.map(entry=><Select.Item key={entry.id} value={entry.id}>{entry.name}</Select.Item>)}</Select.Content></Select.Root></label><label><Text size="2" weight="medium">参考声音设定</Text><Select.Root value={voices.some(item=>item.id===voiceId)?voiceId:NONE} onValueChange={chooseVoice} disabled={formBusy}><Select.Trigger aria-label="使用已有音色设定"/><Select.Content><Select.Item value={NONE}>本次单独填写</Select.Item>{voices.map(entry=><Select.Item key={entry.id} value={entry.id}>{entry.name}</Select.Item>)}</Select.Content></Select.Root></label></div>
   <label><Text size="2" weight="medium">配音名称</Text><TextField.Root value={name} onChange={event=>setName(event.target.value)} maxLength={120} placeholder="例如：邮差 · 轻声读信" disabled={formBusy}/></label>
   {formMode==='design'?<>
    <Callout.Root size="1" color={designReady?'jade':'amber'}><Callout.Icon><Sparkles size={16}/></Callout.Icon><Callout.Text>{designReady?'用人物设定生成新声线。候选声音试听满意后，可作为角色的固定声音继续配音。':designCapability.reason||designCapability.message||'VoiceDesign 模型尚未就绪，可先填写人物声线设定。'}</Callout.Text></Callout.Root>
    <label><Text size="2" weight="medium">人物声线设定</Text><TextArea value={voiceDescription} onChange={event=>setVoiceDescription(event.target.value)} rows={6} maxLength={2000} placeholder="例如：20岁左右的年轻男性，声音清朗、略有沙哑，普通话，无明显地方口音。性格温柔内敛，有少年感，平时语速平稳，尾音轻收。" disabled={formBusy}/></label>
    <Text as="p" size="1" color="gray" className="voice-design-guide">描述年龄感、音高与质感、口音、平常气质。先建立日常声线，避免把哭喊等强烈情绪固定进声音。</Text>
    <label><Text size="2" weight="medium">试音台词</Text><TextArea value={designText} onChange={event=>setDesignText(event.target.value)} rows={4} maxLength={500} placeholder="写一小段自然对白，用来判断人物的声音是否合适…" disabled={formBusy}/></label>
    <div className="voice-text-count"><Text size="1" color="gray">真实生成 WAV 供试听，满意后再复用。</Text><Text size="1" color="gray">{designText.length} / 500</Text></div>
    <Button type="submit" disabled={!designReady||!voiceDescription.trim()||!designText.trim()||formBusy} loading={submitting} className="voice-generate-button"><Sparkles size={16}/>{submitting?'正在提交…':'生成人物声线候选'}</Button>
   </>:<>
    <label><Text size="2" weight="medium">声音来源</Text><Select.Root value={voiceMode} onValueChange={setVoiceMode} disabled={formBusy}><Select.Trigger aria-label="角色声音来源"/><Select.Content><Select.Item value="designed">已设计的人物声线</Select.Item><Select.Item value="preset">预置音色</Select.Item></Select.Content></Select.Root></label>
    {voiceMode==='designed'?<>
     <label><Text size="2" weight="medium">已设计的角色声音</Text><Select.Root value={selectedDesign?.id} onValueChange={id=>{const job=designedJobs.find(item=>item.id===id);if(job){setDesignJobId(id);setVoiceDescription(job.request?.voiceDescription||'');}}} disabled={formBusy||!designedJobs.length}><Select.Trigger aria-label="选择已设计的人物声线" placeholder={designedJobs.length?'选择已试听的候选声线':'先生成人物声线候选'}/><Select.Content>{designedJobs.map(job=><Select.Item key={job.id} value={job.id}>{jobName(job)} · {job.id.slice(0,6)}</Select.Item>)}</Select.Content></Select.Root></label>
     {selectedDesign?<div className="voice-design-selected"><Text size="1" color="gray">{selectedDesign.request?.voiceDescription||voiceDescription}</Text><audio controls preload="metadata" src={'/api/tts/jobs/'+selectedDesign.id+'/audio'} aria-label="试听选中的人物声线"/></div>:<Button type="button" size="1" variant="soft" onClick={()=>setFormMode('design')}><Sparkles size={13}/>先设计人物声线</Button>}
     {!referenceCapability.available?<Callout.Root size="1" color="amber"><Callout.Text>{referenceCapability.reason||referenceCapability.message||'固定声线复用模型尚未就绪；候选声音仍可试听。'}</Callout.Text></Callout.Root>:null}
    </>:<label><Text size="2" weight="medium">预置音色</Text><Select.Root value={speakers.some(item=>item.id===speaker)?speaker:undefined} onValueChange={setSpeaker} disabled={formBusy||!speakers.length}><Select.Trigger aria-label="选择真实预置音色" placeholder={checking?'读取音色…':speakers.length?'选择音色':'尚无可用音色'}/><Select.Content>{speakers.map(entry=><Select.Item key={entry.id} value={entry.id}>{entry.name||entry.id}{entry.description?' · '+entry.description:''}</Select.Item>)}</Select.Content></Select.Root></label>}
    <label><Text size="2" weight="medium">{instructionSupported?'本句情绪与说话方式':'本句表演备注'}</Text><TextArea value={instruct} onChange={event=>setInstruct(event.target.value)} rows={3} maxLength={500} placeholder="例如：轻声读信，语速稍慢，句尾略带迟疑。" disabled={formBusy}/></label>
    {!instructionSupported?<Text as="p" size="1" color="gray" className="voice-design-guide">当前 Base 模型保持参考声线，不执行逐句情绪指令。此处仅记录表演备注，不会混入台词。</Text>:null}
    <Flex gap="2" align="center" wrap="wrap" className="voice-profile-save"><Button type="button" size="1" variant="soft" onClick={()=>void saveProfile()} disabled={!selectedCharacter||!(voiceMode==='designed'?selectedDesign:speakerKnown)||formBusy} loading={profileSaving}><Save size={13}/>保存为角色声音</Button><Text size="1" color="gray">{selectedCharacter?.voiceProfile?'已保存角色音色，可修改后再次保存。':'选择角色后可保存固定声线与设定。'}</Text></Flex>
    <label><Text size="2" weight="medium">本镜对白原文</Text><TextArea value={text} onChange={event=>setText(event.target.value)} rows={6} maxLength={1000} placeholder="填写这一个镜头中实际要说出的台词…" disabled={formBusy}/></label><div className="voice-text-count"><Text size="1" color="gray">按镜头分段制作，方便对齐画面。</Text><Text size="1" color="gray">{text.length} / 1000</Text></div>
    <div className="voice-form-model"><AudioLines size={14}/><Text size="1" color="gray">{voiceMode==='designed'?'Qwen3-TTS Base · 复用本作品已试听的设计声线':(model||'语音模型待就绪')+' · 预置音色与情绪指导'}</Text></div><Button type="submit" disabled={!ready||!text.trim()||formBusy} loading={submitting} className="voice-generate-button"><Mic2 size={16}/>{submitting?'正在提交…':'生成角色配音'}</Button>
   </>}
  </form></Card><div className="voice-studio-jobs"><div className="voice-jobs-heading"><h3>配音任务</h3><Badge color={jobs.some(job=>ACTIVE.has(job.status))?'jade':'gray'}>{jobs.filter(job=>ACTIVE.has(job.status)).length} 条进行中</Badge></div>
   {jobsError?<Callout.Root size="1" color="amber"><Callout.Text>{jobsError}</Callout.Text></Callout.Root>:null}
   {jobs.length===0?<div className="voice-studio-empty"><UserRound size={33}/><Text size="2">这里会留住角色的声音</Text><Text size="1" color="gray">提交后显示真实队列状态，完成后可试听 WAV 与查看耗时。</Text></div>:jobs.map(job=>{
    const media=mediaForJob(work,job),duration=jobDuration(job,media),inLibrary=media?.id&&voices.some(entry=>array(entry.mediaIds).includes(media.id));let placement=null,placementError='';
    if(job.status==='succeeded')try{placement=voicePlacement(timeline,{...media,duration},starts[job.id]??'0');}catch(failure){placementError=failure.message;}
    return <Card key={job.id} className="voice-job-card"><Flex justify="between" align="center" gap="2"><Text size="2" weight="medium">{jobName(job)}</Text>{job.kind==='voice-design'?<Badge color="blue" size="1">声线候选</Badge>:job.kind==='designed-speech'?<Badge color="gray" size="1">固定声线配音</Badge>:null}<Badge color={job.status==='succeeded'?'jade':job.status==='failed'?'red':'gray'}>{ACTIVE.has(job.status)?<Spinner size="1"/>:null}{STATUS[job.status]||job.status}</Badge></Flex>
     {job.kind==='voice-design'&&job.request?.voiceDescription?<Text as="p" size="1" color="gray" className="voice-job-dialogue">{job.request.voiceDescription}</Text>:null}{jobText(job)?<Text as="p" size="2" className="voice-job-dialogue">{jobText(job)}</Text>:null}{job.message||job.error?<Text as="p" size="1" color={job.error?'red':'gray'}>{job.error||job.message}</Text>:null}
     {job.status==='succeeded'?<><audio controls preload="metadata" src={`/api/tts/jobs/${job.id}/audio`} aria-label={`试听 ${jobName(job)}`}/><Flex gap="3" align="center" wrap="wrap" className="voice-job-metrics"><Text size="1" color="gray"><Clock3 size={12}/> {duration?decimal(duration)+' 秒音频':'时长待检测'}</Text><Text size="1" color="gray">生产耗时 {numeric(job.productionMs)!==null?decimal(job.productionMs/1000)+' 秒':'待记录'}</Text><Button size="1" variant="ghost" asChild><a href={`/api/tts/jobs/${job.id}/audio`} download><Download size={13}/>下载 WAV</a></Button></Flex>
      {media?.id?<Text as="p" size="1" color="jade" className="voice-registered"><Check size={12}/>{inLibrary?'已归入配音库':'已保存到作品声音素材'}</Text>:null}
      {job.kind==='voice-design'?<Button type="button" size="2" variant="soft" onClick={()=>useDesignedVoice(job)} disabled={formBusy}><Check size={14}/>用这条声线配音</Button>:<>
      <div className="voice-placement"><label><Text size="1" color="gray">从整片第几秒开始</Text><TextField.Root type="number" min="0" max={total||undefined} step="0.01" value={starts[job.id]??'0'} onChange={event=>setStarts(previous=>({...previous,[job.id]:event.target.value}))} aria-label={`配音 ${jobName(job)} 的时间轴起点`} disabled={adding===job.id}/></label><Button size="2" variant="soft" disabled={!media?.id||!placement||adding!==null} loading={adding===job.id} onClick={()=>void addToTimeline(job)}><Plus size={15}/>加入当前集配音轨</Button></div><Text as="p" size="1" color={placementError?'amber':'gray'} className="voice-placement-note">{placementError||`当前集 ${decimal(total)} 秒 · 本次放入 ${decimal(placement.duration)} 秒${placement.trimmed?'，自动裁至片尾，原音频保留':''}`}</Text></>}
     </>:null}
    </Card>;
   })}
  </div></div>
 </section>;
}
