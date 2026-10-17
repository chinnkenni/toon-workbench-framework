import {mkdir,readFile,writeFile,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';

const instances=new Map(),HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9-]{36}$/i;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=(kind,value)=>createHash('sha256').update(kind+'\0'+value).digest('hex');
const matches=(left,right)=>HASH.test(left||'')&&HASH.test(right||'')&&timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
const metadata=device=>({id:device.id,name:device.name,createdAt:device.createdAt,lastSeenAt:device.lastSeenAt??null,revokedAt:device.revokedAt??null});
async function ordinary(file,{missing=false}={}){try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile())throw fail('局域网接入记录不能是文件链接或目录',503);if(info.size>2*1024*1024)throw fail('局域网接入记录超过限制',503);return info;}catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}}
function validState(value){
 if(!value||value.schemaVersion!==1||!Array.isArray(value.devices)||value.devices.length>1000||!Array.isArray(value.sessions)||value.sessions.length>512)throw fail('局域网接入记录格式无效',503);
 const ids=new Set();for(const device of value.devices){if(!UUID.test(device.id||'')||ids.has(device.id)||typeof device.name!=='string'||device.name.length>100||!HASH.test(device.tokenHash||'')||!Number.isFinite(Date.parse(device.createdAt)))throw fail('局域网设备记录无效',503);ids.add(device.id);}
 for(const session of value.sessions)if(!HASH.test(session.hash||'')||!ids.has(session.deviceId)||!Number.isFinite(Date.parse(session.expiresAt)))throw fail('局域网会话记录无效',503);
 if(value.pair&&(!HASH.test(value.pair.hash||'')||!Number.isFinite(Date.parse(value.pair.expiresAt))))throw fail('局域网配对记录无效',503);
 return value;
}
/** One gateway owns this hashed credential catalog; no token is stored in plaintext. */
export async function createLanAccess({dataDir,clock=()=>Date.now(),pairTtlMs=300000,sessionTtlMs=12*60*60*1000}={}){
 const key=resolve(dataDir);if(instances.has(key))return instances.get(key);
 const pending=(async()=>{
  await mkdir(key,{recursive:true});if((await lstat(key)).isSymbolicLink())throw fail('局域网接入数据根不能是目录链接',503);const root=await realpath(key),directory=join(root,'lan');await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw fail('局域网接入目录不能是链接',503);
  const file=join(directory,'access.json');let state={schemaVersion:1,devices:[],sessions:[],pair:null};if(await ordinary(file,{missing:true}))try{state=validState(JSON.parse(await readFile(file,'utf8')));}catch(error){throw error.status?error:fail('局域网接入记录无法解析，未覆盖历史',503);}
  let writes=Promise.resolve();const failures=new Map();
  async function persist(){await ordinary(file,{missing:true});if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw fail('局域网接入目录发生变化',503);const temp=join(directory,'.access-'+randomUUID()+'.tmp');try{await writeFile(temp,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}}
  function serial(fn){const promise=writes.then(async()=>{const previous=structuredClone(state);try{return await fn();}catch(error){state=previous;throw error;}});writes=promise.catch(()=>{});return promise;}
  function stamp(){return new Date(clock()).toISOString();}
  function limit(peer){const at=clock();for(const [key,value]of failures)if(value.until<=at)failures.delete(key);const entry=failures.get(peer);if(entry&&entry.count>=8)throw fail('配对尝试过多，请稍后再试',429);if(!entry&&failures.size>=1024)throw fail('配对服务繁忙，请稍后再试',429);}
  function failed(peer){const entry=failures.get(peer)||{count:0,until:clock()+10*60*1000};entry.count++;failures.set(peer,entry);}
  async function authenticate(value,kind){
   if(typeof value!=='string'||value.length<32||value.length>160)return null;
   return serial(async()=>{
    const hash=digest(kind,value);let device;
    if(kind==='token')device=state.devices.find(entry=>!entry.revokedAt&&matches(entry.tokenHash,hash));
    else{const session=state.sessions.find(entry=>Date.parse(entry.expiresAt)>clock()&&matches(entry.hash,hash));device=session&&state.devices.find(entry=>entry.id===session.deviceId&&!entry.revokedAt);}
    if(!device)return null;
    if(!device.lastSeenAt||clock()-Date.parse(device.lastSeenAt)>=60000){device.lastSeenAt=stamp();await persist();}
    return metadata(device);
   });
  }
  return {
   async safeState(){await writes;return {pairing:{active:Boolean(state.pair&&Date.parse(state.pair.expiresAt)>clock()),expiresAt:state.pair&&Date.parse(state.pair.expiresAt)>clock()?state.pair.expiresAt:null},devices:state.devices.map(metadata),limits:{pairTtlSeconds:Math.floor(pairTtlMs/1000),sessionTtlSeconds:Math.floor(sessionTtlMs/1000)}};},
   createPairCode:()=>serial(async()=>{const raw=randomBytes(8).toString('hex').toUpperCase(),code=raw.match(/.{4}/g).join('-'),expiresAt=new Date(clock()+pairTtlMs).toISOString();state.pair={hash:digest('pair',raw),createdAt:stamp(),expiresAt};await persist();return {code,expiresAt};}),
   consumePairCode:({code,deviceName,peer='unknown'})=>serial(async()=>{
    limit(peer);const canonical=typeof code==='string'?code.replace(/[-\s]/g,'').toUpperCase():'';
    if(!/^[A-F0-9]{16}$/.test(canonical)||!state.pair||Date.parse(state.pair.expiresAt)<=clock()||!matches(state.pair.hash,digest('pair',canonical))){failed(peer);throw fail('配对码无效、已使用或已过期',401);}
    if(typeof deviceName!=='string'||!deviceName.trim()||deviceName.trim().length>100||/[\u0000-\u001f\u007f]/.test(deviceName))throw fail('请填写1–100字设备名称');
    if(state.devices.filter(device=>!device.revokedAt).length>=128||state.devices.length>=1000)throw fail('设备数量达到限制，请先吊销不再使用的设备',409);
    const token='toon_lan_'+randomBytes(32).toString('base64url'),device={id:randomUUID(),name:deviceName.trim(),tokenHash:digest('token',token),createdAt:stamp(),lastSeenAt:null,revokedAt:null};state.devices.push(device);state.pair=null;await persist();failures.delete(peer);return {token,device:metadata(device)};
   }),
   authenticateToken:token=>authenticate(token,'token'),authenticateSession:session=>authenticate(session,'session'),
   createSession:token=>serial(async()=>{
    if(typeof token!=='string'||token.length>160)throw fail('设备凭据无效',401);const device=state.devices.find(entry=>!entry.revokedAt&&matches(entry.tokenHash,digest('token',token)));if(!device)throw fail('设备凭据无效或已吊销',401);
    state.sessions=state.sessions.filter(entry=>Date.parse(entry.expiresAt)>clock());const own=state.sessions.filter(entry=>entry.deviceId===device.id);if(own.length>=8){const oldest=own[0];state.sessions=state.sessions.filter(entry=>entry!==oldest);}if(state.sessions.length>=512)throw fail('浏览器会话达到限制',429);
    const session=randomBytes(32).toString('base64url'),expiresAt=new Date(clock()+sessionTtlMs).toISOString();state.sessions.push({hash:digest('session',session),deviceId:device.id,createdAt:stamp(),expiresAt});await persist();return {session,expiresAt,maxAge:Math.floor(sessionTtlMs/1000),device:metadata(device)};
   }),
   removeSession:session=>serial(async()=>{if(typeof session==='string'&&session.length<=160){const hash=digest('session',session),remaining=state.sessions.filter(entry=>!matches(entry.hash,hash));if(remaining.length!==state.sessions.length){state.sessions=remaining;await persist();}}}),
   revoke:id=>serial(async()=>{if(!UUID.test(id||''))throw fail('设备编号无效');const device=state.devices.find(entry=>entry.id===id);if(!device)throw fail('设备不存在',404);device.revokedAt??=stamp();state.sessions=state.sessions.filter(entry=>entry.deviceId!==id);await persist();return {revoked:true,device:metadata(device)};}),
  };
 })();instances.set(key,pending);try{return await pending;}catch(error){instances.delete(key);throw error;}
}
