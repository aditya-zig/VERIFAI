import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalArtifactService} from '../services/local-artifact-service.mjs';

test('artifact lifecycle writes terminal audit with exact commit and server repair evidence',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'verifiai-artifact-service-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const secret='sentinel-no-prefix-secret-987';
  const service=new LocalArtifactService({env:{VERIFIAI_ARTIFACT_DIR:root,XKIRO_API_KEY:secret}});
  const audit={id:'run-service',status:'Completed',startedAt:'a',finishedAt:'b',durationMs:1,
    stages:{},repository:{fullName:'owner/repo',commit:'abc123'},finding:{title:'f',description:secret},
    execution:{status:'Completed',executed:true,exitCode:0,command:'check',stdout:secret,stderr:''},
    cleanup:{repositoryRemoved:true,sandboxRemoved:true},model:{provider:'xkiro',model:'m'},specialists:{status:'Completed',results:[]}};
  const repair={verdict:'VerifiedRepair',patch:{files:[{path:'x',expected:'a',replacement:'b'}]},diff:'-'+secret,
    before:{status:'Failed',executed:true,exitCode:1},after:{status:'Completed',executed:true,exitCode:0},
    regressions:[{status:'Completed',executed:true,exitCode:0}],cleanup:{candidateRemoved:true},originalUnchanged:true};
  const proof=await service.refresh(audit,{repair});
  assert.equal(proof.runId,'run-service');
  assert.ok(proof.manifest.sha256);
  const repo=JSON.parse(await readFile(join(root,'run-service','repo.json'),'utf8'));
  assert.equal(repo.commit,'abc123');
  assert.doesNotMatch(await readFile(join(root,'run-service','stdout.txt'),'utf8'),new RegExp(secret));
  assert.equal(service.get('run-service').manifest.sha256,proof.manifest.sha256);
});

test('browser evidence without materializable screenshot records Missing screenshot proof',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'verifiai-artifact-browser-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const service=new LocalArtifactService({env:{VERIFIAI_ARTIFACT_DIR:root}});
  const audit={id:'run-browser',status:'Completed',repository:{fullName:'owner/repo',commit:'abc'},stages:{},cleanup:{}};
  const proof=await service.refresh(audit,{browser:{status:'Completed',screenshotRefs:['/api/local/browser-shots/missing.png']}});
  assert.equal(proof.artifacts.find(x=>x.name==='screenshot-1').status,'Missing');
  assert.deepEqual(proof.screenshotRefs,[]);
});
