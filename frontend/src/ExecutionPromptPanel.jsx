import {useEffect,useId,useRef,useState} from 'react';
import {Badge,Button,Callout,IconButton,Select,TextArea} from '@radix-ui/themes';
import {Check,ChevronDown,Code2,Eye,LockKeyhole,Plus,RefreshCw,Save,Trash2} from 'lucide-react';
import {executionRecipe,executionState,submitExecutionPrompt} from './execution-prompt-ui.mjs';

const EMPTY_STATUS={mode:'legacy',state:'missing',reasons:[]};
const NONE='__none__';
const FIELD_LABELS=[['integrated_multimodal_description','画面、动作与对白',5],['overall_soundscape','环境声与拟音',3],['non_diegetic_music','画外配乐',2]];

/** This editor owns recipe drafts; polling may update status, never text under the user's cursor. */
export default function ExecutionPromptPanel({workId,shot,characters=[],sourceKey,productionDirty,disabled,api,onBegin,onEnd,onCommitted,onStatusChange,toast=()=>{}}){
 const prefix=useId(),mounted=useRef(true),requestId=useRef(0),apiRef=useRef(api),dirtyRef=useRef(false),recipeRef=useRef(null);
 apiRef.current=api;
 const [record,setRecord]=useState(shot?.executionPrompt||null),[status,setStatus]=useState(EMPTY_STATUS),[recipe,setRecipe]=useState(()=>executionRecipe(shot?.executionPrompt)),[recipeDirty,setRecipeDirty]=useState(false),[preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(null),[loading,setLoading]=useState(true),[storageFailed,setStorageFailed]=useState(false),[reload,setReload]=useState(0);
 const storageKey=`rack-execution-draft:${workId}/${shot.id}`;
 const effective=executionState({status,dirty:productionDirty,recipeDirty,loading});
 const boundCharacters=characters.filter(character=>(shot.characterIds||[]).includes(character.id));
 const compilation=record?.compilation,lock=record?.lock;
 recipeRef.current=recipe;

 function replaceRecipe(next){recipeRef.current=next;setRecipe(next);}
 function stash(next){try{localStorage.setItem(storageKey,JSON.stringify(next));setStorageFailed(false);}catch{setStorageFailed(true);}}
 function clearStash(){try{localStorage.removeItem(storageKey);}catch{}}
 function edit(next){if(disabled||busy)return;dirtyRef.current=true;setRecipeDirty(true);replaceRecipe(next);setPreview(null);setError('');stash(next);}
 function accept(result,{replace=false}={}){
  const next=result.executionPrompt||null;setRecord(next);setStatus(result.status||EMPTY_STATUS);
  if(replace){const value=executionRecipe(next);replaceRecipe(value);dirtyRef.current=false;setRecipeDirty(false);clearStash();}
  else if(!dirtyRef.current)replaceRecipe(executionRecipe(next));
 }
 useEffect(()=>{
  mounted.current=true;
  try{const stored=JSON.parse(localStorage.getItem(storageKey)||'null');if(stored){const next=executionRecipe(stored);replaceRecipe(next);dirtyRef.current=true;setRecipeDirty(true);}}
  catch{}
  return ()=>{mounted.current=false;requestId.current++;};
 },[storageKey]);
 useEffect(()=>{
  const ticket=++requestId.current;setLoading(true);
  Promise.resolve().then(()=>apiRef.current(`/api/works/${workId}/studio/shots/${shot.id}/execution-prompt`)).then(result=>{if(mounted.current&&ticket===requestId.current)accept(result);}).catch(problem=>{if(mounted.current&&ticket===requestId.current){setError(problem.message||'暂时无法读取执行稿。');setStatus(EMPTY_STATUS);}}).finally(()=>{if(mounted.current&&ticket===requestId.current)setLoading(false);});
 },[workId,shot.id,sourceKey,reload]);
 useEffect(()=>{onStatusChange?.({...effective,hash:compilation?.hash||null,state:status.state,revision:record?.revision||0});},[effective.label,effective.canGenerate,effective.color,compilation?.hash,status.state,record?.revision]);

 async function run(action){
  if(disabled||busy||loading||productionDirty)return;
  if(action==='lock'&&(recipeDirty||!compilation||status.state!=='compiled'))return;
  const captured=structuredClone(recipeRef.current),target=onBegin?.(`prompt-${action}`);if(!target)return;
  const ticket=++requestId.current;setBusy(action);setError('');
  let committed=false;
  try{
   const result=await submitExecutionPrompt({api:apiRef.current,workId,shotId:shot.id,action,recipe:captured,revision:record?.revision||0,hash:compilation?.hash});
   if(!mounted.current||ticket!==requestId.current)return;
   if(action==='preview'){setPreview(result.preview);if(result.status)setStatus(result.status);}
   else{
    committed=true;accept(result,{replace:true});setPreview(action==='compile'?result.compilation||result.executionPrompt?.compilation:null);
    toast(action==='draft'?'英文执行稿草稿已保存':action==='compile'?'执行稿已编译，请核对原文后锁版':'执行稿已锁版，可显式提交 GB10');
    try{await onCommitted?.(result);}catch{setError('执行稿已保存，暂未刷新到最新制作资料，请刷新核对。');}
   }
  }catch(problem){if(mounted.current&&ticket===requestId.current)setError(`${committed?'操作已保存，':''}${problem.message||'执行稿操作未完成。'}`);}
  finally{if(mounted.current){setBusy(null);setLoading(false);}onEnd?.();}
 }
 function addSpeaker(){const used=new Set(recipe.speakers.map(item=>item.label));let number=1;while(used.has(`S${number}`))number++;edit({...recipe,speakers:[...recipe.speakers,{label:`S${number}`,characterId:''}]});}
 const exact=preview||compilation;

 return <section className="segment-execution" aria-label="最终 H3 执行稿">
  <header className="segment-execution-heading"><div><Code2 size={16}/><h3>最终 H3 执行稿</h3></div><Badge color={effective.color}>{effective.label}</Badge><IconButton type="button" size="1" variant="ghost" color="gray" aria-label="重新核对执行稿状态" title="保留本机编辑，重新读取服务器修订号与锁版状态" disabled={Boolean(busy)||loading} onClick={()=>setReload(value=>value+1)}><RefreshCw size={13}/></IconButton></header>
  <p className="segment-field-hint">由 Codex 对话整理英文执行稿。这里只校验、排版与留档，不自动翻译制作脚本，也不追加角色卡或技能全文。</p>
  <p className="segment-execution-mode">{shot.firstFrameMediaId?'I2VA · 单张首帧，三个执行字段':'T2VA · 文生视频，三个执行字段'}<span>阅读技能 ≠ 直接送模</span></p>
  {productionDirty?<Callout.Root color="amber" size="1"><Callout.Text>制作资料或绑定有未保存修改。先保存分镜，再预览、编译和锁版。</Callout.Text></Callout.Root>:null}
  {status.state==='stale'?<Callout.Root color="amber" size="1"><Callout.Text>已锁执行稿与当前资料不一致，不能继续沿用。{(status.reasons||[]).join('；')}。请重新核对并编译锁版。</Callout.Text></Callout.Root>:null}
  <details className="segment-execution-instructions"><summary>英文执行稿怎么写 <ChevronDown size={13}/></summary><p>画面字段以 <code>[Shot 1]</code> 开头，只保留本镜可见身份、动作、空间、声音和必要约束。说话角色从 S1 开始顺序编号，原文中固定使用 (S1)、(S2)；中文原台词写为 <code>{'<d>[Chinese]原台词</d>'}</code>。画面内需要原样显示的中文文字放在英文双引号内；中文对白仍使用上述标签。禁止把家谱、待审状态或制作说明当画面叙述。</p><p>当前 CFG=1 不提供普通 CFG 的负向引导，请把限制改成正向可见状态。多参考 Ref2VA 尚未接入。</p></details>
  <div className="segment-execution-speakers"><div className="segment-execution-subheading"><strong>本镜说话角色</strong><Button type="button" size="1" variant="ghost" disabled={disabled||busy||recipe.speakers.length>=boundCharacters.length} onClick={addSpeaker}><Plus size={13}/>添加</Button></div>{recipe.speakers.length?recipe.speakers.map((speaker,index)=><div className="segment-execution-speaker" key={speaker.label}><label htmlFor={`${prefix}-speaker-${index}`}>({speaker.label})</label><Select.Root value={speaker.characterId||NONE} disabled={disabled||Boolean(busy)} onValueChange={value=>edit({...recipe,speakers:recipe.speakers.map((item,i)=>i===index?{...item,characterId:value===NONE?'':value}:item)})}><Select.Trigger id={`${prefix}-speaker-${index}`} aria-label={`说话角色 ${speaker.label}`} className="segment-select"/><Select.Content><Select.Item value={NONE}>选择本镜绑定角色</Select.Item>{boundCharacters.map(character=><Select.Item key={character.id} value={character.id}>{character.name}</Select.Item>)}</Select.Content></Select.Root><IconButton type="button" size="1" variant="ghost" color="gray" aria-label={`移除说话角色 ${speaker.label}`} disabled={disabled||Boolean(busy)||index!==recipe.speakers.length-1} title="从最后一个编号移除，保留既有标签" onClick={()=>edit({...recipe,speakers:recipe.speakers.filter((_,i)=>i!==index)})}><Trash2 size={13}/></IconButton></div>):<p className="segment-field-hint">无对白可留空；先在制作资料中绑定需要说话的角色。</p>}</div>
  {FIELD_LABELS.map(([key,label,rows])=><div className="segment-field" key={key}><label htmlFor={`${prefix}-${key}`}>{label}<code>{key}</code></label><TextArea id={`${prefix}-${key}`} aria-label={`H3 执行稿：${label}`} value={recipe[key]} rows={rows} maxLength={{integrated_multimodal_description:16000,overall_soundscape:4000,non_diegetic_music:2000}[key]} resize="vertical" disabled={disabled||Boolean(busy)} onChange={event=>edit({...recipe,[key]:event.target.value})} placeholder={key==='integrated_multimodal_description'?'[Shot 1] Describe only what happens in this shot, in English…':'Write the sound direction in English; use an explicit silent / no-music description if intended.'}/></div>)}
  <div className="segment-execution-actions"><Button type="button" size="1" variant="surface" color="gray" disabled={disabled||Boolean(busy)||loading||productionDirty} loading={busy==='draft'} onClick={()=>run('draft')}><Save size={13}/>保存执行稿草稿</Button><Button type="button" size="1" variant="surface" disabled={disabled||Boolean(busy)||loading||productionDirty} loading={busy==='preview'} onClick={()=>run('preview')}><Eye size={13}/>只读预览</Button><Button type="button" size="1" variant="surface" disabled={disabled||Boolean(busy)||loading||productionDirty} loading={busy==='compile'} onClick={()=>run('compile')}><Code2 size={13}/>保存编译</Button><Button type="button" size="1" disabled={disabled||Boolean(busy)||loading||productionDirty||recipeDirty||!compilation||status.state!=='compiled'} loading={busy==='lock'} onClick={()=>run('lock')}><LockKeyhole size={13}/>锁定执行稿</Button></div>
  {exact?<div className="segment-execution-output"><div><strong>{preview?'本次编译预览原文':'已保存的送模原文'}</strong>{lock?.hash===exact.hash&&status.state==='locked'&&!recipeDirty&&!productionDirty?<Badge color="green" size="1"><Check size={10}/>已锁版</Badge>:<Badge color="gray" size="1">{preview&&preview.hash!==compilation?.hash?'尚未保存':'待核对'}</Badge>}</div><p className="segment-execution-hash">SHA256 <code>{exact.hash}</code></p><pre tabIndex={0} aria-label="最终送给 H3 的完整提示词">{exact.prompt}</pre>{(exact.warnings||[]).length?<ul className="segment-execution-warnings">{exact.warnings.map((warning,index)=><li key={index}>{typeof warning==='string'?warning:warning.message||JSON.stringify(warning)}</li>)}</ul>:null}<p className="segment-field-hint">生成会冻结这份原文、哈希、来源 recipe 和本次绑定。仅预览和锁版不会启动 GPU。</p></div>:<p className="segment-field-hint">填写英文三字段后，可先预览精确送模原文；保存编译并锁版后才可使用此模式生成。</p>}
  {compilation?<details className="segment-execution-provenance"><summary>锁版与来源记录</summary><dl><div><dt>编译版本</dt><dd>{compilation.version||'—'}</dd></div><div><dt>资料指纹</dt><dd>{compilation.sourceFingerprint||'未记录'}</dd></div><div><dt>绑定指纹</dt><dd>{compilation.bindingFingerprint||'未记录'}</dd></div><div><dt>锁定时间</dt><dd>{lock?.lockedAt||'尚未锁定'}</dd></div></dl>{(record.history||[]).length?<p>已保留 {(record.history||[]).length} 个历史编译版本，旧生产记录保持原值。</p>:null}</details>:null}
  {recipeDirty?<p className="segment-field-hint">英文执行稿有本机未保存修改，锁版与生成暂停；保存编译会建立新的固定版本。</p>:null}
  {storageFailed?<Callout.Root color="amber" size="1"><Callout.Text>浏览器暂存不可用，请及时保存执行稿草稿。</Callout.Text></Callout.Root>:null}
  {error?<Callout.Root color="red" size="1" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root>:null}
 </section>;
}
