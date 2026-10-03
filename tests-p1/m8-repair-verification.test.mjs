import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,symlink,writeFile,mkdir} from 'node:fs/promises';
import {runOwnedProcess} from '../services/local-command.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runRepairVerification} from '../services/local-repair-verification.mjs';

async function fixture(contents='export const value = false;\n'){
  const root=await mkdtemp(join(tmpdir(),'verifiai-repair-fixture-'));
  await writeFile(join(root,'broken.js'),contents);
  return root;
}
const verifyValue=async({workspacePath})=>{
  const text=await readFile(join(workspacePath,'broken.js'),'utf8');
  const ok=text.includes('value = true');
  return {status:ok?'Completed':'Failed',executed:true,exitCode:ok?0:1,command:'node check',stdout:text.trim(),stderr:'',provenance:{kind:'fixture'}};
};

test('successful repair requires executed before failure, after pass, regression pass, and leaves original unchanged',async(t)=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const before=await readFile(join(root,'broken.js'),'utf8');
  const result=await runRepairVerification({
    workspacePath:root,finding:{status:'Confirmed'},baseCommitSha:'abc123',
    patch:{files:[{path:'broken.js',expected:'value = false',replacement:'value = true'}]},
    verify:verifyValue,
    regressions:[async({workspacePath})=>({status:'Completed',executed:true,exitCode:0,command:'regression',stdout:await readFile(join(workspacePath,'broken.js'),'utf8'),stderr:'',provenance:{kind:'fixture-regression'}})],
    timeoutMs:500,
  });
  assert.equal(result.verdict,'VerifiedRepair');
  assert.equal(result.before.exitCode,1);assert.equal(result.after.exitCode,0);assert.equal(result.regressions[0].exitCode,0);
  assert.equal(result.originalUnchanged,true);assert.equal(result.cleanup.candidateRemoved,true);
  assert.equal(result.verifiedBaseCommitSha,'abc123');assert.ok(result.patchDigest);
  assert.equal(await readFile(join(root,'broken.js'),'utf8'),before);
});

test('Completed status with nonzero AFTER or regression can never verify',async(t)=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  let calls=0;
  const result=await runRepairVerification({
    workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'false',replacement:'true'}]},
    verify:async()=>{calls+=1;return calls===1
      ?{status:'Failed',executed:true,exitCode:1,command:'check'}
      :{status:'Completed',executed:true,exitCode:1,command:'check'};},
    regressions:[async()=>({status:'Completed',executed:true,exitCode:1,command:'regression'})],
    timeoutMs:500,
  });
  assert.notEqual(result.verdict,'VerifiedRepair');
  assert.equal(result.verdict,'RejectedRepair');
});

test('non-executed evidence cannot verify even when status strings look correct',async(t)=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await runRepairVerification({
    workspacePath:root,finding:{status:'Confirmed'},patch:{files:[{path:'broken.js',expected:'false',replacement:'true'}]},
    verify:async()=>({status:'Failed',executed:false,exitCode:1}),timeoutMs:500,
  });
  assert.equal(result.verdict,'Incomplete');
  assert.match(result.error,/executed failure/i);
});

test('ancestor symlink escape is rejected before mutation and external file remains identical',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'verifiai-repair-root-'));
  const external=await mkdtemp(join(tmpdir(),'verifiai-repair-external-'));
  t.after(()=>Promise.all([rm(root,{recursive:true,force:true}),rm(external,{recursive:true,force:true})]));
  await mkdir(join(root,'source'));
  await writeFile(join(external,'target.js'),'export const value = false;\n');
  await symlink(external,join(root,'source','linked'),'dir');
  const original=await readFile(join(external,'target.js'),'utf8');
  const result=await runRepairVerification({
    workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'source/linked/target.js',expected:'false',replacement:'true'}]},
    verify:async()=>({status:'Failed',executed:true,exitCode:1}),timeoutMs:500,
  });
  assert.equal(result.verdict,'Incomplete');
  assert.match(result.error,/symlink/i);
  assert.equal(await readFile(join(external,'target.js'),'utf8'),original);
});

