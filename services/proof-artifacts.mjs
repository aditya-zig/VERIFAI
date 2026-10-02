import {createHash} from 'node:crypto';
import {dirname,resolve,sep} from 'node:path';
import {mkdir,rm,writeFile} from 'node:fs/promises';

const DEFAULT_MAX_BUNDLE_BYTES=50*1024*1024;
const DEFAULT_MAX_TEXT_BYTES=256*1024;
const MAX_SCREENSHOTS=10;
const MAX_SCREENSHOT_BYTES=1024*1024;
const SECRET_KEY=/(authorization|api[-_]?key|token|secret|password|passwd|cookie|credential)/i;

function sha256(value){return createHash('sha256').update(value).digest('hex');}
function normalizedSecrets(values){
  if(!Array.isArray(values))return [];
  return [...new Set(values.filter(v=>typeof v==='string'&&v.length>=4).sort((a,b)=>b.length-a.length))];
}
function redactString(value,secrets){
  let text=String(value);
  for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi,'[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,'[REDACTED]');
}
function redact(value,secrets,key=''){
  if(SECRET_KEY.test(key))return '[REDACTED]';
  if(typeof value==='string')return redactString(value,secrets);
  if(Array.isArray(value))return value.map(item=>redact(item,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v,secrets,k)]));
  return value;
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function jsonBuffer(value,secrets){return Buffer.from(JSON.stringify(canonical(redact(value,secrets)),null,2)+'\n','utf8');}
function textBuffer(value,max,secrets){
  const buf=Buffer.from(redactString(value??'',secrets),'utf8');
  return buf.length<=max?{buffer:buf,truncated:false}:{buffer:buf.subarray(0,max),truncated:true};
}
function present(name,path,buffer,extra={}){return {name,path,status:'Present',bytes:buffer.length,sha256:sha256(buffer),...extra};}
function missing(name,reason){return {name,status:'Missing',reason};}
function assertRunId(runId){if(typeof runId!=='string'||runId==='.'||runId==='..'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId))throw new Error('runId must be a stable path-safe identifier');}
export function artifactBundlePath(rootDir,runId){
  assertRunId(runId);const root=resolve(rootDir),path=resolve(root,runId);
  if(!path.startsWith(root+sep))throw new Error('artifact path escapes root');
  return path;
}

