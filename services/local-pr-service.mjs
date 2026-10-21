import {createGitHubRepairTransport} from './github-repair-transport.mjs';
import {createVerifiedRepairPullRequest,issuePrApproval} from './verified-repair-pr.mjs';
import {assertPrincipalScope} from './request-principal.mjs';

export class LocalPrService{
  #results=new Map();
  constructor(audits,repairs,artifacts,{env=process.env,transportFactory=createGitHubRepairTransport}={}){
    this.audits=audits;this.repairs=repairs;this.artifacts=artifacts;this.env=env;this.transportFactory=transportFactory;
  }
  get(auditId){const value=this.#results.get(auditId);return value?JSON.parse(JSON.stringify(value)):undefined;}
  // Publication needs an already-consumable human approval: this method NEVER
  // mints implicit approval. Gates run before the transport is even built:
  // human identity, repository scope, then the single-use approval binding
  // (unknown → 404, wrong audit/principal → 403, expired → 410, reused → 409,
  // stale evidence → 409). A failed publication consumes the approval; a new
  // approval must be issued by a human after re-verification.
  async create(auditId,{principal,approvalId,approvals}={}){
    const audit=this.audits.get(auditId);if(!audit)throw Object.assign(new Error('audit not found'),{statusCode:404});
    const repair=this.repairs.get(auditId);if(!repair)throw Object.assign(new Error('verified repair not found'),{statusCode:409});
    const proof=this.artifacts.get(auditId);if(!proof)throw Object.assign(new Error('proof artifact manifest not found'),{statusCode:409});
    const repository=audit.repository?.fullName;if(!repository)throw Object.assign(new Error('repository identity missing'),{statusCode:409});
    if(!principal)throw Object.assign(new Error('repair publication requires an authenticated human principal'),{statusCode:401});
    if(principal.kind!=='human')throw Object.assign(new Error('only human principals may publish repair PRs'),{statusCode:403});
    assertPrincipalScope(principal,repository);
    if(!approvals||typeof approvals.verifyPublicationBinding!=='function')throw Object.assign(new Error('human approval service is not configured'),{statusCode:503});
    const binding=approvals.verifyPublicationBinding({principal,auditId,approvalId});
    const approvalSecret=this.env.VERIFIAI_PR_APPROVAL_SECRET||this.env.VERIFIAI_STATE_SECRET;
    if(!approvalSecret||approvalSecret.length<32)throw Object.assign(new Error('PR approval secret is not configured'),{statusCode:503});
    const token=this.env.VERIFIAI_GITHUB_TOKEN||this.env.GITHUB_TOKEN;
    if(!token)throw Object.assign(new Error('GitHub PR token is not configured'),{statusCode:503});
    const baseBranch=binding.baseBranch||this.env.VERIFIAI_GITHUB_BASE_BRANCH||'main';

    // The signature token below revalidates server-owned immutable evidence at
    // the transport boundary. It is a technical binding only; the human
    // authorization is the consumed single-use approval referenced alongside.
    const approvalToken=issuePrApproval({secret:approvalSecret,runId:auditId,repository,baseBranch,repair,proof});
    const transport=this.transportFactory({token});
    const result=await createVerifiedRepairPullRequest({
      transport,repository,baseBranch,runId:auditId,finding:audit.finding,repair,proof,approvalToken,approvalSecret,
    });
    const approval={bound:true,patchDigest:repair.patchDigest,proofManifestSha256:proof.manifest.sha256,issuedBy:'local-service',humanApproved:true,approvalId,principalId:principal.id};
    const stored={auditId,repository,baseBranch,...result,approval,principal:{id:principal.id,kind:principal.kind,repositories:[...principal.repositories]}};
    this.#results.set(auditId,stored);
    return JSON.parse(JSON.stringify(stored));
  }
}
