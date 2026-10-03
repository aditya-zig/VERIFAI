import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createVerifiedRepairPullRequest,issuePrApproval} from '../services/verified-repair-pr.mjs';

const secret='0123456789abcdef0123456789abcdef';
const hash=(s)=>createHash('sha256').update(s).digest('hex');
const patchA={files:[{path:'src/example.js',expected:'false',replacement:'true'}]};
const beforeText='export const value = false;\n',afterText='export const value = true;\n';
function repair(){
  return {verdict:'VerifiedRepair',verifiedBaseCommitSha:'abcdef1234567890',patch:structuredClone(patchA),patchDigest:hash(JSON.stringify(patchA)),
    changedFiles:[{path:'src/example.js',beforeHash:hash(beforeText),afterHash:hash(afterText)}],
    before:{status:'Failed',executed:true,exitCode:1,command:'check',stderr:'before failed'},
    after:{status:'Completed',executed:true,exitCode:0,command:'check',stdout:'after passed'},
    regressions:[{status:'Completed',executed:true,exitCode:0,command:'regression'}],
    originalUnchanged:true,cleanup:{candidateRemoved:true}};
}
function proof(){
  const names=['run','repository','repair','repair-diff','before-verification','after-verification','regressions'];
  return {manifest:{id:'proof:run:manifest',sha256:'a'.repeat(64)},artifacts:names.map((name,i)=>({name,status:'Present',path:name+'.json',sha256:String(i+1).repeat(64).slice(0,64)}))};
}
function spy({stale=false}={}){
  const calls=[];
  return {calls,transport:{
    async verifyRemoteBase(input){calls.push(['verifyRemoteBase',input]);if(stale)throw new Error('stale-base: changed');return {ok:true};},
    async createBranch(input){calls.push(['createBranch',input]);return {sha:input.expectedBaseSha};},
    async commitVerifiedPatch(input){calls.push(['commitVerifiedPatch',input]);return {commitSha:'repair-sha'};},
    async pushBranch(input){calls.push(['pushBranch',input]);return {ok:true};},
    async openPullRequest(input){calls.push(['openPullRequest',input]);return {number:123,url:'https://example/pull/123'};},
  }};
}
function args(r=repair(),p=proof()){
  return {repository:'owner/repo',baseBranch:'main',runId:'run-verified',finding:{title:'Bug',description:'Problem'},repair:r,proof:p,approvalSecret:secret};
}

test('negative probe: no approval + nonzero AFTER/regression + missing proof causes ZERO transport calls',async()=>{
  const r=repair();r.after.exitCode=1;r.regressions[0].exitCode=1;
  const s=spy();
  await assert.rejects(createVerifiedRepairPullRequest({...args(r,{manifest:null,artifacts:[]}),transport:s.transport}),/AFTER|proof|approval/i);
  assert.deepEqual(s.calls,[]);
});

test('approval for patch A becomes invalid after caller swaps to patch B',async()=>{
  const r=repair(),p=proof();
  const token=issuePrApproval({secret,runId:'run-verified',repository:'owner/repo',baseBranch:'main',repair:r,proof:p});
  const swapped=structuredClone(r);
  swapped.patch={files:[{path:'src/example.js',expected:'false',replacement:'dangerous'}]};
  swapped.patchDigest=hash(JSON.stringify(swapped.patch));
  const s=spy();
  await assert.rejects(createVerifiedRepairPullRequest({...args(swapped,p),approvalToken:token,transport:s.transport}),/stale/i);
  assert.deepEqual(s.calls,[]);
});

test('remote base changed after approval stops before branch/commit/push/PR writes',async()=>{
  const r=repair(),p=proof(),s=spy({stale:true});
  const token=issuePrApproval({secret,runId:'run-verified',repository:'owner/repo',baseBranch:'main',repair:r,proof:p});
  await assert.rejects(createVerifiedRepairPullRequest({...args(r,p),approvalToken:token,transport:s.transport}),/stale-base/i);
  assert.deepEqual(s.calls.map(x=>x[0]),['verifyRemoteBase']);
});

