import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPrService} from '../services/local-pr-service.mjs';

test('LocalPrService publishes only server-owned repair/proof after explicit create()',async()=>{
  const audit={id:'run',repository:{fullName:'owner/repo'},finding:{title:'Bug'}};
  const repair={verdict:'VerifiedRepair',verifiedBaseCommitSha:'abcdef1234567890',
    patch:{files:[{path:'x',expected:'a',replacement:'b'}]},
    patchDigest:'x',changedFiles:[],before:{status:'Failed',executed:true,exitCode:1},after:{status:'Completed',executed:true,exitCode:0},
    regressions:[],originalUnchanged:true,cleanup:{candidateRemoved:true}};
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
