import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
const body=html.match(/function renderMasterAudit\(run, host\) \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(body,'master renderer exists');
function render(extra={}){
  const host={innerHTML:'',querySelector:()=>null};
  vm.runInNewContext(`function renderMasterAudit(run,host){${body}\n}\nrenderMasterAudit(run,host);`,{
    run:{id:'unit-ui',status:'Incomplete',stages:{},...extra},host,escapeHtml:value=>String(value??''),
  });
  return host.innerHTML;
}
function execution(exitCode){return {exitCode,status:exitCode===0?'Completed':'Failed',command:'node --check broken.js',durationMs:1,stdout:'',stderr:'',sandbox:{started:true,removed:true,name:'unit-fixture',memoryBytes:1073741824,nanoCpus:2000000000,privileged:false}};}
test('missing or unexecuted command never offers repair or Create PR',()=>{
  for(const extra of [{},{execution:{...execution(null),status:'Incomplete'}},{execution:{...execution(1),sandbox:{started:false}}}]){
    assert.doesNotMatch(render(extra),/data-action="repair-local-audit"|data-action="create-local-pr"/);
  }
});
test('nonzero executed-shaped evidence offers deliberate patch verification, not PR',()=>{
  const markup=render({execution:execution(1)});
  assert.match(markup,/data-action="repair-local-audit"/);assert.doesNotMatch(markup,/data-action="create-local-pr"/);
});
test('only VerifiedRepair exposes the explicit human Create PR control',()=>{
  assert.match(render({execution:execution(1),repair:{verdict:'VerifiedRepair',before:{exitCode:1},after:{exitCode:0}}}),/data-action="create-local-pr"/);
  assert.doesNotMatch(render({execution:execution(0)}),/data-action="repair-local-audit"|data-action="create-local-pr"/);
});
test('post-repair UI refreshes server-owned state so VerifiedRepair exposes Create PR without another audit',async()=>{
  const verify=html.match(/async function verifyLocalRepair\(auditId, buttonEl\) \{([\s\S]*?)\n  \}/)?.[1];assert.ok(verify);
  const root={innerHTML:'',querySelector:()=>null};const result={innerHTML:''};const repair={verdict:'VerifiedRepair',before:{exitCode:1},after:{exitCode:0},originalUnchanged:true};
  const record={id:'unit-ui',status:'Incomplete',stages:{},execution:execution(1),repair};
  const input={value:JSON.stringify({files:[{path:'broken.js',expected:'bad',replacement:'good'}]})};
  const doc={getElementById:id=>id==='localRepoResult'?root:id==='localRepairPatch'?input:result};
  await vm.runInNewContext(`function renderMasterAudit(run,host){${body}\n}\nasync function verifyLocalRepair(auditId,buttonEl){${verify}\n}\nverifyLocalRepair('unit-ui',{disabled:false});`,{
    document:doc,escapeHtml:value=>String(value??''),fetch:async(_,options)=>({ok:true,json:async()=>options?.method==='POST'?repair:record}),
  });
  assert.match(root.innerHTML,/data-action="create-local-pr"/);
});
