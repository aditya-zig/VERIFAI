import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const runner=fileURLToPath(new URL('../../../scripts/ci-local-e2e.mjs',import.meta.url));
// Exercise the real CLI gate; bounded fixture tests never contact AWS or Docker.
function invoke(env){
 const dir=mkdtempSync(join(tmpdir(),'verifai-ci-aws-gate-'));
 try {
  mkdirSync(join(dir,'tests-e2e'));
  for(const name of ['command-safety','local-browser','local-repository','local-sandbox','master-failure']){
   writeFileSync(join(dir,'tests-e2e',`${name}.test.mjs`),'');
  }
  for(const name of ['local-analysis','local-audit','local-command','browser-route','sandbox-interruption']){
   writeFileSync(join(dir,'tests-e2e',`${name}.test.mjs`),"import {writeFileSync} from 'node:fs'; writeFileSync('provider-ran','yes');");
  }
  const result=spawnSync(process.execPath,[runner],{cwd:dir,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,...env}});
  assert.equal(result.status,0,`${result.stdout}${result.stderr}`);
  return {ran:existsSync(join(dir,'provider-ran')),output:result.stdout+result.stderr};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
const modelRegion={VERIFIAI_BEDROCK_MODEL_ID:'test-model',AWS_REGION:'us-east-1'};

test('AWS E2E never spends merely because credentials are present',()=>{
 const r=invoke({...modelRegion,AWS_PROFILE:'test-profile',XKIRO_API_KEY:'legacy-sentinel'});
 assert.equal(r.ran,false);
 assert.match(r.output,/SKIPPED.*VERIFIAI_RUN_AWS_E2E/);
});

test('AWS E2E requires an explicit opt-in and model/region before running',()=>{
 for(const env of [
  {...modelRegion,VERIFIAI_RUN_AWS_E2E:'true'},
  {VERIFIAI_RUN_AWS_E2E:'1',AWS_REGION:'us-east-1'},
  {VERIFIAI_RUN_AWS_E2E:'1',VERIFIAI_MODEL_ID:'test-model'},
  {...modelRegion,VERIFIAI_RUN_AWS_E2E:'1',VERIFIAI_MODEL_PROVIDER:'openrouter'},
 ]) assert.equal(invoke(env).ran,false);
});

test('AWS E2E accepts both configuration aliases with standard credential-chain resolution',()=>{
 for(const env of [modelRegion,{VERIFIAI_MODEL_ID:'test-model',AWS_DEFAULT_REGION:'us-east-1'}]){
  const r=invoke({...env,VERIFIAI_RUN_AWS_E2E:'1'});
  assert.equal(r.ran,true,'credential resolution belongs to the AWS SDK, including execution roles');
 }
});
