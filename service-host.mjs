import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {existsSync,openSync,closeSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadLanConfig} from './lan-gateway.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const defaultServices=rootDir=>[
 {id:'monitor',name:'服务器监控',port:18987,path:'/health',identity:'server-monitor',command:process.execPath,args:[join(rootDir,'server.mjs')],cwd:rootDir,env:{PORT:'18987'},logs:['console.log','error.log']},
 {id:'studio',name:'漫剧工作台',port:18990,path:'/health',identity:'art-studio',command:process.execPath,args:[join(rootDir,'studio-server.mjs')],cwd:rootDir,env:{PORT:'18990',MONITOR_URL:'http://127.0.0.1:18987'},logs:['studio.log','studio-error.log']},
 {id:'toonflow',name:'本机媒体引擎',port:19300,path:'/api/ai/media/models',identity:'toonflow',command:join(rootDir,'runtime','bun','bin',process.platform==='win32'?'bun.exe':'bun'),args:[join(rootDir,'vendor','toonflow','build','server','index.js')],cwd:join(rootDir,'vendor','toonflow'),env:{PORT:'19300',TOONFLOW_DATA_DIR:join(rootDir,'data','toonflow')},logs:['toonflow.log','toonflow-error.log'],installed:()=>existsSync(join(rootDir,'runtime','bun','bin',process.platform==='win32'?'bun.exe':'bun'))&&existsSync(join(rootDir,'vendor','toonflow','build','server','index.js'))},
];
function json(req,res,status,value){const content=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':content.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});res.end(req.method==='HEAD'?undefined:content);}
async function socketOpen(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let done=false;const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};socket.setTimeout(400,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});}
async function serviceReady(service,fetcher){
 try{const response=await fetcher(`http://127.0.0.1:${service.port}${service.path}`,{signal:AbortSignal.timeout(1000),redirect:'error'});if(!response.ok){await response.body?.cancel();return false;}let raw='',bytes=0;const decoder=new TextDecoder();for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024*1024)return false;raw+=decoder.decode(chunk,{stream:true});}raw+=decoder.decode();const value=JSON.parse(raw);return service.identity==='toonflow'?value?.code===200&&Array.isArray(value.data):value?.service===service.identity&&value?.ready===true;}catch{return false;}
}

