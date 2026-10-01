import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

const REQUIRED_PROOF=['run','repository','repair','repair-diff','before-verification','after-verification','regressions'];

function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function digest(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function repairPatchDigest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function clip(value,limit=4000){const text=String(value??'');return text.length<=limit?text:text.slice(0,limit)+'...[truncated]';}
function requireTransport(t){for(const m of ['verifyRemoteBase','createBranch','commitVerifiedPatch','pushBranch','openPullRequest'])if(typeof t?.[m]!=='function')throw new Error('GitHub transport missing '+m+'()');}
function assertRepository(repository){if(typeof repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new Error('repository must be owner/name');}
function safeBranch(runId){const slug=String(runId??'').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48);if(!slug)throw new Error('runId is required');return 'verifiai/repair-'+slug;}

function assertExecutedRepair(repair){
  if(repair?.verdict!=='VerifiedRepair')throw new Error('PR creation requires repair.verdict == VerifiedRepair');
  if(repair?.before?.executed!==true||!Number.isInteger(repair.before.exitCode)||repair.before.exitCode===0)throw new Error('PR creation requires executed BEFORE failure');
  if(repair?.after?.executed!==true||repair.after.exitCode!==0)throw new Error('PR creation requires executed AFTER verification with exitCode 0');
  if(!Array.isArray(repair?.regressions)||repair.regressions.some(x=>x?.executed!==true||x?.exitCode!==0))throw new Error('PR creation requires every regression executed with exitCode 0');
  if(repair?.originalUnchanged!==true)throw new Error('PR creation requires original workspace unchanged');
  if(repair?.cleanup?.candidateRemoved!==true)throw new Error('PR creation requires candidate cleanup');
  if(!repair?.verifiedBaseCommitSha||!/^[0-9a-f]{7,64}$/i.test(repair.verifiedBaseCommitSha))throw new Error('PR creation requires verified base commit SHA');
  if(!repair?.patch||!Array.isArray(repair.patch.files)||!repair.patch.files.length)throw new Error('PR creation requires verified patch');
  if(repair.patchDigest!==repairPatchDigest(repair.patch))throw new Error('repair patch digest mismatch; re-verification required');
  if(!Array.isArray(repair.changedFiles)||repair.changedFiles.length!==repair.patch.files.length)throw new Error('PR creation requires verified file hashes');
  for(const file of repair.changedFiles){
    if(typeof file?.path!=='string'||!/^[0-9a-f]{64}$/i.test(file.beforeHash??'')||!/^[0-9a-f]{64}$/i.test(file.afterHash??''))throw new Error('PR creation requires verified before/after file hashes');
  }
}
function assertProof(proof){
  if(!proof?.manifest?.id||!/^[0-9a-f]{64}$/i.test(proof?.manifest?.sha256??''))throw new Error('proof artifact manifest is required');
  if(!Array.isArray(proof.artifacts))throw new Error('proof artifacts are required');
  for(const name of REQUIRED_PROOF){
    const item=proof.artifacts.find(x=>x?.name===name);
    if(!item||item.status!=='Present'||typeof item.path!=='string'||!/^[0-9a-f]{64}$/i.test(item.sha256??''))throw new Error('required proof artifact missing: '+name);
  }
}
function binding({runId,repository,baseBranch,repair,proof}){
  return {
    runId,repository,baseBranch,
    baseCommitSha:repair.verifiedBaseCommitSha,
    patchDigest:repair.patchDigest,
    proofManifestId:proof.manifest.id,
    proofManifestSha256:proof.manifest.sha256,
  };
}
function encode(v){return Buffer.from(JSON.stringify(v),'utf8').toString('base64url');}
function sign(payload,secret){return createHmac('sha256',secret).update(payload).digest('base64url');}

export function issuePrApproval({secret,runId,repository,baseBranch='main',repair,proof,now=Date.now(),ttlMs=15*60*1000}={}){
  if(typeof secret!=='string'||secret.length<32)throw new Error('PR approval secret must be at least 32 characters');
  assertRepository(repository);assertExecutedRepair(repair);assertProof(proof);
  const b=binding({runId,repository,baseBranch,repair,proof});
  const envelope={v:1,aud:'verifiai-create-pr',iat:now,exp:now+Math.min(Math.max(ttlMs,60000),30*60*1000),binding:b};
  const payload=encode(envelope);return payload+'.'+sign(payload,secret);
}
export function verifyPrApproval({token,secret,runId,repository,baseBranch='main',repair,proof,now=Date.now()}={}){
  if(typeof token!=='string'||!token)throw new Error('explicit human PR approval is required');
  if(typeof secret!=='string'||secret.length<32)throw new Error('PR approval secret must be at least 32 characters');
  const [payload,sig,...rest]=token.split('.');if(!payload||!sig||rest.length)throw new Error('invalid PR approval');
  const expected=Buffer.from(sign(payload,secret)),provided=Buffer.from(sig);
  if(expected.length!==provided.length||!timingSafeEqual(expected,provided))throw new Error('invalid PR approval signature');
  let env;try{env=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{throw new Error('invalid PR approval payload');}
  if(env?.v!==1||env?.aud!=='verifiai-create-pr'||env.exp<now||env.iat>now+30000)throw new Error('expired or invalid PR approval');
  const current=binding({runId,repository,baseBranch,repair,proof});
  if(digest(env.binding)!==digest(current))throw new Error('PR approval is stale: verified repair/proof changed');
  return current;
}
function evidenceLine(v){if(!v||typeof v!=='object')return 'Missing';return clip(v.status,80)+' · exit '+String(v.exitCode)+(v.stdout?'\nstdout: '+clip(v.stdout,1200):'')+(v.stderr?'\nstderr: '+clip(v.stderr,1200):'');}
function verifiedTargetLabel({finding,repair}={}){
  return repair?.verifiedTarget?.command || finding?.verifiedTarget?.command || repair?.before?.command || finding?.executedCheck?.command || repair?.selectedCommand || '(bounded command)';
}
function modelHypothesisBlock({finding,repair}={}){
  const h=repair?.modelHypothesis||finding?.modelHypothesis||finding?.hypothesis;
  const title=h?.title||finding?.title||'(model hypothesis)';
  const desc=h?.description||finding?.description||'';
  return 'Model hypothesis (Unconfirmed, not verification): '+clip(title,300)+'\n\n'+clip(desc,1500);
}
function buildBody({finding,repair,proof}){
  const regs=repair.regressions.map((x,i)=>'- Regression '+(i+1)+' (SAME-COMMAND REPLAY): exit '+x.exitCode).join('\n')||'- No regressions configured.';
  const refs=proof.artifacts.filter(x=>x.status==='Present').map(x=>'- '+x.path+' · '+x.sha256).join('\n');
  const target=verifiedTargetLabel({finding,repair});
  const targetExit=repair?.verifiedTarget?.exitCode ?? repair?.before?.exitCode;
  return '## Verified target (executed command failure)\n'+clip(target,300)+' · exit '+String(targetExit)+
    '\n\n## '+modelHypothesisBlock({finding,repair})+
    '\n\n## Original failure\n'+evidenceLine(repair.before)+'\n\n## After repair\n'+evidenceLine(repair.after)+
    '\n\n## Regression result\n'+regs+'\nSame-command replay only; not independent regression breadth.'+
    '\n\n## Proof manifest\n- '+proof.manifest.id+' · '+proof.manifest.sha256+
    '\n\n## Proof artifacts\n'+refs+'\n\n## Review gate\nHuman approval was bound to this exact verified repair and proof manifest. Merge remains manual.\n';
}

export async function createVerifiedRepairPullRequest({
  transport,repository,baseBranch='main',runId,finding,repair,proof,approvalToken,approvalSecret,
}={}){
  // Every structural gate happens before even a read from GitHub.
  requireTransport(transport);assertRepository(repository);assertExecutedRepair(repair);assertProof(proof);
  verifyPrApproval({token:approvalToken,secret:approvalSecret,runId,repository,baseBranch,repair,proof});
  const branch=safeBranch(runId);
  await transport.verifyRemoteBase({repository,baseBranch,baseCommitSha:repair.verifiedBaseCommitSha,changedFiles:repair.changedFiles});
  await transport.createBranch({repository,baseBranch,branch,expectedBaseSha:repair.verifiedBaseCommitSha});
  const verifiedLabel=verifiedTargetLabel({finding,repair});
  const committed=await transport.commitVerifiedPatch({
    repository,branch,baseCommitSha:repair.verifiedBaseCommitSha,patch:repair.patch,changedFiles:repair.changedFiles,
    commitMessage:'VERIFAI verified repair: '+clip(verifiedLabel,120),
  });
  if(!committed?.commitSha)throw new Error('GitHub transport did not return commitSha');
  await transport.pushBranch({repository,branch,commitSha:committed.commitSha});
  const pullRequest=await transport.openPullRequest({repository,baseBranch,headBranch:branch,title:'VERIFAI repair: '+clip(verifiedLabel,120),body:buildBody({finding,repair,proof})});
  if(!pullRequest)throw new Error('GitHub transport did not return a pull request');
  return {branch,commitSha:committed.commitSha,pullRequest};
}
