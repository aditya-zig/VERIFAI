import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalArtifactService } from '../services/local-artifact-service.mjs';
import { LocalRepairService } from '../services/local-repair-service.mjs';
import { composeFinding } from '../services/finding-evidence.mjs';

const audit = (id) => ({ id, status:'Completed', stages:{}, finding:{ title:'Hypothesis', description:'original', severity:'info' }, repository:{ fullName:'owner/repo', commit:'abc123' }, execution:{ status:'Completed', exitCode:0, command:'node --version', stdout:'original bytes', sandbox:{ started:true } } });

test('missing or blank executed/selected commands reject repair before clone', async () => {
  for (const [command, selectedCommand] of [[undefined,undefined],['',''],[' ',' '],['node --check x.js',undefined]]) {
    let clones=0;
    const run={...audit('a'),selectedCommand,execution:{status:'Failed',exitCode:1,sandbox:{started:true},command}};
    const service=new LocalRepairService({async clone(){clones++;throw new Error('clone must not occur');}}, {get:()=>run});
    await assert.rejects(service.repair('a',{files:[]}), /command|failed execution|not admitted/i);
    assert.equal(clones,0);
    if(!command?.trim()) assert.equal(composeFinding({modelFinding:run.finding,execution:run.execution}).assessment.canAdmitRepair,false);
  }
});

test('a failed swap AND failed rollback retain previous bytes and invalidate published proof',async(t)=>{
  const root=await fs.mkdtemp(join(tmpdir(),'verifai-final-rollback-'));
  const service=new LocalArtifactService({env:{VERIFIAI_ARTIFACT_DIR:root}});
  const original=audit('rollback');
  await service.getOrPublish(original);
  const before=await fs.readFile(join(root,'rollback','finding.json'));
  const rename=fs.rename;
  let calls=0;
  fs.rename=async(...args)=>{
    calls++;
    if(calls===2||calls===3) throw Object.assign(new Error('controlled filesystem replacement/rollback failure'),{code:'EACCES'});
    return rename(...args);
  };
  syncBuiltinESMExports();
  t.after(async()=>{fs.rename=rename;syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});});
  await assert.rejects(service.getOrPublish({...original,finding:{...original.finding,description:'new bytes'}}));
  fs.rename=rename;syncBuiltinESMExports();
  assert.equal(service.get('rollback'),undefined,'unavailable proof must not remain eligible for PR');
  const retained=[];
  async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()) await walk(path);else if(entry.name==='finding.json')retained.push(await fs.readFile(path));}}
  await walk(root);
  assert.ok(retained.some(bytes=>bytes.equals(before)),'last known good proof bytes retained for recovery');
});

test('Seek AI key values are redacted from downloadable proof bytes',async(t)=>{
  const root=await fs.mkdtemp(join(tmpdir(),'verifai-final-redaction-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const key='unit_seek_credential_only';
  const service=new LocalArtifactService({env:{VERIFIAI_ARTIFACT_DIR:root,SEEK_AI_API_KEY:key}});
  const run=audit('redaction');run.execution.stdout=`unexpected echoed credential: ${key}`;
  await service.getOrPublish(run);
  const {buffer}=await service.read('redaction','stdout.txt');
  assert.ok(!buffer.toString().includes(key));
  assert.match(buffer.toString(),/REDACTED/);
});
