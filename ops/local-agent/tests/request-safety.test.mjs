// Behavioral HTTP safety tests for the VERIFAI local web/API slice
// (scripts/serve-web.mjs). Each test runs the server as its own process,
// exactly the way serve-web.mjs serves a human operator, with an offline
// repository adapter so the suite needs no network, Docker, browser or
// model API. One API process per test keeps any single request failure from
// masking the other regressions.
//
// Regressions from the PR80 request-safety audit:
// - malformed URL-encoded route ids crashed the whole process (finding F2)
// - foreign Origin/Host and text/plain mutation requests were accepted (F1)
// Every rejected mutation must also leave the repository adapter untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const childPath=path.join(repoRoot,'ops/local-agent/tests/request-safety-child.mjs');
const cloneTarget='https://github.com/octocat/Hello-World';

/** Starts one real API process and returns its port, liveness and admission log. */
async function startServer(extraEnv={}){
  const suiteTmp=mkdtempSync('/tmp/opencode/request-safety-');
  const cloneLogPath=path.join(suiteTmp,'clones.jsonl');
  const child=spawn(process.execPath,[childPath],{
    cwd:repoRoot,
    env:{...process.env,VERIFIAI_TEST_CLONE_LOG:cloneLogPath,...extraEnv},
    stdio:['ignore','pipe','pipe'],
  });
  let stderr='';
  child.stderr.on('data',buffer=>{stderr+=buffer.toString();});
  let exitCode;
  child.once('exit',code=>{exitCode=code;});
  const port=await new Promise((resolve,reject)=>{
    child.once('exit',code=>reject(new Error(`API process exited with ${code} before PORT: ${stderr}`)));
    child.stdout.on('data',function onData(buffer){
      const match=buffer.toString().match(/PORT (\d+)/);
      if(match){
        child.stdout.removeListener('data',onData);
        resolve(Number(match[1]));
      }
    });
  });
  return {
    suiteTmp,
    port,
    stderr:()=>stderr,
    alive:()=>exitCode===undefined,
    exitCode:()=>exitCode,
    cloneEntries(){
      try{return readFileSync(cloneLogPath,'utf8').split('\n').filter(Boolean).map(JSON.parse);}
      catch{return [];}
    },
    async stop(){
      child.kill('SIGTERM');
      await new Promise(resolve=>{
        if(exitCode!==undefined)return resolve();
        child.once('exit',resolve);
        setTimeout(resolve,5000).unref();
      });
      rmSync(suiteTmp,{recursive:true,force:true});
    },
  };
}

/** Raw HTTP client so Host and Origin headers are fully caller-controlled. */
function request(port,{path:route='/',method='GET',hostHeader,headers={},body,timeoutMs=5000}={}){
  const headerHost=hostHeader??`127.0.0.1:${port}`;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>resolve({error:new Error(`timeout waiting for ${method} ${route}`)}),timeoutMs).unref();
    const req=http.request({host:'127.0.0.1',port,method,path:route,agent:false,headers:{host:headerHost,...headers}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{
        clearTimeout(timer);
        resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')});
      });
    });
    req.on('error',error=>{clearTimeout(timer);resolve({error});});
    if(body!==undefined)req.end(body);else req.end();
  });
}

test('malformed percent encoding in audit id returns 400 and the API process survives',async t=>{
  const server=await startServer();
  t.after(()=>server.stop());
  const first=await request(server.port,{path:'/api/local/audits/%/browser'});
  assert.equal(first?.status,400,`malformed audit id must return 400, saw ${JSON.stringify(first)}`);
  assert.ok(server.alive(),`request must not crash the API process: exit=${server.exitCode()} stderr=${server.stderr()}`);
  assert.equal(server.cloneEntries().length,0,'malformed routes must reach no repository admission');
  const health=await request(server.port,{path:'/health'});
  assert.equal(health.status,200,'health endpoint must survive a malformed-route request');
});

test('malformed percent encoding in a repository cleanup id returns 400 instead of 500 or a crash',async t=>{
  const server=await startServer();
  t.after(()=>server.stop());
  const response=await request(server.port,{method:'POST',path:'/api/local/repositories/%/cleanup'});
  assert.equal(response.status,400,`expected 400, saw ${response?.status} ${response?.body}`);
  assert.ok(server.alive(),`cleanup decode must not crash the API process: exit=${server.exitCode()} stderr=${server.stderr()}`);
});

test('a Host header outside the loopback address is refused 403',async t=>{
  const server=await startServer();
  t.after(()=>server.stop());
  const response=await request(server.port,{path:'/health',hostHeader:'rebind-attacker.example'});
  assert.equal(response.status,403,`rebound Host must be refused, saw ${response?.status} ${response?.body}`);
  assert.ok(server.alive(),'refused host must not crash the API process');
});

