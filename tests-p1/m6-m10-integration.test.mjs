import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runSequentialSpecialists} from '../services/local-specialists.mjs';
import {runRepairVerification} from '../services/local-repair-verification.mjs';
import {LocalArtifactService} from '../services/local-artifact-service.mjs';
import {createVerifiedRepairPullRequest,issuePrApproval} from '../services/verified-repair-pr.mjs';

const approvalSecret='0123456789abcdef0123456789abcdef';
const hash=value=>createHash('sha256').update(value).digest('hex');

function spy(){
  const calls=[];
  return {calls,transport:{
    async verifyRemoteBase(input){calls.push(['verifyRemoteBase',input]);return {ok:true};},
    async createBranch(input){calls.push(['createBranch',input]);return {sha:input.expectedBaseSha};},
    async commitVerifiedPatch(input){calls.push(['commitVerifiedPatch',input]);return {commitSha:'commit-repair'};},
    async pushBranch(input){calls.push(['pushBranch',input]);return {ok:true};},
    async openPullRequest(input){calls.push(['openPullRequest',input]);return {number:77,url:'https://example.test/pull/77'};},
  }};
}

async function buildFixture(t){
  const workspace=await mkdtemp(join(tmpdir(),'verifiai-integration-workspace-'));
  const artifactsRoot=await mkdtemp(join(tmpdir(),'verifiai-integration-artifacts-'));
  t.after(()=>Promise.all([rm(workspace,{recursive:true,force:true}),rm(artifactsRoot,{recursive:true,force:true})]));
  await writeFile(join(workspace,'broken.js'),'export const value = false;\n');

  const specialist=await runSequentialSpecialists({
    specialists:[{id:'security',async run({callModel}){
      const model=await callModel(async()=>({provider:'stub',model:'security-stub'}));
      return {status:'Completed',findings:[{title:'Security observation',severity:'info',evidence:{file:'broken.js'}}],evidenceRefs:['file:broken.js'],model};
    }}],
    maxSpecialists:1,maxModelCalls:1,persist:async()=>{},
  });

  const verify=async({workspacePath})=>{
    const text=await readFile(join(workspacePath,'broken.js'),'utf8');
    const ok=text.includes('value = true');
    return {status:ok?'Completed':'Failed',executed:true,exitCode:ok?0:1,command:'node check',
      stdout:text,stderr:'',durationMs:1,provenance:{kind:'integration-fixture'}};
  };

  const repair=await runRepairVerification({
    workspacePath:workspace,
    finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'value = false',replacement:'value = true'}]},
    verify,
    regressions:[verify],
    timeoutMs:500,
    baseCommitSha:'abc1234',
  });
  assert.equal(repair.verdict,'VerifiedRepair');

  const audit={
    id:'integration-run',
    status:'Incomplete',
    startedAt:'start',finishedAt:'finish',durationMs:10,failedStage:'execution',
    stages:{clone:{status:'Completed'},analysis:{status:'Completed'},sandbox:{status:'Completed'},execution:{status:'Failed'},finding:{status:'Completed'},cleanup:{status:'Completed'}},
    repository:{fullName:'owner/repo',commit:'abc1234'},
    finding:{title:'Broken value',severity:'high',description:'Fixture failure',evidence:{file:'broken.js'}},
    specialists:specialist,
    execution:{status:'Failed',executed:true,exitCode:1,command:'node check',stdout:'false',stderr:'',durationMs:1},
    cleanup:{repositoryRemoved:true,sandboxRemoved:true},
    model:{provider:'stub',model:'base-stub'},
  };
  const artifacts=new LocalArtifactService({env:{VERIFIAI_ARTIFACT_DIR:artifactsRoot}});
  const proof=await artifacts.refresh(audit,{repair});
  return {audit,specialist,repair,proof};
}

