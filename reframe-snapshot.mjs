import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizeClipReframe,clipReframeSource} from './clip-reframe.mjs';
import {resolveTimelineMedia} from './timeline-renderer.mjs';

export async function freezeReframeSelection(work,timeline,workspaceDirectory){
 const result=[];
 for(const clip of timeline.clips||[]){if(clip.enabled===false||clip.reframe===undefined||clip.reframe===null)continue;
  const reframe=normalizeClipReframe(clip.reframe,{work,clip}),source=clipReframeSource(work,clip),file=await resolveTimelineMedia(workspaceDirectory,source.asset),before=await stat(file),hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);const after=await stat(file),sha256=hash.digest('hex');
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Object.assign(new Error('冻结重构图源视频时文件发生变化'),{status:409});
  const recordedSha=source.asset.sha256||source.job?.telemetry?.sha256;if(recordedSha&&recordedSha!==sha256)throw Object.assign(new Error('重构图源视频与原版本 SHA256 不符'),{status:409});
  result.push({clipId:clip.id,shotId:clip.shotId,selectedAssetId:clip.assetId,reframe,reframeSourceSnapshot:{assetId:clip.assetId,relativePath:source.asset.relativePath,sha256,bytes:before.size,width:source.width,height:source.height,measurement:source.measurement}});
 }
 return result;
}
