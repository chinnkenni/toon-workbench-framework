const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim()?value:null;
const skillId=/^[a-z0-9][a-z0-9-]{0,63}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const CREATIVE_STAGE_LABELS=Object.freeze({script:'剧本打磨',storyboard:'分镜拆分',camera:'运镜设定',characters:'人物设定',scenes:'场景设定',prompts:'提示词强化',video:'视频生成',voice:'角色配音',music:'配乐音效',timeline:'时间轴与审片',export:'成片导出',publishing:'发布',server:'模型与服务器','op-ed':'片头片尾'});

/** Presentation only: these statements are not independent proof of skill use or quality. */
export function archiveSkillApplication(record){
 const details=record?.details;if(!object(details)||details.recordType!=='skill-application')return null;
 const stage=typeof details.creativeStage==='string'&&Object.hasOwn(CREATIVE_STAGE_LABELS,details.creativeStage)?details.creativeStage:null;
 const applications=[];for(const value of Array.isArray(details.applications)?details.applications:[]){
  if(!object(value)||typeof value.skillId!=='string'||!skillId.test(value.skillId)||!text(value.application))continue;
  applications.push({skillId:value.skillId,version:Number.isSafeInteger(value.version)&&value.version>0?value.version:null,sha256:typeof value.sha256==='string'&&/^[a-f0-9]{64}$/i.test(value.sha256)?value.sha256:null,application:value.application,outputRefs:Array.isArray(value.outputRefs)?value.outputRefs.filter(reference=>text(reference)!==null):[]});
 }
 return {stage,stageLabel:stage?CREATIVE_STAGE_LABELS[stage]:'制作阶段未记录',episodeId:typeof details.episodeId==='string'&&uuid.test(details.episodeId)?details.episodeId:null,verification:details.verification==='agent-reported'?'agent-reported':null,authorityLabel:details.verification==='agent-reported'?'Agent 登记的应用说明':'应用说明（登记来源未记录）',qualityNote:'后台未独立核验技能实际应用或产物质量。',applications,note:text(details.note)};
}