test('cross-origin browser-style POST with text/plain body is refused and reaches no repository admission',async t=>{
  const server=await startServer();
  t.after(()=>server.stop());
  const response=await request(server.port,{
    method:'POST',
    path:'/api/local/repositories',
    headers:{origin:'https://attacker.example','content-type':'text/plain; charset=utf-8'},
    body:JSON.stringify({url:cloneTarget}),
  });
  assert.equal(response.status,403,`cross-origin mutation must be refused, saw ${response?.status} ${response?.body}`);
  assert.equal(server.cloneEntries().length,0,'cross-origin mutation must never reach the repository adapter');
  const health=await request(server.port,{path:'/health'});
  assert.equal(health.status,200,'health must survive the refused cross-origin request');
});

test('text/plain JSON published without Origin through the server API port is refused as JSON-only writes',async t=>{
  const server=await startServer();
  t.after(()=>server.stop());
  const response=await request(server.port,{
    method:'POST',
    path:'/api/local/repositories',
    headers:{'content-type':'text/plain; charset=utf-8'},
    body:JSON.stringify({url:cloneTarget}),
  });
  assert.equal(response.status,415,`non-JSON bodies must be refused 415, saw ${response?.status} ${response?.body}`);
  assert.equal(server.cloneEntries().length,0,'refused write must never reach the repository adapter');
});

test('a foreign Origin is refused even on read endpoints',async t=>{
  const server=await startServer();
  t.after(()=>server.stop());
  const response=await request(server.port,{path:'/health',headers:{origin:'https://attacker.example'}});
  assert.equal(response.status,403,`foreign-origin request must be refused, saw ${response?.status} ${response?.body}`);
  assert.ok(server.alive(),'refused origin must not crash the API process');
});

test('legitimate loopback same-origin POST and no-Origin server API POST still work',async t=>{
  const server=await startServer();
  t.after(()=>server.stop());
  const sameOrigin=await request(server.port,{
    method:'POST',
    path:'/api/local/repositories',
    headers:{origin:`http://127.0.0.1:${server.port}`,'content-type':'application/json'},
    body:JSON.stringify({url:cloneTarget}),
  });
  assert.equal(sameOrigin.status,201,`same-origin browser flow must be preserved, saw ${sameOrigin?.status} ${sameOrigin?.body}`);
  const serverCall=await request(server.port,{
    method:'POST',
    path:'/api/local/repositories',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({url:cloneTarget}),
  });
  assert.equal(serverCall.status,201,`no-Origin server or CLI flow must be preserved, saw ${serverCall?.status} ${serverCall?.body}`);
  const entries=server.cloneEntries();
  assert.equal(entries.length,2,'exactly the two admitted clones must have reached the adapter');
  assert.equal(entries[0]?.url,cloneTarget);
  const health=await request(server.port,{path:'/health'});
  assert.equal(health.status,200,'health stays intact after admitted mutations');
});

test('web-to-API proxy keeps same-origin JSON, no-Origin proxy posts reachable upstream and still enforces intake',async t=>{
  const upstream=await startServer();
  t.after(()=>upstream.stop());
  const web=await startServer({VERIFIAI_TEST_UPSTREAM_URL:`http://127.0.0.1:${upstream.port}`});
  t.after(()=>web.stop());
  const healthWeb=await request(web.port,{path:'/health'});
  assert.equal(healthWeb.status,200,'web front must stay healthy while proxying');
  const admitted=await request(web.port,{
    method:'POST',
    path:'/api/local/repositories',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({url:cloneTarget}),
  });
  assert.equal(admitted.status,201,`proxy POST must reach the local API, saw ${admitted?.status} ${admitted?.body}`);
  assert.equal(upstream.cloneEntries().length,1,'proxy POST must admit exactly one clone through the offline adapter');
  const sameOrigin=await request(web.port,{
    method:'POST',
    path:'/api/local/repositories',
    headers:{origin:`http://127.0.0.1:${web.port}`,'content-type':'application/json'},
    body:JSON.stringify({url:cloneTarget}),
  });
  assert.equal(sameOrigin.status,201,`same-origin browser JSON fetch through the proxy must be preserved, saw ${sameOrigin?.status} ${sameOrigin?.body}`);
  const refused=await request(web.port,{
    method:'POST',
    path:'/api/local/repositories',
    headers:{origin:'https://attacker.example','content-type':'text/plain; charset=utf-8'},
    body:JSON.stringify({url:cloneTarget}),
  });
  assert.equal(refused.status,403,`cross-origin text/plain write must be refused in proxy mode, saw ${refused?.status} ${refused?.body}`);
  const malformed=await request(web.port,{method:'POST',path:'/api/local/repositories/%/cleanup'});
  assert.equal(malformed.status,400,`malformed id must yield 400 in proxy mode, saw ${malformed?.status} ${malformed?.body}`);
  assert.ok(upstream.alive()&&web.alive(),'neither API process may crash while proxying');
  const entries=upstream.cloneEntries();
  assert.equal(entries.length,2,'refused and malformed requests must stay out of upstream admission');
  const healthAfter=await request(web.port,{path:'/health'});
  assert.equal(healthAfter.status,200,'web front must survive the refused requests');
});
