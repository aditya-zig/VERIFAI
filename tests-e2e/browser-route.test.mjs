import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, access, readdir} from 'node:fs/promises';
import {openBrowser} from './browser-driver.mjs';
import {execFileSync} from 'node:child_process';
import {sandboxOwner} from '../services/local-sandbox.mjs';
import {runBrowserJourney} from '../services/local-browser.mjs';
import {createDemoServer} from '../scripts/serve-web.mjs';

test('browser endpoint rejects nonexistent audits without launching a browser',async(t)=>{
 const server=createDemoServer({apiOnly:true}); await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.shutdown());
 const base=`http://127.0.0.1:${server.address().port}`;
 const res=await fetch(`${base}/api/local/audits/not-an-audit/browser`,{method:'POST'});
 assert.equal(res.status,404);const body=await res.json();assert.equal(body.status,'Incomplete');assert.match(body.error,/audit not found/);
 assert.equal((await fetch(`${base}/api/local/audits/not-an-audit/browser/screenshot`)).status,404);
});
test('real installed Chrome startup deadline is Incomplete and leaves no profile or fixture',async()=>{
 // Explicit negative-only audit fixture: never used for real success acceptance.
 const before=(await readdir('/tmp')).filter(name=>name.startsWith('verifai-browser-')).sort();
 const result=await runBrowserJourney({auditId:'controlled-negative-timeout',getAudit:()=>({status:'Completed'}),timeoutMs:1});
 assert.equal(result.status,'Incomplete');assert.equal(result.screenshot,undefined);
 assert.equal(result.cleanup.profileRemoved,true);assert.equal(result.cleanup.fixtureStopped,true);
 assert.deepEqual((await readdir('/tmp')).filter(name=>name.startsWith('verifai-browser-')).sort(),before);
});

test('real M5 audit then fixture browser action, screenshot binary proxy and cleanup',async(t)=>{
 const api=createDemoServer({apiOnly:true});await new Promise(r=>api.listen(0,'127.0.0.1',r));t.after(()=>api.shutdown());
 const web=createDemoServer({apiUrl:`http://127.0.0.1:${api.address().port}`});await new Promise(r=>web.listen(0,'127.0.0.1',r));t.after(()=>web.shutdown());
 const base=`http://127.0.0.1:${web.address().port}`;
 const beforeProfiles=(await readdir('/tmp')).filter(name=>name.startsWith('verifai-browser-')).sort();
 const page=await openBrowser(base);let pageClosed=false;t.after(async()=>{if(!pageClosed)await page.close();});
 await page.wait(`!!document.getElementById('localRepoUrl') && !document.getElementById('startLocalAudit').disabled`);
 assert.equal(await page.evaluate(`!!document.querySelector('[data-action="run-fixture-browser"]')`),false);
 await page.evaluate(`document.getElementById('localRepoUrl').value='https://github.com/octocat/Hello-World';document.getElementById('localRepositoryForm').requestSubmit()`);
 await page.wait(`!!document.getElementById('localRepositoryForm').dataset.auditId`);
 const id=await page.evaluate(`document.getElementById('localRepositoryForm').dataset.auditId`);let audit;
 for(let i=0;i<1200;i++){audit=await (await fetch(`${base}/api/local/audits/${id}`)).json();if(audit.status!=='Running')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(audit.status,'Completed',JSON.stringify(audit));assert.equal(audit.execution.exitCode,0);assert.equal(audit.cleanup.repositoryRemoved,true);await assert.rejects(access(audit.clone.workspacePath));
 await page.wait(`!!document.querySelector('[data-action="run-fixture-browser"]') && !document.querySelector('[data-action="run-fixture-browser"]').disabled`);
 assert.match(await page.evaluate(`document.body.innerText`),/not verification of the cloned application/);
 // Close the observing browser before starting the product fixture browser.
 await page.close();pageClosed=true;
 const pending=fetch(`${base}/api/local/audits/${id}/browser`,{method:'POST'});
 await new Promise(r=>setTimeout(r,50));
 const busy=await fetch(`${base}/api/local/audits`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://github.com/octocat/Hello-World'})});assert.equal(busy.status,429,'browser holds the same admission as Docker/model');
 const journeyResponse=await pending;assert.equal(journeyResponse.status,200);
 const result=await journeyResponse.json();assert.equal(result.status,'Completed',JSON.stringify(result));assert.equal(result.auditId,id);
 assert.match(result.startUrl,/^http:\/\/127\.0\.0\.1:\d+\/$/);assert.equal(result.finalUrl,result.startUrl);
 assert.equal(result.assertion.passed,true);assert.equal(result.assertion.observed,'Action completed');
 assert.ok(result.actions.some(action=>action.action==='click-button'));assert.ok(result.networkEvidence.some(entry=>entry.status===200 && entry.url===result.startUrl));assert.ok(Array.isArray(result.consoleErrors));
 assert.equal(result.cleanup.browserClosed,true);assert.equal(result.cleanup.profileRemoved,true);assert.equal(result.cleanup.fixtureStopped,true);
 const screenshot=await fetch(`${base}${result.screenshotRefs[0]}`);assert.equal(screenshot.status,200);assert.equal(screenshot.headers.get('content-type'),'image/png');
 const bytes=Buffer.from(await screenshot.arrayBuffer());assert.ok(bytes.length>100 && bytes.length<=1048576);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 const stored=await (await fetch(`${base}/api/local/audits/${id}`)).json();assert.deepEqual(stored.browser,result);
 assert.deepEqual((await readdir('/tmp')).filter(name=>name.startsWith('verifai-browser-')).sort(),beforeProfiles);
 assert.equal(execFileSync('docker',['ps','-aq','--filter',`label=dev.verifiai.local-agent.owner=${sandboxOwner}`],{encoding:'utf8'}).trim(),'');
 await assert.rejects(fetch(result.finalUrl), 'fixture really stopped');
 const evidence={audit,browser:result,screenshotBytes:bytes.length,status:'PASS'};
 if(process.env.VERIFIAI_BROWSER_LOG)await writeFile(process.env.VERIFIAI_BROWSER_LOG,JSON.stringify(evidence,null,2)+'\n');
 if(process.env.VERIFIAI_BROWSER_SCREENSHOT)await writeFile(process.env.VERIFIAI_BROWSER_SCREENSHOT,bytes);
 console.log(JSON.stringify({auditId:id,journeyId:result.journeyId,status:result.status,screenshotBytes:bytes.length,assertion:result.assertion,cleanup:result.cleanup}));
});
