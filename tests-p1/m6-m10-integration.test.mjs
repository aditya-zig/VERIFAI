import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runSequentialSpecialists} from '../services/local-specialists.mjs';
import {runRepairVerification} from '../services/local-repair-verification.mjs';
import {createArtifactBundle} from '../services/proof-artifacts.mjs';
import {createVerifiedRepairPullRequest,issuePrApproval} from '../services/verified-repair-pr.mjs';

const approvalSecret='0123456789abcdef0123456789abcdef';
const sha=(value)=>createHash('sha256').update(value).digest('hex');

function spyTransport({stale=false}={}){
  const calls=[];
  return {calls,transport:{
    async verifyRemoteBase(input){calls.push(['verifyRemoteBase',input]);if(stale)throw new Error('stale-base: changed');},
    async createBranch(input){calls.push(['createBranch',input]);return {sha:input.expectedBaseSha};},
    async commitVerifiedPatch(input){calls.push(['commitVerifiedPatch',input]);return {commitSha:'verified-commit'};},
    async pushBranch(input){calls.push(['pushBranch',input]);},
    async openPullRequest(input){calls.push(['openPullRequest',input]);return {number:77,url:'https://example.test/pull/77'};},
  }};
}
function publicProof(bundle){
  return {manifest:{id:'proof:'+bundle.runId+':manifest',sha256:bundle.manifestSha256},artifacts:bundle.manifest.artifacts};
}
async function buildVerifiedChain(t){
  const workspace=await mkdtemp(join(tmpdir(),'verifiai-integration-'));
  const artifactsRoot=await mkdtemp(join(tmpdir(),'verifiai-integration-proof-'));
  t.after(()=>Promise.all([rm(workspace,{recursive:true,force:true}),rm(artifactsRoot,{recursive:true,force:true})]));
  await writeFile(join(workspace,'broken.js'),'export const safe = false;\n');

  const m5={id:'integration-run',status:'Incomplete',repository:{fullName:'owner/repo',commit:'abcdef1234567890'},
    finding:{title:'Unsafe boolean',description:'The controlled check fails.',severity:'high',evidence:{file:'broken.js'}},
    execution:{status:'Failed',executed:true,exitCode:1,command:'node check',stdout:'false\n',stderr:'',durationMs:2,provenance:{kind:'fixture'}},
    cleanup:{repositoryRemoved:true,sandboxRemoved:true},model:{provider:'fixture',model:'base'}};

  const m6=await runSequentialSpecialists({
    specialists:[{id:'security',async run({callModel}){return callModel(async()=>({
      status:'Completed',findings:[{title:'Security review',severity:'low',description:'bounded',evidence:{file:'broken.js'}}],
      evidenceRefs:['file:broken.js'],model:{provider:'fixture',model:'security'}}));}}],
    maxSpecialists:1,maxModelCalls:1,persist:async()=>{},
  });
  assert.equal(m6.status,'Completed');

  const verify=async({workspacePath,label})=>{
    const content=await readFile(join(workspacePath,'broken.js'),'utf8');
    const ok=content.includes('safe = true');
    return {status:ok?'Completed':'Failed',executed:true,exitCode:ok?0:1,command:'node check',
      stdout:content,stderr:'',durationMs:1,provenance:{kind:'fixture',label}};
  };
  const m8=await runRepairVerification({
    workspacePath:workspace,finding:{status:'Confirmed'},baseCommitSha:m5.repository.commit,
    patch:{files:[{path:'broken.js',expected:'safe = false',replacement:'safe = true'}]},
    verify,regressions:[verify],timeoutMs:500,
  });
  assert.equal(m8.verdict,'VerifiedRepair');

  const browser={status:'Completed',auditId:m5.id,startUrl:'http://127.0.0.1/fixture',finalUrl:'http://127.0.0.1/fixture',
    actions:[{action:'click-button'}],assertions:[{passed:true}],screenshotRefs:['/api/local/browser-shots/browser-test.png'],
    consoleErrors:[],networkEvidence:[],durationMs:1,cleanup:{browserClosed:true,profileRemoved:true,fixtureStopped:true},
    target:{kind:'fixture',label:'VERIFAI local integration fixture'}};
  const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const bundle=await createArtifactBundle({
    rootDir:artifactsRoot,runId:m5.id,data:{run:m5,repository:m5.repository,finding:m5.finding,specialists:m6,execution:m5.execution,browser,repair:m8,cleanup:m5.cleanup,model:m5.model},
    screenshotResolver:async(ref)=>ref===browser.screenshotRefs[0]?png:undefined,
  });
  const m9=publicProof(bundle);
  const token=issuePrApproval({secret:approvalSecret,runId:m5.id,repository:m5.repository.fullName,baseBranch:'main',repair:m8,proof:m9});
  return {m5,m6,m8,m9,token};
}

