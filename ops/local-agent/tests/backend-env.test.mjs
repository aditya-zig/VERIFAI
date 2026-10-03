import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return String(p);}
test('root start script works outside the checkout and keeps provider credentials in API only',async()=>{
 const tmp=mkdtempSync('/tmp/verifai-web-env-test-');const owner=`vagent.${createHash('sha256').update(root).digest('hex').slice(0,12)}`;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:tmp,WEB_PORT:await port(),PORT:await port(),AWS_ACCESS_KEY_ID:'controlled-sentinel-never-real-credential',AWS_SECRET_ACCESS_KEY:'controlled-sentinel-never-real-credential',AWS_SESSION_TOKEN:'controlled-sentinel-never-real-credential',AWS_PROFILE:'controlled-profile',AWS_BEARER_TOKEN_BEDROCK:'controlled-sentinel-never-real-credential'};
 const run=name=>spawnSync('bash',[name==='start-local.sh'?join(root,'start.sh'):join(root,'ops/local-agent/scripts',name)],{cwd:name==='start-local.sh'?tmp:root,env,encoding:'utf8',timeout:60000});
 try {
  const start=run('start-local.sh');assert.equal(start.status,0,start.stderr);
  const pid=role=>Number(readFileSync(join(tmp,`verifiai-local-agent-${process.getuid()}-${owner}`,`${role}.state`),'utf8').match(/^pid=(\d+)$/m)[1]);
  const credentials=['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_BEARER_TOKEN_BEDROCK'];
  const present=p=>credentials.filter(name=>readFileSync(`/proc/${p}/environ`).includes(Buffer.from(`${name}=`)));
  assert.deepEqual(present(pid('api')),credentials,'backend credentials remain configured');
  const web=pid('web');assert.deepEqual(present(web),[],'web launcher must not inherit backend AWS credentials');
  const children=execFileSync('pgrep',['-P',String(web)],{encoding:'utf8'}).trim().split('\n').map(Number);
  for(const child of children)assert.deepEqual(present(child),[],'web child must not inherit backend AWS credentials');
 } finally {
  const stop=run('stop-local.sh');assert.equal(stop.status,0,stop.stderr);rmSync(tmp,{recursive:true,force:true});
 }
});

test('npm start forwards help without launching services',()=>{
 const result=spawnSync('npm',['--prefix',root,'start','--','--help'],{cwd:tmpdir(),encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stderr,/usage: start-local\.sh/);
});

test('root start script preserves failure for unsupported arguments',()=>{
 const result=spawnSync(join(root,'start.sh'),['--unsupported'],{cwd:tmpdir(),encoding:'utf8',timeout:10000});
 assert.equal(result.status,1,result.stderr);
 assert.match(result.stderr,/usage: start-local\.sh/);
});
