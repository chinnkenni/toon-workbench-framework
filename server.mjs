import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import {createModelInventory} from './model-inventory.mjs';
import {getTtsCapability} from './tts-runtime.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const data=join(root,'data'); await mkdir(data,{recursive:true});
const configPath=join(data,'servers.json');
const sshExe=process.platform==='win32'?'C:\\Windows\\System32\\OpenSSH\\ssh.exe':'ssh';
let servers=existsSync(configPath)?JSON.parse(await readFile(configPath,'utf8')):[];
async function save(){const temp=configPath+'.tmp';await writeFile(temp,JSON.stringify(servers,null,2));await rename(temp,configPath);}
await save();
let events=[];try{events=JSON.parse(await readFile(join(data,'events.json'),'utf8'));}catch{}
let eventWrites=Promise.resolve();
function event(server,message,ok=true){events.unshift({id:randomUUID(),time:new Date().toISOString(),server:server.name,message,ok});events=events.slice(0,200);const snapshot=JSON.stringify(events);eventWrites=eventWrites.then(()=>writeFile(join(data,'events.json'),snapshot)).catch(()=>{});}
const samples=new Map(),pending=new Map();
const tunnels=new Map();
await writeFile(join(data,'controller.pid'),String(process.pid));
function portOpen(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});const finish=value=>{socket.destroy();resolve(value);};socket.setTimeout(700,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});}
async function ensureTunnel(s){
 const index=servers.findIndex(x=>x.id===s.id),comfyPort=19188+index*20;
 let tunnel=tunnels.get(s.id);if(tunnel){tunnel.ready=await portOpen(comfyPort);return;}
 const child=spawn(sshExe,['-N','-i',s.keyPath,'-p',String(s.port),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=6','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-L',`127.0.0.1:${comfyPort}:127.0.0.1:8188`,...(s.connectHost?['-4','-o',`HostKeyAlias=${s.host}`]:[]),`${s.user}@${s.connectHost||s.host}`],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 tunnel={ready:false,comfyPort,child};tunnels.set(s.id,tunnel);let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-1500);});child.on('error',e=>{tunnels.delete(s.id);event(s,'服务隧道启动失败：'+e.message,false);});child.on('close',()=>{tunnels.delete(s.id);if(error)event(s,'服务隧道断开：'+error,false);});
}
function ssh(s,command,input='',timeout=18000){return new Promise((resolvePromise,reject)=>{
  const args=['-T','-i',s.keyPath,'-p',String(s.port),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=6','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1',...(s.connectHost?['-4','-o',`HostKeyAlias=${s.host}`]:[]),`${s.user}@${s.connectHost||s.host}`,command];
  const child=spawn(sshExe,args,{windowsHide:true}); let out='',err='',settled=false;
  const timer=setTimeout(()=>{child.kill();finish(new Error('连接超时，请检查服务器电源和网络'));},timeout);
  function finish(error){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolvePromise(out);}
  child.on('error',finish);child.stdout.on('data',x=>{out+=x;if(out.length>1024*1024){child.kill();finish(new Error('输出超过限制'));}});child.stderr.on('data',x=>{err=(err+x).slice(-4000);});
  child.on('close',code=>finish(code===0?null:new Error(err.trim()||`SSH 退出码 ${code}`)));child.stdin.on('error',()=>{});child.stdin.end(input);
});}
async function poll(s){if(pending.has(s.id))return pending.get(s.id);const job=(async()=>{
  const previous=samples.get(s.id);
  try{const collector=await readFile(join(root,'collector.py'),'utf8');const metric=JSON.parse(await ssh(s,'python3 -',collector));const history=[...(previous?.history||[]),{time:metric.sampledAt,cpu:metric.cpu,gpu:metric.gpu?.utilization??null}].slice(-90);
    if(metric.services?.comfyui)await ensureTunnel(s);
    samples.set(s.id,{online:true,metric,history,lastSuccess:new Date().toISOString()});if(!previous?.online)event(s,'SSH 已连接，开始采集真实指标');
  }catch(e){samples.set(s.id,{...previous,online:false,error:e.message});if(previous?.online!==false)event(s,e.message,false);}
})().finally(()=>pending.delete(s.id));pending.set(s.id,job);return job;}
function publicServer(s){const snap=samples.get(s.id),tunnel=tunnels.get(s.id);return {...s,...snap,loading:pending.has(s.id),keyPath:undefined,hasKey:existsSync(s.keyPath),serviceLinks:tunnel?.ready?{comfyui:`http://127.0.0.1:${tunnel.comfyPort}`}:null};}
const modelInventory=createModelInventory({rootDir:root,dataDir:data,getServers:()=>servers,readRemote:(server,script)=>ssh(server,'python3 -',script,30000),getTtsCapability});
async function workstation(){
 const check=async(url,identity)=>{try{const response=await fetch(url,{signal:AbortSignal.timeout(700)});if(identity){const result=await response.json();return response.ok&&result.service===identity&&result.ready===true;}await response.body?.cancel();return response.ok;}catch{return false;}};
 const [toonflow,studio]=await Promise.all([check('http://127.0.0.1:19300/'),check('http://127.0.0.1:18990/health','art-studio')]);return {toonflow,studio};
}
export function validateServer(body){
  if(typeof body.name!=='string'||!body.name.trim()||body.name.length>80)throw new Error('请输入服务器名称（最多 80 字）');
  if(typeof body.host!=='string'||body.host.length>253||! /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(body.host))throw new Error('请输入有效 IP 或主机名');
  if(typeof body.user!=='string'||! /^[a-z_][a-z0-9_-]{0,31}$/i.test(body.user))throw new Error('SSH 用户名格式不正确');
  const port=Number(body.port||22);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('端口应为 1–65535');
  if(typeof body.keyPath!=='string'||!body.keyPath.trim())throw new Error('请明确填写本机 SSH 私钥路径');
  const keyPath=resolve(body.keyPath);
  if(!existsSync(keyPath))throw new Error('本机找不到指定 SSH 私钥文件');
  return {id:randomUUID(),name:body.name.trim(),host:body.host,port,user:body.user,keyPath};
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req){let raw='';for await(const part of req){raw+=part;if(raw.length>16384)throw new Error('请求过大');}return JSON.parse(raw||'{}');}
const port=Number(process.env.PORT||18987),origin=`http://127.0.0.1:${port}`;
const app=http.createServer(async(req,res)=>{
 try{
  if(req.headers.host!==`127.0.0.1:${port}`&&req.headers.host!==`localhost:${port}`){json(res,403,{error:'仅允许本机访问'});return;}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:19300; frame-ancestors 'none'");
  if(!['GET','HEAD'].includes(req.method)&&! [origin,`http://localhost:${port}`].includes(req.headers.origin)){json(res,403,{error:'请求来源不受信任'});return;}
  const url=new URL(req.url,origin);
  if(url.pathname==='/health'&&['GET','HEAD'].includes(req.method)){json(res,200,{service:'server-monitor',ready:true});return;}
  if(/^\/api\/works(?:\/|$)/.test(url.pathname)){
    const destination=`http://127.0.0.1:18990${url.pathname}${url.search}`;
    if(['GET','HEAD'].includes(req.method)){res.writeHead(307,{'Location':destination,'Cache-Control':'no-store'});res.end();return;}
    json(res,409,{error:'作品制作已迁移至独立漫剧工作台，请从 http://127.0.0.1:18990/ 操作。',studioUrl:'http://127.0.0.1:18990/'});return;
  }
  if(url.pathname==='/api/shutdown'&&req.method==='POST'){
    json(res,200,{stopping:true});for(const tunnel of tunnels.values())tunnel.child?.kill();
    app.close(()=>process.exit(0));app.closeIdleConnections();setTimeout(()=>process.exit(0),2000).unref();return;
  }
  if(url.pathname==='/api/state'&&req.method==='GET'){json(res,200,{servers:servers.map(publicServer),events,interval:10,workstation:await workstation()});return;}
  if(url.pathname==='/api/model-inventory'&&req.method==='GET'){json(res,200,await modelInventory.sample());return;}
  if(url.pathname==='/api/servers'&&req.method==='POST'){
    const s=validateServer(await body(req));if(servers.some(x=>x.host===s.host&&x.port===s.port&&x.user===s.user))throw new Error('该连接已经存在');servers.push(s);await save();event(s,'已添加服务器');void poll(s);json(res,201,{id:s.id});return;
  }
  const match=url.pathname.match(/^\/api\/servers\/([a-f0-9-]+)\/(refresh|prepare|apply|authorize)$/);
  if(match&&req.method==='POST'){
    const s=servers.find(x=>x.id===match[1]);if(!s){json(res,404,{error:'服务器不存在'});return;}
    if(match[2]==='refresh'){await poll(s);json(res,200,publicServer(s));return;}
    const script=await readFile(join(root,'setup-server.sh'),'utf8');
    await ssh(s,'umask 077; mkdir -p ~/.local/share/rack-console; cat > ~/.local/share/rack-console/setup-server.sh',script);
    const command='sudo bash ~/.local/share/rack-console/setup-server.sh';
    if(match[2]==='authorize'){
      if(process.platform!=='win32')throw new Error('请手动在服务器终端执行授权命令');
      const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
      const args=['-t','-i',s.keyPath,'-p',String(s.port),'-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',...(s.connectHost?['-4','-o',`HostKeyAlias=${s.host}`]:[]),`${s.user}@${s.connectHost||s.host}`,command];
      const script=`& ${quote(sshExe)} ${args.map(quote).join(' ')}; Write-Host '完成后回到机柜点击检查连接；可以关闭此窗口。'`;
      const encoded=Buffer.from(script,'utf16le').toString('base64');
      const launch=`Start-Process -FilePath powershell.exe -WindowStyle Normal -ArgumentList '-NoProfile -NoExit -EncodedCommand ${encoded}'`;
      const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(launch,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});child.on('error',e=>event(s,e.message,false));child.unref();
      event(s,'已打开交互授权终端，等待用户输入 sudo 密码');json(res,200,{launched:true});return;
    }
    if(match[2]==='apply'){
      try{const output=await ssh(s,'sudo -n bash ~/.local/share/rack-console/setup-server.sh');event(s,'已应用开机配置');await poll(s);json(res,200,{applied:true,output});return;}
      catch(e){if(!/password|密码|terminal|tty/i.test(e.message))throw e;}
    }
    event(s,'开机配置脚本已上传，等待本机 sudo 授权');json(res,200,{applied:false,command,message:'请在该服务器终端执行一次，输入系统密码。完成后点击检查连接。'});return;
  }
  const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
  if(req.method==='GET'&&files[url.pathname]){const file=files[url.pathname];const content=await readFile(join(root,'public',file));res.writeHead(200,{'Content-Type':file.endsWith('html')?'text/html; charset=utf-8':file.endsWith('css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-cache'});res.end(content);return;}
  json(res,404,{error:'未找到'});
 }catch(e){json(res,400,{error:e.message});}
});
app.listen(port,'127.0.0.1',()=>{console.log(`机柜控制台 ${origin}`);servers.forEach(s=>void poll(s));void modelInventory.sample().catch(error=>console.error('模型服务采样失败：',error.message));});
setInterval(()=>servers.forEach(s=>void poll(s)),10000).unref();
setInterval(()=>void modelInventory.sample().catch(error=>console.error('模型服务采样失败：',error.message)),30000).unref();

