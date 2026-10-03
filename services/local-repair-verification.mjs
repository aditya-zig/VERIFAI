import {createHash} from 'node:crypto';
import {cp,lstat,mkdtemp,readFile,readdir,realpath,readlink,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {repairVerificationGate} from './repair-verification-policy.mjs';

const MAX_PATCH_BYTES=64*1024;
const MAX_DIFF_BYTES=16*1024;
const MAX_TREE_ENTRIES=20000;
let repairBusy=false;

function sha(value){return createHash('sha256').update(value).digest('hex');}
function inside(root,path){const full=resolve(root,path);if(full!==resolve(root)&&!full.startsWith(resolve(root)+sep))throw new Error('Invalid patch path outside candidate workspace');return full;}

async function assertSafePatchTarget(root,relPath){
  const rootReal=await realpath(root);
  let current=rootReal;
  for(const part of relPath.split(/[\\/]+/)){
    current=join(current,part);
    const st=await lstat(current);
    if(st.isSymbolicLink())throw new Error('Invalid patch path: symlink component is not allowed');
  }
  const targetReal=await realpath(current);
  if(targetReal!==rootReal&&!targetReal.startsWith(rootReal+sep))throw new Error('Invalid patch path: target escapes candidate workspace');
  const st=await lstat(targetReal);
  if(!st.isFile())throw new Error('Invalid patch target: regular file required');
  return targetReal;
}

async function hashTree(root){
  const rootReal=await realpath(root);
  const h=createHash('sha256');let entries=0;
  async function walk(dir){
    const names=(await readdir(dir)).sort();
    for(const name of names){
      if(name==='.git')continue;
      const path=join(dir,name);const rel=relative(rootReal,path);
      const st=await lstat(path);entries+=1;
      if(entries>MAX_TREE_ENTRIES)throw new Error('Original tree too large to verify safely');
      h.update(rel+'\0'+st.mode+'\0');
      if(st.isSymbolicLink()){h.update('link\0'+await readlink(path)+'\0');continue;}
      if(st.isDirectory()){h.update('dir\0');await walk(path);continue;}
      if(st.isFile()){h.update('file\0');h.update(await readFile(path));h.update('\0');}
    }
  }
  await walk(rootReal);return h.digest('hex');
}

function normalizeEvidence(value){
  const raw=value&&typeof value==='object'?value:{};
  return {
    status:raw.timedOut===true||raw.aborted===true?'Incomplete':['Completed','Failed','Incomplete'].includes(raw.status)?raw.status:'Incomplete',
    executed:raw.executed===true,
    ...(typeof raw.timedOut==='boolean'?{timedOut:raw.timedOut}:{}),
    ...(typeof raw.aborted==='boolean'?{aborted:raw.aborted}:{}),
    ...(Number.isInteger(raw.exitCode)||raw.exitCode===null?{exitCode:raw.exitCode}:{}),
    ...(typeof raw.command==='string'?{command:raw.command}:{}),
    ...(typeof raw.stdout==='string'?{stdout:raw.stdout.slice(-8192)}:{}),
    ...(typeof raw.stderr==='string'?{stderr:raw.stderr.slice(-8192)}:{}),
    ...(typeof raw.durationMs==='number'?{durationMs:raw.durationMs}:{}),
    ...(raw.provenance&&typeof raw.provenance==='object'?{provenance:raw.provenance}:{}),
  };
}
const executedFailure=e=>e?.status==='Failed'&&e?.executed===true&&Number.isInteger(e.exitCode)&&e.exitCode!==0;
const executedSuccess=e=>e?.status==='Completed'&&e?.executed===true&&e.exitCode===0;

function assertPatch(patch){
  if(!patch||!Array.isArray(patch.files)||patch.files.length!==1)throw new Error('Invalid patch: exactly one file change is supported');
  const file=patch.files[0];
  if(!file||typeof file.path!=='string'||!file.path||isAbsolute(file.path)||file.path.split(/[\\/]+/).includes('..'))throw new Error('Invalid patch path');
  if(typeof file.expected!=='string'||typeof file.replacement!=='string')throw new Error('Invalid patch: expected and replacement text are required');
  if(Buffer.byteLength(JSON.stringify(patch),'utf8')>MAX_PATCH_BYTES)throw new Error('Invalid patch: patch exceeds 64 KiB');
  return {files:[{path:file.path,expected:file.expected,replacement:file.replacement}]};
}

async function runCheck(check,label,workspacePath,timeoutMs,externalSignal){
  if(typeof check!=='function')throw new Error(label+' check is required');
  const controller=new AbortController();
  const signal=externalSignal?AbortSignal.any([externalSignal,controller.signal]):controller.signal;
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort(new Error(label+' timeout'));},timeoutMs);
  const started=performance.now();
  try{
    const value=await check({workspacePath,signal,label});
    if(timedOut||signal.aborted)throw new Error(label+' timeout');
    const evidence=normalizeEvidence(value);
    if(evidence.durationMs===undefined)evidence.durationMs=Math.round(performance.now()-started);
    return evidence;
  }catch(error){
    if(timedOut)return {status:'Incomplete',executed:false,exitCode:null,durationMs:Math.round(performance.now()-started),stderr:label+' timeout'};
    throw error;
  }finally{clearTimeout(timer);}
}

