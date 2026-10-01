import {join,resolve,sep} from 'node:path';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createArtifactBundle} from './proof-artifacts.mjs';

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
  constructor({env=process.env,screenshotResolver}={}){
    this.env=env;this.screenshotResolver=screenshotResolver;
    this.root=resolve(env.VERIFIAI_ARTIFACT_DIR||join(env.VERIFIAI_DATA_DIR||'./data','artifacts'));
  }
  setScreenshotResolver(resolver){if(resolver!==undefined&&typeof resolver!=='function')throw new Error('screenshot resolver must be a function');this.screenshotResolver=resolver;}
  get(runId){const value=this.#records.get(runId);return value?JSON.parse(JSON.stringify(value)):undefined;}
  async read(runId,artifactPath){
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
      return {item:{...item},buffer:await handle.readFile()};
    }finally{await handle?.close();}
  }
  async refresh(audit,{repair,browser}={}){
    if(!audit?.id||audit.status==='Running')throw new Error('terminal audit is required for proof artifacts');
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
    const descriptor=publicDescriptor(bundle);this.#records.set(audit.id,descriptor);return JSON.parse(JSON.stringify(descriptor));
  }
}
