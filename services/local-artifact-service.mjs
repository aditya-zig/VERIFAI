import {join,resolve,sep} from 'node:path';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {createArtifactBundle} from './proof-artifacts.mjs';
import {proofFingerprint,sha256Bytes} from './proof-snapshots.mjs';

function secretsFromEnv(env){
  const names=['XKIRO_API_KEY','OPENROUTER_API_KEY','NVIDIA_API_KEY','OLLAMA_API_KEY','GITHUB_TOKEN','GH_TOKEN','VERIFIAI_GITHUB_TOKEN'];
  return names.map(name=>env[name]).filter(value=>typeof value==='string'&&value.length>=4);
}
function publicDescriptor(bundle){
  return {
    runId:bundle.runId,
    manifest:{id:`proof:${bundle.runId}:manifest`,sha256:bundle.manifestSha256},
    artifacts:bundle.manifest.artifacts.map(item=>({name:item.name,status:item.status,path:item.path,sha256:item.sha256,reason:item.reason})),
    screenshotRefs:bundle.manifest.references.screenshots,
    totalBytes:bundle.totalBytes,
  };
}
export class LocalArtifactService{
  #records=new Map();
  #fingerprints=new Map();
  #locks=new Map();
  constructor({env=process.env,screenshotResolver}={}){
    this.env=env;this.screenshotResolver=screenshotResolver;
    this.root=resolve(env.VERIFIAI_ARTIFACT_DIR||join(env.VERIFIAI_DATA_DIR||'./data','artifacts'));
  }
  setScreenshotResolver(resolver){if(resolver!==undefined&&typeof resolver!=='function')throw new Error('screenshot resolver must be a function');this.screenshotResolver=resolver;}
  get(runId){const value=this.#records.get(runId);return value?JSON.parse(JSON.stringify(value)):undefined;}
  async #withLock(runId,fn){
    const prior=this.#locks.get(runId)||Promise.resolve();
    let release;
    const current=new Promise((resolve)=>{release=resolve;});
    const next=prior.then(()=>current);
    this.#locks.set(runId,next);
    await prior;
    try{return await fn();}
    finally{release();if(this.#locks.get(runId)===next)this.#locks.delete(runId);}
  }
  #remember(runId,descriptor,fingerprint){
    this.#records.set(runId,descriptor);
    this.#fingerprints.set(runId,fingerprint);
    while(this.#records.size>30){
      const oldest=this.#records.keys().next().value;
      this.#records.delete(oldest);
      this.#fingerprints.delete(oldest);
    }
  }
  async #publishLocked(audit,{repair,browser}={}){
    const bundle=await createArtifactBundle({
      rootDir:this.root,runId:audit.id,replace:true,knownSecrets:secretsFromEnv(this.env),screenshotResolver:this.screenshotResolver,
      data:{
        run:{id:audit.id,status:audit.status,startedAt:audit.startedAt,finishedAt:audit.finishedAt,durationMs:audit.durationMs,failedStage:audit.failedStage,error:audit.error,stages:audit.stages},
        repository:audit.repository,
        finding:audit.finding,
        specialists:audit.specialists,
        execution:audit.execution,
        browser,
        repair,
        cleanup:audit.cleanup,
        model:audit.model,
      },
    });
    const descriptor=publicDescriptor(bundle);
    this.#remember(audit.id,descriptor,proofFingerprint({audit,repair,browser}));
    return JSON.parse(JSON.stringify(descriptor));
  }
  async read(runId,artifactPath){
    return this.#withLock(runId,async()=>{
      const record=this.#records.get(runId);
      if(!record)throw Object.assign(new Error('proof artifact bundle not found'),{statusCode:404});
      const item=record.artifacts.find(x=>x.status==='Present'&&x.path===artifactPath);
      if(!item)throw Object.assign(new Error('proof artifact not found'),{statusCode:404});
      const base=resolve(this.root,runId),target=resolve(base,artifactPath);
      if(target!==base&&!target.startsWith(base+sep))throw Object.assign(new Error('invalid artifact path'),{statusCode:400});
      let handle;
      try{
        handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
        const stat=await handle.stat();
        if(!stat.isFile()||stat.uid!==process.getuid()||stat.size>50*1024*1024)throw new Error('artifact ownership/size check failed');
        const buffer=await handle.readFile();
        if(!item.sha256||sha256Bytes(buffer)!==item.sha256)throw Object.assign(new Error('proof artifact integrity check failed: bytes do not match manifest hash'),{statusCode:500});
        return {item:{...item},buffer};
      }finally{await handle?.close();}
    });
  }
  async refresh(audit,{repair,browser}={}){
    if(!audit?.id||audit.status==='Running')throw new Error('terminal audit is required for proof artifacts');
    return this.#withLock(audit.id,()=>this.#publishLocked(audit,{repair,browser}));
  }
  async getOrPublish(audit,{repair,browser}={}){
    if(!audit?.id||audit.status==='Running')throw new Error('terminal audit is required for proof artifacts');
    return this.#withLock(audit.id,async()=>{
      const fingerprint=proofFingerprint({audit,repair,browser});
      const cached=this.#records.get(audit.id);
      if(cached&&this.#fingerprints.get(audit.id)===fingerprint)return JSON.parse(JSON.stringify(cached));
      return this.#publishLocked(audit,{repair,browser});
    });
  }
}
