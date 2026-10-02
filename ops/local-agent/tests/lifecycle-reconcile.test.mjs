import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const scripts=path.join(repoRoot,'ops/local-agent/scripts');
const reconcile=path.join(scripts,'reconcile-local.sh');
const watcher=path.join(scripts,'watch-local.sh');
const stop=path.join(scripts,'stop-local.sh');

function stateDir(tmp){
  const digest=createHash('sha256').update(repoRoot).digest('hex').slice(0,12);
  return path.join(tmp,`verifiai-local-agent-${process.getuid()}-vagent.${digest}`);
}
function run(script,args=[],tmp){
  return spawnSync('bash',[script,...args],{cwd:repoRoot,env:{...process.env,TMPDIR:tmp},encoding:'utf8',timeout:15000});
}
function ps(pid,field){return spawnSync('ps',['-o',`${field}=`,'-p',String(pid)],{encoding:'utf8'}).stdout.trim();}
function alive(pid){return spawnSync('kill',['-0',String(pid)]).status===0;}
function writeState(dir,name,fields){mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,`${name}.state`),Object.entries(fields).map(([k,v])=>`${k}=${v}\n`).join(''));}

test('lifecycle scripts are valid bash',()=>{
  for(const script of [reconcile,watcher,stop]){
    assert.equal(spawnSync('bash',['-n',script]).status,0,`bash -n failed: ${script}`);
  }
});

test('stop refuses a reused pid and leaves the unrelated process and state untouched',()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'verifai-stop-refuse-'));
  const decoy=spawn('sleep',['120'],{stdio:'ignore'});
  try{
    const dir=stateDir(tmp);
    writeState(dir,'worker',{service:'worker',pid:decoy.pid,start_time:'Mon Jan 1 00:00:00 1990',cwd:repoRoot,command:'sleep 120'});
    const r=run(stop,[],tmp);
    assert.notEqual(r.status,0,`stop should refuse identity mismatch:\n${r.stdout}\n${r.stderr}`);
    assert.ok(alive(decoy.pid),'unrelated process must survive a refused stop');
    assert.ok(existsSync(path.join(dir,'worker.state')),'refused ownership state must be preserved');
  }finally{decoy.kill('SIGKILL');rmSync(tmp,{recursive:true,force:true});}
});

test('stop terminates an owned process gracefully and clears its state',()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'verifai-stop-owned-'));
  // Detached via setsid so the fixture is not a child of this test process:
  // a synchronous waiter cannot reap its own child, and the resulting zombie
  // would pass kill -0 forever. Reparented processes are reaped normally.
  const launched=spawnSync('bash',['-c','setsid sleep 120 < /dev/null > /dev/null 2>&1 & echo $!'],{cwd:repoRoot,encoding:'utf8'});
  const pid=Number(launched.stdout.trim());
  assert.ok(Number.isInteger(pid)&&pid>1,'fixture did not launch');
  try{
    const dir=stateDir(tmp);
    const cwd=spawnSync('readlink',[`/proc/${pid}/cwd`],{encoding:'utf8'}).stdout.trim();
    writeState(dir,'worker',{service:'worker',pid,start_time:ps(pid,'lstart'),cwd,command:ps(pid,'args')});
    const r=run(stop,[],tmp);
    assert.equal(r.status,0,`owned stop failed:\n${r.stdout}\n${r.stderr}`);
    assert.ok(!alive(pid),'owned process must be stopped');
    assert.ok(!existsSync(path.join(dir,'worker.state')),'stopped state must be cleared');
  }finally{if(alive(pid))spawnSync('kill',['-KILL',String(pid)]);rmSync(tmp,{recursive:true,force:true});}
});

test('stop clears stale state when the recorded process is already gone',()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'verifai-stop-gone-'));
  try{
    const dir=stateDir(tmp);
    writeState(dir,'worker',{service:'worker',pid:999999,start_time:'x',cwd:repoRoot,command:'node worker.mjs'});
    const r=run(stop,[],tmp);
    assert.equal(r.status,0,`gone-process stop failed:\n${r.stdout}\n${r.stderr}`);
    assert.ok(!existsSync(path.join(dir,'worker.state')),'stale state must be cleared');
  }finally{rmSync(tmp,{recursive:true,force:true});}
});

