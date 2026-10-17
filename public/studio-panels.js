const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const words=value=>Array.isArray(value)?value.join('\n'):String(value??'');
const stamp=value=>value&&Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'';
const seconds=value=>Number.isFinite(Number(value))&&Number(value)>0?`${Number(value).toFixed(1)} 秒`:'时长待检测';
const categories={
 characters:{title:'角色库',singular:'角色',description:'固定外观与服装，让同一人物在每个镜头中保持一致。',descriptionLabel:'角色设定',descriptionPlaceholder:'身份、性格、年龄与整体气质…',traitsLabel:'不变特征 · 外观 / 服装',traitsPlaceholder:'例如：银色短发、左眼下泪痣、深蓝工作服；每行一个不变特征',empty:'先给主角建立一张角色卡',hint:'上传正面、侧面或三视图，记录不能变化的外观。'},
 scenes:{title:'场景库',singular:'场景',description:'记录空间、光线和地标，换镜头也能认出同一个地方。',descriptionLabel:'场景设定',descriptionPlaceholder:'地点、年代、天气、氛围与美术风格…',traitsLabel:'固定细节 · 布局 / 光线 / 地标',traitsPlaceholder:'例如：窗户在左、暖色顶灯、门旁的红色邮筒；每行一个固定细节',empty:'为故事建立第一个场景',hint:'上传场景图，再写清机位改变时仍要保留的细节。'},
 voices:{title:'配音库',singular:'配音',description:'管理生成或导入的角色配音，在此试听并复用。',descriptionLabel:'配音说明',descriptionPlaceholder:'所属角色、台词、情绪、语速与录音用途…',traitsLabel:'声音不变特征',traitsPlaceholder:'音色、口音、语速、情绪基准…',empty:'把角色的声音留在作品里',hint:'上传配音样本与台词录音，记录同一角色的音色与说话方式。'},
 music:{title:'配乐库',singular:'配乐',description:'整理情绪与使用场景，试听后放到时间轴。',descriptionLabel:'配乐说明',descriptionPlaceholder:'情绪、节奏、适合的剧情，以及署名或授权说明…',traitsLabel:'音乐方向',traitsPlaceholder:'乐器、节奏、情绪走向与需要保持的风格…',empty:'为故事准备一组配乐',hint:'上传片头、情绪段落或片尾配乐，添加到时间轴后可调整位置。'},
 sfx:{title:'音效库',singular:'音效',description:'把环境声、动作声与特殊音效归到一起。',descriptionLabel:'音效说明',descriptionPlaceholder:'声音来源、使用情节、空间与远近关系…',traitsLabel:'声音特征',traitsPlaceholder:'例如：木地板脚步声、偏近、轻混响…',empty:'收集故事里的声音细节',hint:'上传脚步、风声、机械声等音效，选好位置后加入时间轴。'}
};
const isAudio=category=>['voices','music','sfx'].includes(category);
const mediaList=work=>Array.isArray(work?.studio?.media)?work.studio.media:[];
const entries=(work,category)=>work?.studio?.libraries?.[category]||work?.studio?.[category]||[];
const safeUrl=value=>typeof value==='string'&&value.startsWith('/api/works/')?value:'';
const mediaFor=(work,entry,type)=>{
 const known=new Map(mediaList(work).map(media=>[media.id,media]));
 return [...new Set(Array.isArray(entry?.mediaIds)?entry.mediaIds:[])].map(id=>known.get(id)).filter(media=>media&&(!type||media.type===type));
};
const skillScenarios={characters:['character','character-writing'],scenes:['scene']};
const skillScenarioName={character:'角色外观设计','character-writing':'人物内在设计',scene:'场景设计'};
const array=value=>Array.isArray(value)?value:[];

// Existing bindings remain visible even when the global skill is later changed or disabled.
export function librarySkillOptions(category,entry,skills){
 const snapshots=array(entry?.skillSnapshot),saved=new Map(snapshots.map(skill=>[skill.id,skill]));
 const selected=new Set(array(entry?.skillIds).length?entry.skillIds:snapshots.map(skill=>skill.id));
 const accepted=skillScenarios[category]||[],known=new Map(array(skills).map(skill=>[skill.id,skill]));
 const ids=[...new Set([...array(skills).filter(skill=>accepted.includes(skill.scenario)).map(skill=>skill.id),...selected])];
 return ids.map(id=>{
  const current=known.get(id),snapshot=saved.get(id),eligible=Boolean(current?.enabled&&accepted.includes(current.scenario));
  return {id,current,snapshot,selected:selected.has(id),eligible,missing:!current,name:snapshot?.name||current?.name||id};
 });
}

