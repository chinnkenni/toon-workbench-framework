import http from 'node:http';
import {mkdir,readFile,writeFile,realpath,stat} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {handleWorks} from './works.mjs';
import {handleCreativeSkills} from './creative-skills.mjs';
import {handleStyleReferences} from './style-references.mjs';
import {handleCreativeTts,getActiveTtsJobs} from './tts.mjs';
import {handleCreativeMusic,getActiveMusicJobs} from './music.mjs';
import {handleAsr,getActiveAsrJobs} from './asr.mjs';
import {createStudioAudioRegistrar} from './studio-audio.mjs';
import {handleProductionLog} from './production-log.mjs';
import {handlePublishing,getActivePublishingJobs} from './publishing.mjs';
import {createYouTubePublisher} from './publishing-youtube.mjs';
import {handleWorkbenchGuide} from './workbench-guide.mjs';
import {handleWorkArchives,getActiveArchiveJobs} from './work-archive.mjs';
import {handleLanManagement} from './lan-management-proxy.mjs';
import {getPendingArchiveCallbacks} from './studio.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const files={'/':'studio.html','/studio.html':'studio.html','/studio-app.js':'studio-app.js','/works.js':'works.js','/h3-frame-options.js':'h3-frame-options.js','/artist.css':'artist.css','/style.css':'style.css','/studio-panels.js':'studio-panels.js','/timeline.js':'timeline.js','/clip-reframe.js':'clip-reframe.js','/audio-automation-input.js':'audio-automation-input.js','/timeline-preview.js':'timeline-preview.js','/timeline-transport.js':'timeline-transport.js','/generation-log.js':'generation-log.js'};
const studioAsset=/^\/studio-ui\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|png|svg|woff2)$/;
const assetMime={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
function requireInside(base,target){const path=relative(base,target);if(!path||path.startsWith('..')||isAbsolute(path))throw Object.assign(new Error('未找到工作台静态资源'),{status:404});}
async function builtFile(rootDir,file){
 const publicRoot=await realpath(join(rootDir,'public')),directory=await realpath(join(publicRoot,'studio-ui'));requireInside(publicRoot,directory);
 const target=await realpath(join(directory,file));requireInside(directory,target);if(!(await stat(target)).isFile())throw Object.assign(new Error('未找到工作台静态资源'),{status:404});return target;
}
async function staticFile(req,res,file,mime,cache='no-cache'){
 const content=await readFile(file);res.writeHead(200,{'Content-Type':mime,'Content-Length':content.length,'Cache-Control':cache});res.end(req.method==='HEAD'?undefined:content);
}
function json(req,res,status,value){const content=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':content.length,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:content);}
function monitorOrigin(value){const url=new URL(value);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('监控服务须使用本机 HTTP 地址');return url.origin;}
async function stateFromMonitor(base,fetcher){
 try{const response=await fetcher(base+'/api/state',{signal:AbortSignal.timeout(3000),redirect:'error'});if(!response.ok){await response.body?.cancel();return {servers:[]};}let raw='',bytes=0;const decoder=new TextDecoder();for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)return {servers:[]};raw+=decoder.decode(chunk,{stream:true});}raw+=decoder.decode();const value=JSON.parse(raw);return value&&Array.isArray(value.servers)?value:{servers:[]};}catch{return {servers:[]};}
}
export async function activeWorkloads(dataDir){
 try{const catalog=JSON.parse(await readFile(join(dataDir,'works','catalog.json'),'utf8'));if(!Array.isArray(catalog.works))throw new Error('作品索引格式无效');return catalog.works.reduce((counts,work)=>{counts.generations+=(work.jobs||[]).filter(job=>['queued','running'].includes(job.status)).length;counts.exports+=(work.studio?.exports||[]).filter(job=>['queued','running'].includes(job.status)).length;return counts;},{generations:0,exports:0});}
 catch(error){if(error.code==='ENOENT')return {generations:0,exports:0};throw Object.assign(new Error('无法核对作品任务，暂不关闭工作台'),{status:409});}
}

