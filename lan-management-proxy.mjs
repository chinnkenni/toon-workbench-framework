import http from 'node:http';
import {pipeline} from 'node:stream/promises';

/** Called only after the studio's localhost Host/Origin checks. */
export async function handleLanManagement(req,res,url,{port=18996}={}){
 if(!url.pathname.startsWith('/api/lan/'))return false;
 if(!Number.isInteger(port)||port<1||port>65535)throw Object.assign(new Error('接入管理端口无效'),{status:503});
 const read=['GET','HEAD'].includes(req.method),download=read&&['/api/lan/ca.crt','/api/lan/client.zip'].includes(url.pathname);
 const allowed=read&&url.pathname==='/api/lan/state'||download||req.method==='POST'&&(url.pathname==='/api/lan/pair-code'||/^\/api\/lan\/devices\/[a-f0-9-]{36}\/revoke$/.test(url.pathname));
 if(!allowed||url.search)throw Object.assign(new Error('未找到接入管理接口'),{status:404});
 const parts=[];let bytes=0;if(!read)for await(const part of req){bytes+=part.length;if(bytes>8192)throw Object.assign(new Error('接入管理请求过大'),{status:413});parts.push(part);}
 const content=Buffer.concat(parts),path=download?url.pathname.slice('/api/lan'.length):url.pathname;
 await new Promise((done,reject)=>{
  const upstream=http.request({hostname:'127.0.0.1',port,path,method:req.method,headers:{Host:`127.0.0.1:${port}`,...(!read?{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json','Content-Length':content.length}:{})}},response=>{
   for(const name of ['content-type','content-length','content-disposition','cache-control'])if(response.headers[name])res.setHeader(name,response.headers[name]);
   res.writeHead(response.statusCode);pipeline(response,res).then(done,reject);
  });upstream.setTimeout(30000,()=>upstream.destroy());upstream.once('error',()=>reject(Object.assign(new Error('局域网接入服务尚未就绪，请稍后刷新'),{status:503})));upstream.end(read?undefined:content);
 });return true;
}
