import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runRepairVerification} from '../services/local-repair-verification.mjs';

async function fixture(contents='export const value = false;\n') {
  const root = await mkdtemp(join(tmpdir(),'verifiai-repair-fixture-'));
  await writeFile(join(root,'broken.js'), contents);
  return root;
}
const verifyValue = async ({workspacePath}) => {
  const text = await readFile(join(workspacePath,'broken.js'),'utf8');
  return {status:text.includes('value = true')?'Completed':'Failed',exitCode:text.includes('value = true')?0:1,stdout:text.trim(),stderr:''};
};

test('verified failure repaired in isolated copy becomes VerifiedRepair and original is unchanged', async (t) => {
  const root=await fixture(); t.after(()=>rm(root,{recursive:true,force:true}));
  const before=await readFile(join(root,'broken.js'),'utf8');
  const result=await runRepairVerification({
    workspacePath:root,
    finding:{id:'finding-1',status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'value = false',replacement:'value = true'}]},
    verify:verifyValue,
    regressions:[async ({workspacePath})=>({status:(await readFile(join(workspacePath,'broken.js'),'utf8')).includes('true')?'Completed':'Failed',exitCode:0})],
    timeoutMs:500,
  });
  assert.equal(result.verdict,'VerifiedRepair');
  assert.equal(result.before.status,'Failed');
  assert.equal(result.after.status,'Completed');
  assert.equal(result.regressions[0].status,'Completed');
  assert.equal(result.originalUnchanged,true);
  assert.equal(result.cleanup.candidateRemoved,true);
  assert.match(result.diff,/value = false/);
  assert.match(result.diff,/value = true/);
  assert.equal(await readFile(join(root,'broken.js'),'utf8'),before);
});

test('repair that still fails is RejectedRepair', async (t) => {
  const root=await fixture(); t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await runRepairVerification({
    workspacePath:root,
    finding:{id:'finding-2',status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'false',replacement:'still-false'}]},
    verify:verifyValue,
    timeoutMs:500,
  });
  assert.equal(result.verdict,'RejectedRepair');
  assert.equal(result.after.status,'Failed');
});

test('invalid patch is Incomplete and regression failure rejects a candidate', async (t) => {
  const root=await fixture(); t.after(()=>rm(root,{recursive:true,force:true}));
  const invalid=await runRepairVerification({
    workspacePath:root,
    finding:{id:'finding-3',status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'missing-token',replacement:'true'}]},
    verify:verifyValue,
    timeoutMs:500,
  });
  assert.equal(invalid.verdict,'Incomplete');
  assert.match(invalid.error,/patch/i);

  const regression=await runRepairVerification({
    workspacePath:root,
    finding:{id:'finding-4',status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'value = false',replacement:'value = true'}]},
    verify:verifyValue,
    regressions:[async()=>({status:'Failed',exitCode:1,stderr:'regression'})],
    timeoutMs:500,
  });
  assert.equal(regression.verdict,'RejectedRepair');
  assert.equal(regression.regressions[0].status,'Failed');
});

test('timeout is Incomplete and cleanup is still reported', async (t) => {
  const root=await fixture(); t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await runRepairVerification({
    workspacePath:root,
    finding:{id:'finding-5',status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'false',replacement:'true'}]},
    verify:async()=>new Promise(()=>{}),
    timeoutMs:30,
  });
  assert.equal(result.verdict,'Incomplete');
  assert.match(result.error,/timeout/i);
  assert.equal(result.cleanup.candidateRemoved,true);
  assert.equal(await readFile(join(root,'broken.js'),'utf8'),'export const value = false;\n');
});