test('M5-shaped audit composes through M6 -> M8 -> M9 -> explicit M10 approval -> PR spy',async(t)=>{
  const {audit,specialist,repair,proof}=await buildFixture(t);
  assert.equal(specialist.status,'Completed');
  assert.equal(specialist.modelCalls,1);
  assert.equal(repair.before.exitCode,1);
  assert.equal(repair.after.exitCode,0);
  assert.equal(repair.regressions[0].exitCode,0);
  assert.ok(proof.manifest.sha256);
  assert.equal(proof.artifacts.find(x=>x.name==='repair').status,'Present');

  const s=spy();
  const token=issuePrApproval({secret:approvalSecret,runId:audit.id,repository:audit.repository.fullName,baseBranch:'main',repair,proof});
  const result=await createVerifiedRepairPullRequest({
    transport:s.transport,repository:audit.repository.fullName,baseBranch:'main',runId:audit.id,
    finding:audit.finding,repair,proof,approvalToken:token,approvalSecret,
  });
  assert.equal(result.pullRequest.number,77);
  assert.deepEqual(s.calls.map(x=>x[0]),['verifyRemoteBase','createBranch','commitVerifiedPatch','pushBranch','openPullRequest']);
});

test('specialist Incomplete remains Incomplete and cannot masquerade as completion',async()=>{
  const result=await runSequentialSpecialists({
    specialists:[{id:'security',async run(){throw new Error('provider unavailable');}}],
    maxSpecialists:1,maxModelCalls:1,persist:async()=>{},
  });
  assert.equal(result.status,'Incomplete');
  assert.equal(result.results[0].status,'Incomplete');
  assert.match(result.results[0].error,/provider unavailable/);
});

test('rejected repair causes zero GitHub transport calls',async(t)=>{
  const {audit,repair,proof}=await buildFixture(t);
  const rejected={...repair,verdict:'RejectedRepair'};
  const s=spy();
  await assert.rejects(createVerifiedRepairPullRequest({
    transport:s.transport,repository:audit.repository.fullName,baseBranch:'main',runId:audit.id,
    finding:audit.finding,repair:rejected,proof,approvalToken:'x',approvalSecret,
  }),/VerifiedRepair/);
  assert.deepEqual(s.calls,[]);
});

test('missing required artifact causes zero GitHub transport calls',async(t)=>{
  const {audit,repair,proof}=await buildFixture(t);
  const brokenProof=structuredClone(proof);
  brokenProof.artifacts=brokenProof.artifacts.filter(x=>x.name!=='after-verification');
  const s=spy();
  await assert.rejects(createVerifiedRepairPullRequest({
    transport:s.transport,repository:audit.repository.fullName,baseBranch:'main',runId:audit.id,
    finding:audit.finding,repair,proof:brokenProof,approvalToken:'x',approvalSecret,
  }),/required proof artifact missing/i);
  assert.deepEqual(s.calls,[]);
});

test('missing approval causes zero GitHub transport calls',async(t)=>{
  const {audit,repair,proof}=await buildFixture(t);
  const s=spy();
  await assert.rejects(createVerifiedRepairPullRequest({
    transport:s.transport,repository:audit.repository.fullName,baseBranch:'main',runId:audit.id,
    finding:audit.finding,repair,proof,approvalSecret,
  }),/approval/i);
  assert.deepEqual(s.calls,[]);
});

test('approval bound to patch A becomes stale if caller swaps to patch B',async(t)=>{
  const {audit,repair,proof}=await buildFixture(t);
  const token=issuePrApproval({secret:approvalSecret,runId:audit.id,repository:audit.repository.fullName,baseBranch:'main',repair,proof});
  const changed=structuredClone(repair);
  changed.patch={files:[{path:'broken.js',expected:'value = false',replacement:'value = dangerous'}]};
  changed.patchDigest=hash(JSON.stringify(changed.patch));
  changed.changedFiles=[{...changed.changedFiles[0],afterHash:hash('export const value = dangerous;\n')}];
  const s=spy();
  await assert.rejects(createVerifiedRepairPullRequest({
    transport:s.transport,repository:audit.repository.fullName,baseBranch:'main',runId:audit.id,
    finding:audit.finding,repair:changed,proof,approvalToken:token,approvalSecret,
  }),/stale/i);
  assert.deepEqual(s.calls,[]);
});
