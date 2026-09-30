import {randomUUID,createHash} from 'node:crypto';
import {access} from 'node:fs/promises';
import {selectCommand} from './local-command.mjs';
import {executeSandbox} from './local-sandbox.mjs';
import {analyzeRepository} from './local-analysis.mjs';
import {acquireLocalAudit} from './local-audit.mjs';

const stageNames=['clone','analysis','sandbox','execution','finding','cleanup'];
export class MasterAuditService {
  #runs=new Map();
  #tasks=new Set();
  constructor(repositories,{env=process.env}={}) {this.repositories=repositories;this.env=env;}
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
        ...(['Completed','Failed','Incomplete'].includes(status)?{durationMs:old.startedMs?now-old.startedMs:0}:{} )};
      active=name;
    };
    try {
      stage('clone','Running');
      record=await this.repositories.clone(url,{signal:lease.signal});
      Object.assign(run,{repository:record.repository,clone:record.clone,files:record.files});
      stage('clone','Completed',`${record.files.count} tracked files cloned`);
      // Exactly one real model call BEFORE command execution. It inspects real
      // bounded repository context, not fabricated/predicted command output.
      // Execution evidence is attached afterward by the server, never by AI.
      stage('analysis','Running');
      const analysis=await analyzeRepository(record,{env:this.env,signal:lease.signal,auditId:run.id});
      run.model={...analysis.model,calls:1};
      stage('analysis','Completed',`${run.model.provider} / ${run.model.model}`);
      stage('sandbox','Running');
      const command=await selectCommand(record.clone.workspacePath,record.files.items);
      run.selectedCommand=[command.executable,...command.args].join(' ');
      stage('execution','Running');
      active='sandbox';
      run.execution=await executeSandbox(record.clone.workspacePath,command,{signal:lease.signal,onStarted:metadata=>{
        run.stages.sandbox.detail=`Container created: ${metadata.name}`;active='execution';
      }});
      stage('sandbox',run.execution.sandbox.started?'Completed':'Incomplete',`Docker sandbox: ${run.execution.sandbox.name}; removed after command`);
      stage('execution',run.execution.status,`Exit ${run.execution.exitCode}`);
      run.outputHash=createHash('sha256').update(JSON.stringify({stdout:run.execution.stdout,stderr:run.execution.stderr,exitCode:run.execution.exitCode})).digest('hex');
      if(run.execution.status==='Incomplete')throw new Error(run.execution.timedOut?'Command timed out':'Command interrupted');
      stage('finding','Running');
      const e=run.execution;
      run.finding={...analysis.finding,
        description:`${analysis.finding.description}\n\nExecuted evidence: ${e.command}\nExit: ${e.exitCode}\nstdout: ${e.stdout || '(empty)'}\nstderr: ${e.stderr || '(empty)'}`,
        evidence:{...analysis.finding.evidence,execution:e}};
      stage('finding','Completed','API finding attached to server-owned executed evidence');
      terminalStatus=e.exitCode===0?'Completed':'Incomplete';
      if(e.exitCode!==0)run.failedStage='execution';
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
