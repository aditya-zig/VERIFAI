// Real browser acceptance helper, not a product browser agent. No downloads,
// response interception, mocks, or third-party package dependency.
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {once} from 'node:events';

export async function openBrowser(url) {
  const profile=await mkdtemp('/tmp/verifai-browser-');
  const child=spawn(process.env.VERIFIAI_CHROME || '/usr/bin/google-chrome-stable',[
    '--headless=new','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],
    {stdio:['ignore','ignore','pipe'],env:{HOME:process.env.HOME,PATH:process.env.PATH,LANG:'C.UTF-8'}});
  let startupTimer;
  const endpoint=await new Promise((resolve,reject)=>{
    let text='';startupTimer=setTimeout(()=>reject(new Error('Incomplete: installed Chrome startup timed out')),15000);
    child.stderr.on('data',chunk=>{text=(text+chunk).slice(-8192);const match=text.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(startupTimer);resolve(match[1]);}});
    child.once('error',reject);child.once('exit',code=>reject(new Error(`Incomplete: Chrome exited ${code}`)));
  }).catch(async error=>{clearTimeout(startupTimer);await rm(profile,{recursive:true,force:true});throw error;});
  const ws=new WebSocket(endpoint);await once(ws,'open');
  let id=0;const pending=new Map();
  ws.addEventListener('message',({data})=>{const message=JSON.parse(data);if(message.id){const request=pending.get(message.id);pending.delete(message.id);if(request){clearTimeout(request.timer);message.error?request.reject(new Error(JSON.stringify(message.error))):request.resolve(message.result);}}});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>{pending.delete(current);reject(new Error(`Incomplete: CDP timeout ${method}`));},15000);pending.set(current,{resolve,reject,timer});ws.send(JSON.stringify({id:current,method,params,sessionId}));});
  const {targetId}=await call('Target.createTarget',{url});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  const wait=async(expression,timeoutMs=90000)=>{const start=Date.now();while(Date.now()-start<timeoutMs){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`Incomplete: browser wait timed out: ${expression}`);};
  return {evaluate,wait,
    screenshot:async path=>{const data=await call('Page.captureScreenshot',{captureBeyondViewport:true},sessionId);await writeFile(path,Buffer.from(data.data,'base64'));},
    close:async()=>{const exit=child.exitCode===null && child.signalCode===null?once(child,'exit'):Promise.resolve();await call('Browser.close');ws.close();await exit;await rm(profile,{recursive:true,force:true});},
  };
}
