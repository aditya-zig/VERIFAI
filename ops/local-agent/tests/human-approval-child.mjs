// Child used by human-approval-routes.test.mjs: the real serve-web server with
// operator principals in env, an offline repository adapter, and controlled
// audit/repair/proof stores plus a real LocalPrService over a recording
// transport. Nothing leaves the machine: no network, no GitHub writes.
// Tracks transport steps in VERIFIAI_TEST_TRANSPORT_LOG and publication
// requests in VERIFIAI_TEST_PR_LOG for the parent's assertions.
import {appendFileSync} from 'node:fs';

const cloneLogPath=process.env.VERIFIAI_TEST_CLONE_LOG;
const transportLogPath=process.env.VERIFIAI_TEST_TRANSPORT_LOG;
if(!cloneLogPath||!transportLogPath)throw new Error('VERIFIAI_TEST_CLONE_LOG and VERIFIAI_TEST_TRANSPORT_LOG are required');

const adapter={
  async clone(url){appendFileSync(cloneLogPath,`${JSON.stringify({url,at:Date.now()})}\n`);return {id:'offline-repo',repository:url,fullName:url,files:{count:1,items:['README']}};},
  get(){return undefined;},
  async cleanup(){return false;},
  async cleanupAll(){},
};

const audit={id:'run-app',status:'Completed',repository:{fullName:'octocat/Hello-World'},finding:{title:'Bug'}};
const {createHash}=await import('node:crypto');
const patch={files:[{path:'x',expected:'a',replacement:'b'}]};
const repair={verdict:'VerifiedRepair',verifiedBaseCommitSha:'abcdef1234567890',
  patch,
  patchDigest:createHash('sha256').update(JSON.stringify(patch)).digest('hex'),
  changedFiles:[{path:'x',beforeHash:'1'.repeat(64),afterHash:'2'.repeat(64)}],
  before:{status:'Failed',executed:true,exitCode:1,command:'check'},after:{status:'Completed',executed:true,exitCode:0,command:'check'},
  regressions:[{status:'Completed',executed:true,exitCode:0,command:'regression'}],originalUnchanged:true,cleanup:{candidateRemoved:true}};
const names=['run','repository','repair','repair-diff','before-verification','after-verification','regressions'];
const proof={manifest:{id:'proof:run-app:manifest',sha256:'a'.repeat(64)},artifacts:names.map((name,i)=>({name,status:'Present',path:name+'.json',sha256:String(i+1).repeat(64).slice(0,64)}))};
const audits={get:id=>id==='run-app'?JSON.parse(JSON.stringify(audit)):undefined};
const repairs={get:id=>id==='run-app'?JSON.parse(JSON.stringify(repair)):undefined};
const artifacts={get:id=>id==='run-app'?JSON.parse(JSON.stringify(proof)):undefined};

const transport={
  async verifyRemoteBase(input){appendFileSync(transportLogPath,JSON.stringify({step:'verify',repository:input.repository})+'\n');},
  async createBranch(input){appendFileSync(transportLogPath,JSON.stringify({step:'branch',repository:input.repository})+'\n');return {sha:input.expectedBaseSha};},
  async commitVerifiedPatch(input){appendFileSync(transportLogPath,JSON.stringify({step:'commit',repository:input.repository})+'\n');return {commitSha:'c'};},
  async pushBranch(input){appendFileSync(transportLogPath,JSON.stringify({step:'push',repository:input.repository})+'\n');},
  async openPullRequest(input){appendFileSync(transportLogPath,JSON.stringify({step:'pr',repository:input.repository})+'\n');return {number:1,url:'u-demo'};},
};

const {LocalPrService}=await import('../../../services/local-pr-service.mjs');
const prEnv={...process.env,VERIFIAI_PR_APPROVAL_SECRET:'0123456789abcdef0123456789abcdef',VERIFIAI_GITHUB_TOKEN:'tok'};
const pullRequests=new LocalPrService(audits,repairs,artifacts,{env:prEnv,transportFactory:()=>transport});

const {createDemoServer}=await import('../../../scripts/serve-web.mjs');
const server=createDemoServer({
  repositories:adapter,
  env:{...process.env,VERIFIAI_PR_APPROVAL_SECRET:'0123456789abcdef0123456789abcdef',VERIFIAI_GITHUB_TOKEN:'tok'},
  adapters:{audits,repairs,artifacts,pullRequests},
});
server.listen(0,'127.0.0.1',()=>{process.stdout.write(`PORT ${server.address().port}\n`);});
process.on('SIGTERM',()=>{server.shutdown().catch(()=>{}).finally(()=>process.exit(0));});