async function applyPatch(candidatePath,patch){
  const change=patch.files[0];
  const filePath=await assertSafePatchTarget(candidatePath,change.path);
  const before=await readFile(filePath,'utf8');
  const first=before.indexOf(change.expected),last=before.lastIndexOf(change.expected);
  if(first<0||first!==last)throw new Error('Invalid patch: expected text must occur exactly once');
  const after=before.slice(0,first)+change.replacement+before.slice(first+change.expected.length);
  await writeFile(filePath,after,'utf8');
  let diff=`--- a/${change.path}\n+++ b/${change.path}\n-${before}\n+${after}\n`;
  if(Buffer.byteLength(diff,'utf8')>MAX_DIFF_BYTES)diff=Buffer.from(diff).subarray(0,MAX_DIFF_BYTES).toString('utf8')+'\n...[diff truncated]\n';
  return {path:change.path,beforeHash:sha(before),afterHash:sha(after),diff};
}

export async function runRepairVerification({workspacePath,finding,patch,verify,regressions=[],timeoutMs=10000,signal,baseCommitSha}={}){
  if(repairBusy)return {verdict:'Incomplete',error:'Busy: one repair verification at a time',cleanup:{candidateRemoved:true}};
  repairBusy=true;
  let candidatePath,targetPath,treeBefore;
  const result={verdict:'Incomplete',regressions:[],cleanup:{candidateRemoved:false},originalUnchanged:false};
  try{
    if(!workspacePath||typeof workspacePath!=='string')throw new Error('workspacePath is required');
    const legacyConfirmed=finding?.status==='Confirmed'||finding?.findingState==='Confirmed';
    const target=finding?.verifiedTarget;
    const targetFailure=target&&typeof target==='object'
      &&target.status==='Failed'
      &&Number.isInteger(target.exitCode)&&target.exitCode!==0
      &&(target.executed===true||target.sandboxStarted===true)
      &&typeof target.command==='string'&&target.command.length>0;
    if(!legacyConfirmed&&!targetFailure)throw new Error('Verified executed command failure required before repair (model hypothesis stays Unconfirmed)');
    if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>60000)throw new Error('timeoutMs must be between 10 and 60000');
    if(!Array.isArray(regressions)||regressions.length>8||regressions.some(x=>typeof x!=='function'))throw new Error('regressions must contain at most 8 checks');
    const normalizedPatch=assertPatch(patch);
    targetPath=await assertSafePatchTarget(workspacePath,normalizedPatch.files[0].path);
    treeBefore=await hashTree(workspacePath);
    candidatePath=await mkdtemp(join(tmpdir(),'verifai-repair-'));
    await cp(workspacePath,candidatePath,{recursive:true,dereference:false,preserveTimestamps:false});
    await assertSafePatchTarget(candidatePath,normalizedPatch.files[0].path);

    result.before=await runCheck(verify,'before verification',candidatePath,timeoutMs,signal);
    if(!executedFailure(result.before)){result.error='Before verification did not prove an executed failure';return result;}

    const applied=await applyPatch(candidatePath,normalizedPatch);
    result.patch=normalizedPatch;result.diff=applied.diff;
    result.changedFiles=[{path:applied.path,beforeHash:applied.beforeHash,afterHash:applied.afterHash}];
    result.patchDigest=sha(JSON.stringify(normalizedPatch));
    if(baseCommitSha)result.verifiedBaseCommitSha=baseCommitSha;

    result.after=await runCheck(verify,'after verification',candidatePath,timeoutMs,signal);
    if(result.after.status==='Incomplete'){result.error='After verification was Incomplete';return result;}
    if(!executedSuccess(result.after)){result.verdict='RejectedRepair';result.error='After verification did not prove executed success';return result;}

    for(let i=0;i<regressions.length;i+=1){
      const evidence=await runCheck(regressions[i],`regression ${i+1}`,candidatePath,timeoutMs,signal);
      result.regressions.push(evidence);
      if(evidence.status==='Incomplete'){result.error=`Regression ${i+1} was Incomplete`;return result;}
      if(!executedSuccess(evidence)){result.verdict='RejectedRepair';result.error=`Regression ${i+1} did not prove executed success`;return result;}
    }
    result.verdict='VerifiedRepair';return result;
  }catch(error){result.verdict='Incomplete';result.error=String(error?.message||error);return result;}
  finally{
    if(candidatePath){try{await rm(candidatePath,{recursive:true,force:true});result.cleanup.candidateRemoved=true;}catch(error){result.cleanup.candidateRemoved=false;result.verdict='Incomplete';result.error='Candidate cleanup failed: '+String(error?.message||error);}}
    else result.cleanup.candidateRemoved=true;
    if(treeBefore){
      try{const treeAfter=await hashTree(workspacePath);result.originalTreeBefore=treeBefore;result.originalTreeAfter=treeAfter;result.originalUnchanged=treeBefore===treeAfter;
        if(!result.originalUnchanged){result.verdict='Incomplete';result.error='Original workspace changed during repair verification';}}
      catch(error){result.verdict='Incomplete';result.error='Could not verify original workspace integrity: '+String(error?.message||error);}
    }
    if(result.verdict==='VerifiedRepair'){
      const gate=repairVerificationGate(result);
      if(!gate.eligible){result.verdict='Incomplete';result.error=gate.reason;}
    }
    repairBusy=false;
  }
}
