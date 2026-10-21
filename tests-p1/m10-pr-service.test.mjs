import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LocalPrService} from '../services/local-pr-service.mjs';
import {LocalHumanApprovalsService} from '../services/human-pr-approvals.mjs';

const HUMAN={id:'operator-human',kind:'human',repositories:['owner/repo']};
const AGENT={id:'worker-agent',kind:'agent',repositories:['owner/repo']};

const expectHttpError=async(call,statusCode,pattern,messageSuffix='')=>{
  let captured;
  try{await call();}catch(error){captured=error;}
  assert.ok(captured,`${messageSuffix}expected a rejection`);
  assert.ok(pattern.test(String(captured?.message)),`${messageSuffix}message "${String(captured?.message)}" must match ${pattern}`);
  assert.equal(captured?.statusCode,statusCode,`${messageSuffix}status must be ${statusCode}, saw ${captured?.statusCode}`);
};

function verifiedRepairFixture(){
  const hash=(s)=>createHash('sha256').update(s).digest('hex');
  const patch={files:[{path:'x',expected:'a',replacement:'b'}]};
  return {verdict:'VerifiedRepair',verifiedBaseCommitSha:'abcdef1234567890',patch,patchDigest:hash(JSON.stringify(patch)),
    changedFiles:[{path:'x',beforeHash:'1'.repeat(64),afterHash:'2'.repeat(64)}],
    before:{status:'Failed',executed:true,exitCode:1,command:'check'},after:{status:'Completed',executed:true,exitCode:0,command:'check'},
    regressions:[{status:'Completed',executed:true,exitCode:0,command:'regression'}],originalUnchanged:true,cleanup:{candidateRemoved:true}};
}

function proofFixture(){
  const names=['run','repository','repair','repair-diff','before-verification','after-verification','regressions'];
  return {manifest:{id:'proof:run:manifest',sha256:'a'.repeat(64)},artifacts:names.map((name,i)=>({name,status:'Present',path:name+'.json',sha256:String(i+1).repeat(64).slice(0,64)}))};
}

function baselineAuditStore(){
  const audit={id:'run',repository:{fullName:'owner/repo'},finding:{title:'Bug'}};
  return {get:()=>audit};
}

function controlledTransport(){
  const calls=[];
  const transport={
    calls,
    async verifyRemoteBase(x){calls.push(['verify',x]);},
    async createBranch(x){calls.push(['branch',x]);return {sha:x.expectedBaseSha};},
    async commitVerifiedPatch(x){calls.push(['commit',x]);return {commitSha:'c'};},
    async pushBranch(x){calls.push(['push',x]);},
    async openPullRequest(x){calls.push(['pr',x]);return {number:1,url:'u'};},
  };
  return transport;
}

function buildApprovals(){
  return new LocalHumanApprovalsService({evidenceProvider:()=>({
    auditId:'run',repository:'owner/repo',baseBranch:'main',repair:verifiedRepairFixture(),proof:proofFixture(),browser:null})});
}

const PR_ENV={VERIFIAI_PR_APPROVAL_SECRET:'0123456789abcdef0123456789abcdef',VERIFIAI_GITHUB_TOKEN:'token'};

test('LocalPrService never publishes without an authenticated human principal',async()=>{
  let transportFactoryCalls=0;
  const service=new LocalPrService(baselineAuditStore(),{get:()=>({})},{get:()=>({})},{
    env:PR_ENV,transportFactory:()=>{transportFactoryCalls+=1;return {};},
  });
  expectHttpError(()=>service.create('run'),401,/authenticated human principal/,'publishing requires identity: ');
  expectHttpError(()=>service.create('run',{principal:AGENT,approvals:{}}),403,/only human principals may publish/,'agent must be refused: ');
  assert.equal(transportFactoryCalls,0,'no transport may be constructed for refused publication');
});

