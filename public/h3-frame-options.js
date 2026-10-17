// Generation choices are independent of the timeline's export canvas.
export const H3_WIDE_RATIO='47:20';
export const H3_WIDE_HINT='宽银幕 47:20 仅支持 352P，生成尺寸为 832 × 352。需要使用时先选 352P；成片导出尺寸在时间轴中单独设置。';

export function h3RatioChoices(resolution){
 return ['16:9','9:16','1:1',H3_WIDE_RATIO].map(value=>({value,label:value===H3_WIDE_RATIO?'47:20 · 宽银幕（仅 352P）':value,disabled:value===H3_WIDE_RATIO&&resolution!=='352P'}));
}
export function h3ResolutionChoices(ratio){
 return ['352P','480P'].map(value=>({value,label:ratio===H3_WIDE_RATIO?(value==='352P'?'352P · 832 × 352':'480P · 此画幅不支持'):value,disabled:ratio===H3_WIDE_RATIO&&value==='480P'}));
}
export function h3FrameSelectionError({ratio,resolution}={}){
 return ratio===H3_WIDE_RATIO&&resolution!=='352P'?'47:20 宽银幕仅支持 352P（832 × 352）。请明确选择 352P 后再保存或生成，当前设置未被自动改动。':'';
}
export function h3NativeFrameFields({ratio='16:9',resolution='352P'}={}){
 const options=(choices,selected)=>choices.map(choice=>`<option value="${choice.value}" ${choice.value===selected?'selected':''} ${choice.disabled?'disabled':''}>${choice.label}</option>`).join('');
 return `<div class="field-grid"><label>生成画幅<select name="ratio">${options(h3RatioChoices(resolution),ratio)}</select></label><label>生成分辨率<select name="resolution">${options(h3ResolutionChoices(ratio),resolution)}</select></label></div><p class="muted small" data-h3-frame-hint>${h3FrameSelectionError({ratio,resolution})||H3_WIDE_HINT}</p>`;
}
/** Preserve selected values, including an invalid restored draft; never coerce a canvas. */
export function bindH3NativeFrameFields(form){
 const ratio=form.querySelector('[name="ratio"]'),resolution=form.querySelector('[name="resolution"]'),hint=form.querySelector('[data-h3-frame-hint]');
 if(!ratio||!resolution)return;
 const sync=()=>{
  for(const [control,choices] of [[ratio,h3RatioChoices(resolution.value)],[resolution,h3ResolutionChoices(ratio.value)]]){
   for(const choice of choices){const option=[...control.options].find(item=>item.value===choice.value);if(option){option.disabled=choice.disabled;option.textContent=choice.label;}}
  }
  const error=h3FrameSelectionError({ratio:ratio.value,resolution:resolution.value});resolution.setCustomValidity(error);
  if(hint){hint.textContent=error||H3_WIDE_HINT;hint.setAttribute('role',error?'alert':'note');}
 };
 ratio.addEventListener('change',sync);resolution.addEventListener('change',sync);sync();
 return sync;
}
