import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createArtifactBundle} from '../services/proof-artifacts.mjs';

test('proof bundle writes only real evidence with stable manifest and redaction', async (t) => {
  const root=await mkdtemp(join(tmpdir(),'verifai-artifacts-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const bundle=await createArtifactBundle({
    rootDir:root,
    runId:'run-123',
    data:{
      run:{id:'run-123',status:'Completed',token:'do-not-store'},
      repository:{fullName:'octocat/Hello-World',commit:'abc123'},
      finding:{title:'Example',severity:'low',evidence:{file:'README'}},
      execution:{status:'Completed',exitCode:0,stdout:'hello\n',stderr:'',command:'git test'},
      browser:{status:'Completed',startUrl:'https://example.test',finalUrl:'https://example.test/done',actions:[],assertions:[],screenshotRefs:['screens/shot-1.png'],consoleErrors:[],networkEvidence:[],durationMs:10},
      repair:{verdict:'VerifiedRepair',diff:'--- a/x\n+++ b/x\n-a\n+b\n',before:{status:'Failed'},after:{status:'Completed'},regressions:[{status:'Completed'}]},
      cleanup:{repositoryRemoved:true,sandboxRemoved:true},
      model:{provider:'stub',model:'m',authorization:'Bearer top-secret'},
    },
  });
  assert.equal(bundle.runId,'run-123');
  const manifest=JSON.parse(await readFile(join(bundle.path,'manifest.json'),'utf8'));
  assert.equal(manifest.runId,'run-123');
  assert.deepEqual(manifest.references.screenshots,['screens/shot-1.png']);
  assert.equal(manifest.artifacts.find(x=>x.name==='execution').status,'Present');
  assert.equal(manifest.artifacts.find(x=>x.name==='browser').status,'Present');
  assert.equal(manifest.artifacts.find(x=>x.name==='repair-diff').status,'Present');
  const model=await readFile(join(bundle.path,'model.json'),'utf8');
  assert.doesNotMatch(model,/top-secret|Bearer/);
  assert.match(model,/REDACTED/);
  assert.equal(await readFile(join(bundle.path,'stdout.txt'),'utf8'),'hello\n');
});

test('missing execution is a manifest Missing entry, never a synthetic execution file', async (t) => {
  const root=await mkdtemp(join(tmpdir(),'verifai-artifacts-missing-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const bundle=await createArtifactBundle({rootDir:root,runId:'run-missing',data:{run:{id:'run-missing',status:'Incomplete'}}});
  const manifest=JSON.parse(await readFile(join(bundle.path,'manifest.json'),'utf8'));
  const execution=manifest.artifacts.find(x=>x.name==='execution');
  assert.equal(execution.status,'Missing');
  assert.match(execution.reason,/not present/i);
  await assert.rejects(access(join(bundle.path,'execution.json')));
});

test('text artifacts are bounded and structure is deterministic', async (t) => {
  const root=await mkdtemp(join(tmpdir(),'verifai-artifacts-bounds-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const data={run:{id:'run-bounds',status:'Completed'},execution:{status:'Completed',exitCode:0,stdout:'x'.repeat(5000),stderr:'',command:'echo'}};
  const a=await createArtifactBundle({rootDir:root,runId:'run-bounds-a',data,maxTextBytes:128,maxBundleBytes:8192});
  const b=await createArtifactBundle({rootDir:root,runId:'run-bounds-b',data,maxTextBytes:128,maxBundleBytes:8192});
  const ma=JSON.parse(await readFile(join(a.path,'manifest.json'),'utf8'));
  const mb=JSON.parse(await readFile(join(b.path,'manifest.json'),'utf8'));
  assert.deepEqual(ma.artifacts.map(x=>x.name),mb.artifacts.map(x=>x.name));
  const stdout=await readFile(join(a.path,'stdout.txt'),'utf8');
  assert.ok(Buffer.byteLength(stdout)<=128);
  assert.equal(ma.artifacts.find(x=>x.name==='stdout').truncated,true);
  assert.ok(ma.totalBytes<=8192);
});