export function librarySkillPayload(entry,selectedIds,changed){
 const payload={...entry};delete payload.skillSnapshot;
 if(changed)payload.skillIds=[...new Set(selectedIds)];else delete payload.skillIds;
 return payload;
}

function skillSource(skill){
 const source=skill?.source;
 return typeof source==='string'?source:[source?.repository,source?.commit?.slice(0,12)].filter(Boolean).join(' · ');
}
function skillGuidance(skill,label){
 return skill?`<div class="art-skill-guidance"><strong>${esc(label)}${skill.version!=null?` · v${esc(skill.version)}`:''}</strong><p>${esc(skill.instructions||'此版本未记录适配指导。')}</p>${skillSource(skill)?`<small>来源：${esc(skillSource(skill))}</small>`:''}</div>`:'';
}
export function renderLibrarySkillChoices(options){
 return options.map(option=>{
  const {id,current,snapshot,selected,eligible,name}=option;
  const status=option.missing?'已不在全局库':!current.enabled?'已停用':!eligible?'情境已变更':skillScenarioName[current.scenario]||current.scenario;
  return `<div class="art-design-skill${selected?' selected':''}"><label class="art-design-skill-choice"><input type="checkbox" name="designSkillIds" value="${esc(id)}" ${selected?'checked':''} ${!eligible&&!selected?'disabled':''} data-art-skill-id="${esc(id)}" data-art-skill-eligible="${eligible}"><span><strong>${esc(name)}</strong><small>${esc(status)}${snapshot?` · 已存 v${esc(snapshot.version)}`:current?` · v${esc(current.version)}`:''}</small></span></label><details class="art-design-skill-detail"><summary>查看设计指导</summary>${current?.description?`<p class="art-skill-description">${esc(current.description)}</p>`:''}${snapshot?skillGuidance(snapshot,'卡片已保存的指导'):''}${current?skillGuidance(current,snapshot?'全局当前指导':'当前指导'):''}${!current&&!snapshot?'<p class="muted small">此历史绑定未记录指导内容，可保留绑定或手动移除。</p>':''}${selected&&!eligible?'<p class="muted small">历史绑定可保留或移除；此技能当前不能新增选择。</p>':''}</details></div>`;
 }).join('');
}

