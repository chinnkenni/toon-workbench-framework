// Pure data compiler for an explicitly requested static storyboard preview.
// It neither reads prompts nor produces speech/real speech-alignment claims.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
const graphemes=new Intl.Segmenter('zh',{granularity:'grapheme'});
const parts=value=>[...graphemes.segment(value)].map(item=>item.segment);
const unsafe=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function checkedText(value,label,max){if(typeof value!=='string'||value.length>max||unsafe.test(value))fail(`${label}包含不支持的控制字符或超过限制`);return value;}
const width=part=>part==='\t'?4:[...part].some(char=>char.codePointAt(0)>255)?2:1;

/** Insert visual line breaks without losing any original grapheme or whitespace. */
function lines(value,columns){
 const result=[];let text='',rawText='',used=0;
 const flush=()=>{result.push({text,rawText});text='';rawText='';used=0;};
 for(const part of parts(value)){
  if(/^(?:\r\n|\r|\n|\u2028|\u2029)$/.test(part)){rawText+=part;flush();continue;}
  const cells=width(part);if(used&&used+cells>columns)flush();text+=part;rawText+=part;used+=cells;
 }
 if(text||rawText||!result.length)flush();return result;
}
function pagesFor(cue,columns,maxLines){
 const labelFor=name=>`计划对白 · ${name}`;
 let displayedSpeaker=cue.speakerName||cue.speakerLabel||'未标说话者',header=lines(labelFor(displayedSpeaker),columns);
 if(header.length>=maxLines){displayedSpeaker=cue.speakerLabel||'未标说话者';header=lines(labelFor(displayedSpeaker),columns);}
 const capacity=maxLines-header.length;if(capacity<1)fail('当前字幕宽度不足以显示计划对白标签，请增大导出尺寸');
 const content=lines(cue.text,columns),result=[];
 for(let i=0;i<content.length;i+=capacity){const group=content.slice(i,i+capacity);result.push({text:[...header.map(line=>line.text),...group.map(line=>line.text)].join('\n'),rawText:group.map(line=>line.rawText).join(''),displayedSpeaker});}
 if(result.map(page=>page.rawText).join('')!==cue.text)fail('计划对白分页未完整保留原句');return result;
}
function equalWindows(count,frames){return Array.from({length:count},(_,index)=>({startFrame:Math.floor(index*frames/count),endFrame:Math.floor((index+1)*frames/count)}));}
function planWindows(dialogue,pages,frames,fps){
 let reason=null,windows=[];
 for(const cue of dialogue){
  const start=cue.planStart,end=cue.planEnd;
  if(start===null||end===null){reason='missing-plan-bounds';break;}
  if(start<0||end<=start||end>frames/fps){reason='outside-current-clip';break;}
  const startFrame=Math.round(start*fps),endFrame=Math.round(end*fps);
  if(endFrame<=startFrame){reason='under-one-frame-plan';break;}
  if(windows.length&&startFrame<windows.at(-1).endFrame){reason='overlapping-or-unordered-plan';break;}
  windows.push({startFrame,endFrame});
 }
 if(!reason&&windows.some((window,index)=>window.endFrame-window.startFrame<pages[index].length))reason='insufficient-planned-frames-for-pages';
 if(reason)windows=equalWindows(dialogue.length,frames);
 if(windows.some((window,index)=>window.endFrame-window.startFrame<pages[index].length))fail('当前片段计划时长不足以完整显示全部对白字幕页，请加长片段或拆分分镜；没有截断原句');
 return {windows,allocation:reason?'equal-segments':'saved-plan-bounds',reason};
}

/**
 * @returns Full frozen source and drawtext-ready textfile events. The caller must
 * write `event.text` as UTF-8 and use expansion=none, never interpolate it into a
 * filter expression. start/end are clip-local planned seconds, not measured lip
 * sync. Layout pages preserve `rawText` exactly, including source whitespace.
 */
