import {randomUUID,createHash} from 'node:crypto';
import {access,mkdir,rename,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {selectCommand} from './local-command.mjs';
import {executeSandbox} from './local-sandbox.mjs';
import {analyzeRepository} from './local-analysis.mjs';
import {composeFinding} from './finding-evidence.mjs';
import {acquireLocalAudit} from './local-audit.mjs';
import {createSecuritySpecialist,runSequentialSpecialists} from './local-specialists.mjs';
import {reviewSecurityRepository} from './local-security-specialist.mjs';

const stageNames=['clone','analysis','sandbox','execution','finding','cleanup'];

function securityEnabled(env) {
  return env.VERIFIAI_M6_SECURITY_SPECIALIST === 'true';
}

export async function persistSpecialistState(runId,snapshot,{env=process.env}={}) {
  const root=resolve(env.VERIFIAI_DATA_DIR || './data','specialists');
  await mkdir(root,{recursive:true,mode:0o700});
  const path=join(root,`${runId}.json`);
  const temp=`${path}.tmp-${process.pid}`;
  const text=JSON.stringify(snapshot,null,2)+'\n';
  if (Buffer.byteLength(text,'utf8') >= 1024*1024) throw new Error('specialist shared state must stay below 1 MiB');
  await writeFile(temp,text,{mode:0o600});
  await rename(temp,path);
  return path;
}

export class MasterAuditService {
  #runs=new Map();
  #tasks=new Set();
  constructor(repositories,{
    env=process.env,
    analyze=analyzeRepository,
    execute=executeSandbox,
    select=selectCommand,
    securityReview=reviewSecurityRepository,
    persistSpecialists=persistSpecialistState,
  }={}) {
    this.repositories=repositories;
    this.env=env;
    this.analyze=analyze;
    this.execute=execute;
    this.select=select;
    this.securityReview=securityReview;
    this.persistSpecialists=persistSpecialists;
  }
  start(url) {
    const lease=acquireLocalAudit(AbortSignal.timeout(120_000)); // Reject Busy BEFORE clone, model, or Docker.
    const id=randomUUID();
    const run={id,status:'Running',startedAt:new Date().toISOString(),stages:Object.fromEntries(stageNames.map(name=>[name,{status:'Pending'}]))};
    if(this.#runs.size>=30){const old=[...this.#runs].find(([,value])=>value.status!=='Running');if(old)this.#runs.delete(old[0]);}
    this.#runs.set(id,run);
    const task=this.#execute(run,url,lease);
    this.#tasks.add(task);task.finally(()=>this.#tasks.delete(task));
    return {id,status:'Running'};
  }
  get(id) {const run=this.#runs.get(id);return run?JSON.parse(JSON.stringify(run)):undefined;}
  async waitForIdle(){await Promise.all([...this.#tasks]);}
  async #execute(run,url,lease) {
    const start=performance.now();
    let record;
    let active='clone';
    let cleanupBroken=false;
    let terminalStatus='Incomplete';
    const stage=(name,status,detail)=>{
      const old=run.stages[name];const now=Date.now();
      run.stages[name]={...old,status,...(detail?{detail}:{}),
        ...(status==='Running'?{startedAt:new Date(now).toISOString(),startedMs:now}:{}),
        ...(['Completed','Failed','Incomplete'].includes(status)?{durationMs:old.startedMs?now-old.startedMs:0}:{})};
      active=name;
    };
    try {
      stage('clone','Running');
      record=await this.repositories.clone(url,{signal:lease.signal});
      Object.assign(run,{repository:record.repository,clone:record.clone,files:record.files});
      stage('clone','Completed',`${record.files.count} tracked files cloned`);
      // Exactly one real base model call BEFORE command execution.
      stage('analysis','Running');
      const analysis=await this.analyze(record,{env:this.env,signal:lease.signal,auditId:run.id});
      run.model={...analysis.model,calls:1};
      stage('analysis','Completed',`${run.model.provider} / ${run.model.model}`);
      stage('sandbox','Running');
      const command=await this.select(record.clone.workspacePath,record.files.items);
      run.selectedCommand=[command.executable,...command.args].join(' ');
      stage('execution','Running');
      active='sandbox';
      run.execution=await this.execute(record.clone.workspacePath,command,{signal:lease.signal,onStarted:metadata=>{
        run.stages.sandbox.detail=`Container created: ${metadata.name}`;active='execution';
      }});
      stage('sandbox',run.execution.sandbox.started?'Completed':'Incomplete',`Docker sandbox: ${run.execution.sandbox.name}; removed after command`);
      stage('execution',run.execution.status,`Exit ${run.execution.exitCode}`);
      run.outputHash=createHash('sha256').update(JSON.stringify({stdout:run.execution.stdout,stderr:run.execution.stderr,exitCode:run.execution.exitCode})).digest('hex');
      if(run.execution.status==='Incomplete')throw new Error(run.execution.timedOut?'Command timed out':'Command interrupted');
      stage('finding','Running');
      const e=run.execution;
      const composed=composeFinding({
        modelFinding:analysis.finding,
        execution:e,
        selectedCommand:run.selectedCommand,
        repository:record.repository,
        auditId:run.id,
      });
      run.finding={
        title:composed.title,
        severity:composed.severity,
        description:composed.description,
        evidence:{file:analysis.finding.evidence?.file,execution:e,selectedCommand:run.selectedCommand,provenance:composed.evidence.provenance},
        hypothesis:composed.hypothesis,
        executedCheck:composed.executedCheck,
        assessment:composed.assessment,
        verifiedTarget:composed.verifiedTarget,
      };
      stage('finding','Completed','Model hypothesis kept separate from server-owned executed evidence');
      terminalStatus=e.exitCode===0?'Completed':'Incomplete';
      if(e.exitCode!==0)run.failedStage='execution';

      // M6 is strictly opt-in. When disabled, the M5 run shape and model count
      // remain unchanged. When enabled, exactly one security specialist runs
      // after the base finding and before clone cleanup.
      if (securityEnabled(this.env)) {
        const specialist=createSecuritySpecialist((current,options)=>this.securityReview(current,{...options,env:this.env}));
        try {
          const result=await runSequentialSpecialists({
            specialists:[specialist],
            maxSpecialists:1,
            maxModelCalls:1,
            signal:lease.signal,
            context:{record,auditId:run.id},
            persist:async(snapshot)=>{
              run.specialists=snapshot;
              await this.persistSpecialists(run.id,snapshot,{env:this.env});
            },
          });
          run.specialists=result;
          if(result.status==='Incomplete') {
            terminalStatus='Incomplete';
            run.failedStage='specialist';
            run.error=result.results.find((item)=>item.status==='Incomplete')?.error || 'Security specialist incomplete';
          }
        } catch(error) {
          terminalStatus='Incomplete';
          run.failedStage='specialist';
          run.error=String(error?.message || error);
          run.specialists=run.specialists || {
            status:'Incomplete',
            results:[{id:'security',status:'Incomplete',findings:[],evidenceRefs:[],error:run.error}],
            evidenceRefs:[],
            modelCalls:0,
          };
        }
      }
    } catch(error) {
      if(/cleanup failed/i.test(error.message)){active='cleanup';cleanupBroken=true;}
      stage(active,'Incomplete',String(error.message));
      terminalStatus='Incomplete';run.failedStage=active;run.error=String(error.message);
    } finally {
      try {
        stage('cleanup','Running');
        if(record){
          await this.repositories.cleanup(record.id);
          const stillExists=await access(record.clone.workspacePath).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
          if(stillExists)throw new Error('Temporary repository still exists');
        }
        if(cleanupBroken)throw new Error('Docker sandbox cleanup was not proven');
        run.cleanup={repositoryRemoved:true,sandboxRemoved:run.execution?.sandbox?.removed ?? true};
        stage('cleanup','Completed','Temporary repository and sandbox removed');
      } catch(error) {stage('cleanup','Incomplete',String(error.message));terminalStatus='Incomplete';run.failedStage='cleanup';run.error=String(error.message);}
      for(const name of stageNames){
        if(run.stages[name].status==='Pending')run.stages[name].status='Skipped';
        else if(run.stages[name].status==='Running')run.stages[name].status='Incomplete';
      }
      run.durationMs=Math.round(performance.now()-start);
      run.finishedAt=new Date().toISOString();run.status=terminalStatus;lease.release();
    }
  }
}
