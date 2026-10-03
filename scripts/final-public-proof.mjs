import {createHash} from 'node:crypto';

const base=(process.env.VERIFIAI_LOCAL_BASE_URL||'http://127.0.0.1:4173').replace(/\/$/,'');
const repository=process.env.VERIFIAI_PUBLIC_PROOF_REPO;
const expectedBase=process.env.VERIFIAI_PUBLIC_PROOF_BASE_SHA||'';
const runs=Number(process.env.VERIFIAI_PUBLIC_PROOF_RUNS||3);
const patch={files:[{path:'broken.mjs',expected:'}}\n',replacement:'}\n'}]};

if(!repository) throw new Error('VERIFIAI_PUBLIC_PROOF_REPO is required');
if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repository)) throw new Error('VERIFIAI_PUBLIC_PROOF_REPO must be a public GitHub repository URL');
if(!Number.isInteger(runs)||runs<1||runs>3) throw new Error('VERIFIAI_PUBLIC_PROOF_RUNS must be 1..3');

async function json(url,options){
  const response=await fetch(url,options);
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(`${options?.method||'GET'} ${url} -> ${response.status}: ${body.error||JSON.stringify(body)}`);
  return body;
}
async function waitAudit(id){
  for(let i=0;i<1800;i++){
    const current=await json(`${base}/api/local/audits/${encodeURIComponent(id)}`);
    if(current.status!=='Running') return current;
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error(`audit ${id} timed out`);
}
function hash(buffer){return createHash('sha256').update(buffer).digest('hex');}
function assert(cond,msg){if(!cond) throw new Error(msg);}
function parsePr(url){
  const m=String(url||'').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if(!m) throw new Error('M10 did not return a canonical GitHub PR URL');
  return {owner:m[1],repo:m[2],number:Number(m[3])};
}
async function verifyPublicPr(url,branch){
  const p=parsePr(url);
  const response=await fetch(`https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.number}`,{
    headers:{accept:'application/vnd.github+json','user-agent':'VERIFAI-public-proof'}
  });
  if(!response.ok) throw new Error(`public PR lookup failed: HTTP ${response.status}`);
  const pr=await response.json();
  assert(pr.merged_at===null,'proof PR is unexpectedly merged');
  assert(pr.head?.ref===branch,'proof PR head branch mismatch');
  return {url:pr.html_url,state:pr.state,merged:false};
}

const health=await fetch(`${base}/health`);
assert(health.ok,'VERIFAI local service is not healthy');

const summaries=[];
for(let index=1;index<=runs;index++){
  const started=await json(`${base}/api/local/audits`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:repository})
  });
  const audit=await waitAudit(started.id);
  assert(audit.status==='Incomplete','BEFORE must terminate Incomplete because the real command failed');
  assert(audit.failedStage==='execution','BEFORE must fail at execution');
  assert(audit.execution?.status==='Failed'&&Number.isInteger(audit.execution.exitCode)&&audit.execution.exitCode!==0,'BEFORE must be a real nonzero executed failure');
  assert(audit.cleanup?.repositoryRemoved===true&&audit.cleanup?.sandboxRemoved===true,'audit cleanup was not proven');
  if(expectedBase) assert(audit.repository?.commit===expectedBase,`base SHA mismatch: expected ${expectedBase}, got ${audit.repository?.commit}`);

  const repair=await json(`${base}/api/local/audits/${encodeURIComponent(audit.id)}/repair`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({patch})
  });
  assert(repair.verdict==='VerifiedRepair','repair did not reach VerifiedRepair');
  assert(repair.before?.exitCode!==0,'repair BEFORE evidence is not nonzero');
  assert(repair.after?.exitCode===0,'repair AFTER evidence is not zero');
  assert(Array.isArray(repair.regressions)&&repair.regressions.length>0&&repair.regressions.every(x=>x.exitCode===0),'regression did not pass');
  assert(repair.originalUnchanged===true,'original checkout changed');
  assert(repair.cleanup?.candidateRemoved===true,'repair candidate cleanup was not proven');

  const proof=await json(`${base}/api/local/audits/${encodeURIComponent(audit.id)}/artifacts`);
  const browser=proof.artifacts?.find(x=>x.name==='browser');
  const screenshots=proof.artifacts?.find(x=>x.name==='screenshots');
  assert(browser?.status==='Missing','CLI proof must keep browser evidence Missing/NotExecuted');
  assert(screenshots?.status==='Missing','CLI proof must not fabricate screenshots');

  for(const item of proof.artifacts||[]){
    if(item.status!=='Present') continue;
    const response=await fetch(`${base}/api/local/audits/${encodeURIComponent(audit.id)}/artifacts/${encodeURIComponent(item.path)}`);
    assert(response.ok,`artifact download failed: ${item.path}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    assert(hash(bytes)===item.sha256,`artifact hash mismatch: ${item.path}`);
  }

  const published=await json(`${base}/api/local/audits/${encodeURIComponent(audit.id)}/pr`,{method:'POST'});
  assert(published.branch&&published.commitSha&&published.pullRequest?.url,'real repair branch/commit/PR missing');
  const remote=await verifyPublicPr(published.pullRequest.url,published.branch);

  const summary={run:index,runId:audit.id,baseCommit:audit.repository.commit,before:audit.execution.exitCode,after:repair.after.exitCode,regressions:repair.regressions.map(x=>x.exitCode),manifestSha256:proof.manifest?.sha256,branch:published.branch,commitSha:published.commitSha,pr:remote.url,merged:false,cleanup:{audit:audit.cleanup,repair:repair.cleanup},status:'PASS'};
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}
console.log(JSON.stringify({status:'PASS',runs:summaries.length,summaries},null,2));
