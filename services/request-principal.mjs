// Operator-configured scoped bearer principals for protected local writes.
//
// Configuration comes only from the environment contract
// VERIFIAI_LOCAL_PRINCIPALS_JSON as a JSON array:
//   [{"id":"operator-human","kind":"human","repositories":["owner/name"],"token":"<at least 32 chars>"}]
// kind is exactly 'human' or 'agent'; anything else is an invalid
// configuration and protected writes fail closed with 503. Callers cannot
// spoof kind or id: they are read from the configured record only. Tokens are
// digested and compared in constant time and are never logged, returned or
// echoed anywhere in this module.
//
// Status contract:
//   503  VERIFIAI_LOCAL_PRINCIPALS_JSON missing/invalid, or a row invalid
//   401  missing Authorization header / unsupported scheme / unknown token
//   403  token ok but the requested role kind or repository scope mismatch
import {createHash,timingSafeEqual} from 'node:crypto';

const MIN_TOKEN_LENGTH=32;
const KINDS=new Set(['human','agent']);
const REPOSITORY_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function notConfigured(){
  return Object.assign(new Error('operator principals are not configured; protected writes require VERIFIAI_LOCAL_PRINCIPALS_JSON'),{statusCode:503});
}
function invalidConfig(){
  return Object.assign(new Error('VERIFIAI_LOCAL_PRINCIPALS_JSON is an invalid principal configuration'),{statusCode:503});
}

export function loadPrincipalConfig(env=process.env){
  const raw=env?.VERIFIAI_LOCAL_PRINCIPALS_JSON;
  if(raw===undefined||String(raw).trim()==='')throw notConfigured();
  let parsed;
  try{parsed=JSON.parse(String(raw));}catch{throw invalidConfig();}
  if(!Array.isArray(parsed)||parsed.length===0)throw invalidConfig();
  const records=[];
  const identities=new Set();
  const tokenDigests=new Set();
  for(const row of parsed){
    if(!row||typeof row!=='object'||Array.isArray(row))throw invalidConfig();
    const {id,kind,repositories,token}=row;
    if(typeof id!=='string'||!/^[A-Za-z0-9_.:@-]{1,64}$/.test(id)||identities.has(id))throw invalidConfig();
    if(!KINDS.has(kind))throw invalidConfig();
    if(typeof token!=='string'||token.length<MIN_TOKEN_LENGTH||/\s/.test(token))throw invalidConfig();
    if(!Array.isArray(repositories)||repositories.some(value=>typeof value!=='string'||!REPOSITORY_PATTERN.test(value)))throw invalidConfig();
    identities.add(id);
    const tokenDigest=createHash('sha256').update(token).digest('hex');
    // The same token under two records would make the transport role depend on
    // record order; that ambiguity is refused at configuration level.
    if(tokenDigests.has(tokenDigest))throw invalidConfig();
    tokenDigests.add(tokenDigest);
    records.push({id,kind,repositories:[...repositories],tokenDigest:Buffer.from(tokenDigest,'hex')});
  }
  return records;
}

// Resolves a request's bearer token to the configured record. No client input
// can select the role: the match is token-only, and only server-configured
// id/kind/repositories leave this function.
function digestToken(token){
  return createHash('sha256').update(String(token)).digest();
}
function matchBearerRecord({env=process.env,authorization}={}){
  const config=loadPrincipalConfig(env);
  const header=String(authorization??'');
  const match=/^[Bb]earer[ \t]+(\S+)$/.exec(header);
  if(!header||!match)throw Object.assign(new Error('requires an authenticated Bearer token'),{statusCode:401});
  const provided=digestToken(match[1]);
  for(const record of config){
    if(record.tokenDigest.length===provided.length&&timingSafeEqual(record.tokenDigest,provided))
      return {id:record.id,kind:record.kind,repositories:[...record.repositories]};
  }
  throw Object.assign(new Error('unknown bearer principal'),{statusCode:401});
}

// Runtime entry the parent runtime imports: resolves the acting principal for
// an HTTP request against operator configuration only. Human-only publication
// gating stays with the caller-endpoint role decisions downstream.
export function resolveRequestPrincipal(req,env=process.env){
  return matchBearerRecord({env,authorization:req?.headers?.authorization});
}

export function authorizeBearer({env=process.env,authorization,kind,repository}={}){
  const principal=matchBearerRecord({env,authorization});
  if(!kind)throw invalidConfig(); // route bug guard: role kind is required
  if(principal.kind!==kind)throw Object.assign(new Error(`bearer principal is not authorized for role kind ${kind}`),{statusCode:403});
  if(repository!==undefined)assertPrincipalScope(principal,repository);
  return principal;
}

// Rejects a resolved principal whose configured repositories do not cover the
// target repository. Routes and LocalPrService share this so the scope error
// text stays identical on both layers.
export function assertPrincipalScope(principal,repository){
  if(typeof repository!=='string'||repository==='')throw invalidConfig();
  if(!Array.isArray(principal?.repositories)||!principal.repositories.includes(repository))
    throw Object.assign(new Error(`repository scope ${repository} is not configured for principal ${principal?.id}`),{statusCode:403});
  return principal;
}

// Public-facing configuration summary for unauthenticated capability
// endpoints: a configured boolean and which role kinds are covered. No ids,
// repository lists or tokens cross this boundary; identities stay server-side.
export function describePrincipalConfig(env=process.env){
  try{
    const records=loadPrincipalConfig(env);
    return {
      configured:true,
      humanPrincipalConfigured:records.some(record=>record.kind==='human'),
      agentPrincipalConfigured:records.some(record=>record.kind==='agent'),
    };
  }catch(error){
    return {configured:false,reason:String(error?.message??'unknown configuration error')};
  }
}
