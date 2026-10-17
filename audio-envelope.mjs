const FIELDS=['fadeIn','fadeOut','envelope'];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
function fail(message){throw Object.assign(new Error(message),{status:400});}
function bounded(value,min,max,label){if(!finite(value)||value<min||value>max)fail(`${label}须为 ${min}–${max} 之间的数值`);return value;}
function envelopeTime(value,duration,isLast){
 // A frame-aligned timeline subtraction can put the same endpoint a few ULPs above its duration.
 if(isLast&&finite(value)&&value>duration){const bits=new DataView(new ArrayBuffer(16));bits.setFloat64(0,duration);bits.setFloat64(8,value);if(bits.getBigUint64(8)-bits.getBigUint64(0)<=4n)return duration;}
 return bounded(value,0,duration,'包络时间');
}
const decimal=value=>String(value===0?0:value);
export const hasAudioAutomation=value=>Boolean(value&&FIELDS.some(key=>Object.hasOwn(value,key)));

/** Times are relative to the trimmed track, before its timeline start delay. */
export function normalizeAudioAutomation(value,duration){
 if(!value||typeof value!=='object'||Array.isArray(value))fail('声音包络须为对象');
 bounded(duration,1/48000,600,'声音时长');
 const fadeIn=bounded(value.fadeIn===undefined?0:value.fadeIn,0,duration,'淡入时长'),fadeOut=bounded(value.fadeOut===undefined?0:value.fadeOut,0,duration,'淡出时长');
 if(fadeIn+fadeOut>duration+1e-9)fail('淡入与淡出时长之和不能超过声音时长');
 const input=value.envelope===undefined?[]:value.envelope;if(!Array.isArray(input)||input.length>64)fail('声音包络最多 64 个关键点');
 let previous=-1;
 const envelope=input.map((item,index)=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['time','gain'].includes(key)))fail('声音包络关键点只接受 time 和 gain 数值');
  const time=envelopeTime(item.time,duration,index===input.length-1),gain=bounded(item.gain,0,2,'包络增益');if(time<=previous)fail('声音包络时间须严格递增且不得重复');previous=time;return {time,gain};
 });
 return {fadeIn,fadeOut,envelope};
}

/** Constructs only numeric FFmpeg expressions; no user expression is accepted. */
export function audioAutomationFilters(value,duration,gain){
 bounded(gain,0,2,'音量');const automation=normalizeAudioAutomation(value,duration),points=automation.envelope;
 let expression='1';
 if(points.length){
  expression=decimal(points.at(-1).gain);
  for(let index=points.length-2;index>=0;index--){const start=points[index],end=points[index+1];expression=`if(lt(t,${decimal(end.time)}),${decimal(start.gain)}+(${decimal(end.gain)}-${decimal(start.gain)})*((t-${decimal(start.time)})/(${decimal(end.time)}-${decimal(start.time)})),${expression})`;}
  if(points[0].time>0)expression=`if(lt(t,${decimal(points[0].time)}),${decimal(points[0].gain)},${expression})`;
 }
 const filters=[`volume='${decimal(gain)}*(${expression})':eval=frame`];
 if(automation.fadeIn>0)filters.push(`afade=t=in:st=0:d=${decimal(automation.fadeIn)}`);
 if(automation.fadeOut>0)filters.push(`afade=t=out:st=${decimal(duration-automation.fadeOut)}:d=${decimal(automation.fadeOut)}`);
 return filters;
}
