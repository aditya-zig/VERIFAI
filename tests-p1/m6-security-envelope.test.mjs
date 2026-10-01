import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewSecurityRepository} from '../services/local-security-specialist.mjs';

test('M6 accepts the observed evidence_file alias but still binds it to a tracked file',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'verifiai-m6-envelope-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'README'),'hello');
  const record={repository:{fullName:'octocat/Hello-World'},clone:{workspacePath:root},files:{items:['README'],count:1}};
  const fetchImpl=async()=>new Response(JSON.stringify({
    id:'provider-response',
    choices:[{message:{content:JSON.stringify({title:'Observation',severity:'info',description:'Concrete security observation',evidence_file:'README'})}}],
    usage:{prompt_tokens:10,completion_tokens:8},
  }),{status:200,headers:{'content-type':'application/json'}});
  const result=await reviewSecurityRepository(record,{
    env:{VERIFIAI_MODEL_PROVIDER:'xkiro',XKIRO_API_KEY:'sentinel'},
    fetchImpl,
    auditId:'audit-1',
  });
  assert.equal(result.status,'Completed');
  assert.equal(result.findings[0].evidence.file,'README');
  assert.deepEqual(result.evidenceRefs,['file:README']);
});

test('M6 evidence_file alias still rejects files outside the tracked clone',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'verifiai-m6-envelope-bad-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'README'),'hello');
  const record={repository:{fullName:'octocat/Hello-World'},clone:{workspacePath:root},files:{items:['README'],count:1}};
  const fetchImpl=async()=>new Response(JSON.stringify({
    choices:[{message:{content:JSON.stringify({title:'Bad',severity:'info',description:'bad citation',evidence_file:'../../etc/passwd'})}}],
  }),{status:200,headers:{'content-type':'application/json'}});
  await assert.rejects(reviewSecurityRepository(record,{
    env:{VERIFIAI_MODEL_PROVIDER:'xkiro',XKIRO_API_KEY:'sentinel'},fetchImpl,
  }),/outside the clone/i);
});
