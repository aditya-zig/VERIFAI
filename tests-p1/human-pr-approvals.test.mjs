// Service tests for the server-side single-use human approval store
// (services/human-pr-approvals.mjs): approvals are issued to authenticated
// human principals only, bind to the changing evidence via digest, expire
// after 15 minutes and are single-use.
import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalHumanApprovalsService} from '../services/human-pr-approvals.mjs';

const human={id:'operator-human',kind:'human',repositories:['owner/repo']};
const agent={id:'worker-agent',kind:'agent',repositories:['owner/repo']};
const completeEvidence=()=>({
  auditId:'run1',repository:'owner/repo',baseBranch:'main',
  repair:{verdict:'VerifiedRepair',patchDigest:'d'.repeat(64),verifiedBaseCommitSha:'abc1234'},
  proof:{manifest:{id:'proof:run1:manifest',sha256:'a'.repeat(64)},artifacts:[]},
  browser:null,
});

const expectHttpError=(call,statusCode,pattern)=>assert.throws(call,error=>{
  assert.ok(pattern.test(String(error?.message)),`message "${String(error?.message)}" must match ${pattern}`);
  assert.equal(error?.statusCode,statusCode,`status must be ${statusCode}, saw ${error?.statusCode}`);
  return true;
});

test('approvals service requires an evidence provider and fails closed',()=>{
  assert.throws(()=>new LocalHumanApprovalsService({}),/evidenceProvider/);
});

test('agent principals cannot issue a human approval',()=>{
  const approvals=new LocalHumanApprovalsService({evidenceProvider:completeEvidence});
  expectHttpError(()=>approvals.issue({principal:agent,auditId:'run1'}),403,/human principals may approve/);
  assert.equal(approvals.outstandingCount(),0,'a refused approval must create no record');
});

test('human approval is issued single-use, bound and expiring in 15 minutes',()=>{
  let clock=1_000_000;
  const approvals=new LocalHumanApprovalsService({evidenceProvider:completeEvidence,now:()=>clock});
  const issued=approvals.issue({principal:human,auditId:'run1'});
  assert.match(issued.approvalId,/^[a-f0-9-]{36}$/);
  assert.equal(issued.auditId,'run1');
  assert.equal(issued.principalId,'operator-human');
  assert.equal(issued.expiresAt,1_000_000+15*60*1000);
  const binding=approvals.verifyPublicationBinding({principal:human,auditId:'run1',approvalId:issued.approvalId});
  assert.equal(binding.repository,'owner/repo');
  assert.equal(binding.baseBranch,'main');
  expectHttpError(()=>approvals.verifyPublicationBinding({principal:human,auditId:'run1',approvalId:issued.approvalId}),409,/already consumed/);
  assert.equal(approvals.get(issued.approvalId).consumed,true);
});

test('approval requires complete and present evidence before issue',()=>{
  const approvals=new LocalHumanApprovalsService({evidenceProvider:auditId=>auditId==='run1'?null:undefined});
  expectHttpError(()=>approvals.issue({principal:human,auditId:'run1'}),409,/verified repair and proof/);
});

test('expired approval is refused 410, reused is refused 409',()=>{
  let clock=5_000_000;
  const approvals=new LocalHumanApprovalsService({evidenceProvider:completeEvidence,now:()=>clock});
  const issued=approvals.issue({principal:human,auditId:'run1'});
  clock=5_000_000+15*60*1000+1;
  expectHttpError(()=>approvals.verifyPublicationBinding({principal:human,auditId:'run1',approvalId:issued.approvalId}),410,/expired/);
});

test('evidence change after approval makes it stale 409',()=>{
  let repair={verdict:'VerifiedRepair',patchDigest:'d'.repeat(64),verifiedBaseCommitSha:'abc1234'};
  const approvals=new LocalHumanApprovalsService({evidenceProvider:()=>({
    auditId:'run1',repository:'owner/repo',baseBranch:'main',repair,
    proof:{manifest:{id:'proof:run1:manifest',sha256:'a'.repeat(64)},artifacts:[]},browser:null})});
  const issued=approvals.issue({principal:human,auditId:'run1'});
  repair={...repair,patchDigest:'e'.repeat(64)};
  expectHttpError(()=>approvals.verifyPublicationBinding({principal:human,auditId:'run1',approvalId:issued.approvalId}),409,/stale|evidence changed/);
  assert.equal(approvals.get(issued.approvalId).consumed,false,'stale approval is not consumed');
  expectHttpError(()=>approvals.verifyPublicationBinding({principal:agent,auditId:'run1',approvalId:issued.approvalId}),403,/different principal/);
  expectHttpError(()=>approvals.verifyPublicationBinding({principal:human,auditId:'run2',approvalId:issued.approvalId}),403,/different audit/);
  expectHttpError(()=>approvals.verifyPublicationBinding({principal:human,auditId:'run1',approvalId:'no-such-id'}),404,/unknown approval id/);
  expectHttpError(()=>approvals.verifyPublicationBinding({principal:human,auditId:'run1',approvalId:undefined}),400,/approvalId is required/);
});
