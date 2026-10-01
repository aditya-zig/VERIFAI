import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalRepairService} from '../services/local-repair-service.mjs';

test('repair service rejects audits without executed failure before cloning',async()=>{
  let clones=0;
  const audits={get:()=>({id:'a',repository:{fullName:'owner/repo',commit:'abc'},execution:{status:'Completed',exitCode:0}})};
  const repos={async clone(){clones++;}};
  const service=new LocalRepairService(repos,audits);
  await assert.rejects(service.repair('a',{files:[]}),/real failed execution/i);
  assert.equal(clones,0);
});

test('repair service pins exact commit and cleans reacquired clone',async()=>{
  let cleaned=0,runInput;
  const audit={id:'a',repository:{fullName:'owner/repo',commit:'abc123'},execution:{status:'Failed',exitCode:1},selectedCommand:'node --check broken.js'};
  const record={id:'r',repository:{fullName:'owner/repo',commit:'abc123'},clone:{workspacePath:'/tmp/fake'},files:{items:['broken.js']}};
  const repos={async clone(){return record;},async cleanup(){cleaned++;}};
  const service=new LocalRepairService(repos,{get:()=>audit},{
    select:async()=>({executable:'node',args:['--check','broken.js'],source:'fixture'}),
    execute:async()=>({status:'Failed',exitCode:1,sandbox:{started:true}}),
    runRepair:async(input)=>{runInput=input;return {verdict:'RejectedRepair',cleanup:{candidateRemoved:true}};},
  });
  const result=await service.repair('a',{files:[{path:'broken.js',expected:'x',replacement:'y'}]});
  assert.equal(result.verdict,'RejectedRepair');
  assert.equal(runInput.baseCommitSha,'abc123');
  assert.equal(runInput.regressions.length,1);
  assert.equal(cleaned,1);
});

test('repair service rejects changed remote HEAD and cleans clone',async()=>{
  let cleaned=0;
  const audit={repository:{fullName:'owner/repo',commit:'old'},execution:{status:'Failed',exitCode:1},selectedCommand:'node --check broken.js'};
  const repos={async clone(){return {id:'r',repository:{fullName:'owner/repo',commit:'new'},clone:{workspacePath:'/tmp/fake'},files:{items:['broken.js']}};},async cleanup(){cleaned++;}};
  const service=new LocalRepairService(repos,{get:()=>audit});
  await assert.rejects(service.repair('a',{files:[]}),/HEAD changed/i);
  assert.equal(cleaned,1);
});
