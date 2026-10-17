// Project saved measurements only. No request, timestamp arithmetic, deployment lookup or rate synthesis.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const OUTPUT=['width','height','duration','durationSeconds','containerDurationSeconds','fps','frames'];
const TIMING=['queueMs','productionMs','serverExecutionMs','totalMs','generationMs'];
const secretKey=/api[_-]?key|(?:access|refresh|oauth|session|device)[_-]?token|private[_-]?key|password|authorization|cookies?|secret|storage[_-]?state|ssh[_-]?key|key[_-]?path|vault/i;
const secretText=/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{15,}/i;
function savedObject(value){
 if(!plain(value))return null;let nodes=0;
 function copy(item,depth){if(++nodes>20000||depth>24)throw Error('Saved metric tree is too large');if(item===null||typeof item==='boolean')return item;if(typeof item==='number'){if(!Number.isFinite(item))throw Error('Invalid saved number');return item;}if(typeof item==='string'){if(secretText.test(item))throw Error('Credential text is not a metric');return item;}if(Array.isArray(item))return item.map(child=>copy(child,depth+1));if(!plain(item))throw Error('Invalid saved JSON');const result={};for(const [key,child]of Object.entries(item)){if(['__proto__','prototype','constructor'].includes(key)||secretKey.test(key))throw Error('Credential field is not a metric');result[key]=copy(child,depth+1);}return result;}
 try{const result=copy(value,0);if(Buffer.byteLength(JSON.stringify(result),'utf8')>256*1024)return null;return result;}catch{return null;}
}
const finite=(value,{integer=false,zero=false}={})=>typeof value==='number'&&Number.isFinite(value)&&(zero?value>=0:value>0)&&(!integer||Number.isSafeInteger(value))?value:null;
/** metrics is an already frozen flat record; output+telemetry are the same actual job's saved snapshot. */
export function recordedStyleMetrics({metrics,media,output,telemetry,includeEmpty=false}={}){
 const flat=plain(metrics)?metrics:null,timing=flat||(plain(telemetry)?telemetry:{}),result={};
 // A job output snapshot is authoritative, including missing/null fields. Do not backfill from stale asset metadata.
 const read=key=>flat?flat[key]:output===null||plain(output)||plain(telemetry)?output?.[key]:media?.[key];
 for(const key of OUTPUT)result[key]=finite(read(key),{integer:['width','height','frames'].includes(key)});
 const audio=read('hasAudio');result.hasAudio=typeof audio==='boolean'?audio:null;
 for(const key of TIMING)result[key]=finite(timing[key],{zero:true});
 result.parameters=savedObject(timing.parameters);result.rates=savedObject(timing.rates);
 result.modelRevision=typeof timing.modelRevision==='string'&&timing.modelRevision.length>0&&timing.modelRevision.length<=180&&!secretText.test(timing.modelRevision)?timing.modelRevision:null;
 const hasEvidence=flat!==null||plain(output)||plain(telemetry)||OUTPUT.some(key=>media?.[key]!==undefined)||typeof media?.hasAudio==='boolean';
 return includeEmpty||hasEvidence||Object.values(result).some(value=>value!==null)?result:undefined;
}