/** Supervises only fixed local services; adopted services are never killed. */
export async function createServiceHost({rootDir=root,port=18991,services,fetcher=fetch,intervalMs=3000,backoffMs=1000,maxBackoffMs=30000,writePid=true}={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('后台服务端口无效');
 if(services===undefined){services=defaultServices(rootDir);let config;try{config=await loadLanConfig(rootDir);}catch{services.push({id:'lan-gateway',name:'漫剧局域网接入',port:18996,configurationError:'局域网配置无效，未启动接入网关；本机服务继续运行'});}if(config)services.push({id:'lan-gateway',name:'漫剧局域网接入',port:config.managementPort,path:'/health',identity:'studio-lan-manager',command:process.execPath,args:[join(rootDir,'lan-gateway.mjs')],cwd:rootDir,logs:['lan-gateway.log','lan-gateway-error.log']});}
 const logDir=join(rootDir,'logs');await mkdir(logDir,{recursive:true});
 const entries=services.map(service=>({service,child:null,busy:false,failures:0,retryAt:0,healthySince:0,state:{id:service.id,name:service.name,port:service.port,status:'checking',owned:false,pid:null,restarts:0,startedAt:null,lastExit:null,nextRetryAt:null,error:null}}));
 let stopping=false;
 function launch(entry){
  const {service,state}=entry;if(stopping||entry.child)return;
  if(service.installed&&!service.installed()){state.status='not-installed';state.error='本机运行时或媒体引擎尚未安装';return;}
  const names=service.logs||[service.id+'.log',service.id+'-error.log'];let stdout,stderr;
  try{
   stdout=openSync(join(logDir,names[0]),'a');stderr=openSync(join(logDir,names[1]),'a');
   const child=spawn(service.command,service.args||[],{cwd:service.cwd||rootDir,env:{...process.env,...service.env},windowsHide:true,shell:false,stdio:['ignore',stdout,stderr]});entry.child=child;
   Object.assign(state,{status:'starting',owned:true,pid:child.pid||null,startedAt:new Date().toISOString(),nextRetryAt:null,error:null});
   let ended=false;const endedChild=(code,signal,error)=>{if(ended)return;ended=true;if(entry.child===child)entry.child=null;state.lastExit={at:new Date().toISOString(),code,signal,error:error?.message||null};state.pid=null;entry.healthySince=0;entry.failures++;const delay=Math.min(maxBackoffMs,backoffMs*2**Math.min(entry.failures-1,10));entry.retryAt=Date.now()+delay;state.nextRetryAt=new Date(entry.retryAt).toISOString();state.status=stopping?'stopped':'backoff';state.error=error?.message||`子服务已退出，${Math.ceil(delay/1000)} 秒后重试`;state.restarts++;};
   child.once('error',error=>endedChild(null,null,error));child.once('exit',(code,signal)=>endedChild(code,signal));
  }catch(error){entry.failures++;entry.retryAt=Date.now()+Math.min(maxBackoffMs,backoffMs*2**Math.min(entry.failures-1,10));Object.assign(state,{status:'backoff',nextRetryAt:new Date(entry.retryAt).toISOString(),error:error.message,pid:null});}
  finally{if(stdout!==undefined)closeSync(stdout);if(stderr!==undefined)closeSync(stderr);}
 }
 async function check(entry){
  if(stopping||entry.busy)return;entry.busy=true;
  try{
   const {service,state}=entry;if(service.configurationError){state.status='configuration-error';state.error=service.configurationError;return;}if(await serviceReady(service,fetcher)){
    state.status=entry.child?'ready':'external';state.owned=Boolean(entry.child);state.error=null;state.nextRetryAt=null;entry.retryAt=0;if(!entry.healthySince)entry.healthySince=Date.now();if(Date.now()-entry.healthySince>30000)entry.failures=0;return;
   }
   if(entry.child){state.status='starting';state.error='等待本机子服务健康检查；不会中断正在运行的任务';return;}
   if(await socketOpen(service.port)){state.status='conflict';state.owned=false;state.error='端口已占用，但服务身份不匹配；未启动第二个实例';return;}
   if(Date.now()<entry.retryAt){state.status='backoff';return;}launch(entry);
  }finally{entry.busy=false;}
 }
 const app=http.createServer((req,res)=>{
  const actualPort=app.address()?.port||port;if(![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(req.headers.host)){json(req,res,403,{error:'仅允许本机访问'});return;}
  const url=new URL(req.url,`http://127.0.0.1:${actualPort}`);
  if(!['GET','HEAD'].includes(req.method)){json(req,res,405,{error:'后台宿主仅提供只读健康检查'});return;}
  if(url.pathname!=='/health'){json(req,res,404,{error:'未找到'});return;}
  json(req,res,200,{service:'rack-service-host',ready:true,startedAt,children:entries.map(entry=>({...entry.state}))});
 });
 const startedAt=new Date().toISOString();await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(port,'127.0.0.1',()=>{app.off('error',reject);resolve();});});
 if(writePid){await mkdir(join(rootDir,'data'),{recursive:true});await writeFile(join(rootDir,'data','service-host.pid'),String(process.pid));}
 const tick=()=>Promise.all(entries.map(check));void tick();const timer=setInterval(()=>void tick(),intervalMs);timer.unref();
 return {app,port:app.address().port,origin:`http://127.0.0.1:${app.address().port}`,check:tick,close:async({terminateOwnedChildren=false}={})=>{stopping=true;clearInterval(timer);if(terminateOwnedChildren)await Promise.all(entries.filter(entry=>entry.child).map(entry=>new Promise(resolve=>{const child=entry.child;const timer=setTimeout(resolve,2000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill();})));await new Promise(resolve=>{app.close(resolve);app.closeIdleConnections();});}};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const host=await createServiceHost({port:Number(process.env.PORT||18991)});console.log(`机柜本机后台宿主 ${host.origin}`);}
