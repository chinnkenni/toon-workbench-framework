export function output1080Size(width,height){
 if(width===height)return {width:1080,height:1080};
 return width>height?{width:1920,height:1080}:{width:1080,height:1920};
}
/** Static previs is an explicit CPU mode; UI state cannot carry AI enhancement into it. */
export function exportOutput({mode='video',enhance='none',ready=false,width,height}){
 if(!['video','storyboard'].includes(mode))throw new Error('请选择动态成片或故事板预演。');
 const selected=mode==='video'&&enhance==='ai-1080p'&&ready?'ai-1080p':'none';
 return {mode,enhance:selected,...(selected==='ai-1080p'?output1080Size(width,height):{width,height})};
}
