import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createArtifactBundle} from '../services/proof-artifacts.mjs';

test('bundle stores real evidence, materializes screenshot, and redacts arbitrary known secret values',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'verifiai-artifacts-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sentinel='plain-sentinel-credential-XYZ123';
  const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const bundle=await createArtifactBundle({
    rootDir:root,runId:'run-123',knownSecrets:[sentinel],
    screenshotResolver:async(ref)=>ref==='/api/local/browser-shots/one.png'?png:undefined,
    data:{
      run:{id:'run-123',status:'Completed',note:'contains '+sentinel},
      repository:{fullName:'octocat/Hello-World',commit:'abc123'},
      finding:{title:'Example',severity:'low',description:'finding '+sentinel,evidence:{file:'README'}},
      specialists:{status:'Completed',results:[{id:'security',status:'Completed',findings:[],evidenceRefs:[],model:{provider:'stub'}}]},
      execution:{status:'Completed',executed:true,exitCode:0,stdout:'hello '+sentinel+'\n',stderr:'err '+sentinel,command:'git test'},
      browser:{status:'Completed',startUrl:'http://127.0.0.1/',finalUrl:'http://127.0.0.1/done',actions:[{text:sentinel}],assertions:[],screenshotRefs:['/api/local/browser-shots/one.png'],consoleErrors:[{text:sentinel}],networkEvidence:[],durationMs:10},
      repair:{verdict:'VerifiedRepair',diff:'--- a/x\n-'+sentinel+'\n+fixed\n',patch:{files:[{path:'x',expected:'a',replacement:'b'}]},before:{status:'Failed',executed:true,exitCode:1},after:{status:'Completed',executed:true,exitCode:0},regressions:[{status:'Completed',executed:true,exitCode:0}],cleanup:{candidateRemoved:true},originalUnchanged:true},
      cleanup:{repositoryRemoved:true,sandboxRemoved:true},
      model:{provider:'stub',model:'m',note:sentinel},
    },
  });
  const manifest=JSON.parse(await readFile(join(bundle.path,'manifest.json'),'utf8'));
  assert.equal(manifest.references.screenshots[0],'screenshots/1.png');
  assert.deepEqual(await readFile(join(bundle.path,'screenshots/1.png')),png);
  for(const file of ['run.json','finding.json','execution.json','stdout.txt','stderr.txt','browser.json','repair.diff','model.json']){
    assert.doesNotMatch(await readFile(join(bundle.path,file),'utf8'),new RegExp(sentinel));
  }
  assert.match(await readFile(join(bundle.path,'stdout.txt'),'utf8'),/REDACTED/);
  assert.ok(bundle.manifestSha256);
});

test('missing execution and missing screenshot remain Missing, never synthetic files',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'verifiai-artifacts-missing-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bundle=await createArtifactBundle({
    rootDir:root,runId:'run-missing',
    screenshotResolver:async()=>undefined,
    data:{run:{id:'run-missing',status:'Incomplete'},browser:{status:'Incomplete',screenshotRefs:['/api/local/browser-shots/missing.png']}},
  });
  const manifest=JSON.parse(await readFile(join(bundle.path,'manifest.json'),'utf8'));
  assert.equal(manifest.artifacts.find(x=>x.name==='execution').status,'Missing');
  assert.equal(manifest.artifacts.find(x=>x.name==='screenshot-1').status,'Missing');
  assert.deepEqual(manifest.references.screenshots,[]);
  await assert.rejects(access(join(bundle.path,'execution.json')));
  await assert.rejects(access(join(bundle.path,'screenshots/1.png')));
});

test('text artifacts are bounded and structure is deterministic',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'verifiai-artifacts-bounds-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const data={run:{id:'run-bounds',status:'Completed'},execution:{status:'Completed',executed:true,exitCode:0,stdout:'x'.repeat(5000),stderr:'',command:'echo'}};
  const a=await createArtifactBundle({rootDir:root,runId:'run-bounds-a',data,maxTextBytes:128,maxBundleBytes:8192});
  const b=await createArtifactBundle({rootDir:root,runId:'run-bounds-b',data,maxTextBytes:128,maxBundleBytes:8192});
  const ma=JSON.parse(await readFile(join(a.path,'manifest.json'),'utf8'));
  const mb=JSON.parse(await readFile(join(b.path,'manifest.json'),'utf8'));
  assert.deepEqual(ma.artifacts.map(x=>x.name),mb.artifacts.map(x=>x.name));
  assert.ok(Buffer.byteLength(await readFile(join(a.path,'stdout.txt'),'utf8'))<=128);
  assert.equal(ma.artifacts.find(x=>x.name==='stdout').truncated,true);
  assert.ok(ma.totalBytes<=8192);
});