test('M5-shaped audit → M6 → M8 → M9 → explicit M10 approval composes without real external transports',async(t)=>{
  const chain=await buildVerifiedChain(t);
  const spy=spyTransport();
  const result=await createVerifiedRepairPullRequest({
    transport:spy.transport,repository:chain.m5.repository.fullName,baseBranch:'main',runId:chain.m5.id,
    finding:chain.m5.finding,repair:chain.m8,proof:chain.m9,approvalToken:chain.token,approvalSecret,
  });
  assert.equal(result.pullRequest.number,77);
  assert.deepEqual(spy.calls.map(([name])=>name),['verifyRemoteBase','createBranch','commitVerifiedPatch','pushBranch','openPullRequest']);
  assert.equal(chain.m9.artifacts.find(x=>x.name==='screenshot-1').status,'Present');
});

test('specialist Incomplete stays Incomplete instead of fake completion',async()=>{
  const result=await runSequentialSpecialists({
    specialists:[{id:'security',run:async()=>{throw new Error('provider unavailable');}}],
    maxSpecialists:1,maxModelCalls:1,persist:async()=>{},
  });
  assert.equal(result.status,'Incomplete');
  assert.equal(result.results[0].status,'Incomplete');
});

test('rejected repair cannot reach GitHub transport',async(t)=>{
  const chain=await buildVerifiedChain(t);
  const rejected={...chain.m8,verdict:'RejectedRepair'};
  const spy=spyTransport();
  await assert.rejects(createVerifiedRepairPullRequest({
    transport:spy.transport,repository:chain.m5.repository.fullName,baseBranch:'main',runId:chain.m5.id,
    finding:chain.m5.finding,repair:rejected,proof:chain.m9,approvalToken:chain.token,approvalSecret,
  }),/VerifiedRepair/);
  assert.deepEqual(spy.calls,[]);
});

test('missing required artifact cannot reach GitHub transport',async(t)=>{
  const chain=await buildVerifiedChain(t);
  const proof=structuredClone(chain.m9);
  proof.artifacts.find(x=>x.name==='after-verification').status='Missing';
  const spy=spyTransport();
  await assert.rejects(createVerifiedRepairPullRequest({
    transport:spy.transport,repository:chain.m5.repository.fullName,baseBranch:'main',runId:chain.m5.id,
    finding:chain.m5.finding,repair:chain.m8,proof,approvalToken:chain.token,approvalSecret,
  }),/required proof artifact missing/);
  assert.deepEqual(spy.calls,[]);
});

test('missing approval cannot reach GitHub transport',async(t)=>{
  const chain=await buildVerifiedChain(t),spy=spyTransport();
  await assert.rejects(createVerifiedRepairPullRequest({
    transport:spy.transport,repository:chain.m5.repository.fullName,baseBranch:'main',runId:chain.m5.id,
    finding:chain.m5.finding,repair:chain.m8,proof:chain.m9,approvalSecret,
  }),/human PR approval/i);
  assert.deepEqual(spy.calls,[]);
});

test('stale approval after proof mutation cannot reach GitHub transport',async(t)=>{
  const chain=await buildVerifiedChain(t);
  const proof=structuredClone(chain.m9);proof.manifest.sha256='f'.repeat(64);
  const spy=spyTransport();
  await assert.rejects(createVerifiedRepairPullRequest({
    transport:spy.transport,repository:chain.m5.repository.fullName,baseBranch:'main',runId:chain.m5.id,
    finding:chain.m5.finding,repair:chain.m8,proof,approvalToken:chain.token,approvalSecret,
  }),/stale/i);
  assert.deepEqual(spy.calls,[]);
});
