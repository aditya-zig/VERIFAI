import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createDemoServer} from '../scripts/serve-web.mjs';
import {openBrowser} from './browser-driver.mjs';
import {sandboxOwner} from '../services/local-sandbox.mjs';
import {repositoryWorkspaceRoot} from '../services/repository-workspaces.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const target='https://github.com/octocat/Hello-World';
const noContainers=()=>assert.equal(execFileSync('docker',['ps','-aq','--filter',`label=dev.verifiai.local-agent.owner=${sandboxOwner}`],{encoding:'utf8'}).trim(),'');

test('master local audit: real public clone, one API model, Docker command, UI and automatic cleanup',async(t)=>{
  const external=process.env.VERIFIAI_MASTER_URL;
  const server=external?null:createDemoServer();
  if(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.shutdown());}
  const base=external || `http://127.0.0.1:${server.address().port}`;
  const page=await (await fetch(base)).text();
  assert.ok(page.includes('/api/local/audits'),'UI must use the master audit endpoint, not manual clone/cleanup');
  const browser=await openBrowser(base);t.after(()=>browser.close());
  const logs=[];
  const count=Number(process.env.VERIFIAI_MASTER_RUNS || 1);
  assert.ok(Number.isInteger(count)&&count>=1&&count<=10);
  for(let run=1;run<=count;run++){
    const started=Date.now();
    let record;
    let id;
    try {
    await browser.wait(`!!document.getElementById('localRepoUrl') && !document.getElementById('startLocalAudit').disabled`);
    await browser.evaluate(`document.getElementById('localRepoUrl').value=${JSON.stringify(target)};document.getElementById('localRepositoryForm').requestSubmit()`);
    await browser.wait(`!!document.getElementById('localRepositoryForm').dataset.auditId`);
    id=await browser.evaluate(`document.getElementById('localRepositoryForm').dataset.auditId`);
    const busy=await fetch(`${base}/api/local/audits`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:target})});
    assert.equal(busy.status,429,'second simultaneous audit must be Busy before cloning/creating a second sandbox');
    for(let poll=0;poll<1200;poll++){
      const response=await fetch(`${base}/api/local/audits/${id}`);
      assert.equal(response.status,200);
      record=await response.json();
      if(record.status!=='Running')break;
      await delay(100);
    }
    assert.equal(record.status,'Completed',JSON.stringify(record));
    for(const stage of ['clone','analysis','sandbox','execution','finding','cleanup'])assert.equal(record.stages[stage].status,'Completed',stage);
    assert.equal(record.repository.fullName,'octocat/Hello-World');
    assert.equal(record.clone.success,true);
    assert.ok(record.files.items.includes('README'));
    assert.ok(record.model.provider && record.model.model);
    assert.equal(record.model.calls,1);
    assert.equal(record.model.requestId,id);
    if(record.model.responseId)assert.ok(!logs.some(log=>log.modelResponseId===record.model.responseId),'provider response identity must not be replayed across master runs');
    assert.equal(record.execution.command,'git -c core.fsmonitor=false ls-files --error-unmatch -- README');
    assert.equal(record.execution.exitCode,0);
    assert.equal(record.execution.stdout,'README\n');
    assert.equal(record.execution.stderr,'');
    assert.equal(record.execution.sandbox.engine,'docker');
    assert.equal(record.execution.sandbox.removed,true);
    assert.equal(record.execution.sandbox.privileged,false);
    assert.ok(record.execution.sandbox.memoryBytes<=2*1024**3);
    assert.ok(record.execution.sandbox.nanoCpus<=2e9);
    assert.deepEqual(record.finding.evidence.execution,record.execution);
    assert.match(record.outputHash,/^[a-f0-9]{64}$/);
    await assert.rejects(access(record.clone.workspacePath));
    noContainers();
    assert.deepEqual(await readdir(repositoryWorkspaceRoot),[],'no registered target workspace or owner record remains');
    const dirs=await readdir('/tmp');
    assert.equal(dirs.some(name=>name.startsWith('verifai-repository-')),false,'no target clone remains');
    const healthy=await fetch(`${base}/health`);assert.equal(healthy.status,200);
    if(external)assert.equal((await fetch('http://127.0.0.1:8787/health')).status,200);
    await browser.wait(`document.getElementById('localAuditStatus')?.textContent==='Completed limited check' && !!document.getElementById('localExecutionEvidence') && !document.getElementById('startLocalAudit').disabled`);
    const text=await browser.evaluate(`document.getElementById('localRepoResult').innerText`);
    assert.ok(text.includes(record.finding.title));assert.match(text,/Docker sandbox started/);assert.match(text,/Exit: 0/);assert.match(text,/cleanup: Completed/);assert.match(text,/analysis: Completed/);
    const ram=execFileSync('free',['-m'],{encoding:'utf8'}).split('\n').find(line=>line.startsWith('Mem:')).trim().split(/\s+/);
    logs.push({run,durationMs:Date.now()-started,id,repository:record.repository.fullName,clone:record.stages.clone.status,
      model:record.stages.analysis.status,provider:record.model.provider,modelId:record.model.model,sandbox:record.stages.sandbox.status,
      command:record.execution.command,exitCode:record.execution.exitCode,stdout:record.execution.stdout,stderr:record.execution.stderr,
      commandDurationMs:record.execution.durationMs,outputHash:record.outputHash,finding:record.finding.title,severity:record.finding.severity,
      modelCalls:record.model.calls,modelRequestId:record.model.requestId,modelResponseId:record.model.responseId,modelUsage:record.model.usage,modelCacheHeader:record.model.cacheHeader,sandboxName:record.execution.sandbox.name,sandboxMemoryLimitMiB:record.execution.sandbox.memoryBytes/1048576,
      sandboxCpuLimit:record.execution.sandbox.nanoCpus/1e9,sandboxPrivileged:record.execution.sandbox.privileged,sandboxRemoved:record.execution.sandbox.removed,
      stageDurationsMs:Object.fromEntries(Object.entries(record.stages).map(([name,value])=>[name,value.durationMs])),
      cleanup:record.stages.cleanup.status,containersRemaining:0,targetReposRemaining:0,ramAvailableMiB:Number(ram.at(-1)),status:'PASS'});
    console.log(JSON.stringify(logs.at(-1)));
    if(process.env.VERIFIAI_MASTER_LOG)await writeFile(process.env.VERIFIAI_MASTER_LOG,JSON.stringify(logs,null,2)+'\n');
    if(run===count && process.env.VERIFIAI_MASTER_SCREENSHOT)await browser.screenshot(process.env.VERIFIAI_MASTER_SCREENSHOT);
    } catch(error) {
      logs.push({run,id,durationMs:Date.now()-started,status:'FAIL',error:String(error.message),stages:record?.stages,execution:record?.execution});
      if(process.env.VERIFIAI_MASTER_LOG)await writeFile(process.env.VERIFIAI_MASTER_LOG,JSON.stringify(logs,null,2)+'\n');
      throw error;
    }
  }
  assert.equal(logs.length,count);
});
