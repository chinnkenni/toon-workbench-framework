import {readFile,writeFile,mkdir,rename,lstat,realpath,stat} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=message=>Object.assign(new Error(message),{status:400});
const inFlight=new Map();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function modelIdentity(job){const model=job?.model||job?.modelSnapshot;return model?{id:model.id??null,revision:model.revision??null,sha256:model.weightSha256??model.sha256??null}:null;}
async function saveReceipt(file,receipt){receipt.updatedAt=new Date().toISOString();const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});await rename(temporary,file);}
function checkMedia(media,workId){if(!media||!UUID.test(media.id||'')||media.type!=='audio'||media.mimeType!=='audio/wav'||media.relativePath!==`assets/imported/${media.id}.wav`||media.url!==`/api/works/${workId}/studio/media/${media.id}`)throw fail('声音归档媒体登记无效');return media;}
export function createStudioAudioRegistrar({dataDir,getOrigin,fetcher=fetch}){
 return async({workId,file,mimeType='audio/wav',name,job,category='voices'})=>{
  if(!UUID.test(workId||''))throw fail('声音归档作品编号无效');
  if(mimeType!=='audio/wav'||!['voices','music'].includes(category))throw fail('声音归档类型无效');
  if(!UUID.test(job?.id||''))throw fail('声音归档任务编号无效');
  const root=await realpath(dataDir),source=await realpath(file),path=relative(root,source);
  if(isAbsolute(path)||path.startsWith('..')||!['tts','music'].includes(path.split(/[\\/]/)[0]))throw fail('声音归档源文件越界');
  const info=await stat(source);if(!info.isFile()||info.size<44||info.size>64*1024*1024)throw fail('生成声音为空或超过 64 MB');
  const origin=new URL(getOrigin());if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/')throw fail('声音归档只允许本机工作台');
  const label=(typeof name==='string'&&name.trim()?name.trim():'生成声音').slice(0,120);
  const bytes=await readFile(source);if(bytes.length!==info.size||bytes.length>64*1024*1024)throw fail('声音源文件在读取时发生变化');
  const identity={jobId:job.id.toLowerCase(),workId,category,model:modelIdentity(job),sourceSha256:createHash('sha256').update(bytes).digest('hex')};
  const directory=join(root,'audio-registration');await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw fail('声音登记目录不能是外部链接');
  const receiptFile=join(directory,identity.jobId+'.json'),pending=inFlight.get(receiptFile);
  if(pending){if(!same(pending.identity,identity))throw fail('同一声音任务不能登记不同来源或作品');return structuredClone(await pending.promise);}
  async function request(path,body,raw=false,method='POST'){const response=await fetcher(origin.origin+path,{method,headers:{Origin:origin.origin,...(method==='POST'?{'Content-Type':raw?mimeType:'application/json'}:{})},...(method==='POST'?{body:raw?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000),redirect:'error'});const value=await response.json();if(!response.ok)throw new Error(value.error||'声音导入作品未完成');return value;}
  const promise=(async()=>{
   let receipt;try{const receiptInfo=await lstat(receiptFile);if(!receiptInfo.isFile()||receiptInfo.isSymbolicLink()||receiptInfo.size>128*1024||await realpath(receiptFile)!==receiptFile)throw fail('声音登记凭据无效');receipt=JSON.parse(await readFile(receiptFile,'utf8'));if(receipt.version!==1||!same(receipt.identity,identity)||!['prepared','uploaded','completed'].includes(receipt.stage))throw fail('声音任务来源或登记凭据不匹配');}catch(error){if(error.code!=='ENOENT')throw error;}
   if(!receipt){const description=category==='voices'?`对白：${job?.request?.text||job?.text||''}`:`配乐：${job?.request?.prompt||job?.prompt||''}`;receipt={version:1,identity,stage:'prepared',createdAt:new Date().toISOString(),entry:{name:label,description:description.slice(0,10000),voiceStyle:category==='voices'?[job?.request?.voiceDescription||job?.request?.speaker,job?.request?.instruct].filter(Boolean).join('；'):'',locked:true}};await saveReceipt(receiptFile,receipt);}
   if(receipt.media)checkMedia(receipt.media,workId);
   if(receipt.stage==='completed'){if(!UUID.test(receipt.libraryEntryId||''))throw fail('声音库登记凭据无效');return {...receipt.media,libraryEntryId:receipt.libraryEntryId};}
   if(!receipt.media){const result=await request(`/api/works/${workId}/studio/media?name=${encodeURIComponent(receipt.entry.name+'.wav')}`,bytes,true);receipt.media=checkMedia(result.media,workId);receipt.stage='uploaded';await saveReceipt(receiptFile,receipt);}
   // Recover a library commit whose successful response/receipt write was interrupted.
   const current=await request(`/api/works/${workId}`,undefined,false,'GET'),entries=current.work?.studio?.libraries?.[category];if(!Array.isArray(entries))throw fail('无法核对声音库已有登记');
   const existing=entries.find(entry=>Array.isArray(entry.mediaIds)&&entry.mediaIds.includes(receipt.media.id));
   const entry=existing||(await request(`/api/works/${workId}/studio/libraries/${category}`,{entry:{...receipt.entry,mediaIds:[receipt.media.id]}})).entry;
   if(!UUID.test(entry?.id||''))throw fail('声音库返回无效登记编号');
   receipt.libraryEntryId=entry.id;receipt.stage='completed';await saveReceipt(receiptFile,receipt);return {...receipt.media,libraryEntryId:entry.id};
  })();
  inFlight.set(receiptFile,{identity,promise});try{return structuredClone(await promise);}finally{inFlight.delete(receiptFile);}
 };
}
