import {join,resolve,sep} from 'node:path';
import {mkdir,mkdtemp,open,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {createArtifactBundle,artifactBundlePath} from './proof-artifacts.mjs';
import {proofFingerprint,sha256Bytes} from './proof-snapshots.mjs';

let stagingCounter=0;
function snapshotInput(value){
  if(value===undefined)return undefined;
  try{return structuredClone(value);}
  catch{return JSON.parse(JSON.stringify(value));}
}

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
    // Caller passes entry-snapshots; fingerprint and bytes derive from the same copy.
    const fingerprint=proofFingerprint({audit,repair,browser});
    const data={
      run:{id:audit.id,status:audit.status,startedAt:audit.startedAt,finishedAt:audit.finishedAt,durationMs:audit.durationMs,failedStage:audit.failedStage,error:audit.error,stages:audit.stages},
      repository:audit.repository,
      finding:audit.finding,
      specialists:audit.specialists,
      execution:audit.execution,
      browser,
      repair,
      cleanup:audit.cleanup,
      model:audit.model,
    };
    const secrets=secretsFromEnv(this.env);
    const resolver=this.screenshotResolver;
    await mkdir(resolve(this.root),{recursive:true,mode:0o700});
    const finalPath=artifactBundlePath(this.root,audit.id);
    const stagingRoot=await mkdtemp(join(resolve(this.root),`.staging-${process.pid}-${(stagingCounter+=1)}-`));
    const backupPath=`${finalPath}.backup-${process.pid}-${stagingCounter}`;
    let bundle;
    try{
      bundle=await createArtifactBundle({rootDir:stagingRoot,runId:audit.id,replace:false,knownSecrets:secrets,screenshotResolver:resolver,data});
    }catch(error){
      await rm(stagingRoot,{recursive:true,force:true});
      throw error;
    }
    const stagedPath=artifactBundlePath(stagingRoot,audit.id);
    let movedBackup=false;
    try{
      try{await rename(finalPath,backupPath);movedBackup=true;}
      catch(error){if(error?.code!=='ENOENT')throw error;}
      await rename(stagedPath,finalPath);
    }catch(error){
      if(movedBackup){
        try{await rename(backupPath,finalPath);}catch{}
      }
      await rm(stagingRoot,{recursive:true,force:true});
      await rm(backupPath,{recursive:true,force:true});
      throw error;
    }
    await rm(stagingRoot,{recursive:true,force:true});
    await rm(backupPath,{recursive:true,force:true});
    const descriptor={
      runId:bundle.runId,
      manifest:{id:`proof:${bundle.runId}:manifest`,sha256:bundle.manifestSha256},
      artifacts:bundle.manifest.artifacts.map(item=>({name:item.name,status:item.status,path:item.path,sha256:item.sha256,reason:item.reason})),
      screenshotRefs:bundle.manifest.references.screenshots,
      totalBytes:bundle.totalBytes,
    };
    this.#remember(audit.id,descriptor,fingerprint);
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
    const auditSnap=snapshotInput(audit),repairSnap=snapshotInput(repair),browserSnap=snapshotInput(browser);
    return this.#withLock(auditSnap.id,()=>this.#publishLocked(auditSnap,{repair:repairSnap,browser:browserSnap}));
  }
  async getOrPublish(audit,{repair,browser}={}){
    if(!audit?.id||audit.status==='Running')throw new Error('terminal audit is required for proof artifacts');
    // Snapshot JSON-shaped inputs on entry, before awaiting the per-run
    // queue. The same snapshot feeds the fingerprint and the bytes, so a
    // caller mutating its objects during publication cannot poison the cache.
    const auditSnap=snapshotInput(audit),repairSnap=snapshotInput(repair),browserSnap=snapshotInput(browser);
    const fingerprint=proofFingerprint({audit:auditSnap,repair:repairSnap,browser:browserSnap});
    return this.#withLock(auditSnap.id,async()=>{
      const cached=this.#records.get(auditSnap.id);
      if(cached&&this.#fingerprints.get(auditSnap.id)===fingerprint)return JSON.parse(JSON.stringify(cached));
      return this.#publishLocked(auditSnap,{repair:repairSnap,browser:browserSnap});
    });
  }
}