export async function createArtifactBundle({
  rootDir,runId,data={},maxTextBytes=DEFAULT_MAX_TEXT_BYTES,maxBundleBytes=DEFAULT_MAX_BUNDLE_BYTES,
  knownSecrets=[],screenshotResolver,replace=false,
}={}){
  if(!rootDir||typeof rootDir!=='string')throw new Error('rootDir is required');
  assertRunId(runId);
  if(!Number.isInteger(maxTextBytes)||maxTextBytes<64||maxTextBytes>1024*1024)throw new Error('maxTextBytes must be between 64 bytes and 1 MiB');
  if(!Number.isInteger(maxBundleBytes)||maxBundleBytes<1024||maxBundleBytes>DEFAULT_MAX_BUNDLE_BYTES)throw new Error('maxBundleBytes must be between 1 KiB and 50 MiB');
  if(screenshotResolver!==undefined&&typeof screenshotResolver!=='function')throw new Error('screenshotResolver must be a function');
  const secrets=normalizedSecrets(knownSecrets),files=new Map(),artifacts=[];
  const addJson=(name,path,value)=>{
    if(value===undefined||value===null){artifacts.push(missing(name,name+' evidence not present'));return;}
    const buffer=jsonBuffer(value,secrets);files.set(path,buffer);artifacts.push(present(name,path,buffer));
  };
  const addText=(name,path,value)=>{
    if(value===undefined||value===null){artifacts.push(missing(name,name+' evidence not present'));return;}
    const {buffer,truncated}=textBuffer(value,maxTextBytes,secrets);files.set(path,buffer);artifacts.push(present(name,path,buffer,truncated?{truncated:true}:{}));
  };

  addJson('run','run.json',data.run??{id:runId,status:'Incomplete',note:'Run metadata not supplied'});
  addJson('repository','repo.json',data.repository);
  addJson('finding','finding.json',data.finding);
  addJson('specialists','specialists.json',data.specialists);
  if(data.execution){
    const {stdout,stderr,...meta}=data.execution;addJson('execution','execution.json',meta);addText('stdout','stdout.txt',stdout??'');addText('stderr','stderr.txt',stderr??'');
  }else{artifacts.push(missing('execution','execution evidence not present'),missing('stdout','execution evidence not present'),missing('stderr','execution evidence not present'));}
  addJson('browser','browser.json',data.browser);
  if(data.repair){
    addJson('repair','repair.json',{verdict:data.repair.verdict,patch:data.repair.patch,changedFiles:data.repair.changedFiles,patchDigest:data.repair.patchDigest,verifiedBaseCommitSha:data.repair.verifiedBaseCommitSha,cleanup:data.repair.cleanup,originalUnchanged:data.repair.originalUnchanged});
    addText('repair-diff','repair.diff',data.repair.diff);
    addJson('before-verification','before.json',data.repair.before);
    addJson('after-verification','after.json',data.repair.after);
    addJson('regressions','regressions.json',data.repair.regressions);
  }else{
    for(const name of ['repair','repair-diff','before-verification','after-verification','regressions'])artifacts.push(missing(name,'repair evidence not present'));
  }
  addJson('cleanup','cleanup.json',data.cleanup);
  addJson('model','model.json',data.model);

  const ownedScreens=[];
  const refs=Array.isArray(data.browser?.screenshotRefs)?data.browser.screenshotRefs.slice(0,MAX_SCREENSHOTS):[];
  for(let i=0;i<refs.length;i+=1){
    const ref=refs[i],name=`screenshot-${i+1}`,path=`screenshots/${i+1}.png`;
    if(typeof ref!=='string'||!ref){artifacts.push(missing(name,'invalid screenshot reference'));continue;}
    if(!screenshotResolver){artifacts.push(missing(name,'screenshot resolver unavailable'));continue;}
    try{
      const value=await screenshotResolver(ref);
      const buffer=Buffer.isBuffer(value)?value:value instanceof Uint8Array?Buffer.from(value):null;
      if(!buffer||!buffer.length){artifacts.push(missing(name,'referenced screenshot not found'));continue;}
      if(buffer.length>MAX_SCREENSHOT_BYTES){artifacts.push(missing(name,`screenshot exceeds ${MAX_SCREENSHOT_BYTES} byte cap`));continue;}
      files.set(path,buffer);artifacts.push(present(name,path,buffer,{sourceRef:ref}));ownedScreens.push(path);
    }catch{artifacts.push(missing(name,'referenced screenshot not found'));}
  }
  if(!refs.length)artifacts.push(missing('screenshots','browser screenshot evidence not present'));

  const path=artifactBundlePath(rootDir,runId);
  if(replace)await rm(path,{recursive:true,force:true});
  const payloadBytes=[...files.values()].reduce((sum,b)=>sum+b.length,0);
  const manifest={version:2,runId,artifacts,references:{screenshots:ownedScreens},totalBytes:0};
  let manifestBuffer=jsonBuffer(manifest,secrets);
  for(let i=0;i<4;i+=1){manifest.totalBytes=payloadBytes+manifestBuffer.length;manifestBuffer=jsonBuffer(manifest,secrets);}
  if(manifest.totalBytes>maxBundleBytes)throw new Error(`Artifact bundle exceeds ${maxBundleBytes} bytes`);

  await mkdir(resolve(rootDir),{recursive:true,mode:0o700});await mkdir(path,{recursive:false,mode:0o700});
  for(const [name,buffer] of files){const target=resolve(path,name);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,buffer,{mode:0o600,flag:'wx'});}
  await writeFile(resolve(path,'manifest.json'),manifestBuffer,{mode:0o600,flag:'wx'});
  return {runId,path,manifest:canonical(manifest),totalBytes:manifest.totalBytes,manifestPath:resolve(path,'manifest.json'),manifestSha256:sha256(manifestBuffer)};
}
