import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rm, writeFile, lstat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {runOwnedProcess, validateCommand} from './local-command.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const sandboxOwner = `vagent.${createHash('sha256').update(root).digest('hex').slice(0,12)}`;
const label = `dev.verifiai.local-agent.owner=${sandboxOwner}`;
const kind = 'dev.verifiai.local-agent.kind=audit-sandbox';
const state = join(tmpdir(), `verifiai-local-agent-${process.getuid()}-${sandboxOwner}`);
const lock = join(state, 'sandbox.lock');
let busy = false;

// Docker CLI gets only its own local configuration, never model credentials.
const environment = Object.fromEntries(['HOME','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','XDG_RUNTIME_DIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
environment.PATH = '/usr/bin:/bin';
export const docker = (args, options={}) => runOwnedProcess('/usr/bin/docker', args, {timeoutMs:10_000, environment, ...options});
async function checked(args, options) {
  const result = await docker(args, options);
  if (result.status !== 'Completed') throw new Error(`Docker ${args[0]} incomplete: ${result.stderr.trim() || result.status}`);
  return result.stdout.trim();
}
function busyError() { const error=new Error('Busy: only one local Docker audit is allowed'); error.statusCode=429; return error; }
async function processIdentity(pid) {
  try { const stat=await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]; }
  catch { return null; }
}

// Recover only explicitly labelled containers of a dead owner. Never touch
// another checkout, another kit resource kind, or a live server's sandbox.
export async function recoverSandboxes() {
  let previous;
  try { previous=JSON.parse(await readFile(join(lock,'owner.json'),'utf8')); }
  catch(error) { if(error.code !== 'ENOENT') throw error; }
  if (previous && await processIdentity(previous.pid) === previous.start) throw busyError();
  if (!previous) {
    try { await lstat(lock); throw busyError(); } catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  const ids = (await checked(['ps','-aq','--filter',`label=${label}`,'--filter',`label=${kind}`])).split('\n').filter(Boolean);
  for (const id of ids) await checked(['rm','-f',id]);
  if (previous) await rm(lock,{recursive:true,force:true});
}

// Trusted sandbox lifecycle boundary. Production callers must use
// executeSandbox() below, which validates bounded policy before Docker spawn.
export async function runSandbox(cwd, executable, args, {timeoutMs=10_000, signal, onStarted}={}) {
  if(busy) throw busyError();
  busy=true;
  const name=`verifai-audit-${randomUUID()}`;
  const started=performance.now();
  let acquired=false;
  let evidence;
  let primaryError;
  try {
    signal?.throwIfAborted();
    await mkdir(state,{recursive:true,mode:0o700});
    await recoverSandboxes();
    try { await mkdir(lock,{mode:0o700}); acquired=true; }
    catch(error) { if(error.code==='EEXIST') throw busyError(); throw error; }
    await writeFile(join(lock,'owner.json'), JSON.stringify({pid:process.pid,start:await processIdentity(process.pid)}),{mode:0o600});
    await checked(['create','--pull','never','--name',name,'--label',label,'--label',kind,
      '--memory','1g','--cpus','2','--pids-limit','64','--network','none',
      '--cap-drop','ALL','--security-opt','no-new-privileges','--user',`${process.getuid()}:${process.getgid()}`,
      '--env','HOME=/nonexistent','--env','GIT_CONFIG_NOSYSTEM=1','--env','GIT_CONFIG_GLOBAL=/dev/null',
      '--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
      '--workdir','/repo',process.env.VERIFIAI_SANDBOX_IMAGE || 'verifai-local-audit:m4',executable,...args], {signal});
    // CLI streams files into the stopped container: works on Docker Desktop
    // without sharing host /tmp, and exposes no host bind mount to the audit.
    await checked(['cp','-a',`${resolve(cwd)}/.`,`${name}:/repo`], {signal});
    const config=JSON.parse(await checked(['inspect','--format','{{json .HostConfig}}',name]));
    onStarted?.({name,memoryBytes:config.Memory,nanoCpus:config.NanoCpus,privileged:config.Privileged});
    const output=await docker(['start','--attach',name], {timeoutMs,signal});
    const containerState=JSON.parse(await checked(['inspect','--format','{{json .State}}',name]));
    const incomplete=output.timedOut || output.aborted || containerState.Running || containerState.Status !== 'exited';
    evidence={command:[executable,...args].join(' '),stdout:output.stdout,stderr:output.stderr,
      exitCode:incomplete?null:containerState.ExitCode,durationMs:Math.round(performance.now()-started),
      timedOut:output.timedOut,aborted:output.aborted,truncated:output.truncated,
      status:incomplete?'Incomplete':containerState.ExitCode===0?'Completed':'Failed',
      sandbox:{name,engine:'docker',image:process.env.VERIFIAI_SANDBOX_IMAGE || 'verifai-local-audit:m4',
        memoryBytes:config.Memory,nanoCpus:config.NanoCpus,privileged:config.Privileged,network:config.NetworkMode,readOnly:config.ReadonlyRootfs}};
  } catch(error) { primaryError=error; }
  finally {
    if(acquired) {
      try {
        const owned=(await checked(['ps','-aq','--filter',`name=^/${name}$`,'--filter',`label=${label}`,'--filter',`label=${kind}`]));
        if(owned) await checked(['rm','-f',owned]);
        const remaining=await checked(['ps','-aq','--filter',`name=^/${name}$`]);
        if(remaining) throw new Error(`Incomplete: sandbox cleanup failed for ${name}`);
        if(evidence) evidence.sandbox.removed=true;
        await rm(lock,{recursive:true,force:true});
      } catch(error) { primaryError=new Error(`Incomplete: sandbox cleanup failed: ${error.message}`); }
    }
    busy=false;
  }
  if(primaryError) throw primaryError;
  return evidence;
}

export async function executeSandbox(cwd, selected, options={}) {
  await validateCommand(cwd,selected);
  const result=await runSandbox(cwd,selected.executable,selected.args,options);
  return {...result,source:selected.source};
}