/** The studio is the only HTTP process that owns the shared works catalog. */
export async function createStudioServer({rootDir=root,dataDir=join(rootDir,'data'),port=18990,monitorUrl='http://127.0.0.1:18987',fetcher=fetch,workHandler=handleWorks,writePid=true,publishingAdapters={youtube:createYouTubePublisher()},publishingProtector,archiveRoot,lanManagementPort=18996}={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('工作台端口无效');
 const monitor=monitorOrigin(monitorUrl);await mkdir(dataDir,{recursive:true});let origin,shuttingDown=false,mutations=0;
 if(archiveRoot===undefined){archiveRoot=null;try{const config=JSON.parse(await readFile(join(dataDir,'work-archives','config.json'),'utf8'));if(config.schemaVersion===1&&config.enabled===true&&typeof config.nasRoot==='string'&&isAbsolute(config.nasRoot))archiveRoot=config.nasRoot;}catch(error){if(error.code!=='ENOENT')console.error('NAS档案配置无效；本机工作台继续运行');}}
 const context={rootDir,dataDir,archiveRoot,getState:()=>stateFromMonitor(monitor,fetcher)};
 const persistAudio=createStudioAudioRegistrar({dataDir,getOrigin:()=>origin});
 const app=http.createServer(async(req,res)=>{
  try{
   const actualPort=app.address()?.port||port;origin=`http://127.0.0.1:${actualPort}`;
   if(![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(req.headers.host)){json(req,res,403,{error:'仅允许本机访问'});return;}
   res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:19300; frame-ancestors 'none'");
   if(!['GET','HEAD'].includes(req.method)&&![origin,`http://localhost:${actualPort}`].includes(req.headers.origin)){json(req,res,403,{error:'请求来源不受信任'});return;}
   const url=new URL(req.url,origin);
   if(url.pathname==='/health'&&['GET','HEAD'].includes(req.method)){json(req,res,200,{service:'art-studio',ready:true});return;}
   if(shuttingDown&&!['GET','HEAD'].includes(req.method)){json(req,res,409,{error:'工作台正在核对关闭状态，请稍后再试'});return;}
   if(url.pathname==='/api/shutdown'&&req.method==='POST'){
    if(mutations){json(req,res,409,{error:'仍有素材上传、保存或任务提交请求，请完成后再关闭工作台'});return;}
    shuttingDown=true;let active;try{active={...await activeWorkloads(dataDir),archiveCallbacks:getPendingArchiveCallbacks(dataDir),archives:await getActiveArchiveJobs({dataDir}),tts:await getActiveTtsJobs({dataDir}),music:await getActiveMusicJobs({dataDir}),asr:await getActiveAsrJobs({dataDir}),publishing:await getActivePublishingJobs({dataDir}),publishingOAuth:Object.values(publishingAdapters).reduce((count,adapter)=>count+(adapter.getActiveAuthorizations?.()||0),0)};}catch(error){shuttingDown=false;throw error;}if(Object.values(active).some(count=>count>0)){shuttingDown=false;json(req,res,409,{error:'仍有生成、合成、转写、NAS备份、发布或账号授权任务，请完成后再关闭工作台',active});return;}
    json(req,res,200,{stopping:true});app.close();app.closeIdleConnections();return;
   }
   const mutation=!['GET','HEAD'].includes(req.method);if(mutation)mutations++;
   let handled;try{handled=await handleLanManagement(req,res,url,{port:lanManagementPort})||await handleWorkArchives(req,res,url,{dataDir,rootDir,nasRoot:archiveRoot})||await handleStyleReferences(req,res,url,{dataDir,rootDir})||await handleWorkbenchGuide(req,res,url,{dataDir,rootDir})||await handlePublishing(req,res,url,{dataDir,getOrigin:()=>origin,providerAdapters:publishingAdapters,vaultProtector:publishingProtector})||await handleProductionLog(req,res,url,{dataDir})||await handleCreativeSkills(req,res,url,{dataDir,rootDir})||await handleCreativeTts(req,res,url,{dataDir,persistAudio})||await handleCreativeMusic(req,res,url,{dataDir,persistAudio})||await handleAsr(req,res,url,context)||await workHandler(req,res,url,context);}finally{if(mutation)mutations--;}
   if(handled)return;
   const rawPath=req.url.split('?')[0];
   if(url.pathname.startsWith('/studio-ui/')||rawPath.startsWith('/studio-ui/')){
    if(!['GET','HEAD'].includes(req.method)||!studioAsset.test(rawPath)){json(req,res,404,{error:'未找到工作台静态资源'});return;}
    const file=await builtFile(rootDir,rawPath.slice('/studio-ui/'.length)),mime=assetMime[extname(file)],cache=/\-[A-Za-z0-9_-]{8,}\.(?:js|css|png|svg|woff2)$/.test(rawPath)?'public, max-age=31536000, immutable':'no-cache';
    if(!mime){json(req,res,404,{error:'未找到工作台静态资源'});return;}await staticFile(req,res,file,mime,cache);return;
   }
   if(url.pathname==='/'&&['GET','HEAD'].includes(req.method)){
    let entry;try{entry=await builtFile(rootDir,'index.html');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(entry){await staticFile(req,res,entry,'text/html; charset=utf-8');return;}
   }
   if(['GET','HEAD'].includes(req.method)&&files[url.pathname]){
    const file=files[url.pathname];await staticFile(req,res,join(rootDir,'public',file),file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');return;
   }
   json(req,res,404,{error:'未找到工作台接口或页面'});
  }catch(error){if(!res.headersSent)json(req,res,error.status||(error.code==='ENOENT'?404:500),{error:error.message});else res.destroy(error);}
 });
 app.once('close',()=>{for(const adapter of Object.values(publishingAdapters))adapter.close?.();});
 await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(port,'127.0.0.1',()=>{app.off('error',reject);resolve();});});
 if(writePid)await writeFile(join(dataDir,'studio.pid'),String(process.pid));
 return {app,port:app.address().port,origin:`http://127.0.0.1:${app.address().port}`,context,close:()=>new Promise(resolve=>{app.close(resolve);app.closeIdleConnections();})};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const server=await createStudioServer({port:Number(process.env.PORT||18990),monitorUrl:process.env.MONITOR_URL||'http://127.0.0.1:18987'});console.log(`漫剧工作台 ${server.origin}`);
}