test('repair that still fails is RejectedRepair',async(t)=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await runRepairVerification({workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'false',replacement:'still-false'}]},verify:verifyValue,timeoutMs:500});
  assert.equal(result.verdict,'RejectedRepair');
});

test('invalid patch is Incomplete and regression failure rejects candidate',async(t)=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const invalid=await runRepairVerification({workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'missing-token',replacement:'true'}]},verify:verifyValue,timeoutMs:500});
  assert.equal(invalid.verdict,'Incomplete');assert.match(invalid.error,/patch/i);
  const regression=await runRepairVerification({workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'value = false',replacement:'value = true'}]},verify:verifyValue,
    regressions:[async()=>({status:'Failed',executed:true,exitCode:1,command:'regression',stderr:'regression'})],timeoutMs:500});
  assert.equal(regression.verdict,'RejectedRepair');
});

test('timeout aborts the owned check and waits for termination before cleanup',async(t)=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  let terminated=false;
  const result=await runRepairVerification({workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'false',replacement:'true'}]},
    verify:async({signal})=>new Promise((resolve)=>{
      const timer=setTimeout(()=>resolve({status:'Failed',executed:true,exitCode:1}),5000);
      signal.addEventListener('abort',()=>{clearTimeout(timer);terminated=true;resolve({status:'Incomplete',executed:false,exitCode:null});},{once:true});
    }),timeoutMs:30});
  assert.equal(result.verdict,'Incomplete');assert.equal(terminated,true);assert.equal(result.cleanup.candidateRemoved,true);
});


test('timeout reaps an owned verification process before candidate cleanup returns',async(t)=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const pidFile=join(root,'verify.pid');
  const result=await runRepairVerification({
    workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'false',replacement:'true'}]},
    verify:async({signal,workspacePath})=>{
      const code=`const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
      const owned=await runOwnedProcess(process.execPath,['-e',code],{cwd:workspacePath,timeoutMs:5000,signal});
      return {status:owned.status,executed:true,exitCode:owned.exitCode,command:'node owned-check',stdout:owned.stdout,stderr:owned.stderr};
    },
    timeoutMs:120,
  });
  assert.equal(result.verdict,'Incomplete');
  assert.equal(result.cleanup.candidateRemoved,true);
  const pid=Number(await readFile(pidFile,'utf8'));
  assert.ok(Number.isInteger(pid)&&pid>1);
  assert.throws(()=>process.kill(pid,0),error=>error?.code==='ESRCH');
});

test('a repaired candidate without a regression check stays Incomplete',async t=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await runRepairVerification({workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'false',replacement:'true'}]},verify:verifyValue,timeoutMs:500});
  assert.equal(result.verdict,'Incomplete');
  assert.match(result.error,/regression/i);
  assert.equal(result.originalUnchanged,true);
  assert.equal(result.cleanup.candidateRemoved,true);
});

test('switching the verification command cannot verify a candidate',async t=>{
  const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await runRepairVerification({workspacePath:root,finding:{status:'Confirmed'},
    patch:{files:[{path:'broken.js',expected:'false',replacement:'true'}]},
    verify:async input=>({...await verifyValue(input),command:input.label==='before verification'?'node check':'node --version'}),
    regressions:[verifyValue],timeoutMs:500});
  assert.equal(result.verdict,'Incomplete');
  assert.match(result.error,/command/i);
});

test('a timed-out or cancelled passing check cannot verify a candidate',async t=>{
  for(const flag of ['timedOut','aborted'])await t.test(flag,async t=>{
    const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
    const result=await runRepairVerification({workspacePath:root,finding:{status:'Confirmed'},
      patch:{files:[{path:'broken.js',expected:'false',replacement:'true'}]},
      verify:async input=>({...await verifyValue(input),...(input.label==='after verification'?{[flag]:true}:{})}),
      regressions:[verifyValue],timeoutMs:500});
    assert.equal(result.verdict,'Incomplete');
    assert.equal(result.after[flag],true,'interruption evidence is preserved');
  });
});
