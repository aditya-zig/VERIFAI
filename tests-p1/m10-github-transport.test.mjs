import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGitHubRepairTransport} from '../services/github-repair-transport.mjs';

const hash=(s)=>createHash('sha256').update(s).digest('hex');
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}

test('transport stale-base precondition performs reads only and no writes',async()=>{
  const methods=[];
  const transport=createGitHubRepairTransport({token:'t',fetchImpl:async(_url,init)=>{methods.push(init.method);return response({object:{sha:'new-sha'}});}});
  await assert.rejects(transport.verifyRemoteBase({repository:'o/r',baseBranch:'main',baseCommitSha:'old-sha',changedFiles:[]}),/stale-base/);
  assert.deepEqual(methods,['GET']);
});

test('transport verifies exact BEFORE bytes before reporting remote base valid',async()=>{
  const before='export const value = false;\n';
  const calls=[];
  const transport=createGitHubRepairTransport({token:'t',fetchImpl:async(url,init)=>{
    calls.push([init.method,url]);
    if(url.includes('/git/ref/heads/'))return response({object:{sha:'base'}});
    if(url.includes('/contents/'))return response({encoding:'base64',content:Buffer.from(before).toString('base64')});
    throw new Error('unexpected '+url);
  }});
  await transport.verifyRemoteBase({repository:'o/r',baseBranch:'main',baseCommitSha:'base',changedFiles:[{path:'x.js',beforeHash:hash(before)}]});
  assert.equal(calls.filter(x=>x[0]!=='GET').length,0);
});
