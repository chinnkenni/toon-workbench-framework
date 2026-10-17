export const formatAudioEnvelope=points=>(points||[]).map(point=>`${point.time}, ${point.gain}`).join('\n');
export function parseAudioAutomation({fadeIn,fadeOut,envelope},duration){
 const result={fadeIn:fadeIn===''?0:Number(fadeIn??0),fadeOut:fadeOut===''?0:Number(fadeOut??0),envelope:[]};
 for(const key of ['fadeIn','fadeOut'])if(!Number.isFinite(result[key])||result[key]<0||result[key]>duration)throw new Error('淡入淡出时长须在本条声音时长之内。');
 if(result.fadeIn+result.fadeOut>duration)throw new Error('淡入与淡出时长之和不能超过本条声音。');
 const lines=String(envelope||'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);if(lines.length>64)throw new Error('音量变化最多 64 个控制点。');
 for(const line of lines){const pair=line.split(/[,，\s]+/);if(pair.length!==2||pair.some(value=>value===''))throw new Error('每行填写两个数字：相对秒数, 音量倍数。');const time=Number(pair[0]),gain=Number(pair[1]);if(!Number.isFinite(time)||!Number.isFinite(gain)||time<0||time>duration||gain<0||gain>2)throw new Error('控制点时间须在本条声音内，音量为 0–2 倍。');if(result.envelope.length&&time<=result.envelope.at(-1).time)throw new Error('音量控制点按时间从小到大填写，不能重复。');result.envelope.push({time,gain});}
 return result;
}
