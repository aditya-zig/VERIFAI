// Server-owned single-use human approvals for repair PR publication.
//
// An approval is issued only to an authenticated human principal, is bound by
// digest to the exact evidence snapshot (repository, base branch, verified
// repair, proof artifact manifest, browser evidence and the acting principal),
// expires after 15 minutes and is consumed once. Stale, reused, expired,
// foreign-principal or foreign-audit bindings are refused before any
// publication transport is constructed. Agent principals can never issue.
//
// The evidence provider (injected by the local server) must produce the same
// snapshot shape for issue and for publication so any evidence change
// invalidates outstanding approvals.
import {createHash,randomUUID} from 'node:crypto';

const DEFAULT_TTL_MINUTES=15;

function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function evidenceDigest(value){
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function httpError(statusCode,message){
  return Object.assign(new Error(message),{statusCode});
}

export class LocalHumanApprovalsService{
  #records=new Map();
  #evidenceProvider;
  #now;
  #ttlMs;
  constructor({evidenceProvider,now=Date.now,ttlMs=DEFAULT_TTL_MINUTES*60*1000}={}){
    if(typeof evidenceProvider!=='function')throw new Error('human approvals require an evidenceProvider function');
    if(typeof now!=='function')throw new Error('now must be a function');
    if(!Number.isInteger(ttlMs)||ttlMs<=0)throw new Error('ttlMs must be a positive integer');
    this.#evidenceProvider=evidenceProvider;this.#now=now;this.#ttlMs=ttlMs;
    this.ttlMinutes=Math.round(ttlMs/60000);
  }
  // Returns null when the audit, verified repair or proof manifest is absent.
  #evidence(auditId){
    const evidence=this.#evidenceProvider?.(auditId);
    if(!evidence||typeof evidence!=='object')return null;
    const {repository,baseBranch,repair,proof,browser}=evidence;
    if(typeof repository!=='string'||!repository)return null;
    if(!repair||typeof repair!=='object'||!repair.patchDigest||!repair.verifiedBaseCommitSha)return null;
    if(!proof?.manifest?.sha256)return null;
    return {auditId,repository,baseBranch:baseBranch??'main',repair,proof,browser:browser??null};
  }
  outstandingCount(){return this.#records.size;}
  get(approvalId){
    const record=this.#records.get(approvalId);
    if(!record)return undefined;
    return JSON.parse(JSON.stringify(record));
  }
  issue({principal,auditId}={}){
    if(principal?.kind!=='human')throw httpError(403,'only human principals may approve repair publication');
    if(typeof auditId!=='string'||!auditId)throw httpError(400,'auditId is required for approval');
    const evidence=this.#evidence(auditId);
    if(!evidence)throw httpError(409,'verified repair and proof manifest must exist and match this audit before human approval');
    const issuedAt=this.#now();
    const approvalId=randomUUID();
    this.#records.set(approvalId,{
      approvalId,principalId:principal.id,auditId,
      evidenceDigest:evidenceDigest({principalId:principal.id,...evidence}),
      issuedAt,expiresAt:issuedAt+this.#ttlMs,consumed:false,
    });
    return {approvalId,auditId,principalId:principal.id,issuedAt,expiresAt:issuedAt+this.#ttlMs,ttlMinutes:this.ttlMinutes};
  }
  // Verifies an outstanding approval against current evidence and consumes it.
  // Returns the verified binding snapshot for the caller's records.
  verifyPublicationBinding({principal,auditId,approvalId}={}){
    if(typeof approvalId!=='string'||!approvalId)throw httpError(400,'approvalId is required; approve via POST /api/local/audits/:id/approval first');
    const record=this.#records.get(approvalId);
    if(!record)throw httpError(404,'unknown approval id');
    if(record.consumed)throw httpError(409,'single-use human approval is already consumed');
    if(record.auditId!==auditId)throw httpError(403,'human approval is bound to a different audit');
    if(record.principalId!==principal?.id)throw httpError(403,'human approval is bound to a different principal');
    const now=this.#now();
    if(now>=record.expiresAt)throw httpError(410,'human approval expired');
    const evidence=this.#evidence(auditId);
    if(!evidence)throw httpError(409,'bound evidence is gone: the audit or proof deviation must be re-verified');
    if(evidenceDigest({principalId:principal.id,...evidence})!==record.evidenceDigest)throw httpError(409,'human approval is stale: evidence changed since approval');
    record.consumed=true;record.consumedAt=now;
    return JSON.parse(JSON.stringify(evidence));
  }
}
