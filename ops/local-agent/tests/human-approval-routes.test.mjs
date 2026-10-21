// Behavioral HTTP tests for the human approval + publication boundaries
// (services/principal + approvals + LocalPrService behind serve-web routes).
// The server runs as its own child process with operator principals in env,
// offline repository admission and a controlled recording transport, so no
// network, Docker, browser or model API is involved.
// Contract tracked in GitHub issue #81.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const childPath=path.join(repoRoot,'ops/local-agent/tests/human-approval-child.mjs');
const proxyChildPath=path.join(repoRoot,'ops/local-agent/tests/request-safety-child.mjs');
const humanToken='h'.repeat(40);
const agentToken='a'.repeat(40);
const narrowToken='l'.repeat(40);
const principalsEnv={VERIFIAI_LOCAL_PRINCIPALS_JSON:JSON.stringify([
  {id:'operator-human',kind:'human',repositories:['octocat/Hello-World'],token:humanToken},
  {id:'worker-agent',kind:'agent',repositories:['octocat/Hello-World'],token:agentToken},
  {id:'narrow-human',kind:'human',repositories:['other/repo'],token:narrowToken},
])};

/** Starts one real API process; returns port plus log readers. */
async function startServer(tmp,{envExtras={},}={}){
  const dir=mkdtempSync(path.join(tmp,'child-'));
  const childLogs={clone:path.join(dir,'clones.jsonl'),transport:path.join(dir,'transport.jsonl')};
  const child=spawn(process.execPath,[childPath],{
    cwd:repoRoot,
    env:{...process.env,VERIFIAI_TEST_CLONE_LOG:childLogs.clone,VERIFIAI_TEST_TRANSPORT_LOG:childLogs.transport,...envExtras},
    stdio:['ignore','pipe','pipe'],
  });
  let stderr='';
  child.stderr.on('data',b=>{stderr+=b.toString();});
  const port=await new Promise((resolve,reject)=>{
    child.once('exit',code=>reject(new Error(`child exited ${code} before PORT: ${stderr}`)));
    child.stdout.on('data',function onData(buffer){
      const m=buffer.toString().match(/PORT (\d+)/);
      if(m){child.stdout.removeListener('data',onData);resolve(Number(m[1]));}
    });
  });
  // A still-running child reports exitCode===null, the same value a signal
  // death leaves behind, so liveness must be tracked through the exit event.
  let childExited=false;
  child.on('exit',()=>{childExited=true;});
  return {
    dir,childLogs,child,port,
    exitCode:()=>child.exitCode,
    alive:()=>childExited===false,
    stderr:()=>stderr,
    transportSteps(){try{return readFileSync(childLogs.transport,'utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}},
    cloneEntries(){try{return readFileSync(childLogs.clone,'utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}},
    async stop(){child.kill('SIGTERM');await new Promise(r=>{child.once('exit',r);setTimeout(r,5000).unref();});},
  };
}

/** Raw HTTP client with top-level controlled Host/Origin/Authorization. */
function request(port,{path:route='/',method='GET',hostHeader,headers={},body,timeoutMs=5000}={}){
  const headerHost=hostHeader??`127.0.0.1:${port}`;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>resolve({error:new Error(`timeout waiting for ${method} ${route}`)}),timeoutMs).unref();
    const req=http.request({host:'127.0.0.1',port,method,path:route,agent:false,headers:{host:headerHost,...headers}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{clearTimeout(timer);resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')});});
    });
    req.on('error',error=>{clearTimeout(timer);resolve({error});});
    if(body!==undefined)req.end(body);else req.end();
  });
}

test('capabilities report configuration and names, never tokens; unconfigured front fails closed',async t=>{
  const tmp=mkdtempSync('/tmp/opencode/human-approval-');
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const configured=await startServer(tmp,{envExtras:principalsEnv});
  t.after(()=>configured.stop());
  const page=await request(configured.port,{path:'/api/local/capabilities'});
  assert.equal(page.status,200,`capabilities must be readable, saw ${page.status} ${page.body}`);
  const payload=JSON.parse(page.body);
  assert.equal(payload.auth.configured,true);
  assert.deepEqual(payload.auth,{configured:true,humanPrincipalConfigured:true,agentPrincipalConfigured:true});
  const serialized=JSON.stringify(payload);
  assert.ok(!serialized.includes('operator-human')&&!serialized.includes('worker-agent')&&!serialized.includes('octocat'),'public capabilities must not leak principal identities');
  assert.ok(!page.body.includes(humanToken)&&!page.body.includes(agentToken)&&!page.body.includes(narrowToken),'capability responses must never carry credential material');
  assert.equal(payload.approval.ttlMinutes,15);
  assert.equal(payload.publication.available,true,'human publication must be available with the operator config');
  await configured.stop();
  const unconfigured=await startServer(tmp,{envExtras:{VERIFIAI_LOCAL_PRINCIPALS_JSON:''}});
  t.after(()=>unconfigured.stop());
  const pageToo=await request(unconfigured.port,{path:'/api/local/capabilities'});
  assert.equal(pageToo.status,200);
  const payloadToo=JSON.parse(pageToo.body);
  assert.equal(payloadToo.auth.configured,false);
  assert.equal(payloadToo.publication.available,false);
  const refused=await request(unconfigured.port,{method:'POST',path:'/api/local/audits/run-app/approval',headers:{authorization:'Bearer '+humanToken}});
  assert.equal(refused.status,503,`missing configuration must fail closed, saw ${refused.status} ${refused.body}`);
});

test('approval and publication refuse unauthenticated and unscoped callers without transport activity',async t=>{
  const tmp=mkdtempSync('/tmp/opencode/human-approval-');
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const server=await startServer(tmp,{envExtras:principalsEnv});
  t.after(()=>server.stop());
  const noAuth=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/approval'});
  assert.equal(noAuth.status,401,`missing token must be 401, saw ${noAuth.status} ${noAuth.body}`);
  const wrongToken=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/approval',headers:{authorization:'Bearer '+'z'.repeat(40)}});
  assert.equal(wrongToken.status,401,`unknown token must be 401, saw ${wrongToken.status} ${wrongToken.body}`);
  const prNoAuth=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/pr',headers:{'content-type':'application/json'},body:JSON.stringify({})});
  assert.equal(prNoAuth.status,401,`/pr without token must be 401, saw ${prNoAuth.status} ${prNoAuth.body}`);
  const unknownAudit=await request(server.port,{method:'POST',path:'/api/local/audits/unknown-run/pr',headers:{authorization:'Bearer '+humanToken,'content-type':'application/json'},body:JSON.stringify({approvalId:'deadbeef'})});
  assert.equal(unknownAudit.status,404,`publication on an unknown audit must be 404, saw ${unknownAudit.status} ${unknownAudit.body}`);
  const missingApproval=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/pr',headers:{authorization:'Bearer '+humanToken,'content-type':'application/json'},body:JSON.stringify({})});
  assert.equal(missingApproval.status,400,`publication without approvalId must be 400, saw ${missingApproval.status} ${missingApproval.body}`);
  assert.equal(server.transportSteps().length,0,'no GitHub-transport step may run from refused requests');
});

test('agent principals and role spoofing can neither approve nor publish',async t=>{
  const tmp=mkdtempSync('/tmp/opencode/human-approval-');
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const server=await startServer(tmp,{envExtras:principalsEnv});
  t.after(()=>server.stop());
  const agentApproval=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/approval',headers:{authorization:'Bearer '+agentToken,'x-verifai-kind':'human'}});
  assert.equal(agentApproval.status,403,`agent bearer must never approve, saw ${agentApproval.status} ${agentApproval.body}`);
  const agentPr=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/pr',headers:{authorization:'Bearer '+agentToken,'x-verifai-kind':'human','content-type':'application/json'},body:JSON.stringify({approvalId:'anything'})});
  assert.equal(agentPr.status,403,`agent bearer must never publish, saw ${agentPr.status} ${agentPr.body}`);
  assert.equal(server.transportSteps().length,0,'agent requests must not touch publication transport');
});

test('repository scope outside the configured list is forbidden for approval',async t=>{
  const tmp=mkdtempSync('/tmp/opencode/human-approval-');
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const server=await startServer(tmp,{envExtras:principalsEnv});
  t.after(()=>server.stop());
  const refused=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/approval',headers:{authorization:'Bearer '+narrowToken}});
  assert.equal(refused.status,403,`narrow human must be scope-refused, saw ${refused.status} ${refused.body}`);
  assert.equal(server.transportSteps().length,0,'scope refusals must not create approvals');
});

test('human approval succeeds end to end with a controlled transport and is single-use',async t=>{
  const tmp=mkdtempSync('/tmp/opencode/human-approval-');
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const server=await startServer(tmp,{envExtras:principalsEnv});
  t.after(()=>server.stop());
  const approved=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/approval',headers:{authorization:'Bearer '+humanToken}});
  assert.equal(approved.status,201,`human approval must be issued, saw ${approved.status} ${approved.body}`);
  assert.ok(!approved.body.includes(humanToken),'approval response must never echo the bearer token');
  const approval=JSON.parse(approved.body);
  assert.match(approval.approvalId,/^[0-9a-f-]{36}$/);
  assert.equal(approval.auditId,'run-app');
  assert.equal(approval.principalId,'operator-human');
  assert.ok(approval.expiresAt>approval.issuedAt);
  const published=await request(server.port,{
    method:'POST',
    path:'/api/local/audits/run-app/pr',
    headers:{authorization:'Bearer '+humanToken,'content-type':'application/json'},
    body:JSON.stringify({approvalId:approval.approvalId}),
  });
  assert.equal(published.status,201,`publication must follow the approval, saw ${published.status} ${published.body}`);
  const result=JSON.parse(published.body);
  assert.equal(result.pullRequest.url,'u-demo');
  assert.equal(result.approval.humanApproved,true);
  assert.equal(result.approval.approvalId,approval.approvalId);
  assert.equal(result.approval.principalId,'operator-human');
  assert.equal(result.principal.id,'operator-human');
  assert.ok(!published.body.includes(humanToken),'publication response must never echo the bearer token');
  const steps=server.transportSteps();
  assert.deepEqual(steps.map(x=>x.step),['verify','branch','commit','push','pr']);
  const replay=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/pr',headers:{authorization:'Bearer '+humanToken,'content-type':'application/json'},body:JSON.stringify({approvalId:approval.approvalId})});
  assert.equal(replay.status,409,`reused approval must be refused 409, saw ${replay.status} ${replay.body}`);
  const stray=await request(server.port,{method:'POST',path:'/api/local/audits/run-app/pr',headers:{authorization:'Bearer '+humanToken,'content-type':'application/json'},body:JSON.stringify({approvalId:'00000000-0000-0000-0000-000000000000'})});
  assert.equal(stray.status,404,`unknown approval id must be refused 404, saw ${stray.status} ${stray.body}`);
  assert.deepEqual(server.transportSteps().map(x=>x.step),['verify','branch','commit','push','pr'],'no transport may run for refused publication');
  const resultGet=await request(server.port,{path:'/api/local/audits/run-app/pr'});
  assert.equal(resultGet.status,200);
  assert.equal(JSON.parse(resultGet.body).approval.humanApproved,true);
  assert.ok(!resultGet.body.includes(humanToken));
});

test('web-to-API proxy forwards Authorization to the configured loopback API only and never echoes it',async t=>{
  const tmp=mkdtempSync('/tmp/opencode/human-approval-');
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const upstream=await startServer(tmp,{envExtras:principalsEnv});
  t.after(()=>upstream.stop());
  const web=spawn(process.execPath,[proxyChildPath],{
    cwd:repoRoot,
    env:{...process.env,VERIFIAI_TEST_CLONE_LOG:path.join(tmp,'w.jsonl'),VERIFIAI_TEST_UPSTREAM_URL:`http://127.0.0.1:${upstream.port}`},
    stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>web.kill('SIGTERM'));
  const webPort=await new Promise((resolve,reject)=>{
    web.once('exit',code=>reject(new Error(`web child exited ${code}`)));
    web.stdout.on('data',function onData(buffer){
      const m=buffer.toString().match(/PORT (\d+)/);
      if(m){web.stdout.removeListener('data',onData);resolve(Number(m[1]));}
    });
  });
  const unauthorized=await request(webPort,{method:'POST',path:'/api/local/audits/run-app/approval'});
  assert.equal(unauthorized.status,401,'the proxy must not approve without the forwarded token');
  const viaProxy=await request(webPort,{method:'POST',path:'/api/local/audits/run-app/approval',headers:{authorization:'Bearer '+humanToken}});
  assert.equal(viaProxy.status,201,`authorization must be forwarded to the loopback API, saw ${viaProxy.status} ${viaProxy.body}`);
  assert.ok(!viaProxy.body.includes(humanToken),'proxy response must never echo the bearer token');
  const approval=JSON.parse(viaProxy.body);
  const publish=await request(webPort,{method:'POST',path:'/api/local/audits/run-app/pr',headers:{authorization:'Bearer '+humanToken,'content-type':'application/json'},body:JSON.stringify({approvalId:approval.approvalId})});
  assert.equal(publish.status,201,`proxied publication must reach the configured API, saw ${publish.status} ${publish.body}`);
  assert.ok(!publish.body.includes(humanToken),'proxied publication response must not echo the token');
  assert.deepEqual(upstream.transportSteps().map(x=>x.step),['verify','branch','commit','push','pr']);
  assert.ok(upstream.alive()&&web.exitCode===null,`children must survive: upstream exit=${upstream.exitCode()} upstream stderr=${upstream.stderr()} web exit=${web.exitCode}`);
});
