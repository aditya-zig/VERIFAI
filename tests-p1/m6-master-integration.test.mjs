import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MasterAuditService} from '../services/master-audit.mjs';

function fakeExecution() {
  return {command:'node --version',stdout:'v22\n',stderr:'',exitCode:0,status:'Completed',timedOut:false,
    sandbox:{name:'stub',started:true,removed:true}};
}
async function makeRepos() {
  const path=await mkdtemp(join(tmpdir(),'verifiai-m6-master-'));
  const record={id:'repo-1',repository:{fullName:'owner/repo'},clone:{success:true,workspacePath:path},
    files:{count:1,items:['README.md'],truncated:false,languages:[]}};
  return {
    record,
    async clone(){return record;},
    async cleanup(){await rm(path,{recursive:true,force:true});return true;},
  };
}

test('M6 disabled keeps M5 shape and never calls the security specialist', async () => {
  const repositories=await makeRepos();
  let securityCalls=0;
  const service=new MasterAuditService(repositories,{
    env:{VERIFIAI_M6_SECURITY_SPECIALIST:'false'},
    analyze:async()=>({finding:{title:'base',severity:'info',description:'base',evidence:{file:'README.md'}},model:{provider:'stub',model:'base'}}),
    select:async()=>({executable:'node',args:['--version'],source:'fixture'}),
    execute:async()=>fakeExecution(),
    securityReview:async()=>{securityCalls+=1;throw new Error('must not run');},
    persistSpecialists:async()=>{throw new Error('must not persist');},
  });
  const {id}=service.start('https://github.com/owner/repo');
  await service.waitForIdle();
  const run=service.get(id);
  assert.equal(run.status,'Completed');
  assert.equal(securityCalls,0);
  assert.equal(run.specialists,undefined);
  assert.equal(run.model.calls,1);
});

test('M6 enabled runs one security model specialist and persists before cleanup', async () => {
  const repositories=await makeRepos();
  const events=[];
  const snapshots=[];
  const service=new MasterAuditService(repositories,{
    env:{VERIFIAI_M6_SECURITY_SPECIALIST:'true'},
    analyze:async()=>({finding:{title:'base',severity:'info',description:'base',evidence:{file:'README.md'}},model:{provider:'stub',model:'base'}}),
    select:async()=>({executable:'node',args:['--version'],source:'fixture'}),
    execute:async()=>fakeExecution(),
    securityReview:async()=> {
      events.push('security');
      return {status:'Completed',findings:[{title:'security',severity:'low',description:'review',evidence:{file:'README.md'}}],
        evidenceRefs:['file:README.md'],model:{provider:'stub-provider',model:'security-model'}};
    },
    persistSpecialists:async(_id,snapshot)=>{events.push('persist');snapshots.push(snapshot);},
  });
  const {id}=service.start('https://github.com/owner/repo');
  await service.waitForIdle();
  const run=service.get(id);
  assert.equal(run.status,'Completed');
  assert.deepEqual(events,['security','persist']);
  assert.equal(run.specialists.results.length,1);
  assert.equal(run.specialists.results[0].id,'security');
  assert.equal(run.specialists.results[0].model.provider,'stub-provider');
  assert.equal(run.specialists.modelCalls,1);
  assert.equal(snapshots.length,1);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshots[0]))<1024*1024);
});

test('M6 provider failure makes enabled run Incomplete without fake specialist evidence', async () => {
  const repositories=await makeRepos();
  const service=new MasterAuditService(repositories,{
    env:{VERIFIAI_M6_SECURITY_SPECIALIST:'true'},
    analyze:async()=>({finding:{title:'base',severity:'info',description:'base',evidence:{file:'README.md'}},model:{provider:'stub',model:'base'}}),
    select:async()=>({executable:'node',args:['--version'],source:'fixture'}),
    execute:async()=>fakeExecution(),
    securityReview:async()=>{throw new Error('provider unavailable');},
    persistSpecialists:async()=>{},
  });
  const {id}=service.start('https://github.com/owner/repo');
  await service.waitForIdle();
  const run=service.get(id);
  assert.equal(run.status,'Incomplete');
  assert.equal(run.failedStage,'specialist');
  assert.equal(run.specialists.results[0].status,'Incomplete');
  assert.deepEqual(run.specialists.results[0].evidenceRefs,[]);
});
