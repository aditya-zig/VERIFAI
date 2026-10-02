import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {access,readdir} from 'node:fs/promises';
import {createDemoServer} from '../scripts/serve-web.mjs';
import {recoverRepositoryWorkspaces,repositoryWorkspaceRoot} from '../services/repository-workspaces.mjs';
import {sandboxOwner} from '../services/local-sandbox.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('missing model capability is Incomplete with stage-specific error and actual clone cleanup',async(t)=>{
  const server=createDemoServer({env:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.shutdown());
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(`${base}/api/local/audits`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://github.com/octocat/Hello-World'})});
  assert.equal(response.status,202);const {id}=await response.json();
  let result;for(let i=0;i<600;i++){result=await (await fetch(`${base}/api/local/audits/${id}`)).json();if(result.status!=='Running')break;await delay(50);}
  assert.equal(result.status,'Incomplete');assert.equal(result.failedStage,'analysis');
  assert.match(result.error,/not configured|not configured/i);
  assert.equal(result.stages.clone.status,'Completed');assert.equal(result.stages.analysis.status,'Incomplete');
  assert.equal(result.stages.sandbox.status,'Skipped');assert.equal(result.stages.cleanup.status,'Completed');
  assert.equal(result.finding,undefined);assert.equal(result.execution,undefined);
  await assert.rejects(access(result.clone.workspacePath));
  assert.equal(execFileSync('docker',['ps','-aq','--filter',`label=dev.verifiai.local-agent.owner=${sandboxOwner}`],{encoding:'utf8'}).trim(),'');
});

test('SIGKILL clone-owner recovery removes only its registered workspace, and preserves live ownership',async(t)=>{
  const module=new URL('../services/local-repository.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {LocalRepositoryService} from ${JSON.stringify(module)};const r=await new LocalRepositoryService().clone('https://github.com/octocat/Hello-World');console.log(r.clone.workspacePath);setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}await recoverRepositoryWorkspaces();});
  const path=await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n'))resolve(text.split('\n')[0]);});child.once('error',reject);child.once('exit',code=>{if(!text.includes('\n'))reject(new Error(`Clone child exited ${code}`));});});
  await access(path);await recoverRepositoryWorkspaces();await access(path);
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  await recoverRepositoryWorkspaces();await assert.rejects(access(path));
  assert.deepEqual(await readdir(repositoryWorkspaceRoot),[]);
});
