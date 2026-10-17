import {readFile,readdir,lstat,stat} from 'node:fs/promises';
import {resolve,join,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const skipped=new Set(['.git','node_modules','data','logs','runtime','vendor','coverage']);
const allowed=/\.(?:mjs|js|jsx|css|html|json|md|yaml|yml|py|sh|ps1|vbs)$|(?:^|\/)(?:\.gitignore|\.gitattributes|\.env\.example|LICENSE|NOTICE)$/;
const screenshotPath=/^docs\/screenshots\/[a-z0-9-]+\.jpg$/;
const patterns=[
 ['private-key',/-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/],
 ['api-credential',/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
 ['private-ip',/\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
 ['personal-windows-home',/[A-Za-z]:[\\/]+Users[\\/]+(?!artist\b|example\b|your[-_]?user\b|你的用户名)[^\\/\s"'<>]+/i],
 ['personal-linux-home',/\/home\/(?!artist\b|example\b|your[-_]?user\b)[a-zA-Z0-9_.-]+/],
 ['cloud-page',/https:\/\/(?:chatgpt\.com|notion\.so)\/(?:c|g|page)\/[a-zA-Z0-9-]{12,}/],
];
const findings=[];let files=0,bytes=0;
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
 const path=join(dir,entry.name),name=relative(root,path).replaceAll('\\','/');
 if(entry.isSymbolicLink()){findings.push({path:name,category:'symbolic-link'});continue;}
 if(entry.isDirectory()){if(skipped.has(entry.name)||name==='public/studio-ui')continue;await walk(path);continue;}
 if(!allowed.test(name)&&!screenshotPath.test(name)){findings.push({path:name,category:'unexpected-file-type'});continue;}
 const info=await stat(path);if(info.size>2*1024*1024){findings.push({path:name,category:'oversized-source'});continue;}
 const raw=await readFile(path);files++;bytes+=raw.length;
 if(screenshotPath.test(name)){
  if(raw.length<4||raw[0]!==0xff||raw[1]!==0xd8||raw[2]!==0xff||raw.at(-2)!==0xff||raw.at(-1)!==0xd9)findings.push({path:name,category:'invalid-jpeg-screenshot'});
  continue;
 }
 if(raw.includes(0)){findings.push({path:name,category:'binary-content'});continue;}
 // The checker contains the signatures it detects, rather than actual credentials.
 if(name==='tools/check-share.mjs')continue;
 const text=raw.toString('utf8'),lines=text.split(/\r?\n/);
 lines.forEach((line,index)=>{for(const [category,pattern]of patterns)if(pattern.test(line))findings.push({path:name,line:index+1,category});});
 if(/\.(?:mjs|js|jsx)$/.test(name)){
  for(const match of text.matchAll(/(?:from\s*|import\s*\(|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)){
   const target=resolve(dirname(path),match[1]);
   if(relative(root,target).startsWith('..'))findings.push({path:name,category:'external-relative-import'});
   else try{if(!(await lstat(target)).isFile())throw Error();}catch{findings.push({path:name,category:'missing-relative-import',import:match[1]});}
  }
 }
 if(name.endsWith('.json'))try{JSON.parse(text);}catch{findings.push({path:name,category:'invalid-json'});}
 if(name==='README.md')for(const match of text.matchAll(/!\[[^\]]*\]\((docs\/screenshots\/[^)\s]+)\)/g))try{if(!(await lstat(join(root,match[1]))).isFile())throw Error();}catch{findings.push({path:name,category:'missing-readme-screenshot',image:match[1]});}
}}
await walk(root);
console.log(JSON.stringify({passed:findings.length===0,files,bytes,findings,note:'Heuristic source scan and JPEG signature checks. Screenshots require separate visual privacy review. Runtime and build directories are excluded.'},null,2));
if(findings.length)process.exitCode=1;
