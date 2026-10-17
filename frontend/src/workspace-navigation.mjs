export const MATERIAL_SECTIONS=[{id:'characters',label:'角色'},{id:'scenes',label:'场景'},{id:'audio',label:'声音'},{id:'op-ed',label:'片头片尾'}];
export const TIMELINE_SECTIONS=[{id:'exports',label:'成片'},{id:'edit',label:'剪辑'}];
const valid=(items,value,fallback)=>items.some(item=>item.id===value)?value:fallback;
export function workspaceNavigation(saved={}){
 const contentMode=['workspace','styles','library'].includes(saved.contentMode)?saved.contentMode:saved.libraryView===true?'library':saved.tab==='materials'&&saved.materialSection==='style-references'?'styles':'workspace';
 return {workId:typeof saved.workId==='string'&&saved.workId?saved.workId:null,episodeId:typeof saved.episodeId==='string'&&saved.episodeId?saved.episodeId:null,tab:['script','materials','timeline'].includes(saved.tab)?saved.tab:'timeline',materialSection:valid(MATERIAL_SECTIONS,saved.materialSection,'characters'),timelineSection:valid(TIMELINE_SECTIONS,saved.timelineSection,'exports'),contentMode};
}
export function workspaceDestination(current,tab,section){
 if(!['script','materials','timeline'].includes(tab))throw new Error('未知制作区块');
 const next={...workspaceNavigation(current),tab,contentMode:'workspace'};
 if(tab==='materials'&&section!==undefined){if(!MATERIAL_SECTIONS.some(item=>item.id===section))throw new Error('未知素材分类');next.materialSection=section;}
 if(tab==='timeline'&&section!==undefined){if(!TIMELINE_SECTIONS.some(item=>item.id===section))throw new Error('未知时间轴分类');next.timelineSection=section;}
 return next;
}
export const isGlobalStyleDestination=navigation=>navigation.contentMode==='styles';
