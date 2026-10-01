import test from 'node:test';
import assert from 'node:assert/strict';
import {createVerifiedRepairPullRequest} from '../services/verified-repair-pr.mjs';

function verifiedRepair() {
  return {
    verdict:'VerifiedRepair',
    before:{status:'Failed',exitCode:1,stderr:'before failed'},
    after:{status:'Completed',exitCode:0,stdout:'after passed'},
    regressions:[{status:'Completed',exitCode:0}],
    patch:{files:[{path:'src/example.js',expected:'false',replacement:'true'}]},
    originalUnchanged:true,
    cleanup:{candidateRemoved:true},
    diff:'--- a/src/example.js\n+++ b/src/example.js\n-false\n+true\n',
  };
}

test('PR creation is blocked unless the repair is fully verified', async () => {
  const calls=[];
  const transport={
    createBranch:async()=>calls.push('createBranch'),
    commitVerifiedPatch:async()=>calls.push('commitVerifiedPatch'),
    pushBranch:async()=>calls.push('pushBranch'),
    openPullRequest:async()=>calls.push('openPullRequest'),
  };
  await assert.rejects(
    createVerifiedRepairPullRequest({
      transport,
      repository:'owner/repo',
      baseBranch:'main',
      runId:'run-1',
      finding:{title:'bug',description:'problem'},
      repair:{...verifiedRepair(),verdict:'RejectedRepair'},
      artifactRefs:['proof/run-1/manifest.json'],
    }),
    /VerifiedRepair/,
  );
  await assert.rejects(
    createVerifiedRepairPullRequest({
      transport,
      repository:'owner/repo',
      baseBranch:'main',
      runId:'run-2',
      finding:{title:'bug',description:'problem'},
      repair:{...verifiedRepair(),after:{status:'Incomplete'}},
      artifactRefs:[],
    }),
    /after verification/i,
  );
  assert.deepEqual(calls,[]);
});

test('verified repair creates branch, commit, push, and PR in order with proof body', async () => {
  const calls=[];
  const transport={
    async createBranch(input){calls.push(['createBranch',input]); return {sha:'base-sha'};},
    async commitVerifiedPatch(input){calls.push(['commitVerifiedPatch',input]); return {commitSha:'repair-sha'};},
    async pushBranch(input){calls.push(['pushBranch',input]); return {ok:true};},
    async openPullRequest(input){calls.push(['openPullRequest',input]); return {number:123,url:'https://github.com/owner/repo/pull/123'};},
    async mergePullRequest(){calls.push(['mergePullRequest']);},
  };
  const result=await createVerifiedRepairPullRequest({
    transport,
    repository:'owner/repo',
    baseBranch:'main',
    runId:'run-verified-123',
    finding:{title:'Boolean bug',description:'Original behavior is wrong'},
    repair:verifiedRepair(),
    artifactRefs:['proof/run-verified-123/manifest.json','proof/run-verified-123/after.json'],
  });
  assert.deepEqual(calls.map(([name])=>name),['createBranch','commitVerifiedPatch','pushBranch','openPullRequest']);
  assert.equal(result.pullRequest.number,123);
  assert.match(result.branch,/^verifiai\/repair-/);
  const body=calls.at(-1)[1].body;
  assert.match(body,/Boolean bug/);
  assert.match(body,/before failed/);
  assert.match(body,/after passed/);
  assert.match(body,/regression/i);
  assert.match(body,/proof\/run-verified-123\/manifest\.json/);
  assert.doesNotMatch(body,/auto.?merge/i);
});