export function buildStoryboardCaption(work,shot,options={}){
 if(!plain(work)||!plain(shot)||!plain(options))fail('静态分镜字幕输入无效');
 const fps=options.fps??24,duration=options.duration??shot.duration??4,columns=options.columns??44,maxLines=options.maxLines??3;
 if(![24,30].includes(fps)||typeof duration!=='number'||!Number.isFinite(duration)||duration<1/fps||duration>600||!Number.isInteger(columns)||columns<8||columns>240||!Number.isInteger(maxLines)||maxLines<2||maxLines>12)fail('静态分镜字幕尺寸或计划时长无效');
 const frames=Math.round(duration*fps),shotTitle=checkedText(shot.title??'','分镜标题',2000),shotNumber=Number.isSafeInteger(shot.number)&&shot.number>0?shot.number:null;
 const shotLabel=`镜号 ${shotNumber===null?'未编号':String(shotNumber).padStart(3,'0')}${shotTitle?' · '+shotTitle:''}`;
 const saved=shot.productionCues;
 if(saved!==undefined&&(!plain(saved)||saved.schemaVersion!==1||!Number.isSafeInteger(saved.revision)||saved.revision<0||!plain(saved.cues)||!Array.isArray(saved.cues.dialogue)||saved.cues.dialogue.length>64))fail('已保存的分镜制作对白记录无效，未从提示词猜测字幕');
 const sourceCuesSnapshot=saved?{schemaVersion:saved.schemaVersion,revision:saved.revision,updatedAt:saved.updatedAt??null,cues:clone(saved.cues)}:null;
 const characters=Array.isArray(work.studio?.libraries?.characters)?work.studio.libraries.characters:[];
 const dialogueSnapshot=(saved?.cues.dialogue??[]).map(cue=>{
  if(!plain(cue))fail('已保存的计划对白格式无效');
  const text=checkedText(cue.text,'原台词',2000);if(!text.trim())fail('计划对白原句不能为空');
  const name=characters.find(character=>character.id===cue.speakerId)?.name;
  const speakerName=typeof name==='string'?checkedText(name,'说话者名称',2000):null;
  const speakerLabel=cue.speakerLabel===undefined?'':checkedText(cue.speakerLabel,'说话者标签',120);
  const planStart=cue.planStart??null,planEnd=cue.planEnd??null;
  for(const value of [planStart,planEnd])if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0||value>600))fail('已保存的对白计划时码无效');
  if(planStart!==null&&planEnd!==null&&planEnd<=planStart)fail('已保存的对白计划结束时间无效');
  return {...clone(cue),text,speakerName,speakerLabel,planStart,planEnd};
 });
 const common={schemaVersion:1,source:saved?'production-cues':'none',shotId:shot.id??null,shotNumber,shotTitle,shotLabel,sourceCuesSnapshot,dialogueSnapshot};
 const timing={kind:'planned-only',reference:'current-timeline-clip',unit:'seconds',duration:frames/fps,frames,fps,columns,maxLines,measuredSpeech:false,audioGenerated:false,notice:'静态分镜预演；计划对白字幕，不代表配音已生成或实测口型。'};
 if(!dialogueSnapshot.length)return {...common,text:'',events:[],timing:{...timing,allocation:'none',reason:null,warnings:[]}};
 const pages=dialogueSnapshot.map(cue=>pagesFor(cue,columns,maxLines)),{windows,allocation,reason}=planWindows(dialogueSnapshot,pages,frames,fps),events=[];
 for(let index=0;index<dialogueSnapshot.length;index++){
  const cue=dialogueSnapshot[index],window=windows[index],count=pages[index].length,span=window.endFrame-window.startFrame;
  for(let pageIndex=0;pageIndex<count;pageIndex++){
   const startFrame=window.startFrame+Math.floor(pageIndex*span/count),endFrame=window.startFrame+Math.floor((pageIndex+1)*span/count);
   events.push({...pages[index][pageIndex],cueIndex:index,cueId:cue.id??null,speakerId:cue.speakerId??null,speakerLabel:cue.speakerLabel,speakerName:cue.speakerName,pageIndex,pageCount:count,startFrame,endFrame,start:startFrame/fps,end:endFrame/fps,timingSource:allocation,sourcePlan:{start:cue.planStart,end:cue.planEnd}});
  }
 }
 const warnings=[];if(reason)warnings.push('已有对白计划时码不完整或不适合当前片段，字幕按原句顺序等分当前计划时长；原时码完整留存。');
 if(events.some(event=>event.end-event.start<0.8))warnings.push('部分计划字幕页不足0.8秒，可暂停查看；不代表实际语速或真实口型时码。');
 return {...common,text:dialogueSnapshot.map(cue=>`计划对白 · ${cue.speakerName||cue.speakerLabel||'未标说话者'}：${cue.text}`).join('\n'),events,timing:{...timing,allocation,reason,warnings}};
}
