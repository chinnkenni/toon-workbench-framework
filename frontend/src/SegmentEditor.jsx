import {useEffect,useId,useRef,useState} from 'react';
import {Badge,Button,Callout,CheckboxGroup,Dialog,IconButton,Select,TextArea,TextField} from '@radix-ui/themes';
import {Check,ChevronDown,Clapperboard,Copy,Download,FileText,Film,Image,LockKeyhole,MapPin,Save,Scissors,Sparkles,Users,Volume2,X} from 'lucide-react';
import ExecutionPromptPanel from './ExecutionPromptPanel.jsx';
import ProductionCues from './ProductionCues.jsx';
import TranscriptionPanel from './TranscriptionPanel.jsx';
import {selectedVideoMeasurement} from './execution-prompt-ui.mjs';
import {H3_REQUEST_DURATIONS,h3RequestDuration} from './segment-duration-ui.mjs';
import {closeNestedClipSettings} from './segment-dialog-ui.mjs';
import {H3_WIDE_HINT,h3RatioChoices,h3ResolutionChoices,h3FrameSelectionError} from '../../public/h3-frame-options.js';
import './segment-editor.css';

const DRAFTS_KEY='rack-segment-drafts';
const NONE='__none__';
const RUNNING=new Set(['queued','running']);
const JOB_LABELS={queued:'排队中',running:'生成中',succeeded:'已完成',failed:'生成失败',interrupted:'已中断',cancelled:'已取消'};
const CATEGORIES={storyboard:'分镜设计',continuity:'角色一致性',prompt:'提示词',script:'剧本创作',audio:'声音设计',editing:'剪辑'};
const safeArray=value=>Array.isArray(value)?value:[];

