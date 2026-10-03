import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPrService} from '../services/local-pr-service.mjs';

test('LocalPrService publishes only server-owned repair/proof after explicit create()',async()=>{
  const audit={id:'run',repository:{fullName:'owner/repo'},finding:{title:'Bug'}};
  const repair={verdict:'VerifiedRepair',verifiedBaseCommitSha:'abcdef1234567890',
    patch:{files:[{path:'x',expected:'a',replacement:'b'}]},
    patchDigest:'x',changedFiles:[],before:{status:'Failed',executed:true,exitCode:1,command:'check'},after:{status:'Completed',executed:true,exitCode:0,command:'check'},
    regressions:[{status:'Completed',executed:true,exitCode:0,command:'regression'}],originalUnchanged:true,cleanup:{candidateRemoved:true}};
  const proof={manifest:{id:'proof:run:manifest',sha256:'a'.repeat(64)},artifacts:[]};
  const audits={get:()=>audit},repairs={get:()=>repair},artifacts={get:()=>proof};
  let factoryInput;
  const service=new LocalPrService(audits,repairs,artifacts,{
    env:{VERIFIAI_PR_APPROVAL_SECRET:'0123456789abcdef0123456789abcdef',VERIFIAI_GITHUB_TOKEN:'token'},
    transportFactory:(input)=>{factoryInput=input;return {};},
  });
  await assert.rejects(service.create('run'),/patch digest|proof/i);
  assert.deepEqual(factoryInput,undefined,'transport is not created before structural proof gates pass');
});

test('LocalPrService requires configured approval secret and GitHub token before any transport',async()=>{
  const service=new LocalPrService({get:()=>({id:'x',repository:{fullName:'owner/repo'}})},{get:()=>({})},{get:()=>({})},{
    env:{},transportFactory:()=>{throw new Error('must not construct transport');},
  });
  await assert.rejects(service.create('x'),/approval secret|verified repair|proof/i);
});


test('LocalPrService explicit create uses stored repair/proof and never caller patch input',async()=>{
  const {createHash}=await import('node:crypto');
  const hash=(s)=>createHash('sha256').update(s).digest('hex');
  const patch={files:[{path:'x',expected:'a',replacement:'b'}]};
  const repair={verdict:'VerifiedRepair',verifiedBaseCommitSha:'abcdef1234567890',patch,patchDigest:hash(JSON.stringify(patch)),
    changedFiles:[{path:'x',beforeHash:'1'.repeat(64),afterHash:'2'.repeat(64)}],
    before:{status:'Failed',executed:true,exitCode:1,command:'check'},after:{status:'Completed',executed:true,exitCode:0,command:'check'},
    regressions:[{status:'Completed',executed:true,exitCode:0,command:'regression'}],originalUnchanged:true,cleanup:{candidateRemoved:true}};
  const names=['run','repository','repair','repair-diff','before-verification','after-verification','regressions'];
  const proof={manifest:{id:'proof:run:manifest',sha256:'a'.repeat(64)},artifacts:names.map((name,i)=>({name,status:'Present',path:name+'.json',sha256:String(i+1).repeat(64).slice(0,64)}))};
  const calls=[];
  const transport={
    async verifyRemoteBase(x){calls.push(['verify',x]);},
    async createBranch(x){calls.push(['branch',x]);return {sha:x.expectedBaseSha};},
    async commitVerifiedPatch(x){calls.push(['commit',x]);return {commitSha:'c'};},
    async pushBranch(x){calls.push(['push',x]);},
    async openPullRequest(x){calls.push(['pr',x]);return {number:1,url:'u'};},
  };
  const service=new LocalPrService({get:()=>({id:'run',repository:{fullName:'owner/repo'},finding:{title:'Bug'}})},{get:()=>repair},{get:()=>proof},{
    env:{VERIFIAI_PR_APPROVAL_SECRET:'0123456789abcdef0123456789abcdef',VERIFIAI_GITHUB_TOKEN:'token'},
    transportFactory:()=>transport,
  });
  const result=await service.create('run');
  assert.equal(result.pullRequest.number,1);
  assert.deepEqual(calls.map(x=>x[0]),['verify','branch','commit','push','pr']);
  assert.deepEqual(calls.find(x=>x[0]==='commit')[1].patch,patch);
});