test('LocalPrService requires a consumed human approval service, scope and secrets before transport',async()=>{
  let transportFactoryCalls=0;
  const service=new LocalPrService(baselineAuditStore(),{get:()=>verifiedRepairFixture()},{get:()=>proofFixture()},{
    env:PR_ENV,transportFactory:()=>{transportFactoryCalls+=1;return controlledTransport();},
  });
  const approvals=buildApprovals();
  expectHttpError(()=>service.create('run',{principal:HUMAN,approvalId:'no-such-approval'}),503,/human approval service/,'approvals missing: ');
  const unscoped={...HUMAN,repositories:['other/repo']};
  expectHttpError(()=>service.create('run',{principal:unscoped,approvals,approvalId:'no-such-approval'}),403,/repository scope/,'scope missing: ');
  expectHttpError(()=>service.create('run',{principal:HUMAN,approvals,approvalId:'no-such-approval'}),404,/unknown approval/,'unknown approval: ');
  expectHttpError(()=>service.create('run',{principal:HUMAN,approvals}),400,/approvalId is required/,'approvalId missing: ');
  const secretsService=new LocalPrService(baselineAuditStore(),{get:()=>verifiedRepairFixture()},{get:()=>proofFixture()},{
    env:{},transportFactory:()=>{transportFactoryCalls+=1;return controlledTransport();},
  });
  const issued=approvals.issue({principal:HUMAN,auditId:'run'});
  expectHttpError(()=>secretsService.create('run',{principal:HUMAN,approvals,approvalId:issued.approvalId}),503,/approval secret|token/,'secrets missing: ');
  assert.equal(transportFactoryCalls,0,'no transport may be constructed while identity, evidence or secrets refuse publication');
});

test('LocalPrService explicit create uses stored repair/proof and consumes the human approval',async()=>{
  const patch=verifiedRepairFixture().patch;
  const transport=controlledTransport();
  const service=new LocalPrService({get:()=>({id:'run',repository:{fullName:'owner/repo'},finding:{title:'Bug'}})},{get:()=>verifiedRepairFixture()},{get:()=>proofFixture()},{
    env:PR_ENV,transportFactory:()=>transport,
  });
  const approvals=buildApprovals();
  const approval=approvals.issue({principal:HUMAN,auditId:'run'});
  const result=await service.create('run',{principal:HUMAN,approvalId:approval.approvalId,approvals});
  assert.equal(result.pullRequest.number,1);
  assert.deepEqual(transport.calls.map(x=>x[0]),['verify','branch','commit','push','pr']);
  assert.deepEqual(transport.calls.find(x=>x[0]==='commit')[1].patch,patch,'the published patch is the server-owned repair patch');
  assert.equal(result.approval.humanApproved,true,'a publication consuming a human approval records the fact');
  assert.equal(result.approval.approvalId,approval.approvalId);
  assert.equal(result.approval.principalId,'operator-human');
  assert.equal(result.approval.issuedBy,'local-service');
  assert.equal(result.principal.id,'operator-human');
  expectHttpError(()=>service.create('run',{principal:HUMAN,approvalId:approval.approvalId,approvals}),409,/already consumed/,'replay must be refused: ');
  expectHttpError(()=>service.create('run',{principal:HUMAN,approvalId:'no-such-approval',approvals}),404,/unknown approval/,'a stray id must be refused: ');
});

test('LocalPrService refuses stale approvals after evidence change and never constructs a transport',async()=>{
  let transportFactoryCalls=0;
  const repair=verifiedRepairFixture();
  const approvals=new LocalHumanApprovalsService({evidenceProvider:()=>({
    auditId:'run',repository:'owner/repo',baseBranch:'main',repair:{...repair},proof:proofFixture(),browser:null})});
  const service=new LocalPrService(baselineAuditStore(),{get:()=>repair},{get:()=>proofFixture()},{
    env:PR_ENV,transportFactory:()=>{transportFactoryCalls+=1;return controlledTransport();},
  });
  const approval=approvals.issue({principal:HUMAN,auditId:'run'});
  repair.verifiedBaseCommitSha='ffffff'+'0'.repeat(10);
  expectHttpError(()=>service.create('run',{principal:HUMAN,approvalId:approval.approvalId,approvals}),409,/stale|changed/,'stale approval: ');
  assert.equal(transportFactoryCalls,0,'no transport may be constructed for stale approval');
});
