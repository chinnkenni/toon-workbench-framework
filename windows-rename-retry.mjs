import {rename as filesystemRename} from 'node:fs/promises';
import {setTimeout as waitFor} from 'node:timers/promises';

export const WINDOWS_RENAME_RETRY_DELAYS_MS=Object.freeze([20,40,80,160,320]);
const transient=new Set(['EPERM','EACCES','EBUSY']);

/** Retry only this same atomic rename, never the write, transaction or upload. */
export async function renameWithWindowsRetry(source,target,{platform=process.platform,rename=filesystemRename,wait=waitFor}={}){
 for(let attempt=0;;attempt++){
  try{return await rename(source,target);}
  catch(error){
   if(platform!=='win32'||!transient.has(error?.code)||attempt>=WINDOWS_RENAME_RETRY_DELAYS_MS.length)throw error;
   await wait(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
  }
 }
}
