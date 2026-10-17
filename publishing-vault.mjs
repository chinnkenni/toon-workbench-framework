import {readFile,writeFile,mkdir,rename,realpath,lstat,unlink} from 'node:fs/promises';
import {join,relative,isAbsolute,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const queues=new Map();
const fail=message=>Object.assign(new Error(message),{status:400});
function inside(root,file){const p=relative(root,file);if(!p||p.startsWith('..')||isAbsolute(p))throw fail('发布凭据存储路径无效');}
function windowsProtection(operation,bytes){
 if(process.platform!=='win32')throw Object.assign(new Error('发布凭据仅支持 Windows 当前用户的 DPAPI 加密存储'),{status:503});
 const script="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$b=[Convert]::FromBase64String($v.data);$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser;if($v.operation -eq 'protect'){$r=[Security.Cryptography.ProtectedData]::Protect($b,$null,$scope)}else{$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,$scope)};[Console]::Out.Write([Convert]::ToBase64String($r))";
 return new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});let result='',size=0;const timer=setTimeout(()=>{child.kill();reject(new Error('发布凭据加密操作超时'));},15000);child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){child.kill();return;}result+=chunk;});child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(new Error('无法启动 Windows 发布凭据加密服务'));});child.on('close',code=>{clearTimeout(timer);if(code!==0||size>2*1024*1024||!result.trim())reject(new Error('Windows 当前用户无法加密或解密发布凭据'));else resolve(Buffer.from(result.trim(),'base64'));});child.stdin.end(JSON.stringify({operation,data:Buffer.from(bytes).toString('base64')}));});
}
/** Secrets never enter an API response or a plaintext JSON settings file. */
export function createPublishingVault({dataDir,protector={protect:bytes=>windowsProtection('protect',bytes),unprotect:bytes=>windowsProtection('unprotect',bytes)}}){
 const vaultKey=(platform,kind)=>kind===undefined?platform:platform+'-'+kind;
 async function directory(){const root=await realpath(dataDir),dir=join(root,'publishing','vault');let ancestor=dir;for(;;){try{const resolved=await realpath(ancestor);if(resolved!==root)inside(root,resolved);break;}catch(error){if(error.code!=='ENOENT')throw error;ancestor=dirname(ancestor);}}await mkdir(dir,{recursive:true});inside(root,await realpath(dir));if((await lstat(dir)).isSymbolicLink())throw fail('发布凭据目录不能是链接');return dir;}
 function key(value){if(typeof value!=='string'||!/^[a-z][a-z0-9-]{0,90}$/.test(value))throw fail('发布凭据编号无效');return value;}
 async function fileFor(value){value=key(value);const dir=await directory(),file=join(dir,value+'.dpapi');try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||info.size>2*1024*1024)throw fail('发布凭据文件无效');inside(dir,await realpath(file));}catch(error){if(error.code!=='ENOENT')throw error;}return file;}
 function serial(operation){const previous=queues.get(dataDir)||Promise.resolve(),next=previous.catch(()=>{}).then(operation);queues.set(dataDir,next);return next.finally(()=>{if(queues.get(dataDir)===next)queues.delete(dataDir);});}
 return {
  async get(value,kind){value=vaultKey(value,kind);const pending=queues.get(dataDir);if(pending)await pending.catch(()=>{});const file=await fileFor(value);let content;try{content=await readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}try{return JSON.parse((await protector.unprotect(content)).toString('utf8'));}catch{throw Object.assign(new Error('无法读取当前 Windows 用户的发布授权，请重新连接账号'),{status:409});}},
  put(value,secret){return serial(async()=>{const file=await fileFor(value),raw=Buffer.from(JSON.stringify(secret));if(raw.length>512*1024)throw fail('发布凭据过大');const encrypted=await protector.protect(raw),temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,encrypted,{flag:'wx',mode:0o600});await rename(temporary,file);return {configured:true,protection:'windows-dpapi-current-user'};});},
  set(platform,kind,value){return this.put(vaultKey(platform,kind),value);},
  remove(value,kind){value=vaultKey(value,kind);return serial(async()=>{const file=await fileFor(value);try{await unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}return {configured:false};});},
  async has(value,kind){return (await this.get(value,kind))!==null;},
  async status(platform){const config=await this.get(platform,'config'),tokens=await this.get(platform,'tokens');return {configured:Boolean(config?.clientId),connected:Boolean(tokens?.accessToken||tokens?.refreshToken),protection:'windows-dpapi-current-user',name:tokens?.name??null,scopes:tokens?.scopes??[],expiresAt:tokens?.expiresAt??null};},
 };
}
