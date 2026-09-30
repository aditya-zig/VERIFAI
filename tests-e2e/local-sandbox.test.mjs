import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runSandbox, sandboxOwner} from '../services/local-sandbox.mjs';

function remaining() {return execFileSync('docker',['ps','-aq','--filter',`label=dev.verifiai.local-agent.owner=${sandboxOwner}`],{encoding:'utf8'}).trim();}
async function fixture(t) {const cwd=await mkdtemp(join(tmpdir(),'verifai-sandbox-test-'));t.after(()=>rm(cwd,{recursive:true,force:true}));return cwd;}

test('one real bounded Docker container executes a command and disappears', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'verifai-sandbox-test-'));
  t.after(() => rm(cwd, {recursive:true,force:true}));
  const evidence = await runSandbox(cwd, 'node', ['--version']);
  assert.equal(evidence.exitCode, 0);
  assert.match(evidence.stdout, /^v22\./);
  assert.equal(evidence.sandbox.removed, true);
  assert.ok(evidence.sandbox.memoryBytes <= 2*1024**3);
  assert.ok(evidence.sandbox.nanoCpus <= 2e9);
  assert.equal(evidence.sandbox.privileged, false);
  assert.equal(remaining(), '');
});

test('real nonzero command failure leaves no container', async(t)=>{
  const cwd=await fixture(t);
  await writeFile(join(cwd,'bad.js'),'const = ;');
  const result=await runSandbox(cwd,'node',['--check','bad.js']);
  assert.equal(result.exitCode,1);
  assert.equal(result.status,'Failed');
  assert.match(result.stderr,/SyntaxError/);
  assert.equal(result.sandbox.removed,true);
  assert.equal(remaining(),'');
});

test('a real running command times out and its Docker container is removed',async(t)=>{
  const result=await runSandbox(await fixture(t),'node',['-e',"console.log('real timeout command started');setInterval(()=>{},1000)"],{timeoutMs:1500});
  assert.match(result.stdout,/real timeout command started/);
  assert.equal(result.status,'Incomplete');
  assert.equal(result.exitCode,null);
  assert.equal(result.timedOut,true);
  assert.equal(result.sandbox.removed,true);
  assert.equal(remaining(),'');
});

test('a second audit is Busy, and interruption cleans the only container',async(t)=>{
  const cwd=await fixture(t);
  const controller=new AbortController();
  let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const first=runSandbox(cwd,'node',['-e','setInterval(()=>{},1000)'],{signal:controller.signal,onStarted:started});
  await ready;
  await assert.rejects(runSandbox(cwd,'node',['--version']),error=>error.statusCode===429 && /Busy/.test(error.message));
  assert.equal(remaining().split('\n').length,1);
  controller.abort();
  const result=await first;
  assert.equal(result.status,'Incomplete');
  assert.equal(result.aborted,true);
  assert.equal(result.sandbox.removed,true);
  assert.equal(remaining(),'');
});
