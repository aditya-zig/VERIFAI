import {selectCommand} from './local-command.mjs';
import {executeSandbox} from './local-sandbox.mjs';
import {runRepairVerification} from './local-repair-verification.mjs';
import {describeRegressionCoverage,isExecutedFailure,repairAdmissionForAudit} from './finding-evidence.mjs';

function repoUrl(fullName){return `https://github.com/${fullName}`;}

export class LocalRepairService{
  #repairs=new Map();
  constructor(repositories,audits,{env=process.env,select=selectCommand,execute=executeSandbox,runRepair=runRepairVerification}={}){
    this.repositories=repositories;this.audits=audits;this.env=env;this.select=select;this.execute=execute;this.runRepair=runRepair;
  }
  get(auditId){const value=this.#repairs.get(auditId);return value?JSON.parse(JSON.stringify(value)):undefined;}
  async repair(auditId,patch,{signal}={}){
    const audit=this.audits.get(auditId);
    if(!audit)throw Object.assign(new Error('audit not found'),{statusCode:404});
    if(!isExecutedFailure(audit.execution))throw Object.assign(new Error('Repair requires a real failed execution from the audit (status Failed, sandbox started, integer nonzero exit)'),{statusCode:409});
    if(!audit.repository?.fullName||!audit.repository?.commit)throw Object.assign(new Error('Repair requires exact repository commit provenance'),{statusCode:409});
    const admission=repairAdmissionForAudit(audit);
    if(!admission.eligible)throw Object.assign(new Error(`Repair not admitted: ${admission.reason}`),{statusCode:409});
    let record;
    try{
      record=await this.repositories.clone(repoUrl(audit.repository.fullName),{signal});
      if(record.repository.commit!==audit.repository.commit)throw Object.assign(new Error('Repository HEAD changed; re-verification required'),{statusCode:409});
      const selected=await this.select(record.clone.workspacePath,record.files.items);
      const rendered=[selected.executable,...selected.args].join(' ');
      if(rendered!==audit.selectedCommand)throw Object.assign(new Error('Verification command changed; re-verification required'),{statusCode:409});
      const verify=async({workspacePath,signal:checkSignal,label})=>{
        const e=await this.execute(workspacePath,selected,{signal:checkSignal});
        return {...e,executed:e?.sandbox?.started===true,provenance:{kind:'m5-command',auditId,commit:audit.repository.commit,label}};
      };
      const coverage=describeRegressionCoverage({count:1,command:rendered});
      const repairFinding={
        findingState:'Unconfirmed',
        modelHypothesis:audit.finding?.hypothesis || {kind:'model-hypothesis',title:audit.finding?.title,description:typeof audit.finding?.description==='string'?audit.finding.description:'',confidence:'Unconfirmed'},
        verifiedTarget:{kind:'executed-command-failure',command:audit.execution.command,exitCode:audit.execution.exitCode,status:audit.execution.status,sandboxStarted:true,provenance:{kind:'m5-command',auditId,commit:audit.repository.commit}},
        evidence:audit.execution,
      };
      const result=await this.runRepair({
        workspacePath:record.clone.workspacePath,
        finding:repairFinding,
        patch,
        verify,
        regressions:[verify],
        timeoutMs:Number(this.env.VERIFIAI_REPAIR_CHECK_TIMEOUT_MS||10000),
        signal,
        baseCommitSha:audit.repository.commit,
      });
      const stored={auditId,repository:audit.repository,selectedCommand:audit.selectedCommand,modelHypothesis:repairFinding.modelHypothesis,verifiedTarget:repairFinding.verifiedTarget,coverage,...result};
      this.#repairs.set(auditId,stored);
      return JSON.parse(JSON.stringify(stored));
    }finally{
      if(record)await this.repositories.cleanup(record.id);
    }
  }
}