test('verified immutable repair + proof + explicit bound approval writes in order',async()=>{
  const r=repair(),p=proof(),s=spy();
  const token=issuePrApproval({secret,runId:'run-verified',repository:'owner/repo',baseBranch:'main',repair:r,proof:p});
  const result=await createVerifiedRepairPullRequest({...args(r,p),approvalToken:token,transport:s.transport});
  assert.deepEqual(s.calls.map(x=>x[0]),['verifyRemoteBase','createBranch','commitVerifiedPatch','pushBranch','openPullRequest']);
  assert.equal(result.pullRequest.number,123);
  assert.deepEqual(s.calls[2][1].patch,r.patch);
  assert.match(s.calls.at(-1)[1].body,/Human approval was bound/);
});

test('approval is bound to proof manifest digest',async()=>{
  const r=repair(),p=proof(),token=issuePrApproval({secret,runId:'run-verified',repository:'owner/repo',baseBranch:'main',repair:r,proof:p});
  const changed=structuredClone(p);changed.manifest.sha256='b'.repeat(64);
  const s=spy();
  await assert.rejects(createVerifiedRepairPullRequest({...args(r,changed),approvalToken:token,transport:s.transport}),/stale/i);
  assert.deepEqual(s.calls,[]);
});

test('invalid verification facts block approval and all GitHub calls',async t=>{
  const cases=[
    ['missing regressions',r=>{r.regressions=[];}],
    ['different after command',r=>{r.after.command='node --version';}],
    ['missing regression command',r=>{delete r.regressions[0].command;}],
    ['timeout despite pass',r=>{r.after.timedOut=true;}],
    ['cancelled despite pass',r=>{r.regressions[0].aborted=true;}],
    ['wrong verified file',r=>{r.changedFiles[0].path='src/other.js';}],
  ];
  for(const [name,mutate]of cases)await t.test(name,async()=>{
    const r=repair(),p=proof(),s=spy();
    const token=issuePrApproval({secret,...args(r,p)});
    mutate(r);
    assert.throws(()=>issuePrApproval({secret,...args(r,p)}),/verification|regression|command|file/i);
    await assert.rejects(createVerifiedRepairPullRequest({...args(r,p),approvalToken:token,transport:s.transport}));
    assert.deepEqual(s.calls,[]);
  });
});

test('changing passing evidence or proof metadata invalidates approval',async t=>{
  for(const [name,mutate]of [
    ['output',(r,p)=>{r.after.stdout='different check output';}],
    ['provenance',(r,p)=>{r.after.provenance={commit:'different-revision'};}],
    ['file hash',(r,p)=>{r.changedFiles[0].afterHash='f'.repeat(64);}],
    ['artifact path',(r,p)=>{p.artifacts[0].path='other-run.json';}],
  ])await t.test(name,async()=>{
    const r=repair(),p=proof(),s=spy();
    const token=issuePrApproval({secret,...args(r,p)});
    mutate(r,p);
    await assert.rejects(createVerifiedRepairPullRequest({...args(r,p),approvalToken:token,transport:s.transport}),/stale/i);
    assert.deepEqual(s.calls,[]);
  });
});

test('caller mutation during a GitHub read cannot swap the approved candidate',async()=>{
  const r=repair(),p=proof(),s=spy();
  const token=issuePrApproval({secret,...args(r,p)});
  const read=s.transport.verifyRemoteBase;
  s.transport.verifyRemoteBase=async input=>{
    await read(input);
    r.patch.files[0].replacement='unverified';
    r.after.stdout='unverified evidence';
    p.artifacts[0].path='unapproved artifact';
  };
  await createVerifiedRepairPullRequest({...args(r,p),approvalToken:token,transport:s.transport});
  assert.equal(s.calls.find(x=>x[0]==='commitVerifiedPatch')[1].patch.files[0].replacement,'true');
  const body=s.calls.at(-1)[1].body;
  assert.match(body,/after passed/);
  assert.doesNotMatch(body,/unverified|unapproved/);
});
