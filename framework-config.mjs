import {isAbsolute} from 'node:path';
export function readFrameworkGpuConfig({required=true,env=process.env}={}){
 const host=env.TOON_GPU_HOST||'',user=env.TOON_GPU_USER||'',keyPath=env.TOON_GPU_SSH_KEY||'',connectHost=env.TOON_GPU_CONNECT_HOST||host,port=Number(env.TOON_GPU_PORT||22);
 if(!host||!user||!keyPath){if(!required)return null;throw Object.assign(new Error('GPU SSH adapter is not configured'),{status:503});}
 if(!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)||! /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(connectHost)||! /^[a-z_][a-z0-9_-]{0,63}$/i.test(user)||!isAbsolute(keyPath)||!Number.isInteger(port)||port<1||port>65535)throw Object.assign(new Error('GPU SSH configuration is invalid'),{status:503});
 return {host,user,keyPath,connectHost,port};
}
