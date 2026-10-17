const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const dimensions=value=>Number.isSafeInteger(value?.width)&&Number.isSafeInteger(value?.height)&&value.width>=2&&value.height>=2&&value.width<=32768&&value.height<=32768?{width:value.width,height:value.height}:null;
export function clipReframeSource(work,clip){
 if(clip?.type!=='shot'||!UUID.test(clip.assetId||''))fail('重构图仅支持已明确固定 assetId 的视频分镜片段');
 const shot=work?.shots?.find(item=>item.id===clip.shotId),asset=work?.assets?.find(item=>item.id===clip.assetId&&item.shotId===clip.shotId&&item.type==='video');
 if(!shot||!asset||!shot.assetIds?.includes(asset.id))fail('重构图的视频版本不属于当前作品和分镜');
 const job=work.jobs?.find(item=>item.id===asset.jobId&&(!item.assetId||item.assetId===asset.id))||work.jobs?.find(item=>item.assetId===asset.id&&item.shotId===shot.id),assetDimensions=dimensions(asset),jobDimensions=dimensions(job?.telemetry?.output);
 if(assetDimensions&&jobDimensions&&(assetDimensions.width!==jobDimensions.width||assetDimensions.height!==jobDimensions.height))fail('源视频实测尺寸记录冲突，请先补测该视频版本',409);
 const measured=assetDimensions||jobDimensions;if(!measured)fail('源视频缺少实测宽高，请先补测该视频版本后重构图',409);
 return {asset,shot,job:job||null,...measured,measurement:assetDimensions?'registered-asset':'job-telemetry-output'};
}
/** Pure shared validation: coordinates always refer to the original registered video pixels. */
export function normalizeClipReframe(value,{work,clip,mode='video',actualSource}={}){
 if(value===undefined||value===null)return null;
 if(mode!=='video')fail('故事板使用独立首帧图片，不能使用视频重构图坐标；请清除 reframe 后导出');
 const keys=['sourceWidth','sourceHeight','x','y','width','height'];if(!plain(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Number.isSafeInteger(value[key])))fail('重构图须为 sourceWidth/sourceHeight/x/y/width/height 六个严格整数源像素');
 const source=clipReframeSource(work,clip);
 if(value.sourceWidth!==source.width||value.sourceHeight!==source.height)fail('重构图源尺寸与当前视频版本的实测尺寸不符，请重新选取',409);
 if(value.x<0||value.y<0||value.width<2||value.height<2||value.x+value.width>source.width||value.y+value.height>source.height)fail('重构图矩形越界，宽高至少2像素且须完全位于原视频内');
 if(actualSource&&(actualSource.width!==source.width||actualSource.height!==source.height))fail('FFprobe 实测源视频尺寸与重构图记录不符，未执行裁切',409);
 return Object.fromEntries(keys.map(key=>[key,value[key]]));
}
export function assertReframeExport(timeline,options={}){
 if(!timeline?.clips?.some(clip=>clip.reframe!==undefined&&clip.reframe!==null))return;
 if(options.mode==='storyboard')fail('故事板使用独立首帧图片，不能使用视频重构图坐标；请清除 reframe 后导出');
 if(options.enhance==='ai-1080p')fail('当前重构图暂不支持 AI 超分，请使用普通 video 导出或清除 reframe');
}
