import {createGitHubRepairTransport} from './github-repair-transport.mjs';
import {createVerifiedRepairPullRequest,issuePrApproval} from './verified-repair-pr.mjs';

export class LocalPrService{
  #results=new Map();
  constructor(audits,repairs,artifacts,{env=process.env,transportFactory=createGitHubRepairTransport}={}){
    this.audits=audits;this.repairs=repairs;this.artifacts=artifacts;this.env=env;this.transportFactory=transportFactory;
  }
  get(auditId){const value=this.#results.get(auditId);return value?JSON.parse(JSON.stringify(value)):undefined;}
  async create(auditId){
    const audit=this.audits.get(auditId);if(!audit)throw Object.assign(new Error('audit not found'),{statusCode:404});
    const repair=this.repairs.get(auditId);if(!repair)throw Object.assign(new Error('verified repair not found'),{statusCode:409});
    const proof=this.artifacts.get(auditId);if(!proof)throw Object.assign(new Error('proof artifact manifest not found'),{statusCode:409});
    const repository=audit.repository?.fullName;if(!repository)throw Object.assign(new Error('repository identity missing'),{statusCode:409});
    const approvalSecret=this.env.VERIFIAI_PR_APPROVAL_SECRET||this.env.VERIFIAI_STATE_SECRET;
    if(!approvalSecret||approvalSecret.length<32)throw Object.assign(new Error('PR approval secret is not configured'),{statusCode:503});
    const token=this.env.VERIFIAI_GITHUB_TOKEN||this.env.GITHUB_TOKEN;
    if(!token)throw Object.assign(new Error('GitHub PR token is not configured'),{statusCode:503});
    const baseBranch=this.env.VERIFIAI_GITHUB_BASE_BRANCH||'main';

    // This method is called only by the explicit POST /pr user action. The
    // approval token is created from current server-owned immutable state and
    // immediately revalidated by createVerifiedRepairPullRequest.
    const approvalToken=issuePrApproval({secret:approvalSecret,runId:auditId,repository,baseBranch,repair,proof});
    const transport=this.transportFactory({token});
    const result=await createVerifiedRepairPullRequest({
      transport,repository,baseBranch,runId:auditId,finding:audit.finding,repair,proof,approvalToken,approvalSecret,
    });
    const stored={auditId,repository,baseBranch,...result,approval:{bound:true,patchDigest:repair.patchDigest,proofManifestSha256:proof.manifest.sha256}};
    this.#results.set(auditId,stored);
    return JSON.parse(JSON.stringify(stored));
  }
}
