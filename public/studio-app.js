import {initWorks} from './works.js';
async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error||'操作未完成');return value;}
let timer;function toast(message){const item=document.querySelector('#studio-toast');item.textContent=message;item.hidden=false;clearTimeout(timer);timer=setTimeout(()=>{item.hidden=true;},4500);}
const works=initWorks({api,toast});document.querySelector('#studio-create').onclick=()=>works.create();works.open();
