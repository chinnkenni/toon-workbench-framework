export const H3_REQUEST_DURATIONS=Object.freeze(Array.from({length:12},(_,index)=>index+4));

/** Form strings and saved numeric values only; do not coerce booleans, fractions or corrupt drafts. */
export function h3RequestDuration(value){
 if(typeof value==='string')return /^(?:[4-9]|1[0-5])$/.test(value)?Number(value):null;
 return typeof value==='number'&&Number.isInteger(value)&&value>=4&&value<=15?value:null;
}
