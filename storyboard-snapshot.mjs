import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {planTimeline,resolveTimelineMedia} from './timeline-renderer.mjs';
import {buildStoryboardCaption} from './storyboard-captions.mjs';

/** Freeze registered image bytes and saved planned dialogue before queuing CPU work. */
export async function freezeStoryboardSelection(work,episodeId,timeline,workspaceDirectory,options){
 const plan=planTimeline(work,episodeId,timeline,{mode:'storyboard',compileCaptions:false}),snapshots=[];
 for(const clip of plan.clips){
  if(!clip.shotId)continue;
  const shot=work.shots.find(item=>item.id===clip.shotId&&item.episodeId===episodeId),record=clip.record;
  let file,before,after;const hash=createHash('sha256');try{file=await resolveTimelineMedia(workspaceDirectory,record);before=await stat(file);if(before.size>64*1024*1024)throw Object.assign(new Error('首帧图片超过64MB'),{status:413});for await(const chunk of createReadStream(file))hash.update(chunk);after=await stat(file);}catch(error){throw Object.assign(new Error('故事板首帧不可读取或路径无效：'+clip.title),{status:error.status||409});}
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Object.assign(new Error('冻结故事板首帧时文件发生变化：'+clip.title),{status:409});
  if(!['image/png','image/jpeg','image/webp'].includes(record.mimeType))throw Object.assign(new Error('故事板首帧必须为本作品登记的 PNG/JPEG/WebP：'+clip.title),{status:400});
  const sha256=hash.digest('hex');if(record.sha256&&record.sha256!==sha256)throw Object.assign(new Error('登记后的故事板首帧 SHA 已变化：'+clip.title),{status:409});
  snapshots.push({clipId:clip.id,shotId:shot.id,selectedAssetId:shot.selectedAssetId||shot.assetIds?.at(-1)||null,firstFrameMediaId:record.id,firstFrameSnapshot:{id:record.id,mimeType:record.mimeType,relativePath:record.relativePath,bytes:before.size,sha256},shotTitle:shot.title||'',shotNumber:shot.number??null,captionSnapshot:buildStoryboardCaption(work,shot,{duration:clip.duration,fps:plan.fps,columns:Math.max(8,Math.floor(options.width*.9/Math.max(10,Math.round(options.height*.038)))),maxLines:3})});
 }
 return snapshots;
}
