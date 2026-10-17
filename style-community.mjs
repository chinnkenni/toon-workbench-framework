// Trusted local registration for animating the unchanged, fixed upstream gallery.
import {createHash} from 'node:crypto';

export const COMMUNITY_ID='cinematic-director-frame-h3';
export const COMMUNITY_MANIFEST='deployment/style-community-videos.json';
export const COMMUNITY_FOLDER='style-community-videos/'+COMMUNITY_ID;
export const COMMUNITY_MODEL='MiniMax-H3-GB10';
export const COMMUNITY_COMMIT='b2634d02ed53b1700d6ec0b34ae889d4d85b896c';
export const COMMUNITY_REPOSITORY='zhu930824/cinematic-director-frame';
const SLUG=/^[a-z0-9][a-z0-9-]{0,79}$/,SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>Object.assign(new Error(message),{status:409});
const unsafeText=/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{15,}/i;
export function communityOutputPath(slug,jobId){if(!SLUG.test(slug||'')||!UUID.test(jobId||''))throw fail('社区视频固定产物身份无效');return 'data/'+COMMUNITY_FOLDER+'/h3-'+createHash('sha256').update(slug).digest('hex').slice(0,12)+'-'+jobId+'.mp4';}
/** Pure validation; no work reads, source replacement, defaults persisted or inference. */
export function validateCommunityManifest(value,gallery){
 if(value===undefined)return {schemaVersion:1,id:COMMUNITY_ID,videos:[]};
 if(!plain(value)||value.schemaVersion!==1||value.id!==COMMUNITY_ID||!Array.isArray(value.videos)||value.videos.length>24||!Array.isArray(gallery?.entries)||gallery.source?.repository!==COMMUNITY_REPOSITORY||gallery.source?.commit!==COMMUNITY_COMMIT)throw fail('社区动画登记或固定图库版本无效');
 if(value.source!==undefined&&(!plain(value.source)||value.source.repository!==COMMUNITY_REPOSITORY||value.source.commit!==COMMUNITY_COMMIT))throw fail('社区动画不能替换上游图库版本');
 const seen=new Set();for(const video of value.videos){const source=gallery.entries.find(entry=>entry.id===video?.id);if(!plain(video)||!source||seen.has(video.id)||!SLUG.test(video.id)||video.kind!=='video'||!['pending','ready'].includes(video.status)||video.sourceReferenceId!=='reference:'+source.id||video.sourceImageId!==video.sourceReferenceId||video.sceneGroup!==source.sceneGroup||video.sourceSha256!==source.sha256||video.sourceBytes!==source.bytes||!SHA.test(video.sourceSha256||''))throw fail('社区动画须一对一引用原图编号、场景及完整SHA，不能替换为基准输入');seen.add(video.id);
  if(video.benchmarkId!==undefined||video.benchmarkTitle!==undefined)throw fail('社区动画不能冒标统一输入基准');if(video.prompt!==undefined&&(typeof video.prompt!=='string'||video.prompt.length>100000||unsafeText.test(video.prompt)))throw fail('社区执行稿须为不含凭据的有界文本');
  if(video.status==='pending'){if(['relativePath','sha256','bytes','generation'].some(key=>video[key]!==undefined))throw fail('尚未生成的社区视频不能登记实际产物');continue;}
  const generation=video.generation;if(!plain(generation)||!['workId','episodeId','shotId','jobId','assetId'].every(key=>UUID.test(generation[key]||''))||generation.workId!==value.workId||generation.episodeId!==value.episodeId||generation.modelId!==COMMUNITY_MODEL||!plain(generation.request)||generation.request.prompt!==video.prompt||!plain(generation.telemetry)||generation.telemetry.sha256!==video.sha256||video.relativePath!==communityOutputPath(video.id,generation.jobId)||!SHA.test(video.sha256||'')||!Number.isSafeInteger(video.bytes)||video.bytes<12||video.bytes>512*1024*1024||typeof video.prompt!=='string'||!video.prompt)throw fail('社区动画实际产物、原任务身份或SHA证据不完整');
 }
 return value;
}
