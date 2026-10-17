import http from 'node:http';
import {open,readFile} from 'node:fs/promises';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';

const AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN='https://oauth2.googleapis.com/token';
const API='https://www.googleapis.com/youtube/v3';
const UPLOAD='https://www.googleapis.com/upload/youtube/v3';
export const YOUTUBE_SCOPES=['https://www.googleapis.com/auth/youtube.upload','https://www.googleapis.com/auth/youtube.readonly'];
const CHUNK=4*1024*1024;
const BLOCKED_BROWSER_PORTS=new Set([1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
const idPattern=/^[A-Za-z0-9_-]{6,64}$/;
const fail=(message,status=400,extra={})=>Object.assign(new Error(message),{status,...extra});
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const safeReason=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(value)?value:null;
const now=()=>new Date().toISOString();
function configValues(config){
 if(!config||typeof config.clientId!=='string'||!/^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/.test(config.clientId)||config.clientId.length>300)throw fail('请先在账号接入中配置 Google Desktop 应用的 Client ID。',409);
 if(config.clientSecret!==undefined&&(typeof config.clientSecret!=='string'||config.clientSecret.length>1000))throw fail('Google 应用配置格式无效。');
 return config;
}
async function jsonBody(response){
 const length=Number(response.headers.get('content-length'));if(length>1024*1024)throw fail('Google 返回内容超过预期范围。',502);
 let body='',bytes=0;const decoder=new TextDecoder();for await(const chunk of response.body||[]){bytes+=chunk.length;if(bytes>1024*1024)throw fail('Google 返回内容超过预期范围。',502);body+=decoder.decode(chunk,{stream:true});}body+=decoder.decode();
 if(!body)return {};try{return JSON.parse(body);}catch{throw fail('Google 未返回有效接口结果。',502);}
}
async function requireJson(response){
 const value=await jsonBody(response);if(!response.ok){const reason=safeReason(value.error?.errors?.[0]?.reason)||safeReason(value.error?.status)||safeReason(value.error);throw fail(`YouTube 请求未完成（HTTP ${response.status}${reason?' · '+reason:''}）。`,response.status===401?401:502,{providerCode:reason});}return value;
}
function sameState(left,right){if(typeof right!=='string')return false;const expected=Buffer.from(left),actual=Buffer.from(right);return expected.length===actual.length&&timingSafeEqual(expected,actual);}
function scopes(value){return Array.isArray(value)?value.filter(item=>typeof item==='string'):typeof value==='string'?value.split(/\s+/).filter(Boolean):[];}
function publicAccount(tokens){return tokens?.channelId?{id:'youtube:'+tokens.channelId,name:tokens.name||tokens.channelId,channelId:tokens.channelId,scopes:scopes(tokens.scopes),expiresAt:tokens.expiresAt||null}:null;}
function resultFromVideo(video,requestedPrivacy){
 if(!idPattern.test(video?.id||''))throw fail('YouTube 没有返回可核对的视频编号。',502,{outcomeUnknown:true});
 return {remoteId:video.id,url:'https://www.youtube.com/watch?v='+encodeURIComponent(video.id),status:'uploaded',privacy:video.status?.privacyStatus||requestedPrivacy,processingStatus:video.processingDetails?.processingStatus||'unknown',submittedAt:now()};
}
export function youtubeMetadata(metadata={}){
 if(typeof metadata.title!=='string'||!metadata.title.trim()||[...metadata.title].length>100||/[<>]/.test(metadata.title))throw fail('YouTube 标题需为 1–100 字，且不能包含尖括号。');
 if(typeof metadata.description!=='string'||Buffer.byteLength(metadata.description,'utf8')>5000||/[<>]/.test(metadata.description))throw fail('YouTube 简介最多 5000 字节，且不能包含尖括号。');
 const tags=Array.isArray(metadata.tags)?metadata.tags:[];
 if(tags.some(tag=>typeof tag!=='string'||!tag.trim()||/[<>]/.test(tag))||tags.map(tag=>tag.trim().length+(/\s/.test(tag.trim())?2:0)).reduce((sum,length)=>sum+length,Math.max(0,tags.length-1))>500)throw fail('YouTube 标签格式无效或合计过长。');
 const privacy=metadata.privacy||'private';if(!['private','unlisted','public'].includes(privacy))throw fail('YouTube 可见性无效。');
 const category=String(metadata.categoryId||'1');if(!/^\d{1,3}$/.test(category))throw fail('YouTube 分区编号无效。');
 if(typeof metadata.madeForKids!=='boolean'||typeof metadata.syntheticMedia!=='boolean')throw fail('请明确选择儿童内容及合成内容选项。');
 return {snippet:{title:metadata.title.trim(),description:metadata.description,...(tags.length?{tags:tags.map(tag=>tag.trim())}:{}),categoryId:category,defaultLanguage:'zh'},status:{privacyStatus:privacy,selfDeclaredMadeForKids:metadata.madeForKids,containsSyntheticMedia:metadata.syntheticMedia}};
}
export function validateGoogleUploadUrl(value){
 let url;try{url=new URL(value);}catch{throw fail('Google 上传会话地址无效。',502);}
 if(url.protocol!=='https:'||url.hostname!=='www.googleapis.com'||url.port||url.username||url.password||url.hash||url.pathname!=='/upload/youtube/v3/videos'||!url.searchParams.get('upload_id'))throw fail('Google 上传会话指向非预期服务，已停止。',502);
 return url.href;
}
export function youtubeAckOffset(header,total,sentEnd){
 if(!header)return 0;const match=/^bytes=0-(\d+)$/.exec(header);if(!match)throw fail('YouTube 上传确认范围无效。',502);
 const next=Number(match[1])+1;if(!Number.isSafeInteger(next)||next<0||next>total||next>sentEnd)throw fail('YouTube 上传确认超出已发送范围。',502);return next;
}
function defaultOpenBrowser(url){
 if(process.platform!=='win32')return false;
 return new Promise(resolve=>{const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,detached:true,stdio:'ignore',shell:false});child.once('error',()=>resolve(false));child.once('spawn',()=>{child.unref();resolve(true);});});
}
async function listenLoopback(server){
 for(let attempt=0;attempt<16;attempt++){
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const port=server.address().port;if(port>=1024&&!BLOCKED_BROWSER_PORTS.has(port))return;
  await new Promise(resolve=>server.close(resolve));
 }
 throw fail('暂时无法分配可供浏览器使用的本机授权端口，请重试。',503);
}
/** Google desktop OAuth and official uploads only. No browser cookies or API keys leave local vault. */
export function createYouTubePublisher({fetcher=fetch,openSystemBrowser=defaultOpenBrowser,oauthTtlMs=10*60*1000,chunkSize=CHUNK,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 if(!Number.isInteger(chunkSize)||chunkSize<256*1024||chunkSize%(256*1024)!==0)throw new Error('YouTube chunk size must be a multiple of 256 KiB');
 const pending=new Map(),refreshes=new WeakMap(),epochs=new WeakMap();
 const epoch=vault=>epochs.get(vault)||0;
 const advance=vault=>{const value=epoch(vault)+1;epochs.set(vault,value);return value;};
 async function request(url,options={}){try{return await fetcher(url,{...options,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});}catch{throw fail('无法连接 YouTube 官方服务，请检查本机网络后重试。',502);}}
 async function tokenCall(body,signal){return requireJson(await request(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString(),signal}));}
 async function retryAfter(response){const raw=response.headers.get('retry-after');if(!raw)return;const milliseconds=/^\d+$/.test(raw)?Number(raw)*1000:Date.parse(raw)-Date.now();if(!Number.isFinite(milliseconds)||milliseconds<=0)return;if(milliseconds>120000)throw fail('YouTube 要求稍后继续上传，请先到官方后台核对本次会话。',503,{outcomeUnknown:true});await delay(milliseconds);}
 async function channelFor(accessToken,signal){
  const value=await requireJson(await request(API+'/channels?part=snippet&mine=true',{headers:{Authorization:'Bearer '+accessToken},signal}));const channel=value.items?.[0];
  if(!idPattern.test(channel?.id||''))throw fail('此 Google 账号尚未提供可用的 YouTube 频道，请在 YouTube 完成频道设置。',409);
  return {channelId:channel.id,name:typeof channel.snippet?.title==='string'?channel.snippet.title:channel.id};
 }
 async function getState({vault}){
  const config=await vault.get('youtube','config'),tokens=await vault.get('youtube','tokens');let configured=false;try{configValues(config);configured=true;}catch{}
  return {configured,connected:Boolean(configured&&tokens?.refreshToken&&tokens?.channelId),account:publicAccount(tokens),authorizing:pending.has(vault),scopes:YOUTUBE_SCOPES};
 }
 async function freshTokens(vault){
  if(refreshes.has(vault))return refreshes.get(vault);
  const startedEpoch=epoch(vault),checkEpoch=()=>{if(epoch(vault)!==startedEpoch)throw fail('频道授权正在改变，请完成后重试。',409);};
  const operation=(async()=>{const config=configValues(await vault.get('youtube','config')),tokens=await vault.get('youtube','tokens');checkEpoch();
   if(!tokens?.refreshToken||!tokens.channelId)throw fail('请先在账号接入中授权 YouTube 频道。',409);
   if(tokens.accessToken&&Date.parse(tokens.expiresAt)>Date.now()+60000)return tokens;
   const value=await tokenCall({client_id:config.clientId,...(config.clientSecret?{client_secret:config.clientSecret}:{}),refresh_token:tokens.refreshToken,grant_type:'refresh_token'});
   checkEpoch();if(typeof value.access_token!=='string'||!finite(value.expires_in)||value.expires_in<=0)throw fail('Google 令牌刷新结果无效，请重新授权。',502);
   const result={...tokens,accessToken:value.access_token,refreshToken:value.refresh_token||tokens.refreshToken,expiresAt:new Date(Date.now()+value.expires_in*1000).toISOString(),scopes:value.scope?scopes(value.scope):tokens.scopes};
   await vault.set('youtube','tokens',result);checkEpoch();return result;
  })();refreshes.set(vault,operation);try{return await operation;}finally{refreshes.delete(vault);}
 }
 function stopAuthorization(vault,expected){const item=pending.get(vault);if(item&&(!expected||item===expected)){item.controller.abort();clearTimeout(item.timer);item.server.close();item.server.closeIdleConnections();pending.delete(vault);}}
 async function connect({vault}){
  const currentEpoch=advance(vault);stopAuthorization(vault);const config=configValues(await vault.get('youtube','config'));if(epoch(vault)!==currentEpoch)throw fail('账号连接操作已取消。',409);
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');let redirectUri,used=false,session;
  const checkCurrent=()=>{if(pending.get(vault)!==session||session.controller.signal.aborted||epoch(vault)!==currentEpoch)throw fail('此次授权已取消，请重新连接。',409);};
  const respond=(res,status,message)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>YouTube 账号授权</title><body><h1>YouTube 账号授权</h1><p>'+message+'</p><p>请返回漫剧工作台的账号接入页面。</p></body></html>');};
  const server=http.createServer(async(req,res)=>{
   const host='127.0.0.1:'+server.address()?.port;if(req.headers.host!==host){respond(res,403,'此授权回调仅允许本机访问。');return;}
   const url=new URL(req.url,'http://'+host);if(req.method!=='GET'||url.pathname!=='/oauth2callback'){respond(res,404,'未找到授权回调。');return;}
   if(used||!pending.has(vault)||url.searchParams.getAll('state').length!==1||!sameState(state,url.searchParams.get('state'))){respond(res,400,'授权已过期或来源校验失败，请在工作台重新发起。');return;}
   if(url.searchParams.getAll('code').length>1||url.searchParams.getAll('error').length>1){respond(res,400,'授权回调参数无效。');return;}
   used=true;
   try{
    if(url.searchParams.has('error')){respond(res,400,'你未授予本次访问权限，工作台没有连接此账号。');return;}
    const code=url.searchParams.get('code');if(!code||code.length>10000)throw fail('授权响应没有有效凭据。');
    checkCurrent();const value=await tokenCall({client_id:config.clientId,...(config.clientSecret?{client_secret:config.clientSecret}:{}),code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:redirectUri},session.controller.signal);checkCurrent();
    const granted=value.scope?scopes(value.scope):YOUTUBE_SCOPES;if(!YOUTUBE_SCOPES.every(scope=>granted.includes(scope)))throw fail('本次未完整授予频道读取与视频上传权限。');
    if(typeof value.access_token!=='string'||typeof value.refresh_token!=='string'||!finite(value.expires_in)||value.expires_in<=0)throw fail('Google 未返回可持续使用的授权，请重新连接。');
    const channel=await channelFor(value.access_token,session.controller.signal);checkCurrent();await vault.set('youtube','tokens',{...channel,accessToken:value.access_token,refreshToken:value.refresh_token,expiresAt:new Date(Date.now()+value.expires_in*1000).toISOString(),scopes:granted,connectedAt:now()});checkCurrent();
    respond(res,200,'授权完成。工作台已连接该频道，尚未上传或发布任何内容。');
   }catch{respond(res,400,'此次授权未完成，请检查账号权限或网络后重新连接。');}
   finally{stopAuthorization(vault,session);}
  });
  await listenLoopback(server);
  if(epoch(vault)!==currentEpoch){server.close();throw fail('账号连接操作已取消。',409);}
  redirectUri='http://127.0.0.1:'+server.address().port+'/oauth2callback';const expiresAt=new Date(Date.now()+oauthTtlMs).toISOString(),timer=setTimeout(()=>stopAuthorization(vault,session),oauthTtlMs);timer.unref?.();session={server,timer,expiresAt,controller:new AbortController()};pending.set(vault,session);
  const url=new URL(AUTH);for(const [key,value]of Object.entries({client_id:config.clientId,redirect_uri:redirectUri,response_type:'code',scope:YOUTUBE_SCOPES.join(' '),state,code_challenge:challenge,code_challenge_method:'S256',access_type:'offline',prompt:'consent',include_granted_scopes:'true'}))url.searchParams.set(key,value);
  let opened=false;try{opened=await openSystemBrowser(url.href);}catch{}
  return {authorizationUrl:url.href,expiresAt,systemBrowserRequired:true,opened};
 }
 async function disconnect({vault}){advance(vault);stopAuthorization(vault);await vault.remove('youtube','tokens');return {disconnected:true,remoteGrantRevoked:false};}
 async function refresh({vault,remoteId}){
  if(!idPattern.test(remoteId||''))throw fail('YouTube 视频编号无效。');const token=await freshTokens(vault),value=await requireJson(await request(API+'/videos?part=status,processingDetails&id='+encodeURIComponent(remoteId),{headers:{Authorization:'Bearer '+token.accessToken}})),video=value.items?.find(item=>item.id===remoteId);
  if(!video)return {remoteId,status:'unknown',reason:'频道接口没有返回此视频，可能仍在处理或已被删除。',checkedAt:now()};
  const status=video.status||{},processing=video.processingDetails?.processingStatus||'unknown';
  return {remoteId,url:'https://www.youtube.com/watch?v='+remoteId,status:['rejected','failed','deleted'].includes(status.uploadStatus)||['failed','terminated'].includes(processing)?'rejected':status.uploadStatus==='processed'&&processing==='succeeded'&&status.privacyStatus==='public'?'published':status.uploadStatus==='processed'&&processing==='succeeded'?'uploaded':'processing',privacy:status.privacyStatus||null,processingStatus:processing,rejectionReason:safeReason(status.rejectionReason)||safeReason(status.failureReason),checkedAt:now()};
 }
 async function publishInternal({vault,draft,source,cover,onProgress=async()=>{}}){
  const metadata=youtubeMetadata(draft.metadata),token=await freshTokens(vault);
  if(draft.accountId&&draft.accountId!=='youtube:'+token.channelId)throw fail('当前连接的频道与草稿选择的账号不一致。',409);
  if(!source||typeof source.path!=='string'||!Number.isSafeInteger(source.bytes)||source.bytes<=0||!/^[0-9a-f]{64}$/i.test(source.sha256||'')||source.mimeType!=='video/mp4')throw fail('发布源文件快照无效。');
  const handle=await open(source.path,'r');let remoteResult=null,sessionUrl,offset=0,finalAttempted=false;
  try{
   const initial=await handle.stat();if(!initial.isFile()||initial.size!==source.bytes)throw fail('成片文件已改变，请重新准备发布包。',409);
   const hash=createHash('sha256');for await(const chunk of handle.createReadStream({start:0,autoClose:false}))hash.update(chunk);
   if(hash.digest('hex')!==source.sha256)throw fail('成片指纹已改变，请重新准备发布包。',409);
   const unchanged=async()=>{const value=await handle.stat();if(value.size!==initial.size||value.mtimeMs!==initial.mtimeMs)throw fail('上传过程中成片发生改变，已停止。',409,{outcomeUnknown:finalAttempted});};
   await unchanged();await onProgress({phase:'starting',bytesSent:0,totalBytes:source.bytes});
   const response=await request(UPLOAD+'/videos?uploadType=resumable&part=snippet,status',{method:'POST',headers:{Authorization:'Bearer '+token.accessToken,'Content-Type':'application/json; charset=utf-8','X-Upload-Content-Type':source.mimeType,'X-Upload-Content-Length':String(source.bytes)},body:JSON.stringify(metadata)});
   if(!response.ok)await requireJson(response);sessionUrl=validateGoogleUploadUrl(response.headers.get('location'));await response.body?.cancel();
   const recover=async(sentEnd)=>{
    const check=await request(sessionUrl,{method:'PUT',headers:{Authorization:'Bearer '+token.accessToken,'Content-Length':'0','Content-Range':'bytes */'+source.bytes},body:new Uint8Array()});
    if(check.status===308){const next=youtubeAckOffset(check.headers.get('range'),source.bytes,sentEnd);await check.body?.cancel();await retryAfter(check);return {offset:next};}
    if(check.ok)return {result:resultFromVideo(await requireJson(check),metadata.status.privacyStatus)};
    await check.body?.cancel();throw fail('无法确认本次上传结果，请先检查 YouTube Studio，避免重复上传。',502,{outcomeUnknown:true});
   };
   let stalled=0;
   while(offset<source.bytes){
    await unchanged();const end=Math.min(offset+chunkSize,source.bytes),chunk=Buffer.allocUnsafe(end-offset),read=await handle.read(chunk,0,chunk.length,offset);if(read.bytesRead!==chunk.length)throw fail('无法完整读取所选成片。',409);
    finalAttempted=end===source.bytes;let result;
    try{
     const uploaded=await request(sessionUrl,{method:'PUT',headers:{Authorization:'Bearer '+token.accessToken,'Content-Type':source.mimeType,'Content-Length':String(chunk.length),'Content-Range':`bytes ${offset}-${end-1}/${source.bytes}`},body:chunk});
     if(uploaded.status===308){result={offset:youtubeAckOffset(uploaded.headers.get('range'),source.bytes,end)};await uploaded.body?.cancel();await retryAfter(uploaded);}
     else if(uploaded.ok)result={result:resultFromVideo(await requireJson(uploaded),metadata.status.privacyStatus)};
     else if(uploaded.status>=500){await uploaded.body?.cancel();result=await recover(end);}
     else await requireJson(uploaded);
    }catch(error){if(error.status===401||error.status===409||error.providerCode)throw error;try{result=await recover(end);}catch{throw fail('本次上传结果尚未确认，请先检查 YouTube Studio，再决定后续操作。',502,{outcomeUnknown:true});}}
    if(result?.result){remoteResult=result.result;await onProgress({phase:'uploaded',bytesSent:source.bytes,totalBytes:source.bytes,...remoteResult});break;}
    if(!result||result.offset<offset)throw fail('YouTube 上传确认倒退，已停止。',502,{outcomeUnknown:finalAttempted});
    if(result.offset===offset){if(++stalled>2)throw fail('YouTube 连续未确认上传进度，已停止。',502,{outcomeUnknown:finalAttempted});}else stalled=0;
    offset=result.offset;await onProgress({phase:'uploading',bytesSent:offset,totalBytes:source.bytes});
   }
   if(!remoteResult){const recovered=await recover(source.bytes);if(!recovered.result)throw fail('上传字节已传输，但平台没有返回视频编号；请检查官方后台。',502,{outcomeUnknown:true});remoteResult=recovered.result;await onProgress({phase:'uploaded',bytesSent:source.bytes,totalBytes:source.bytes,...remoteResult});}
   const warnings=[];
   if(cover){
    try{
     if(!['image/png','image/jpeg'].includes(cover.mimeType)||!Number.isSafeInteger(cover.bytes)||cover.bytes<1||cover.bytes>2*1024*1024||!/^[0-9a-f]{64}$/i.test(cover.sha256||''))throw fail('封面需为 2MB 内的 PNG/JPEG，视频已上传，封面未更换。');
     const bytes=await readFile(cover.path);if(bytes.length!==cover.bytes||createHash('sha256').update(bytes).digest('hex')!==cover.sha256)throw fail('封面已改变，视频已上传，封面未更换。');
     await requireJson(await request(UPLOAD+'/thumbnails/set?videoId='+encodeURIComponent(remoteResult.remoteId),{method:'POST',headers:{Authorization:'Bearer '+token.accessToken,'Content-Type':cover.mimeType,'Content-Length':String(bytes.length)},body:bytes}));
    }catch{warnings.push('视频已上传；自定义封面未设置成功，请在 YouTube Studio 中检查，勿重复上传视频。');}
   }
   return {...remoteResult,warnings,account:publicAccount(token)};
  }catch(error){if(remoteResult)error.remoteResult=remoteResult;if(error.outcomeUnknown===undefined)error.outcomeUnknown=false;throw error;}finally{await handle.close();}
 }
 async function publish(options){try{return await publishInternal(options);}catch(error){if(error.outcomeUnknown===undefined)error.outcomeUnknown=false;throw error;}}
 return {getState,connect,disconnect,publish,refresh,getActiveAuthorizations:()=>pending.size,close:()=>{for(const vault of pending.keys()){advance(vault);stopAuthorization(vault);}}};
}
