export const WORK_TYPES=Object.freeze([
 {id:'short-film',label:'主题短片',description:'围绕一个主题，制作独立短片'},
 {id:'series',label:'长篇剧集',description:'持续展开故事，组织多集创作'},
]);

export function workType(work){return work?.type==='series'?'series':'short-film';}
export function workTypeLabel(work){return WORK_TYPES.find(type=>type.id===workType(work)).label;}
export function matchWork(work,search){const query=String(search??'').trim().toLowerCase();return !query||[work.title,work.synopsis,work.style,workTypeLabel(work)].filter(Boolean).join(' ').toLowerCase().includes(query);}
export function groupWorks(works,search=''){
 const groups=WORK_TYPES.map(type=>({...type,total:0,works:[]}));
 for(const work of works){const group=groups[workType(work)==='series'?1:0];group.total++;if(matchWork(work,search))group.works.push(work);}
 return groups;
}
export function filterWorks(works,search='',type='all'){return works.filter(work=>(type==='all'||workType(work)===type)&&matchWork(work,search));}
export function isWorkGroupExpanded(group,search,collapsed){return String(search??'').trim()?group.works.length>0:collapsed[group.id]!==true;}

export function metadataDraft(kind,work,episode,typeHint='short-film'){
 return {kind,workId:work?.id||null,episodeId:episode?.id||null,title:kind==='create-episode'?`第 ${(work?.episodes.length||0)+1} 集`:episode?.title||work?.title||'',type:work?workType(work):workType({type:typeHint}),style:work?.style||'',synopsis:kind==='create-episode'?'':episode?.synopsis||work?.synopsis||''};
}
export function metadataSubmission(entry){
 const isWork=entry.kind.endsWith('work'),creating=entry.kind.startsWith('create');
 const path=isWork?(creating?'/api/works':`/api/works/${entry.workId}/update`):`/api/works/${entry.workId}/episodes${creating?'':`/${entry.episodeId}/update`}`;
 const payload={title:entry.title.trim(),synopsis:entry.synopsis,...(isWork?{style:entry.style,type:entry.type}:{})};
 if(!payload.title)throw new Error('请填写名称。');
 if(isWork&&!WORK_TYPES.some(type=>type.id===entry.type))throw new Error('请选择作品类型。');
 return {path,payload,isWork,creating};
}
