import https from 'node:https';
import {Readable} from 'node:stream';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {readFile,writeFile,mkdir,lstat,rename,unlink,chmod} from 'node:fs/promises';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {spawn} from 'node:child_process';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const defaultProfileDirectory=()=>join(homedir(),'.toon-workbench-framework','remote');
export function lanOrigin(value){
 let url;try{url=new URL(value);}catch{throw fail('接入地址须为 HTTPS 局域网地址');}
 const p=url.hostname.split('.').map(Number),privateV4=p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(p[0]===10||p[0]===192&&p[1]===168||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===127);
 if(url.protocol!=='https:'||!(privateV4||url.hostname==='localhost')||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw fail('接入只允许 HTTPS 私有IPv4地址或 localhost，不接受公网、凭据或额外路径');
 return url.origin;
}
async function regular(file,max=1024*1024){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw fail('接入配置文件不是安全的普通文件');return readFile(file);}
async function atomic(file,bytes){const temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,file);}catch(error){await unlink(temporary).catch(()=>{});throw error;}}
async function protect(operation,bytes){
 const script="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$b=[Convert]::FromBase64String($v.data);$s=[Security.Cryptography.DataProtectionScope]::CurrentUser;if($v.operation -eq 'protect'){$r=[Security.Cryptography.ProtectedData]::Protect($b,$null,$s)}else{$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,$s)};[Console]::Out.Write([Convert]::ToBase64String($r))";
 return new Promise((done,reject)=>{const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let output='',size=0;const timer=setTimeout(()=>{child.kill();reject(fail('接入凭据保护超时'));},15000);child.stdout.on('data',chunk=>{size+=chunk.length;if(size>128*1024)child.kill();else output+=chunk;});child.stderr.resume();child.once('error',()=>{clearTimeout(timer);reject(fail('无法使用Windows当前用户保护接入凭据'));});child.once('close',code=>{clearTimeout(timer);if(code!==0||size>128*1024||!output.trim())reject(fail('接入凭据无法解密，请在本机重新配对'));else done(Buffer.from(output.trim(),'base64'));});child.stdin.end(JSON.stringify({operation,data:Buffer.from(bytes).toString('base64')}));});
}
/** Only this paired origin receives the device token. TLS always checks the pinned CA. */
export function createPairedFetch({origin,ca,token,requestTimeout=30000}){
 origin=lanOrigin(origin);new X509Certificate(ca);
 return async(url,options={})=>{
  const target=new URL(url);if(target.origin!==origin||target.username||target.password)throw fail('接入凭据不能发送到其他服务');
  const headers=new Headers(options.headers||{});if(token)headers.set('Authorization','Bearer '+token);headers.delete('Cookie');
  return new Promise((done,reject)=>{
   const req=https.request(target,{method:options.method||'GET',headers:Object.fromEntries(headers),ca,rejectUnauthorized:true,signal:options.signal},res=>{
    const responseHeaders=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)responseHeaders.append(res.rawHeaders[i],res.rawHeaders[i+1]);
    if([301,302,303,307,308].includes(res.statusCode)&&options.redirect==='error'){res.destroy();reject(fail('接入服务返回重定向，未转发凭据'));return;}
    const body=options.method==='HEAD'||[204,205,304].includes(res.statusCode)?null:Readable.toWeb(res);if(!body)res.resume();
    done(new Response(body,{status:res.statusCode,statusText:res.statusMessage,headers:responseHeaders}));
   });req.setTimeout(requestTimeout,()=>req.destroy(fail('局域网请求超时')));req.once('error',()=>reject(fail('无法建立已验证的局域网HTTPS连接，请核对地址、CA和网络')));req.end(options.body??undefined);
  });
 };
}
export async function readClientProfile(directory=defaultProfileDirectory()){
 const root=resolve(directory);let bytes;try{const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw fail('接入目录不能是链接');if(process.platform!=='win32'&&(info.mode&0o077||process.getuid&&info.uid!==process.getuid()))throw fail('接入目录权限须仅限当前用户');bytes=await regular(join(root,'connection.json'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 let profile;try{profile=JSON.parse(bytes.toString('utf8'));}catch{throw fail('接入配置损坏，请重新配对');}
 if(profile.version!==1||typeof profile.deviceId!=='string'||typeof profile.name!=='string'||!['windows-dpapi-current-user','posix-mode-600'].includes(profile.protection))throw fail('接入配置格式无效');
 const origin=lanOrigin(profile.origin),ca=await regular(join(root,'ca.crt')),sha=createHash('sha256').update(new X509Certificate(ca).raw).digest('hex');if(sha!==profile.caSha256)throw fail('接入CA发生变化，未发送凭据');
 const secretFile=join(root,profile.protection==='windows-dpapi-current-user'?'device-token.dpapi':'device-token.json');
 return {profile:{...profile,origin},directory:root,async fetcher(){const info=await lstat(secretFile);if(profile.protection==='posix-mode-600'&&(info.mode&0o077||process.getuid&&info.uid!==process.getuid()))throw fail('接入凭据权限须仅限当前用户');let secret=await regular(secretFile,128*1024);if(profile.protection==='windows-dpapi-current-user'){if(process.platform!=='win32')throw fail('Windows加密凭据不能跨电脑复制，请重新配对');secret=await protect('unprotect',secret);}let value;try{value=JSON.parse(secret.toString('utf8'));}catch{throw fail('接入凭据格式无效');}if(typeof value.token!=='string'||!value.token||value.token.length>512||/[\r\n]/.test(value.token))throw fail('接入凭据无效');return createPairedFetch({origin,ca,token:value.token});}};
}
export async function connectClient({url,caFile,code,deviceName,directory=defaultProfileDirectory(),transportFactory=createPairedFetch,protector=protect}){
 const origin=lanOrigin(url),ca=await regular(resolve(caFile)),certificate=new X509Certificate(ca),name=String(deviceName||'Codex创作电脑').trim();if(!name||name.length>80||typeof code!=='string'||!code||code.length>128)throw fail('请提供本机接入面板显示的配对码及设备名');
 const root=resolve(directory);try{const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw fail('接入目录不能是链接');const existing=await readClientProfile(root);if(existing)throw fail('当前已有接入，请先 connection disconnect 或另选 --profile 目录，原配置已保留');}catch(error){if(error.code!=='ENOENT')throw error;}
 const response=await transportFactory({origin,ca})(origin+'/access/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code,deviceName:name}),redirect:'error'});let result;try{const parts=[];let size=0;for await(const part of response.body){size+=part.length;if(size>65536)throw fail('配对回执过大');parts.push(part);}result=JSON.parse(Buffer.concat(parts));}catch{throw fail('接入服务未返回有效配对回执');}if(!response.ok)throw fail('配对未完成，请核对临时码和设备状态',response.status);
 const device=result.device||{},token=result.token,deviceId=device.id||result.deviceId;if(typeof token!=='string'||!token||token.length>512||/[\r\n]/.test(token)||!/^[a-f0-9-]{36}$/i.test(deviceId||'')||device.name!==undefined&&(typeof device.name!=='string'||device.name.length>100))throw fail('配对回执缺少设备凭据');
 await mkdir(root,{recursive:true,mode:0o700});if((await lstat(root)).isSymbolicLink())throw fail('接入目录不能是链接');if(process.platform!=='win32')await chmod(root,0o700);
 const protection=process.platform==='win32'?'windows-dpapi-current-user':'posix-mode-600',secret=Buffer.from(JSON.stringify({token}));
 await atomic(join(root,protection==='windows-dpapi-current-user'?'device-token.dpapi':'device-token.json'),protection==='windows-dpapi-current-user'?await protector('protect',secret):secret);
 await atomic(join(root,'ca.crt'),ca);const profile={version:1,origin,deviceId:device.id||result.deviceId,name:device.name||name,caSha256:createHash('sha256').update(certificate.raw).digest('hex'),protection,connectedAt:new Date().toISOString()};await atomic(join(root,'connection.json'),JSON.stringify(profile,null,2));return {connected:true,...profile};
}
export async function disconnectClient(directory=defaultProfileDirectory()){
 const connected=await readClientProfile(directory);if(!connected)return {connected:false,localOnly:true};for(const name of ['connection.json','device-token.dpapi','device-token.json','ca.crt'])await unlink(join(connected.directory,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});return {connected:false,localOnly:true,serverRevoked:false,message:'已移除本机接入凭据；服务端设备请在中央工作台吊销。'};
}
