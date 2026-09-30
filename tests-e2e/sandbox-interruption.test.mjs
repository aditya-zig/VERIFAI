import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {access,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recoverSandboxes,sandboxOwner} from '../services/local-sandbox.mjs';
import {auditRepository} from '../services/local-audit.mjs';
const filter=`label=dev.verifiai.local-agent.owner=${sandboxOwner}`;
const containers=()=>execFileSync('docker',['ps','-aq','--filter',filter],{encoding:'utf8'}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function firstLine(child){return new Promise((resolve,reject)=>{let text='';child.stdout.on('data',chunk=>{text+=chunk; if(text.includes('\n'))resolve(text.split('\n')[0]);});child.once('error',reject);child.once('exit',code=>{if(!text.includes('\n'))reject(new Error(`Child exited ${code}`));});});}

test('agent configuration failure after real Docker execution leaves no sandbox',async(t)=>{
  const cwd=await mkdtemp(join(tmpdir(),'verifai-sandbox-test-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(join(cwd,'package.json'),'{"scripts":{"test":"node --version"}}');
  const result=await auditRepository({repository:{fullName:'local/failure-fixture'},clone:{workspacePath:cwd},files:{items:['package.json']}},{env:{}});
  assert.equal(result.status,'Incomplete');
  assert.equal(result.failedStage,'analysis');
  assert.equal(result.execution.exitCode,0);
  assert.match(result.execution.stdout,/^v22\./);
  assert.equal(result.execution.sandbox.removed,true);
  assert.equal(containers(),'');
});

test('SIGTERM during a real HTTP audit removes its cloned repository and sandbox',async(t)=>{
  const module=new URL('../scripts/serve-web.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {createDemoServer} from ${JSON.stringify(module)};const server=createDemoServer();server.listen(0,'127.0.0.1',()=>console.log(server.address().port));process.on('SIGTERM',()=>server.shutdown().then(()=>process.exit(0)));`],{stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}});
  const port=Number(await firstLine(child));
  const base=`http://127.0.0.1:${port}`;
  const response=await fetch(`${base}/api/local/repositories`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://github.com/octocat/Hello-World'})});
  assert.equal(response.status,201);
  const clone=await response.json();
  const request=fetch(`${base}/api/local/repositories/${clone.id}/audit`,{method:'POST'}).then(r=>r.json());
  let found=false;
  for(let i=0;i<100;i++){if(containers()){found=true;break;}await delay(50);}
  assert.equal(found,true,'actual sandbox was created before interruption');
  const exit=once(child,'exit');child.kill('SIGTERM');
  const result=await request;
  assert.equal(result.status,'Incomplete');
  assert.equal((await exit)[0],0);
  assert.equal(containers(),'');
  await assert.rejects(access(clone.clone.workspacePath));
});

test('a crashed sandbox owner is recovered without deleting live or unowned containers',async(t)=>{
  const cwd=await mkdtemp(join(tmpdir(),'verifai-sandbox-test-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const module=new URL('../services/local-sandbox.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {runSandbox} from ${JSON.stringify(module)};await runSandbox(${JSON.stringify(cwd)},'node',['-e','setInterval(()=>{},1000)'],{timeoutMs:30000,onStarted:v=>console.log(v.name)});`],{stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}await recoverSandboxes();});
  const name=await firstLine(child);
  for(let i=0;i<100;i++){if(execFileSync('docker',['inspect','--format','{{.State.Running}}',name],{encoding:'utf8'}).trim()==='true')break;await delay(50);}
  await assert.rejects(recoverSandboxes(),error=>error.statusCode===429);
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  assert.ok(containers(),'crash leaves an actual owned sandbox for recovery');
  await recoverSandboxes();
  assert.equal(containers(),'');
});

test('alternate TMPDIR recovery does not remove another live state namespace',async(t)=>{
  const temp=await mkdtemp(join(tmpdir(),'verifai-state-scope-'));
  const cwd=await mkdtemp(join(temp,'repo-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const module=new URL('../services/local-sandbox.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {runSandbox} from ${JSON.stringify(module)};const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());await runSandbox(${JSON.stringify(cwd)},'node',['-e','setInterval(()=>{},1000)'],{timeoutMs:30000,signal:controller.signal,onStarted:v=>console.log(v.name)});`],{env:{...process.env,TMPDIR:temp},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}});
  const name=await firstLine(child);
  let running=false;
  for(let i=0;i<100;i++){if(execFileSync('docker',['inspect','--format','{{.State.Running}}',name],{encoding:'utf8'}).trim()==='true'){running=true;break;}await delay(50);}
  assert.equal(running,true);
  await recoverSandboxes();
  assert.equal(execFileSync('docker',['inspect','--format','{{.State.Running}}',name],{encoding:'utf8'}).trim(),'true','a different state root must preserve this live container');
  const exit=once(child,'exit');child.kill('SIGTERM');assert.equal((await exit)[0],0);
  assert.equal(containers(),'');
});
