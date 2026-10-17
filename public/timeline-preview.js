import {normalizeClipReframe} from './clip-reframe.js';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>value===undefined||value===null?'':String(value);
export function exportMode(job){return job?.mode==='storyboard'||job?.exportOptions?.mode==='storyboard'?'storyboard':'video';}
export function exportPreviewInfo(job){
 const mode=exportMode(job),independent=job?.timelineSource==='override',clips=Array.isArray(job?.sourceClips)?job.sourceClips:Array.isArray(job?.timelineSnapshot?.clips)?job.timelineSnapshot.clips.filter(clip=>clip?.enabled!==false):null;
 const duration=job?.durationSeconds??job?.duration;
 return {mode,independent,label:mode==='storyboard'?'故事板预演':independent?'动态试片':'动态成片',title:mode==='storyboard'?'故事板预演':independent?'动态试片':'整片预览',scopeLabel:independent?(mode==='storyboard'?'独立静态预演快照':'独立试片快照'):'本集整片',clipCount:clips?clips.length:null,shotCount:clips?clips.filter(clip=>clip?.type==='shot').length:null,durationSeconds:typeof duration==='number'&&Number.isFinite(duration)&&duration>0?duration:null};
}
function numeric(value,fallback){
  if(value===undefined||value===null)return fallback;
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Invalid timeline number');
  return value;
}
function reframeSettings(value){
  if(value===undefined||value===null)return null;
  const keys=['sourceWidth','sourceHeight','x','y','width','height'];
  if(!object(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Number.isSafeInteger(value[key])))throw new Error('Invalid reframe');
  return Object.fromEntries(keys.map(key=>[key,value[key]]));
}
function selectedSnapshot(job,clip){return (clip.id&&job.selectionSnapshot.find(item=>item?.clipId===clip.id&&item.shotId===clip.shotId))||job.selectionSnapshot.find(item=>item?.shotId===clip.shotId&&(item.clipId===undefined||item.clipId===null));}

// Use an explicit field order so timestamps, extra metadata and object key order
// cannot make an unchanged rendered timeline appear stale. Disabled entries do
// not contribute to the video; enabling one will add it back to this signature.
function renderSettings(timeline){
  if(!object(timeline)||!Array.isArray(timeline.clips)||!Array.isArray(timeline.audio))throw new Error('Missing timeline snapshot');
  const clips=timeline.clips.filter(clip=>clip?.enabled!==false).map(clip=>{
    if(!object(clip)||!['title','shot','media'].includes(clip.type))throw new Error('Invalid timeline clip');
    return {
      type:clip.type,role:clip.role??null,
      shotId:clip.type==='shot'?clip.shotId??null:null,
      assetId:clip.type==='shot'?clip.assetId||null:null,
      mediaId:clip.type==='shot'?null:clip.mediaId||null,
      title:text(clip.title),subtitle:text(clip.subtitle),
      duration:numeric(clip.duration,clip.type==='title'||clip.role?2:4),
      trimStart:numeric(clip.trimStart,0),muted:clip.muted===true,
      reframe:reframeSettings(clip.reframe),
      background:text(clip.background??clip.color??'101827').replace(/^#/,'').toLowerCase(),
    };
  });
  const audio=timeline.audio.filter(track=>track?.enabled!==false).map(track=>{
    if(!object(track)||!['voice','music','sfx'].includes(track.kind))throw new Error('Invalid timeline audio');
    return {
      kind:track.kind,mediaId:track.mediaId??null,
      start:numeric(track.start,0),trimStart:numeric(track.trimStart,0),
      duration:numeric(track.duration,null),gain:numeric(track.gain,1),loop:track.loop===true,
      fadeIn:numeric(track.fadeIn,0),fadeOut:numeric(track.fadeOut,0),envelope:(track.envelope||[]).map(point=>({time:numeric(point.time,null),gain:numeric(point.gain,1)})),
    };
  });
  return {width:numeric(timeline.width,1280),height:numeric(timeline.height,720),fps:numeric(timeline.fps,24),clips,audio};
}

function currentAssetId(work,clip){
  const shot=work.shots?.find(item=>item.id===clip.shotId);
  if(!shot)return null;
  const selected=clip.assetId||shot.selectedAssetId;
  const assets=work.assets||[];
  const asset=selected
    ?assets.find(item=>item.id===selected&&item.shotId===shot.id&&item.type==='video')
    :[...assets].reverse().find(item=>item.shotId===shot.id&&item.type==='video');
  return asset?.id??null;
}

/** True only when the export's saved settings and effective shot versions still match. */
export function isExportCurrent(work,timeline,exportJob){
  if(exportJob?.timelineSource==='override')return false;
  if(!object(work)||!object(exportJob?.timelineSnapshot)||!Array.isArray(exportJob.selectionSnapshot))return false;
  try{
    const current=renderSettings(timeline),saved=renderSettings(exportJob.timelineSnapshot);
    if(JSON.stringify(current)!==JSON.stringify(saved))return false;
    const enabledClips=timeline.clips.filter(clip=>clip?.enabled!==false);
    for(const [clipIndex,clip] of current.clips.entries()){
      if(clip.type!=='shot')continue;
      const original=enabledClips[clipIndex];
      if(clip.reframe)normalizeClipReframe(clip.reframe,{work,clip:original,mode:exportMode(exportJob)});
      if(exportMode(exportJob)==='storyboard'){
        const shot=work.shots?.find(item=>item.id===clip.shotId),snapshot=selectedSnapshot(exportJob,original),image=work.studio?.media?.find(item=>item.id===shot?.firstFrameMediaId&&item.type==='image');
        if(!shot||!image||!snapshot?.firstFrameMediaId||snapshot.firstFrameMediaId!==image.id)return false;
        if(snapshot.shotTitle!==undefined&&snapshot.shotTitle!==shot.title)return false;
        if(snapshot.firstFrameSnapshot){const saved=snapshot.firstFrameSnapshot;for(const key of ['mimeType','relativePath','bytes'])if(saved[key]!==undefined&&saved[key]!==image[key])return false;if(typeof image.sha256==='string'&&/^[a-f0-9]{64}$/i.test(image.sha256)&&typeof saved.sha256==='string'&&image.sha256!==saved.sha256)return false;}
        const caption=snapshot.captionSnapshot;if(!caption)return false;
        const cues=shot.productionCues?{schemaVersion:shot.productionCues.schemaVersion,revision:shot.productionCues.revision,updatedAt:shot.productionCues.updatedAt??null,cues:shot.productionCues.cues}:null;
        if(JSON.stringify(cues)!==JSON.stringify(caption.sourceCuesSnapshot??null))return false;
        if(caption.shotNumber!==undefined&&caption.shotNumber!==(Number.isSafeInteger(shot.number)&&shot.number>0?shot.number:null))return false;
        for(const line of caption.dialogueSnapshot||[]){const role=work.studio?.libraries?.characters?.find(item=>item.id===line.speakerId);if(line.speakerName!==undefined&&line.speakerName!==(typeof role?.name==='string'?role.name:null))return false;}
        continue;
      }
      const assetId=currentAssetId(work,clip);
      // A clip can freeze a version independently from the shot's current pick.
      const selected=clip.assetId||selectedSnapshot(exportJob,original)?.selectedAssetId;
      if(!assetId||!selected||assetId!==selected)return false;
    }
    return true;
  }catch{
    return false;
  }
}
