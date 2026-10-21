// Service tests for operator-configured scoped bearer principals
// (services/request-principal.mjs): the local web/API cannot elevate a caller
// to human/agent by client input; the role comes only from operator config
// (VERIFIAI_LOCAL_PRINCIPALS_JSON), tokens are digested and compared with
// timing-safe comparison, and never logged, returned or echoed.
import test from 'node:test';
import assert from 'node:assert/strict';

import {authorizeBearer,describePrincipalConfig,resolveRequestPrincipal} from '../services/request-principal.mjs';

const humanToken='h'.repeat(40);
const agentToken='a'.repeat(40);
const narrowToken='l'.repeat(40);
const validEnv={VERIFIAI_LOCAL_PRINCIPALS_JSON:JSON.stringify([
  {id:'operator-human',kind:'human',repositories:['octocat/Hello-World'],token:humanToken},
  {id:'worker-agent',kind:'agent',repositories:['octocat/Hello-World'],token:agentToken},
  {id:'narrow-human',kind:'human',repositories:['other/repo'],token:narrowToken},
])};

const expectHttpError=(call,statusCode,pattern)=>{
  assert.throws(call,error=>{
    assert.ok(pattern.test(String(error?.message)),`message "${String(error?.message)}" must match ${pattern}`);
    assert.equal(error?.statusCode,statusCode,`status must be ${statusCode}, saw ${error?.statusCode}`);
    return true;
  });
};

const humanCall=(auth)=>authorizeBearer({env:validEnv,authorization:auth,kind:'human',repository:'octocat/Hello-World'});

test('protected writes keep failing closed when the operator config is missing or invalid',()=>{
  expectHttpError(()=>authorizeBearer({env:{},authorization:'Bearer '+humanToken,kind:'human',repository:'octocat/Hello-World'}),503,/not configured/);
  expectHttpError(()=>authorizeBearer({env:{VERIFIAI_LOCAL_PRINCIPALS_JSON:'not json'},authorization:'Bearer '+humanToken,kind:'human',repository:'octocat/Hello-World'}),503,/invalid principal configuration/);
  expectHttpError(()=>authorizeBearer({env:{VERIFIAI_LOCAL_PRINCIPALS_JSON:JSON.stringify([{id:'x',kind:'robot',repositories:['o/r'],token:'t'.repeat(40)}])},authorization:'Bearer '+'t'.repeat(40),kind:'human',repository:'o/r'}),503,/invalid principal configuration/);
  expectHttpError(()=>authorizeBearer({env:{VERIFIAI_LOCAL_PRINCIPALS_JSON:JSON.stringify([{id:'x',kind:'human',repositories:['o/r'],token:'short'}])},authorization:'Bearer short',kind:'human',repository:'o/r'}),503,/invalid principal configuration/);
  expectHttpError(()=>authorizeBearer({env:{VERIFIAI_LOCAL_PRINCIPALS_JSON:JSON.stringify([{id:'x',kind:'HUMAN',repositories:['o/r'],token:'t'.repeat(40)}])},authorization:'Bearer '+'t'.repeat(40),kind:'human',repository:'o/r'}),503,/invalid principal configuration/);
});

test('matching principal returns identity without exposing the token',()=>{
  const principal=humanCall('Bearer '+humanToken);
  assert.deepEqual(principal,{id:'operator-human',kind:'human',repositories:['octocat/Hello-World']});
  assert.ok(!JSON.stringify(principal).includes(humanToken),'token must never be part of the resolved principal');
});

test('missing bearer or wrong bearer is unauthorized 401',()=>{
  expectHttpError(()=>humanCall(undefined),401,/requires an authenticated Bearer/);
  expectHttpError(()=>humanCall('Bearer '+'z'.repeat(40)),401,/unknown bearer principal/);
  expectHttpError(()=>humanCall(humanToken),401,/Bearer/);
});

test('agent token asked for the human role is refused 403; configured role is authoritative',()=>{
  expectHttpError(()=>humanCall('Bearer '+agentToken),403,/not authorized for role kind/);
});

test('resolveRequestPrincipal never lets client input choose the role',()=>{
  const humanReq={headers:{authorization:'Bearer '+humanToken,'x-verifai-kind':'agent'}};
  assert.deepEqual(resolveRequestPrincipal(humanReq,validEnv),{id:'operator-human',kind:'human',repositories:['octocat/Hello-World']});
  const agentReq={headers:{authorization:'Bearer '+agentToken}};
  assert.deepEqual(resolveRequestPrincipal(agentReq,validEnv),{id:'worker-agent',kind:'agent',repositories:['octocat/Hello-World']});
  expectHttpError(()=>resolveRequestPrincipal({headers:{}},validEnv),401,/requires an authenticated Bearer/);
  expectHttpError(()=>resolveRequestPrincipal({headers:{authorization:'Bearer '+'z'.repeat(40)}},validEnv),401,/unknown bearer principal/);
  expectHttpError(()=>resolveRequestPrincipal({headers:{authorization:'Bearer '+humanToken}},{}),503,/not configured/);
});

test('duplicate token values across role records are an invalid configuration',()=>{
  const shared='s'.repeat(40);
  expectHttpError(()=>authorizeBearer({env:{VERIFIAI_LOCAL_PRINCIPALS_JSON:JSON.stringify([
    {id:'operator-human',kind:'human',repositories:['o/r'],token:shared},
    {id:'worker-agent',kind:'agent',repositories:['o/r'],token:shared},
  ])},authorization:'Bearer '+shared,kind:'human',repository:'o/r'}),503,/invalid principal configuration/);
  const unambiguous=describePrincipalConfig({VERIFIAI_LOCAL_PRINCIPALS_JSON:JSON.stringify([
    {id:'a',kind:'human',repositories:['o/r'],token:'t'.repeat(40)},
    {id:'b',kind:'agent',repositories:['o/r'],token:'u'.repeat(40)},
  ])});
  assert.equal(unambiguous.configured,true);
});

test('repository scope outside the configured list is forbidden 403',()=>{
  expectHttpError(()=>authorizeBearer({env:validEnv,authorization:'Bearer '+narrowToken,kind:'human',repository:'octocat/Hello-World'}),403,/repository scope/);
});

test('agent principals pass when the requested role kind is agent',()=>{
  const principal=authorizeBearer({env:validEnv,authorization:'Bearer '+agentToken,kind:'agent',repository:'octocat/Hello-World'});
  assert.deepEqual(principal,{id:'worker-agent',kind:'agent',repositories:['octocat/Hello-World']});
});

test('describe reports only configuration state, never identities or tokens',()=>{
  const valid=describePrincipalConfig(validEnv);
  assert.deepEqual(valid,{configured:true,humanPrincipalConfigured:true,agentPrincipalConfigured:true});
  const serialized=JSON.stringify(valid);
  assert.ok(!serialized.includes('operator-human')&&!serialized.includes('worker-agent')&&!serialized.includes('octocat'),'public capabilities must not leak principal identities');
  const absent=describePrincipalConfig({});
  assert.equal(absent.configured,false);
  const invalid=describePrincipalConfig({VERIFIAI_LOCAL_PRINCIPALS_JSON:'not json'});
  assert.equal(invalid.configured,false);
  assert.ok(/invalid/.test(invalid.reason));
});