export function initStudioPanels({api,toast,refresh,getWork,getEpisodeId,showTab}){
 const drafts=new Map();
 let audioCategory='voices',boundContainer=null,entrySession=0;
 const dialog=document.createElement('dialog');dialog.className='work-dialog art-library-dialog';document.body.append(dialog);
 const currentEpisode=(work,id)=>work.episodes?.find(e=>e.id===id);
 const keyFor=(work,episodeId)=>`${work.id}:${episodeId}`;
 function draftFor(work,episodeId){
  const key=keyFor(work,episodeId),saved=work.studio?.scripts?.[episodeId]?.text||'';
  let draft=drafts.get(key);
  if(!draft){draft={text:saved,dirty:false,sourceName:''};drafts.set(key,draft);}
  else if(!draft.dirty)draft.text=saved;
  return draft;
 }
 function scriptPanel(work,episodeId){
  const episode=currentEpisode(work,episodeId);
  if(!episode)return '<div class="empty art-empty"><h3>先建立一个分集</h3><p>剧本和分镜会按分集保存。</p><button class="button primary" data-action="new-episode">新增分集</button></div>';
  const draft=draftFor(work,episodeId),saved=work.studio?.scripts?.[episodeId];
  return `<section class="art-script-layout"><div class="art-script-editor panel"><div class="art-panel-heading"><div><p class="art-eyebrow">${esc(episode.title)}</p><h2>剧本</h2><p class="muted">先写完整故事，再把它变成可以逐镜制作的画面。</p></div><label class="button art-import-label">导入 TXT<input class="sr-only" type="file" accept=".txt,text/plain" data-art-script-file></label></div><label class="art-script-label" for="art-script-text">本集剧本</label><textarea id="art-script-text" class="art-script-text" rows="19" maxlength="100000" placeholder="第 1 场 · 夜 · 屋顶\n\n写下人物、动作、环境和对白。每场之间留一个空行，拆分时更容易整理。">${esc(draft.text)}</textarea><div class="art-editor-meta"><span data-art-script-status>${draft.dirty?'有未保存的修改':saved?.updatedAt?'已保存 '+esc(stamp(saved.updatedAt)):'保存在本机作品里'}</span><span data-art-script-count>${draft.text.length.toLocaleString('zh-CN')} 字</span></div><p class="art-import-source muted small" data-art-script-source>${draft.sourceName?`已导入：${esc(draft.sourceName)} · 原文保留在编辑区`:''}</p><div class="art-script-actions"><button class="button" data-art-action="save-script">保存剧本</button><button class="button primary" data-art-action="split-script">保存并拆成分镜草稿 <span aria-hidden="true">→</span></button></div><p class="muted small">按场次和段落拆分，原剧本会保留；已有分镜不被覆盖。拆分后继续检查人物、镜头、动作与声音。</p></div><aside class="art-process-guide"><p class="art-eyebrow">从故事到成片</p><h3>每一步，都有自己的位置</h3><ol><li><strong>定剧本</strong><span>整理本集故事、台词与情绪节奏。</span></li><li><strong>定美术</strong><span>在角色库、场景库锁定参考图与不变特征。</span></li><li><strong>定分镜</strong><span>逐镜写画面与声音，关联角色和场景，再整理提示词。</span></li><li><strong>排时间轴</strong><span>拆分后草稿立即占位，确认和生成复用原位置；片头片尾可替换，再加配音、配乐与音效。</span></li></ol><div class="art-guide-note">这里使用规则整理剧本。当前未接入文本大模型；剧情判断和美术选择始终由你掌握。</div></aside></section>`;
 }
 function scriptSegments(work,episodeId){
  const list=(work.shots||[]).filter(shot=>shot.episodeId===episodeId);
  if(!currentEpisode(work,episodeId))return '';
  const rows=list.map((shot,index)=>{
   const names=(shot.characterIds||[]).map(id=>entries(work,'characters').find(entry=>entry.id===id)?.name).filter(Boolean);
   const scene=entries(work,'scenes').find(entry=>entry.id===shot.sceneId);
   const confirmed=shot.approvalStatus==='confirmed';
   return `<article class="art-segment-row"><span class="art-segment-number">${String(index+1).padStart(2,'0')}</span><div class="art-segment-copy"><h3>${esc(shot.title||'未命名分镜')}</h3><p class="muted">角色：${esc(names.join('、')||'尚未关联')}<span aria-hidden="true"> · </span>场景：${esc(scene?.name||'尚未关联')}</p></div><span class="art-lock-badge ${confirmed?'locked':''}">${confirmed?'已确认 · 已上轨':'草稿 · 待确认'}</span><button type="button" class="button" data-action="edit-segment" data-id="${esc(shot.id)}">处理片段</button></article>`;
  }).join('');
  return `<section class="art-script-segments panel"><div class="art-panel-heading"><div><h2>本集分镜 <span class="muted">${list.length}</span></h2><p class="muted">拆分后分镜草稿立即在时间轴占位；确认和生成复用原位置，可在时间轴的“待确认”区继续处理。</p></div><button type="button" class="button" data-action="tab" data-id="timeline">查看时间轴 <span aria-hidden="true">→</span></button></div>${rows?`<div class="art-segment-list">${rows}</div>`:'<div class="art-segment-empty muted">保存并拆分剧本后，本集的分镜草稿会列在这里。</div>'}</section>`;
 }
 function libraryPanel(work,category){
  const meta=categories[category],list=entries(work,category),audio=isAudio(category);
  const cards=list.map(entry=>{
   const linked=mediaFor(work,entry,audio?'audio':'image'),first=linked[0],url=safeUrl(first?.url),traits=words(entry.lockedTraits);
   const visual=audio?`<div class="art-audio-card-top"><span class="art-audio-symbol" aria-hidden="true">${category==='music'?'♫':category==='sfx'?'≋':'◉'}</span><span>${esc(category==='voices'?'角色配音':category==='music'?'作品配乐':'声音素材')}</span></div>${url?`<audio controls preload="metadata" src="${esc(url)}" aria-label="试听${esc(entry.name)}"></audio>`:'<div class="art-no-audio">尚未添加音频，打开卡片上传</div>'}`:`${url?`<img class="art-reference-image" loading="lazy" src="${esc(url)}" alt="${esc(entry.name)}的参考图">`:`<div class="art-reference-empty"><span aria-hidden="true">${category==='characters'?'♙':'▧'}</span><span>添加${meta.singular}参考图</span></div>`}`;
   const guidance=!audio?array(entry.skillSnapshot).map(skill=>`<span>${esc(skill.name||skill.id)} · v${esc(skill.version)}</span>`).join(''):'';
   return `<article class="art-library-card panel">${visual}<div class="art-card-body"><div class="art-card-title"><h3>${esc(entry.name)}</h3><span class="art-lock-badge ${entry.locked?'locked':''}">${entry.locked?'设定已锁定':'设定草稿'}</span></div><p class="art-card-description">${esc(entry.description||'还没有填写设定。打开卡片补充创作说明。')}</p>${traits?`<div class="art-traits"><span>${audio?'声音特征':'不变特征'}</span><p>${esc(traits)}</p></div>`:''}${guidance?`<div class="art-card-skills" aria-label="已保存的设计技能"><small>设计技能</small>${guidance}</div>`:''}<p class="art-card-meta">${linked.length?`${linked.length} 份${audio?'音频':'参考图'}${audio?' · '+seconds(first?.duration):''}`:entry.locked?'当前仅锁定文字设定，尚无参考素材':'尚无参考素材'}</p><div class="art-card-actions"><button class="button" data-art-action="edit-entry" data-art-category="${category}" data-art-id="${esc(entry.id)}">编辑${meta.singular}卡</button>${audio?`<button class="button primary" data-art-action="audio-to-timeline" data-art-category="${category}" data-art-id="${esc(entry.id)}" ${url?'':'disabled'}>加入时间轴</button>`:''}</div></div></article>`;
  }).join('');
  return `<section class="art-library-section"><div class="art-panel-heading"><div><h2>${meta.title}</h2><p class="muted">${meta.description}</p></div><button class="button primary" data-art-action="new-entry" data-art-category="${category}">＋ 新建${meta.singular}</button></div>${audio?'<p class="art-inline-note">管理生成或导入的配音、配乐与音效；可在上方切换到角色配音或配乐生成。</p>':'<p class="art-inline-note">分镜可关联这些设定来整理提示词；参考图需选作首帧才会传给当前视频模型，锁定设定不会自动获得多图一致性能力。</p>'}${cards?`<div class="art-library-grid">${cards}</div>`:`<div class="empty art-empty"><span class="art-empty-symbol" aria-hidden="true">${audio?'♫':category==='characters'?'♙':'▧'}</span><h3>${meta.empty}</h3><p>${meta.hint}</p><button class="button primary" data-art-action="new-entry" data-art-category="${category}">新建${meta.singular}</button></div>`}</section>`;
 }
 function render(tab,work,episodeId){
  if(tab==='script')return scriptPanel(work,episodeId)+scriptSegments(work,episodeId);
  if(tab==='characters'||tab==='scenes')return libraryPanel(work,tab);
  if(tab==='audio')return `<div class="art-audio-tabs" role="tablist" aria-label="声音素材类型">${[['voices','配音'],['music','配乐'],['sfx','音效']].map(([key,title])=>`<button type="button" class="${audioCategory===key?'active':''}" role="tab" aria-selected="${audioCategory===key}" data-art-action="audio-category" data-art-category="${key}">${title}<span>${entries(work,key).length}</span></button>`).join('')}</div>${libraryPanel(work,audioCategory)}`;
  return '';
 }
 function bind(container){
  boundContainer=container;
  const text=container.querySelector('#art-script-text');
  if(text)text.oninput=()=>{
   const work=getWork(),episodeId=getEpisodeId();if(!work||!episodeId)return;
   const draft=draftFor(work,episodeId);draft.text=text.value;draft.dirty=true;
   const count=container.querySelector('[data-art-script-count]'),status=container.querySelector('[data-art-script-status]');
   if(count)count.textContent=`${text.value.length.toLocaleString('zh-CN')} 字`;
   if(status)status.textContent='有未保存的修改';
  };
  const upload=container.querySelector('[data-art-script-file]');
  if(upload)upload.onchange=async()=>{
   const file=upload.files?.[0];if(!file)return;
   try{
    if(file.size>2*1024*1024)throw new Error('剧本 TXT 请控制在 2 MB 以内');
    const value=await file.text();if(value.length>100000)throw new Error('本集剧本最多 100000 字，请按分集分别导入');
    const work=getWork(),episodeId=getEpisodeId(),draft=draftFor(work,episodeId);draft.text=value;draft.dirty=true;draft.sourceName=file.name;
    if(text){text.value=value;text.dispatchEvent(new Event('input'));text.focus();}
    const source=container.querySelector('[data-art-script-source]');if(source)source.textContent=`已导入：${file.name} · 原文保留在编辑区`;
    toast('剧本已导入，保存后会保留在本机');
   }catch(error){toast(error.message);}finally{upload.value='';}
  };
 }
 async function uploadMedia(work,file,audio){
  if(file.size>64*1024*1024)throw new Error('单个素材最大 64 MB，请压缩后再上传');
  const extension=file.name.split('.').pop().toLowerCase();
  const imageMime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'},audioMime={mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',flac:'audio/flac'};
  const mime=(audio?audioMime:imageMime)[extension];
  if(!mime)throw new Error(audio?'支持 MP3、WAV、M4A、OGG、FLAC 音频':'支持 PNG、JPG、WebP 参考图');
  const response=await fetch(`/api/works/${encodeURIComponent(work.id)}/studio/media?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':mime},body:file});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');if(!result.media?.id)throw new Error('上传结果缺少素材编号');return result.media;
 }
 function openEntry(category,entry={}){
  const work=getWork(),meta=categories[category];if(!work||!meta)return;
  const session=++entrySession;
  const audio=isAudio(category),available=mediaList(work).filter(m=>m.type===(audio?'audio':'image'));
  const selectedMedia=new Map(mediaFor(work,entry,audio?'audio':'image').map(media=>[media.id,media]));
  dialog.innerHTML=`<form class="art-entry-form"><div class="dialog-title"><div><p class="art-eyebrow">${meta.title}</p><h2>${entry.id?'编辑':'新建'}${meta.singular}卡</h2></div><button type="button" class="close" aria-label="关闭">×</button></div><label>${meta.singular}名称<input name="name" required maxlength="120" value="${esc(entry.name)}" placeholder="${category==='characters'?'角色名 / 角色名 · 日常服':category==='scenes'?'场景名 / 场景名 · 夜景':'一眼能找到的声音名称'}"></label><div class="art-entry-media"><div class="art-form-subheading"><strong>${audio?'声音素材':'参考图'}</strong><label class="button art-import-label">${audio?'上传音频':'上传参考图'}<input type="file" data-art-entry-upload class="sr-only" accept="${audio?'.mp3,.wav,.m4a,.ogg,.flac,audio/*':'.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp'}" multiple></label></div><p class="muted small">${audio?'支持 MP3 / WAV / M4A / OGG / FLAC，单个最大 64 MB。':'支持 PNG / JPG / WebP，单张最大 64 MB。可选择已有图片或上传新图。'}</p><div data-art-picked-media class="art-picked-media"></div>${available.length?`<details class="art-existing-media"><summary>从作品素材中选择（${available.length}）</summary><div class="art-media-picker">${available.map(m=>`<label><input type="checkbox" data-art-pick-id="${esc(m.id)}" ${(entry.mediaIds||[]).includes(m.id)?'checked':''}>${!audio&&safeUrl(m.url)?`<img src="${esc(safeUrl(m.url))}" alt="" loading="lazy">`:''}<span>${esc(m.name||m.filename||'未命名素材')}</span></label>`).join('')}</div></details>`:''}</div><label>${meta.descriptionLabel}<textarea name="description" rows="3" maxlength="8000" placeholder="${meta.descriptionPlaceholder}">${esc(entry.description)}</textarea></label><label>${meta.traitsLabel}<textarea name="lockedTraits" rows="3" maxlength="8000" placeholder="${meta.traitsPlaceholder}">${esc(words(entry.lockedTraits))}</textarea></label>${category==='voices'?`<label>音色与表演指导<textarea name="voiceStyle" rows="2" maxlength="2000" placeholder="例如：年轻女声，语气克制，句尾轻落；激动时也不尖叫。">${esc(entry.voiceStyle)}</textarea></label>`:''}<details class="art-negative-details"><summary>${audio?'避免的声音变化':'避免的变化与穿帮'}</summary><label class="sr-only" for="art-negative">避免的变化</label><textarea id="art-negative" name="negativeConstraints" rows="3" maxlength="8000" placeholder="${audio?'不要突然改变音色、口音或响度…':'例如：不要换发色、不要增加配饰、不要镜像场景布局…'}">${esc(words(entry.negativeConstraints))}</textarea></details><label class="art-checkbox-label"><input name="locked" type="checkbox" ${entry.locked!==false?'checked':''}><span>锁定这张卡的设定<small>整理分镜提示词时保留这些不变特征。仍可随时打开卡片修改。</small></span></label>${!audio?`<fieldset class="art-design-skills"><legend>${meta.singular}设计技能</legend><p class="muted small">${category==='characters'?'可多选人物内在设计和角色外观设计技能，帮助审视人物动机、关系与造型。':'可多选场景设计技能，帮助梳理空间布局、生活细节与时代地域。'}展开查看指导，再把设计结果写进卡片。</p><div data-art-design-skills role="group" aria-label="${meta.singular}设计技能选择"><p class="muted small" role="status">正在读取适用技能…</p></div><p data-art-skill-status class="muted small" role="status">保存卡片时记录所选技能的版本与指导。</p><p class="art-skill-footnote">在左下角「创作技能」管理全局技能。这里保存设计指导，不会生成图片或启动制作任务。</p></fieldset>`:''}<p data-art-entry-error class="error" role="alert"></p><p data-art-entry-upload-status class="muted small" role="status"></p><div class="dialog-actions"><button type="button" class="button" data-art-entry-cancel>取消</button><button type="submit" class="button primary">保存${meta.singular}卡</button></div></form>`;
  const form=dialog.querySelector('form'),errorField=dialog.querySelector('[data-art-entry-error]'),uploadStatus=dialog.querySelector('[data-art-entry-upload-status]');
  let uploads=0,saving=false,skillOptions=[],skillsChanged=false;
  const selectedSkillIds=()=>[...form.querySelectorAll('[data-art-skill-id]:checked')].map(input=>input.value);
  const skillStatus=form.querySelector('[data-art-skill-status]');
  const noteSkillChange=()=>{
   skillsChanged=true;
   const selected=selectedSkillIds(),unavailable=skillOptions.filter(option=>selected.includes(option.id)&&!option.eligible);
   skillStatus.textContent=unavailable.length?`保留的历史技能中，${unavailable.map(option=>option.name).join('、')}当前不能重新应用；修改选择后需先取消这些项再保存。`:selected.length?'保存后将采用所选技能的当前启用版本。':'保存后将清除这张卡的设计技能绑定与快照。';
   form.querySelectorAll('[data-art-skill-id]').forEach(input=>{input.closest('.art-design-skill').classList.toggle('selected',input.checked);});
  };
  async function loadDesignSkills(){
   if(audio)return;
   const place=form.querySelector('[data-art-design-skills]');
   place.innerHTML='<p class="muted small" role="status">正在读取适用技能…</p>';
   try{
    const catalog=await api('/api/creative-skills');
    if(session!==entrySession||!dialog.contains(form))return;
    skillOptions=librarySkillOptions(category,entry,catalog.skills);
    const choices=renderLibrarySkillChoices(skillOptions);
    place.innerHTML=choices||`<p class="muted small">全局库中尚无${meta.singular}设计技能，可先保存设定，添加技能后再选择。</p>`;
    if(skillOptions.some(option=>option.eligible))place.insertAdjacentHTML('beforeend','<button type="button" class="button art-skill-refresh" data-art-refresh-skills>保存时更新已选技能版本</button>');
    place.querySelectorAll('[data-art-skill-id]').forEach(input=>input.onchange=()=>{
     // A disabled historical binding can be removed, but cannot be newly selected.
     if(input.dataset.artSkillEligible!=='true'&&!input.checked)input.disabled=true;
     noteSkillChange();
    });
    const update=place.querySelector('[data-art-refresh-skills]');if(update)update.onclick=noteSkillChange;
   }catch(error){
    if(session!==entrySession||!dialog.contains(form))return;
    skillOptions=librarySkillOptions(category,entry,[]);
    place.innerHTML=`${renderLibrarySkillChoices(skillOptions)}<p class="art-skill-load-error" role="alert">技能库读取失败：${esc(error.message)}。仍可保存其他设定，已有技能绑定会保留。</p><button type="button" class="button" data-art-retry-skills>重新读取技能</button>`;
    place.querySelectorAll('[data-art-skill-id]').forEach(input=>input.disabled=true);
    place.querySelector('[data-art-retry-skills]').onclick=()=>void loadDesignSkills();
   }
  }
  void loadDesignSkills();
  const renderPicked=()=>{
   const place=dialog.querySelector('[data-art-picked-media]');
   place.innerHTML=selectedMedia.size?[...selectedMedia.values()].map(m=>`<div class="art-picked-item">${!audio&&safeUrl(m.url)?`<img src="${esc(safeUrl(m.url))}" alt="${esc(m.name)}">`:audio&&safeUrl(m.url)?`<audio controls preload="metadata" src="${esc(safeUrl(m.url))}" aria-label="试听${esc(m.name)}"></audio>`:''}<span>${esc(m.name||m.filename||'参考素材')}</span><button type="button" class="text-button" data-art-unpick="${esc(m.id)}" aria-label="取消使用${esc(m.name)}">取消使用</button></div>`).join(''):`<p class="art-media-unselected">${audio?'还没有选择音频。可以先保存说明，之后补充录音。':'还没有参考图。可以先保存文字设定，之后再上传。'}</p>`;
   place.querySelectorAll('[data-art-unpick]').forEach(button=>button.onclick=()=>{selectedMedia.delete(button.dataset.artUnpick);const input=[...dialog.querySelectorAll('[data-art-pick-id]')].find(x=>x.dataset.artPickId===button.dataset.artUnpick);if(input)input.checked=false;renderPicked();});
  };
  renderPicked();
  dialog.querySelectorAll('[data-art-pick-id]').forEach(input=>input.onchange=()=>{const media=available.find(m=>m.id===input.dataset.artPickId);if(input.checked)selectedMedia.set(media.id,media);else selectedMedia.delete(media.id);renderPicked();});
  dialog.querySelector('[data-art-entry-upload]').onchange=async event=>{
   const files=[...event.target.files];if(!files.length)return;
   uploads++;errorField.textContent='';form.querySelector('[type="submit"]').disabled=true;
   try{for(let index=0;index<files.length;index++){uploadStatus.textContent=`正在保存素材 ${index+1} / ${files.length}…`;const media=await uploadMedia(work,files[index],audio);selectedMedia.set(media.id,media);renderPicked();}uploadStatus.textContent=`已保存 ${files.length} 份素材，保存卡片后完成关联。`;}
   catch(error){errorField.textContent=error.message;uploadStatus.textContent='已上传的素材仍保留在作品中，可继续选择。';}
   finally{uploads--;if(!uploads)form.querySelector('[type="submit"]').disabled=false;event.target.value='';}
  };
  const close=()=>{if(uploads||saving){errorField.textContent=uploads?'素材正在上传，请稍等完成。':'卡片正在保存，请稍等完成。';return;}dialog.close();};
  dialog.querySelector('.close').onclick=close;dialog.querySelector('[data-art-entry-cancel]').onclick=close;
  dialog.oncancel=event=>{if(uploads||saving){event.preventDefault();errorField.textContent=uploads?'素材正在上传，请稍等完成。':'卡片正在保存，请稍等完成。';}};
  form.onsubmit=async event=>{
   event.preventDefault();if(uploads||saving)return;
   const submit=form.querySelector('[type="submit"]');submit.disabled=true;errorField.textContent='';saving=true;
   const controls=[...form.querySelectorAll('input,textarea,button,select')].map(control=>({control,disabled:control.disabled}));
   try{
    const selected=selectedSkillIds();
    if(!audio&&skillsChanged){
     const unavailable=skillOptions.filter(option=>selected.includes(option.id)&&!option.eligible);
     if(unavailable.length)throw new Error(`请先取消当前不可用的技能：${unavailable.map(option=>option.name).join('、')}，再保存新的技能选择。`);
    }
    const data=Object.fromEntries(new FormData(form)),base=audio?entry:librarySkillPayload(entry,selected,skillsChanged),payload={...base,name:data.name.trim(),description:data.description,lockedTraits:data.lockedTraits,negativeConstraints:data.negativeConstraints,locked:form.elements.locked.checked,mediaIds:[...selectedMedia.keys()]};
    if(category==='voices')payload.voiceStyle=data.voiceStyle;
    controls.forEach(({control})=>control.disabled=true);
    await api(`/api/works/${encodeURIComponent(work.id)}/studio/libraries/${category}`,{entry:payload});dialog.close();await refresh(true);toast(`${meta.singular}卡已保存`);
   }catch(error){errorField.textContent=error.message;}finally{saving=false;controls.forEach(({control,disabled})=>control.disabled=disabled);submit.disabled=false;}
  };
  dialog.showModal();form.elements.name.focus();
 }
 async function saveScript(split){
  const work=getWork(),episodeId=getEpisodeId();if(!work||!episodeId)throw new Error('请先选择一个分集');
  const draft=draftFor(work,episodeId),field=boundContainer?.querySelector('#art-script-text');if(field)draft.text=field.value;
  if(split&&!draft.text.trim())throw new Error('先写下或导入本集剧本，再拆成分镜');
  await api(`/api/works/${encodeURIComponent(work.id)}/studio/script`,{episodeId,text:draft.text,sourceName:draft.sourceName||undefined});
  draft.dirty=false;
  if(split)await api(`/api/works/${encodeURIComponent(work.id)}/studio/script/split`,{episodeId,text:draft.text});
  await refresh(true);toast(split?'已拆成分镜草稿，在时间轴逐镜检查并确认':'剧本已保存到本机');if(split)showTab('timeline');
 }
 async function audioToTimeline(category,id){
  const work=getWork(),episodeId=getEpisodeId(),entry=entries(work,category).find(e=>e.id===id);
  if(!episodeId)throw new Error('请先选择分集，再加入时间轴');
  const media=entry&&mediaFor(work,entry,'audio')[0];if(!media)throw new Error('先为这张声音卡上传音频');
  const existing=work.studio?.timelines?.[episodeId];
  if(!existing)throw new Error('先在时间轴确认分镜与时长，再添加声音');
  const timeline=structuredClone(existing),total=(timeline.clips||[]).filter(clip=>clip.enabled!==false).reduce((sum,clip)=>sum+Number(clip.duration||0),0);
  const duration=Number(media.duration);if(!Number.isFinite(duration)||duration<=0)throw new Error('音频时长尚未检测成功，请重新上传可播放的音频');
  if(total<=0)throw new Error('先在时间轴启用片头、分镜或片尾，再加入声音');
  timeline.audio=Array.isArray(timeline.audio)?timeline.audio:[];
  timeline.audio.push({id:crypto.randomUUID(),kind:category==='voices'?'voice':category==='music'?'music':'sfx',mediaId:media.id,start:0,trimStart:0,duration:total>0?Math.min(duration,total):duration,gain:1,loop:false,enabled:true});
  await api(`/api/works/${encodeURIComponent(work.id)}/studio/timeline`,{episodeId,timeline});await refresh(true);toast('声音已加入时间轴，可继续调整起点与音量');showTab('timeline');
 }
 async function handleClick(event){
  const button=event.target.closest('[data-art-action]');if(!button)return false;
  const action=button.dataset.artAction,category=button.dataset.artCategory,id=button.dataset.artId;
  if(!['save-script','split-script','audio-category','new-entry','edit-entry','audio-to-timeline'].includes(action))return false;
  const prior=button.disabled;button.disabled=true;
  try{
   if(action==='save-script'||action==='split-script')await saveScript(action==='split-script');
   if(action==='audio-category'){if(!isAudio(category))throw new Error('未知声音素材类型');if(audioCategory===category)return true;audioCategory=category;showTab('audio');}
   if(action==='new-entry')openEntry(category);
   if(action==='edit-entry'){const item=entries(getWork(),category).find(e=>e.id===id);if(!item)throw new Error('这张设定卡未找到，请刷新重试');openEntry(category,item);}
   if(action==='audio-to-timeline')await audioToTimeline(category,id);
  }catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=prior;}
  return true;
 }
 return {render,handleClick,bind,dispose:()=>{entrySession++;dialog.remove();}};
}
