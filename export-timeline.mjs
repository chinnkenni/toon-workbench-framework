const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fields(value,allowed,label){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(label+'包含不支持的字段');}

/** Restrict a one-off render to saved clip/track identities; never edits the work. */
export function resolveExportTimeline(work,episodeId,override,validateTimeline){
 const saved=work.studio?.timelines?.[episodeId];
 if(override===undefined)return validateTimeline(work,episodeId,saved);
 fields(override,['width','height','fps','clips','audio','updatedAt'],'试片时间轴');
 if(!saved||!Array.isArray(override.clips)||!Array.isArray(override.audio))fail('试片时间轴须来自当前分集已保存的完整时间轴');
 for(const key of ['width','height','fps'])if(override[key]!==saved[key])fail('试片时间轴的画布和帧率须沿用当前分集；导出尺寸请使用 exportOptions');
 const clips=new Map((saved.clips||[]).map(clip=>[clip.id,clip])),audio=new Map((saved.audio||[]).map(track=>[track.id,track]));
 const existingIds=new Set(Object.values(work.studio?.timelines||{}).flatMap(timeline=>[...(timeline.clips||[]),...(timeline.audio||[])].map(item=>item.id)));
 for(const clip of override.clips){
  fields(clip,['id','type','role','title','subtitle','duration','trimStart','muted','enabled','shotId','assetId','mediaId','opEd','opEdInheritance','reframe'],'试片片段');
  const original=clips.get(clip.id);if(!original)fail('试片只能选择当前分集已保存的片段编号');
  for(const key of ['type','role','shotId','mediaId'])if((clip[key]??null)!==(original[key]??null))fail('试片不能替换片段类型、首尾角色、分镜或素材来源');
  for(const key of ['title','subtitle'])if((clip[key]??'')!==(original[key]??''))fail('试片不能修改片段标题或字幕；请先在正式时间轴中保存');
  if('assetId'in clip&&clip.type!=='shot')fail('仅分镜片段可指定其已有成片版本');
  for(const key of ['opEd','opEdInheritance'])if(key in clip&&!equal(clip[key],original[key]))fail('试片不能改写片头片尾的版本引用');
 }
 for(const track of override.audio){
  fields(track,['id','kind','mediaId','start','trimStart','duration','gain','loop','enabled','fadeIn','fadeOut','envelope'],'试片音轨');
  const original=audio.get(track.id);
  if(original){if(track.kind!==original.kind||track.mediaId!==original.mediaId)fail('试片不能替换已有声音轨道类型或素材来源');}
  else if(existingIds.has(track.id))fail('新增试片音轨须使用未占用的新编号');
 }
 return validateTimeline(structuredClone(work),episodeId,override);
}