function instruction(shot,key,tag){
  if(typeof shot[key]==='string')return shot[key];
  const source=shot.prompt||'',start=source.indexOf(tag);
  if(start<0)return key==='visualInstructions'?source:'';
  return source.slice(start+tag.length).split(/\n\s*\n[a-z_]+:/)[0].replace(/^\s*\[Shot 1\]\s*/,'').trim();
}
function shotValues(shot){
  return {title:shot.title||'',visual:instruction(shot,'visualInstructions','integrated_multimodal_description:'),sound:instruction(shot,'soundInstructions','overall_soundscape:'),music:instruction(shot,'musicInstructions','non_diegetic_music:'),characterIds:safeArray(shot.characterIds),sceneId:shot.sceneId||null,voiceIds:safeArray(shot.voiceIds),firstFrameMediaId:shot.firstFrameMediaId||null,skillIds:safeArray(shot.skillIds),duration:h3RequestDuration(shot.duration)??4,ratio:shot.ratio||'16:9',resolution:shot.resolution||'352P'};
}
function draftCatalog(){
  try{const value=JSON.parse(localStorage.getItem(DRAFTS_KEY)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}
}
function restoreValues(base,saved){
  if(!saved||typeof saved!=='object')return base;
  const next={...base};
  for(const key of ['title','visual','sound','music','ratio','resolution'])if(typeof saved[key]==='string')next[key]=saved[key];
  for(const key of ['characterIds','voiceIds','skillIds'])if(Array.isArray(saved[key]))next[key]=[...new Set(saved[key].filter(value=>typeof value==='string'))];
  for(const key of ['sceneId','firstFrameMediaId'])if(saved[key]===null||typeof saved[key]==='string')next[key]=saved[key]||null;
  const duration=h3RequestDuration(saved.duration);if(duration!==null)next.duration=duration;
  return next;
}
function saveDraft(session){
  if(!session?.dirty)return true;
  try{localStorage.setItem(DRAFTS_KEY,JSON.stringify({...draftCatalog(),[session.key]:session.values}));return true;}catch{return false;}
}
function removeDraft(key){
  try{const drafts=draftCatalog();delete drafts[key];localStorage.setItem(DRAFTS_KEY,JSON.stringify(drafts));}catch{}
}
function SkillScenario({skill,scenarios}){
  const list=safeArray(skill.scenarios).length?skill.scenarios:skill.scenario?[skill.scenario]:[];
  const labels=list.map(value=>{
    if(value&&typeof value==='object')return value.name||value.label||value.id;
    const found=Array.isArray(scenarios)?scenarios.find(item=>item.id===value||item.key===value):scenarios?.[value];
    return typeof found==='string'?found:found?.name||found?.label||value;
  }).filter(Boolean);
  return <span className="segment-choice-note">{labels.join(' · ')||CATEGORIES[skill.category]||skill.category||'创作辅助'}</span>;
}
function Field({label,htmlFor,children,hint}){
  return <div className="segment-field"><label htmlFor={htmlFor}>{label}</label>{children}{hint?<p className="segment-field-hint">{hint}</p>:null}</div>;
}
function ChoiceSelect({id,label,value,onChange,options,emptyLabel,disabled}){
  return <Select.Root value={value||NONE} onValueChange={next=>onChange(next===NONE?null:next)} disabled={disabled}>
    <Select.Trigger id={id} aria-label={label} variant="surface" className="segment-select" />
    <Select.Content position="popper">
      {emptyLabel?<Select.Item value={NONE}>{emptyLabel}</Select.Item>:null}
      {options.map(option=><Select.Item key={option.value} value={String(option.value)} disabled={option.disabled}>{option.label}</Select.Item>)}
    </Select.Content>
  </Select.Root>;
}

/** Editing state follows the opened shot, never the polling work object. */
export default function SegmentEditor({work,shotId,open,onOpenChange,api,toast=()=>{},refresh,onEditClip,onOpenLogs,onBusyChange}){
  const prefix=useId(),formRef=useRef(null),videoRef=useRef(null),sessionRef=useRef(null),lockedRef=useRef(false),apiRef=useRef(api);
  apiRef.current=api;
  const [session,setSession]=useState(null),[operation,setOperation]=useState(null),[error,setError]=useState(''),[storageFailed,setStorageFailed]=useState(false);
  const [creative,setCreative]=useState({skills:[],scenarios:[],loading:false});
  const [executionStatus,setExecutionStatus]=useState({canGenerate:false,label:'正在核对',state:'missing'});
  const [productionCueDirty,setProductionCueDirty]=useState(false);
  const requested=work?.shots?.find(item=>item.id===shotId),requestedKey=requested?`${work.id}/${shotId}`:null;

  useEffect(()=>{
    if(lockedRef.current)return;
    if(!open){saveDraft(sessionRef.current);sessionRef.current=null;setSession(null);return;}
    if(!requestedKey||sessionRef.current?.key===requestedKey)return;
    saveDraft(sessionRef.current);
    setExecutionStatus({canGenerate:false,label:'正在核对',state:'missing'});
    setProductionCueDirty(false);
    const saved=draftCatalog()[requestedKey],next={key:requestedKey,workId:work.id,shotId,workSnapshot:work,values:restoreValues(shotValues(requested),saved),dirty:Boolean(saved),restored:Boolean(saved)};
    sessionRef.current=next;setSession(next);setError('');setStorageFailed(false);
  },[open,requestedKey,operation]);

  useEffect(()=>{
    if(!open)return;
    let cancelled=false;setCreative(previous=>({...previous,loading:true}));
    Promise.resolve().then(()=>apiRef.current('/api/creative-skills')).then(result=>{
      if(!cancelled)setCreative({skills:safeArray(result.skills),scenarios:result.scenarios||[],loading:false});
    }).catch(()=>{if(!cancelled)setCreative({skills:[],scenarios:[],loading:false});});
    return ()=>{cancelled=true;};
  },[open]);

  useEffect(()=>()=>{saveDraft(sessionRef.current);},[]);

  const currentWork=session?(work?.id===session.workId?work:session.workSnapshot):null;
  const currentShot=currentWork?.shots?.find(item=>item.id===session?.shotId);
  const values=session?.values;
  const versions=safeArray(currentWork?.assets).filter(asset=>asset.shotId===session?.shotId&&asset.type==='video');
  const selected=versions.find(asset=>asset.id===currentShot?.selectedAssetId)||versions.at(-1);
  const jobs=safeArray(currentWork?.jobs).filter(job=>job.shotId===session?.shotId),latestJob=jobs.at(-1),generating=jobs.some(job=>RUNNING.has(job.status));
  const libraries=currentWork?.studio?.libraries||{},media=safeArray(currentWork?.studio?.media).filter(item=>item.type==='image'&&item.bytes<=25*1024*1024);
  const firstFrame=media.find(item=>item.id===values?.firstFrameMediaId);
  const clip=currentWork?.studio?.timelines?.[currentShot?.episodeId]?.clips?.find(item=>item.type==='shot'&&item.shotId===session?.shotId);
  const locked=Boolean(operation),readOnly=locked||generating;
  const frameError=h3FrameSelectionError(values);
  const measurement=selectedVideoMeasurement(jobs,selected?.id);
  const executionSourceKey=JSON.stringify([currentWork?.style,currentShot?shotValues(currentShot):null,currentShot?.skillSnapshot,currentShot?.productionCues,safeArray(libraries.characters).filter(item=>currentShot?.characterIds?.includes(item.id)),safeArray(libraries.scenes).find(item=>item.id===currentShot?.sceneId),safeArray(libraries.voices).filter(item=>currentShot?.voiceIds?.includes(item.id)),media.find(item=>item.id===currentShot?.firstFrameMediaId)]);

  function updateField(name,value){
    const previous=sessionRef.current;if(!previous||lockedRef.current||generating)return;
    const next={...previous,values:{...previous.values,[name]:value},dirty:true,restored:false};
    sessionRef.current=next;setSession(next);setStorageFailed(!saveDraft(next));setError('');
  }
  function requestOpenChange(next){
    if(lockedRef.current)return;
    if(!next){saveDraft(sessionRef.current);videoRef.current?.pause();}
    onOpenChange?.(next);
  }
  function begin(kind){
    if(lockedRef.current||!sessionRef.current)return null;
    if(['save','confirm','generate-legacy','generate-compiled'].includes(kind)){
      const problem=h3FrameSelectionError(sessionRef.current.values);if(problem){setError(problem);return null;}
    }
    const target={...sessionRef.current,values:structuredClone(sessionRef.current.values)};
    saveDraft(target);lockedRef.current=true;setOperation(kind);setError('');onBusyChange?.(true);
    return target;
  }
  function end(){lockedRef.current=false;setOperation(null);onBusyChange?.(false);}
  async function refreshWork(){try{await refresh?.(true);}catch{toast('操作已完成，暂未刷新到最新记录。');}}
  async function save(action){
    if(generating||!formRef.current?.reportValidity())return;
    const target=begin(action);if(!target)return;
    let persisted=false;
    try{
      let response=await api(`/api/works/${target.workId}/studio/shots/${target.shotId}/save`,target.values);persisted=true;
      if(action==='confirm')response=await api(`/api/works/${target.workId}/studio/shots/${target.shotId}/confirm`,{});
      if(action==='generate-legacy')response=await api(`/api/works/${target.workId}/generate`,{shotId:target.shotId,executionMode:'legacy'});
      const savedShot=response.work?.shots?.find(item=>item.id===target.shotId),next={...target,workSnapshot:response.work||target.workSnapshot,values:savedShot?shotValues(savedShot):target.values,dirty:false,restored:false};
      removeDraft(target.key);
      if(sessionRef.current?.key===target.key){sessionRef.current=next;setSession(next);}
      await refreshWork();
      toast(action==='confirm'?'分镜已确认，时间轴位置已同步':action==='generate-legacy'?'已按历史模式交给 GB10，生产参数与耗时会自动记录':'分镜制作资料已保存；如资料变化，请重新编译执行稿');
    }catch(problem){setError(`${persisted?'分镜已保存，后续操作未完成：':''}${problem.message||'操作未完成，请重试。'}`);}
    finally{end();}
  }
  async function generateCompiled(){
    if(generating||sessionRef.current?.dirty||productionCueDirty||!executionStatus.canGenerate)return;
    const target=begin('generate-compiled');if(!target)return;
    try{await api(`/api/works/${target.workId}/generate`,{shotId:target.shotId,executionMode:'compiled'});await refreshWork();toast('已使用锁定执行稿提交 GB10，原文与来源已冻结记录');}
    catch(problem){setError(problem.message||'生成未提交，请核对执行稿锁版。');}
    finally{end();}
  }
  async function cancelQueued(){
    if(latestJob?.status!=='queued')return;
    const jobId=latestJob.id,target=begin('cancel-queued');if(!target)return;
    try{await api(`/api/works/${target.workId}/jobs/${jobId}/cancel`,{});await refreshWork();toast('本机排队任务已取消，没有中断其他作品的生成');}
    catch(problem){setError(problem.message||'取消未完成，请查看任务当前状态。');}
    finally{end();}
  }
  async function selectVersion(assetId){
    if(assetId===currentShot?.selectedAssetId)return;
    const target=begin('version');if(!target)return;
    try{await api(`/api/works/${target.workId}/shots/${target.shotId}/select-asset`,{assetId});await refreshWork();toast('已选用此版本，时间轴同步更新');}
    catch(problem){setError(problem.message||'版本选用未完成。');}finally{end();}
  }
  async function duplicate(){
    const target=begin('duplicate');if(!target)return;
    try{await api(`/api/works/${target.workId}/shots/${target.shotId}/duplicate`,{});await refreshWork();toast('已复制为新分镜草稿，保留当前镜头');}
    catch(problem){setError(problem.message||'复制未完成。');}finally{end();}
  }

  return <Dialog.Root open={Boolean(session&&(open||locked))} onOpenChange={requestOpenChange}>
    <Dialog.Content className="studio-segment-dialog" maxWidth="1020px" onEscapeKeyDown={event=>{if(closeNestedClipSettings(event))return;if(lockedRef.current)event.preventDefault();}} onPointerDownOutside={event=>{if(lockedRef.current)event.preventDefault();}}>
      <header className="studio-segment-header">
        <div><div className="segment-eyebrow"><Clapperboard size={14}/>片段处理</div><Dialog.Title mb="1">{currentShot?.title||'分镜详情'}</Dialog.Title><Dialog.Description className="studio-segment-description">制作资料与最终执行稿独立管理，每次生成保留固定版本。</Dialog.Description></div>
        <div className="segment-heading-actions"><Badge color={currentShot?.approvalStatus==='confirmed'?'green':'gray'} variant="soft">{currentShot?.approvalStatus==='confirmed'?'已确认 · 已上轨':'分镜草稿'}</Badge><IconButton variant="ghost" color="gray" size="2" aria-label="关闭片段处理" disabled={locked} onClick={()=>requestOpenChange(false)}><X size={20}/></IconButton></div>
      </header>
      {session&&values?<>
        <div className="studio-segment-body">
          <section className="studio-segment-preview" aria-label="视频与历史版本">
            <div className="studio-segment-screen">
              {selected?<video ref={videoRef} key={selected.id} controls preload="metadata" src={selected.url} poster={selected.posterUrl||undefined} aria-label="当前分镜视频"/>:<div className="segment-empty-preview"><Film size={38}/><h3>{generating?'GB10 正在制作画面':'这里将成为你的镜头'}</h3><p>完善右侧分镜，再生成第一个视频版本。</p></div>}
            </div>
            <div className="segment-preview-meta"><span>{clip?`时间轴已占位 ${clip.duration} 秒`:'尚未编排到时间轴'}</span><Badge color="gray" variant="surface">{currentShot?.ratio||'16:9'} · {currentShot?.resolution||'352P'}</Badge></div>
            {selected?<div className="segment-output-measurement" aria-label="当前版本实际帧长"><span>本版请求 <strong>{measurement?.requestedSeconds?`${measurement.requestedSeconds} 秒`:'未记录'}</strong></span><span>实测 <strong>{measurement?.durationSeconds?`${Number(measurement.durationSeconds.toFixed(3))} 秒`:'未记录'}</strong></span><span>{measurement?.frames?`${measurement.frames} 帧`:'帧数未记录'}{measurement?.fps?` · ${measurement.fps} fps`:''}</span></div>:null}
            {latestJob?<div className={`segment-task-message ${latestJob.error?'has-error':''}`} role="status"><Badge color={latestJob.error?'red':generating?'amber':'green'}>{JOB_LABELS[latestJob.status]||latestJob.status}</Badge><span>{latestJob.error||latestJob.message||'等待执行'}</span></div>:null}
            {latestJob?.status==='queued'?<Button type="button" size="1" variant="surface" color="gray" disabled={locked} loading={operation==='cancel-queued'} onClick={cancelQueued}><X size={13}/>取消本机排队</Button>:null}
            <div className="segment-section-title"><h3>视频版本 <span>{versions.length}</span></h3>{selected?<a className="segment-download" href={selected.url} download><Download size={14}/>下载原片</a>:null}</div>
            <div className="studio-segment-versions">
              {versions.length?versions.map((asset,index)=><button type="button" key={asset.id} className={`studio-segment-version ${asset.id===selected?.id?'is-selected':''}`} aria-label={`版本 ${index+1}${asset.id===selected?.id?'，已选用':''}`} aria-pressed={asset.id===selected?.id} disabled={locked} onClick={()=>selectVersion(asset.id)}>{asset.posterUrl?<img src={asset.posterUrl} alt="" loading="lazy"/>:<span className="segment-version-placeholder"><Film size={22}/></span>}<span>版本 {index+1}{asset.id===selected?.id?<Check size={13}/>:null}</span></button>):<p className="segment-field-hint">每次生成都会归档，新版本不会删除旧素材。</p>}
            </div>
            <div className="segment-secondary-actions"><Button variant="surface" color="gray" disabled={locked||!clip||!onEditClip} onClick={event=>onEditClip?.(clip.id,event.currentTarget.closest('[role="dialog"]'))}><Scissors size={15}/>剪辑设置</Button><Button variant="surface" color="gray" disabled={locked} onClick={duplicate}><Copy size={15}/>复制分镜</Button></div>
            <div className="segment-record-link"><FileText size={17}/><div><strong>每次生成都有记录</strong><p>参数、实际耗时与生产速率保留在后台。</p></div>{onOpenLogs?<Button variant="ghost" disabled={locked} onClick={()=>onOpenLogs(session.shotId)}>查看记录</Button>:<a href={`/api/works/${session.workId}/generation-log`} download>导出 JSON</a>}</div>
            {selected?<TranscriptionPanel key={`${session.workId}/${selected.id}`} workId={session.workId} asset={selected} shot={currentShot} api={api} disabled={locked}/>:null}
          </section>
          <form ref={formRef} id={`${prefix}-form`} className="studio-segment-form" onSubmit={event=>{event.preventDefault();void save('save');}}>
            <div className="segment-production-heading"><FileText size={16}/><div><h3>制作脚本与设定</h3><p>完整记录本镜的创作意图与绑定，执行稿由下方单独编译。</p></div></div>
            <Field label="分镜名称" htmlFor={`${prefix}-title`}><TextField.Root id={`${prefix}-title`} name="title" maxLength={120} required value={values.title} onChange={event=>updateField('title',event.target.value)} disabled={readOnly}/></Field>
            <Field label="画面与动作" htmlFor={`${prefix}-visual`} hint="写下主体、动作、镜头运动、构图与光线。"><TextArea id={`${prefix}-visual`} name="visual" rows={5} maxLength={15000} required resize="vertical" value={values.visual} onChange={event=>updateField('visual',event.target.value)} disabled={readOnly} placeholder="雨夜中，邮差提着星灯走向巷口，镜头缓缓跟随…"/></Field>
            <Field label="环境声与对白" htmlFor={`${prefix}-sound`}><TextArea id={`${prefix}-sound`} name="sound" rows={3} maxLength={5000} resize="vertical" value={values.sound} onChange={event=>updateField('sound',event.target.value)} disabled={readOnly} placeholder="环境声；如有对白，请写出角色、台词与说话方式。"/></Field>
            {currentShot?<ProductionCues key={session.key} work={currentWork} shot={currentShot} api={api} refresh={refresh} toast={toast} readOnly={readOnly} onDirtyChange={setProductionCueDirty} onBegin={begin} onEnd={end}/>:null}
            <fieldset className="segment-reference-fieldset"><legend><Users size={15}/>角色设定</legend>{safeArray(libraries.characters).length?<CheckboxGroup.Root aria-label="角色设定" value={values.characterIds} onValueChange={next=>updateField('characterIds',next)} disabled={readOnly} className="segment-checkboxes">{libraries.characters.map(entry=><CheckboxGroup.Item key={entry.id} value={entry.id}><span>{entry.name}{entry.locked?<LockKeyhole size={11}/>:null}</span></CheckboxGroup.Item>)}</CheckboxGroup.Root>:<p className="segment-field-hint">在素材区建立角色卡，再绑定到分镜。</p>}</fieldset>
            <div className="segment-field-grid">
              <Field label={<><MapPin size={14}/>场景</>} htmlFor={`${prefix}-scene`}><ChoiceSelect id={`${prefix}-scene`} label="场景" value={values.sceneId} onChange={next=>updateField('sceneId',next)} emptyLabel="不绑定场景" options={safeArray(libraries.scenes).map(entry=>({value:entry.id,label:entry.name}))} disabled={readOnly}/></Field>
              <Field label={<><Image size={14}/>首帧参考</>} htmlFor={`${prefix}-first-frame`}><ChoiceSelect id={`${prefix}-first-frame`} label="首帧参考" value={values.firstFrameMediaId} onChange={next=>updateField('firstFrameMediaId',next)} emptyLabel="文生视频" options={media.map(entry=>({value:entry.id,label:entry.name}))} disabled={readOnly}/></Field>
            </div>
            {firstFrame?<div className="segment-first-frame"><img src={firstFrame.url} alt={`首帧参考：${firstFrame.name}`}/><div><strong>{firstFrame.name}</strong><span>单张首帧 · H3 图生视频</span></div></div>:null}
            <p className="segment-field-hint">这里保存角色、场景与首帧绑定；编译模式只送出明确整理的英文执行稿，完整角色卡留在制作记录中。</p>
            <div className="segment-field-grid three">
              <Field label="生成画幅" htmlFor={`${prefix}-ratio`}><ChoiceSelect id={`${prefix}-ratio`} label="生成画幅" value={values.ratio} onChange={next=>updateField('ratio',next)} options={h3RatioChoices(values.resolution)} disabled={readOnly}/></Field>
              <Field label="请求时长" htmlFor={`${prefix}-duration`}><ChoiceSelect id={`${prefix}-duration`} label="生成时长" value={String(values.duration)} onChange={next=>{const duration=h3RequestDuration(next);if(duration!==null)updateField('duration',duration);}} options={H3_REQUEST_DURATIONS.map(value=>({value,label:`${value} 秒${value===5?' · 短镜基线':''}`}))} disabled={readOnly}/></Field>
              <Field label="生成分辨率" htmlFor={`${prefix}-resolution`}><ChoiceSelect id={`${prefix}-resolution`} label="生成分辨率" value={values.resolution} onChange={next=>updateField('resolution',next)} options={h3ResolutionChoices(values.ratio)} disabled={readOnly}/></Field>
            </div>
            <p className="segment-field-hint" role={frameError?'alert':'note'}>{frameError||H3_WIDE_HINT}</p>
            <p className="segment-field-hint">请求可选整数 4–15 秒，按台词与动作安排足够时长；5 秒可作短镜基线，长句不必压进 5 秒。请求时长、实测帧长与已有时间轴占位分别记录，改请求不会自动调整占位，需到剪辑设置单独修改。</p>
            <details className="segment-advanced" open={values.skillIds.length>0?true:undefined}><summary><Sparkles size={15}/>创作技能{values.skillIds.length?<Badge size="1" color="green">{values.skillIds.length}</Badge>:null}<ChevronDown size={15}/></summary><div className="segment-advanced-content">{creative.skills.length?<CheckboxGroup.Root aria-label="创作技能" value={values.skillIds} onValueChange={next=>updateField('skillIds',next)} disabled={readOnly} className="segment-skill-choices">{creative.skills.map(skill=><CheckboxGroup.Item key={skill.id} value={skill.id} disabled={skill.enabled===false&&!values.skillIds.includes(skill.id)}><span className="segment-skill-choice"><strong>{skill.name||skill.title||skill.id}{skill.enabled===false?' · 已停用':''}</strong><SkillScenario skill={skill} scenarios={creative.scenarios}/></span></CheckboxGroup.Item>)}</CheckboxGroup.Root>:<p className="segment-field-hint">{creative.loading?'正在读取创作技能…':'暂无可用创作技能，不影响分镜保存与生成。'}</p>}<p className="segment-field-hint">选用的技能说明随本镜保存，辅助整理分镜与提示词。</p></div></details>
            <details className="segment-advanced"><summary><Volume2 size={15}/>音色与配乐制作资料<ChevronDown size={15}/></summary><div className="segment-advanced-content"><fieldset className="segment-reference-fieldset"><legend>音色设定</legend>{safeArray(libraries.voices).length?<CheckboxGroup.Root aria-label="音色设定" value={values.voiceIds} onValueChange={next=>updateField('voiceIds',next)} disabled={readOnly} className="segment-checkboxes">{libraries.voices.map(entry=><CheckboxGroup.Item key={entry.id} value={entry.id}>{entry.name}</CheckboxGroup.Item>)}</CheckboxGroup.Root>:<p className="segment-field-hint">声音库可导入配音并记录音色方向。</p>}</fieldset><Field label="配乐描述" htmlFor={`${prefix}-music`}><TextArea id={`${prefix}-music`} name="music" rows={2} maxLength={5000} resize="vertical" value={values.music} onChange={event=>updateField('music',event.target.value)} disabled={readOnly}/></Field><p className="segment-field-hint">这里只保存声音制作意图；角色音色不会由 H3 提示词自动克隆。独立配音与配乐需另行生成并铺入时间轴。</p></div></details>
            {currentShot?<ExecutionPromptPanel key={session.key} workId={session.workId} shot={currentShot} characters={safeArray(libraries.characters)} sourceKey={executionSourceKey} productionDirty={session.dirty||productionCueDirty} disabled={readOnly} api={api} onBegin={begin} onEnd={end} onCommitted={refreshWork} onStatusChange={setExecutionStatus} toast={toast}/>:null}
            <details className="segment-advanced segment-legacy-mode"><summary>兼容历史生成模式<ChevronDown size={15}/></summary><div className="segment-advanced-content"><p className="segment-field-hint">历史模式使用保存分镜时自动合并的提示词，可能包含完整角色卡和技能指导。它与上面的锁定英文执行稿分开，不会自动退回此模式。</p><div className="segment-prompt-preview"><strong>历史模式上次保存的提示词</strong><pre>{currentShot?.prompt||'尚未保存历史模式提示词。'}</pre></div><Button type="button" size="1" variant="surface" color="gray" disabled={readOnly||Boolean(frameError)} loading={operation==='generate-legacy'} onClick={()=>save('generate-legacy')}><Sparkles size={13}/>保存并按历史模式生成</Button></div></details>
            {error?<Callout.Root color="red" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root>:null}
            {storageFailed?<Callout.Root color="amber"><Callout.Text>浏览器暂存空间不可用，请及时保存当前分镜。</Callout.Text></Callout.Root>:null}
          </form>
        </div>
        <footer className="studio-segment-footer"><div aria-live="polite">{locked?'正在处理，请稍候…':generating?'GB10 正在生成，此时可查看版本与记录':session.dirty?session.restored?'已恢复未保存的制作资料':'制作资料草稿已暂存在本机':productionCueDirty?'逐镜脚本有未保存修改':executionStatus.label}</div><div className="segment-primary-actions"><Button variant="surface" color="gray" disabled={readOnly||Boolean(frameError)} loading={operation==='save'} onClick={()=>save('save')}><Save size={15}/>保存分镜</Button><Button variant="surface" disabled={readOnly||productionCueDirty||Boolean(frameError)} loading={operation==='confirm'} onClick={()=>save('confirm')}><Check size={16}/>确认分镜</Button><Button disabled={readOnly||session.dirty||productionCueDirty||!executionStatus.canGenerate||Boolean(frameError)} loading={operation==='generate-compiled'} onClick={generateCompiled}><Sparkles size={16}/>{generating?'生成进行中':'使用锁定执行稿生成'}</Button></div></footer>
      </>:null}
    </Dialog.Content>
  </Dialog.Root>;
}
