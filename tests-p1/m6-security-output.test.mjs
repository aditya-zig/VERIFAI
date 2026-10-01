import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {reviewSecurityRepository} from '../services/local-security-specialist.mjs';

// Unit envelopes only. Live provider evidence is captured separately; this does not claim an executed vulnerability.
const base={title:'Lack of Repository Security Documentation',severity:'info',description:'Repository source contains no security policy.'};
async function review(value){
  const root=await mkdtemp(join(tmpdir(),'verifai-security-output-'));
  try{
    await writeFile(join(root,'README'),'Hello World!\n');
    return await reviewSecurityRepository({repository:{fullName:'unit/fixture'},clone:{workspacePath:root},files:{items:['README']}},{
      env:{VERIFIAI_MODEL_PROVIDER:'xkiro',VERIFIAI_MODEL_ID:'mistralai/ministral-8b',XKIRO_API_KEY:'unit-only-not-a-real-credential'},
      fetchImpl:async()=>new Response(JSON.stringify({id:'unit-response',choices:[{message:{content:JSON.stringify(value)}}]}),{status:200,headers:{'content-type':'application/json'}}),
    });
  }finally{await rm(root,{recursive:true,force:true});}
}
test('M6 normalizes actual observed evidence_file envelope without manufacturing file evidence',async()=>{
  const result=await review({...base,evidence_file:'README'});
  assert.equal(result.status,'Completed');assert.deepEqual(result.findings[0].evidence,{file:'README'});assert.deepEqual(result.evidenceRefs,['file:README']);
});
test('M6 keeps nested evidence and rejects a flat path outside the real tracked file list',async()=>{
  assert.equal((await review({...base,evidence:{file:'README'}})).status,'Completed');
  await assert.rejects(review({...base,evidence_file:'SECURITY.md'}),/outside the clone/);
});
test('M6 missing citation remains invalid, never synthetic PASS',async()=>{
  await assert.rejects(review(base),/invalid finding/);
});