test('gone owned process reconciles to Crashed and clears active state',()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'verifai-reconcile-gone-'));
  try{
    const dir=stateDir(tmp);
    writeState(dir,'worker',{service:'worker',pid:999999,start_time:'x',cwd:repoRoot,command:'node worker.mjs'});
    const r=run(reconcile,[],tmp);
    assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);
    assert.ok(!existsSync(path.join(dir,'worker.state')));
    assert.match(readFileSync(path.join(dir,'worker.exit'),'utf8'),/status=Crashed/);
  }finally{rmSync(tmp,{recursive:true,force:true});}
});

test('PID reuse or identity mismatch is StaleOwnership and unrelated process survives',()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'verifai-reconcile-reuse-'));
  const decoy=spawn('sleep',['120'],{stdio:'ignore'});
  try{
    const dir=stateDir(tmp);
    writeState(dir,'worker',{service:'worker',pid:decoy.pid,start_time:'Mon Jan 1 00:00:00 1990',cwd:repoRoot,command:'sleep 120'});
    const r=run(reconcile,[],tmp);
    assert.equal(r.status,2,`${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`,/StaleOwnership/);
    assert.ok(alive(decoy.pid));
    assert.ok(existsSync(path.join(dir,'worker.state')));
  }finally{decoy.kill('SIGKILL');rmSync(tmp,{recursive:true,force:true});}
});

test('corrupt or missing PID remains Unknown and is preserved',()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'verifai-reconcile-unknown-'));
  try{
    const dir=stateDir(tmp);mkdirSync(dir,{recursive:true});
    writeFileSync(path.join(dir,'worker.state'),'service=worker\ncommand=node worker.mjs\n');
    const r=run(reconcile,[],tmp);
    assert.equal(r.status,2);
    assert.match(`${r.stdout}\n${r.stderr}`,/Unknown/);
    assert.ok(existsSync(path.join(dir,'worker.state')));
  }finally{rmSync(tmp,{recursive:true,force:true});}
});

test('exact live identity reports Running without signalling it',()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'verifai-reconcile-running-'));
  const child=spawn('sleep',['120'],{cwd:repoRoot,stdio:'ignore'});
  try{
    const dir=stateDir(tmp);
    const cwd=spawnSync('readlink',[`/proc/${child.pid}/cwd`],{encoding:'utf8'}).stdout.trim();
    writeState(dir,'worker',{service:'worker',pid:child.pid,start_time:ps(child.pid,'lstart'),cwd,command:ps(child.pid,'args')});
    const r=run(reconcile,[],tmp);
    assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout,/Running/);
    assert.ok(alive(child.pid));
  }finally{child.kill('SIGKILL');rmSync(tmp,{recursive:true,force:true});}
});

test('watcher uses a lock so duplicate start exits safely, then can restart',async()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'verifai-watch-'));
  const env={...process.env,TMPDIR:tmp};
  const first=spawn('bash',[watcher,'--interval','1'],{cwd:repoRoot,env,stdio:['ignore','pipe','pipe']});
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('watcher did not start')),4000);
      first.stdout.on('data',b=>{if(String(b).includes('watcher: running')){clearTimeout(timer);resolve();}});
      first.once('exit',code=>reject(new Error(`watcher exited early ${code}`)));
    });
    const duplicate=spawnSync('bash',[watcher,'--interval','1'],{cwd:repoRoot,env,encoding:'utf8',timeout:5000});
    assert.equal(duplicate.status,0);
    assert.match(duplicate.stdout,/already running/);
    first.kill('SIGTERM');
    await new Promise(resolve=>first.once('exit',resolve));
    const second=spawn('bash',[watcher,'--interval','1'],{cwd:repoRoot,env,stdio:'ignore'});
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.ok(alive(second.pid),'watcher did not restart');
    second.kill('SIGTERM');
  }finally{
    if(alive(first.pid)) first.kill('SIGTERM');
    rmSync(tmp,{recursive:true,force:true});
  }
});
