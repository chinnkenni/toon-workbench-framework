import http from 'node:http';
import https from 'node:https';
import {Transform} from 'node:stream';
import {createReadStream} from 'node:fs';
import {readFile,lstat,realpath,open} from 'node:fs/promises';
import {isIPv4} from 'node:net';
import {join,resolve,isAbsolute} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createLanAccess} from './lan-access.mjs';

const UPLOAD=64*1024*1024,DOWNLOAD=2*1024*1024*1024,COOKIE='toon_lan_session';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const local=value=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(value);
const lan=value=>isIPv4(value)&&(value.startsWith('127.')||value.startsWith('10.')||value.startsWith('192.168.')||/^172\.(?:1[6-9]|2\d|3[01])\./.test(value));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function headers(res,extra={}){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');for(const [key,value]of Object.entries(extra))res.setHeader(key,value);}
function json(req,res,status,value,extra={}){const bytes=Buffer.from(JSON.stringify(value));headers(res,extra);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);}
function html(req,res,status,value,extra={}){const bytes=Buffer.from(value);headers(res,{'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",...extra});res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);}
const loginPage=message=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接漫剧工作台</title><style>body{font:16px system-ui;max-width:480px;margin:8vh auto;padding:24px;background:#f5f7f8;color:#17252b}form{display:grid;gap:12px;background:white;padding:24px;border-radius:16px;margin:20px 0}input,button{font:inherit;padding:12px;border:1px solid #cbd5dc;border-radius:8px}button{background:#087f68;color:white}p{line-height:1.6}</style><h1>连接漫剧工作台</h1><p>先在服务器所在电脑的工作台中创建一次性配对码。</p>${message?'<p role="alert">'+message+'</p>':''}<form method="post" action="/access/login" autocomplete="off"><strong>使用一次性配对码</strong><input name="deviceName" maxlength="100" placeholder="这台电脑的名称" required><input name="code" type="password" maxlength="40" placeholder="一次性配对码" required autocomplete="off"><button>配对并进入工作台</button></form><form method="post" action="/access/login" autocomplete="off"><strong>已有设备凭据</strong><input name="token" type="password" maxlength="160" placeholder="设备凭据" required autocomplete="off"><button>登录工作台</button></form><p>凭据只用于本次安全登录，不会出现在地址栏或浏览器本地存储。</p></html>`;
function duplicate(req,name){let count=0;for(let index=0;index<req.rawHeaders.length;index+=2)if(req.rawHeaders[index].toLowerCase()===name)count++;return count>1;}
function checkedPath(req){const raw=req.url||'';if(!raw.startsWith('/')||raw.startsWith('//')||raw.includes('#')||/[\u0000-\u0020\\]/.test(raw)||/%(?:00|2e|2f|5c)/i.test(raw.split('?')[0])||raw.split('?')[0].split('/').some(part=>part==='.'||part==='..'))throw fail('请求路径无效');const url=new URL(raw,'http://127.0.0.1');for(const key of url.searchParams.keys())if(/^(?:token|access_token|authorization|paircode|code)$/i.test(key))throw fail('凭据不得放在URL中');return url;}
function checkRequest(req,allowedHosts,allowedOrigins,{management=false}={}){
 if(duplicate(req,'host')||duplicate(req,'origin')||duplicate(req,'authorization')||!allowedHosts.has(req.headers.host))throw fail('请求主机不受信任',403);
 if(management&&!local(req.socket.remoteAddress))throw fail('接入管理仅允许本机访问',403);
 if(!management&&!lan((req.socket.remoteAddress||'').replace(/^::ffff:/,'')))throw fail('仅允许局域网访问',403);
 if(req.headers.origin&&!allowedOrigins.has(req.headers.origin)||!['GET','HEAD'].includes(req.method)&&!allowedOrigins.has(req.headers.origin)||req.headers['sec-fetch-site']==='cross-site')throw fail('请求来源不受信任',403);
 if(!['GET','HEAD','POST'].includes(req.method))throw fail('请求方法不支持',405);
 return checkedPath(req);
}
async function body(req,limit=8192){const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>limit)throw fail('接入请求超过限制',413);chunks.push(part);}const raw=Buffer.concat(chunks).toString('utf8');let value;if((req.headers['content-type']||'').split(';')[0]==='application/x-www-form-urlencoded'){const params=new URLSearchParams(raw);value={};for(const [key,item]of params){if(Object.hasOwn(value,key))throw fail('接入字段重复');value[key]=item;}}else{try{value=JSON.parse(raw||'{}');}catch{throw fail('接入请求需要有效JSON');}}if(!plain(value))throw fail('接入请求格式无效');return value;}
function only(value,keys){if(Object.keys(value).some(key=>!keys.includes(key)))throw fail('接入请求字段无效');}
function sessionCookie(req){const values=(req.headers.cookie||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(COOKIE+'='));if(values.length!==1)return null;return values[0].slice(COOKIE.length+1);}
function blocked(path){return path==='/api/shutdown'||path.startsWith('/api/lan')||/^\/(?:proxy|upstream)(?:\/|$)/i.test(path)||/^\/api\/(?:proxy|upstream|admin|config|settings|credentials|auth|secrets|vault)(?:\/|$)/i.test(path)||/^\/api\/publishing\/(?:config(?:\/|$)|youtube\/(?:connect|disconnect)(?:\/|$))/i.test(path)||/^\/api\/servers(?:\/|$)/i.test(path);}
async function certificate(file){if(typeof file!=='string'||!file)throw fail('TLS证书路径未配置',503);const info=await lstat(file);if(!info.isFile()||info.size<1||info.size>1024*1024)throw fail('TLS证书文件无效',503);return readFile(await realpath(file));}
async function packageInfo(file){if(typeof file!=='string'||!/\.zip$/i.test(file))return null;try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size<4||info.size>256*1024*1024)return null;const handle=await open(file,'r');try{const signature=Buffer.alloc(4);await handle.read(signature,0,4,0);if(signature.readUInt32LE()!==0x04034b50)return null;}finally{await handle.close();}return info;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function sendPackage(req,res,file){const info=await packageInfo(file);if(!info)throw fail('客户端接入包尚未准备好',404);headers(res);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':info.size,'Content-Disposition':'attachment; filename="toon-client.zip"'});if(req.method==='HEAD'){res.end();return;}await new Promise(done=>{const stream=createReadStream(file);stream.on('error',()=>{res.destroy();done();});res.on('close',()=>{stream.destroy();done();});stream.on('end',done);stream.pipe(res);});}
function safeError(req,res,error){if(res.headersSent){res.destroy();return;}json(req,res,error.status||500,{error:error.status?error.message:'局域网服务暂时不可用'});}

/** HTTPS facade for the one existing studio writer; no work catalog is opened here. */
export async function createLanGateway({dataDir,bindAddress,port=18995,managementPort=18996,upstreamPort=18990,monitorPort=18987,certPath,keyPath,caPath,clientPackagePath,access}={}){
 if(!lan(bindAddress))throw fail('网关必须绑定一个明确的局域网IPv4地址');for(const value of [port,managementPort,upstreamPort,monitorPort])if(!Number.isInteger(value)||value<0||value>65535)throw fail('局域网端口配置无效');if(!upstreamPort||!monitorPort)throw fail('上游端口配置无效');
 const credentials=access||await createLanAccess({dataDir}),[cert,key,ca]=await Promise.all([certificate(certPath),certificate(keyPath),caPath?certificate(caPath):Promise.resolve(null)]);
 let publicOrigin,managerOrigin;const active=new Set();
 function originSets(actualPort,manager=false){const hosts=new Set(manager?[`127.0.0.1:${actualPort}`,`localhost:${actualPort}`]:[`${bindAddress}:${actualPort}`,`127.0.0.1:${actualPort}`,`localhost:${actualPort}`]);return {hosts,origins:new Set([...hosts].map(host=>(manager?'http://':'https://')+host))};}
 const manager=http.createServer(async(req,res)=>{try{
  const sets=originSets(manager.address()?.port||managementPort,true),url=checkRequest(req,sets.hosts,sets.origins,{management:true});
  if(url.pathname==='/health'&&['GET','HEAD'].includes(req.method)){json(req,res,200,{service:'studio-lan-manager',ready:true});return;}
  if(url.pathname==='/api/lan/state'&&['GET','HEAD'].includes(req.method)){json(req,res,200,{service:'studio-lan-manager',ready:true,enabled:true,origin:publicOrigin,managementOrigin:managerOrigin,...await credentials.safeState(),tls:{configured:true,caAvailable:Boolean(ca),caFingerprint256:ca?new X509Certificate(ca).fingerprint256:null},clientPackageAvailable:Boolean(await packageInfo(clientPackagePath))});return;}
  if(url.pathname==='/api/lan/pair-code'&&req.method==='POST'){only(await body(req),[]);json(req,res,201,await credentials.createPairCode());return;}
  const revoke=/^\/api\/lan\/devices\/([a-f0-9-]{36})\/revoke$/i.exec(url.pathname);if(revoke&&req.method==='POST'){only(await body(req),[]);json(req,res,200,await credentials.revoke(revoke[1]));return;}
  if(['/ca.crt','/api/lan/ca.crt'].includes(url.pathname)&&['GET','HEAD'].includes(req.method)&&ca){headers(res);res.writeHead(200,{'Content-Type':'application/x-x509-ca-cert','Content-Length':ca.length,'Content-Disposition':'attachment; filename="toon-lan-ca.crt"'});res.end(req.method==='HEAD'?undefined:ca);return;}
  if(url.pathname==='/client.zip'&&['GET','HEAD'].includes(req.method)){await sendPackage(req,res,clientPackagePath);return;}
  throw fail('接入管理路径不存在',404);
 }catch(error){safeError(req,res,error);}});
 const gateway=https.createServer({cert,key,minVersion:'TLSv1.2',maxHeaderSize:16384},async(req,res)=>{try{
  const sets=originSets(gateway.address()?.port||port),url=checkRequest(req,sets.hosts,sets.origins),peer=(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
  if(url.pathname==='/access/login'&&['GET','HEAD'].includes(req.method)){html(req,res,200,loginPage(''));return;}
  if(url.pathname==='/access/ca.crt'&&['GET','HEAD'].includes(req.method)&&ca){headers(res);res.writeHead(200,{'Content-Type':'application/x-x509-ca-cert','Content-Length':ca.length,'Content-Disposition':'attachment; filename="toon-lan-ca.crt"'});res.end(req.method==='HEAD'?undefined:ca);return;}
  if(url.pathname==='/access/pair'&&req.method==='POST'){const input=await body(req);only(input,['code','deviceName']);json(req,res,201,await credentials.consumePairCode({...input,peer}));return;}
  if(url.pathname==='/access/login'&&req.method==='POST'){
   const input=await body(req);only(input,['code','deviceName','token']);if(Boolean(input.code)===Boolean(input.token))throw fail('请选择配对码或已有设备凭据');let token=input.token;
   if(input.code)token=(await credentials.consumePairCode({code:input.code,deviceName:input.deviceName||'浏览器',peer})).token;
   const session=await credentials.createSession(token);headers(res,{'Set-Cookie':`${COOKIE}=${session.session}; Path=/; Max-Age=${session.maxAge}; Secure; HttpOnly; SameSite=Strict`,Location:'/'});res.writeHead(303);res.end();return;
  }
  if(url.pathname==='/access/logout'&&req.method==='POST'){await credentials.removeSession(sessionCookie(req));headers(res,{'Set-Cookie':`${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,Location:'/access/login'});res.writeHead(303);res.end();return;}
  if(url.pathname.startsWith('/access/')&&url.pathname!=='/access/client.zip')throw fail('接入路径不存在',404);
  if(blocked(url.pathname))throw fail('此管理操作仅允许在主机本机执行',403);
  let device;const authorization=req.headers.authorization;if(authorization){const match=/^Bearer (toon_lan_[A-Za-z0-9_-]{43})$/.exec(authorization);device=match?await credentials.authenticateToken(match[1]):null;}else device=await credentials.authenticateSession(sessionCookie(req));
  if(!device){if(req.method==='GET'&&!url.pathname.startsWith('/api/')&&(req.headers.accept||'').includes('text/html')){headers(res,{Location:'/access/login'});res.writeHead(303);res.end();}else json(req,res,401,{error:'请先配对或登录此设备'},{'WWW-Authenticate':'Bearer realm="toon-workbench"'});return;}
  if(url.pathname==='/access/client.zip'){if(!['GET','HEAD'].includes(req.method))throw fail('客户端接入包仅支持下载',405);await sendPackage(req,res,clientPackagePath);return;}
  if(url.pathname==='/health'){json(req,res,200,{service:'studio-lan-gateway',ready:true});return;}
  const monitor=['/api/state','/api/model-inventory'].includes(url.pathname);if(monitor&&!['GET','HEAD'].includes(req.method))throw fail('监控入口仅允许读取',403);
  await proxy(req,res,url,monitor?monitorPort:upstreamPort,monitor&&req.method==='HEAD');
 }catch(error){if(req.url==='/access/login'&&req.method==='POST'&&error.status&&error.status!==403)html(req,res,error.status,loginPage('登录失败，请检查凭据或重新配对。'));else safeError(req,res,error);}});
 async function proxy(req,res,url,targetPort,monitorHead=false){
  if(req.headers['content-length']!==undefined&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>UPLOAD))throw fail('上传超过64MB限制',413);
  const connection=new Set(String(req.headers.connection||'').toLowerCase().split(',').map(value=>value.trim())),requestHeaders={host:`127.0.0.1:${targetPort}`,origin:`http://127.0.0.1:${targetPort}`};
  for(const name of ['accept','accept-language','content-type','content-length','range','if-range','if-none-match','if-modified-since','user-agent'])if(req.headers[name]!==undefined&&!connection.has(name))requestHeaders[name]=req.headers[name];
  await new Promise(resolveDone=>{
   let complete=false,received=0,sent=0;const finish=()=>{if(complete)return;complete=true;active.delete(upstream);resolveDone();},abort=error=>{upstream.destroy();if(!res.headersSent)json(req,res,error.status||502,{error:error.status?error.message:'中央工作台暂时不可用'});else res.destroy();finish();};
   const upstream=http.request({hostname:'127.0.0.1',port:targetPort,method:monitorHead?'GET':req.method,path:url.pathname+url.search,headers:requestHeaders,agent:false},response=>{
    if(Number(response.headers['content-length'])>DOWNLOAD){response.destroy();abort(fail('媒体下载超过2GB限制',502));return;}
    const forwarded={};for(const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified','content-disposition','cache-control','content-security-policy','x-content-type-options','x-frame-options','referrer-policy','allow'])if(response.headers[name]!==undefined)forwarded[name]=response.headers[name];
    if(response.headers.location){try{const target=new URL(response.headers.location,`http://127.0.0.1:${targetPort}`);if(target.origin!==`http://127.0.0.1:${targetPort}`)throw Error();forwarded.location=publicOrigin+target.pathname+target.search;}catch{response.destroy();abort(fail('中央工作台返回了不允许的重定向',502));return;}}
    res.writeHead(response.statusCode||502,forwarded);response.on('data',part=>{received+=part.length;if(received>DOWNLOAD)abort(fail('媒体下载超过2GB限制',502));});response.on('error',()=>abort(fail('中央工作台媒体传输中断',502)));response.on('end',()=>{if(monitorHead)res.end();finish();});if(!monitorHead)response.pipe(res);
   });active.add(upstream);upstream.setTimeout(120000,()=>abort(fail('中央工作台连接超时',504)));upstream.on('error',()=>{if(!complete)abort(fail('中央工作台暂时不可用',502));});
   const limiter=new Transform({transform(chunk,encoding,callback){sent+=chunk.length;callback(sent>UPLOAD?fail('上传超过64MB限制',413):null,sent>UPLOAD?undefined:chunk);}});limiter.on('error',error=>{req.unpipe(limiter);abort(error);});req.on('aborted',()=>{upstream.destroy();finish();});res.on('close',()=>{if(!res.writableFinished){upstream.destroy();finish();}});req.pipe(limiter).pipe(upstream);
  });
 }
 gateway.on('upgrade',(req,socket)=>socket.destroy());manager.on('upgrade',(req,socket)=>socket.destroy());gateway.requestTimeout=120000;gateway.headersTimeout=15000;manager.requestTimeout=15000;manager.headersTimeout=10000;
 try{await new Promise((done,reject)=>{gateway.once('error',reject);gateway.listen(port,bindAddress,()=>{gateway.off('error',reject);done();});});publicOrigin=`https://${bindAddress}:${gateway.address().port}`;await new Promise((done,reject)=>{manager.once('error',reject);manager.listen(managementPort,'127.0.0.1',()=>{manager.off('error',reject);done();});});managerOrigin=`http://127.0.0.1:${manager.address().port}`;}catch(error){gateway.close();manager.close();throw error;}
 return {gateway,manager,origin:publicOrigin,managementOrigin:managerOrigin,access:credentials,state:()=>credentials.safeState(),close:async()=>{for(const request of active)request.destroy();gateway.closeIdleConnections();manager.closeIdleConnections();await Promise.all([new Promise(done=>gateway.close(done)),new Promise(done=>manager.close(done))]);}};
}

export async function loadLanConfig(rootDir){
 const file=join(resolve(rootDir),'data/lan/config.json');let value;try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||info.size>65536)throw fail('局域网配置文件无效',503);value=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!plain(value)||value.enabled!==true)return null;if(Object.keys(value).some(key=>!['schemaVersion','enabled','bindAddress','port','managementPort','upstreamPort','monitorPort','certPath','keyPath','caPath','clientPackagePath'].includes(key))||value.schemaVersion!==undefined&&value.schemaVersion!==1||value.upstreamPort!==18990||value.monitorPort!==undefined&&value.monitorPort!==18987||value.port!==18995||value.managementPort!==18996||!lan(value.bindAddress)||!['certPath','keyPath'].every(key=>typeof value[key]==='string'&&isAbsolute(value[key]))||['caPath','clientPackagePath'].some(key=>value[key]!==undefined&&value[key]!==''&&(typeof value[key]!=='string'||!isAbsolute(value[key]))))throw fail('局域网配置无效，未启动额外实例',503);return value;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const rootDir=fileURLToPath(new URL('.',import.meta.url));try{const config=await loadLanConfig(rootDir);if(!config)throw fail('局域网接入未启用',503);const server=await createLanGateway({...config,dataDir:join(rootDir,'data')});console.log('漫剧局域网 HTTPS 网关已就绪 '+server.origin);}catch{console.error('漫剧局域网网关未启动，请在本机检查配置与证书。');process.exitCode=1;}}
