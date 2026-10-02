import {fileURLToPath} from 'node:url';

// Only the API entry point loads local secrets. The clean-environment web
// proxy and its browser children never read this file. Existing env wins.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Unable to load private backend environment');
}
const {createDemoServer}=await import('./serve-web.mjs');
const {recoverSandboxes}=await import('../services/local-sandbox.mjs');
const {recoverRepositoryWorkspaces}=await import('../services/repository-workspaces.mjs');

await recoverRepositoryWorkspaces();
await recoverSandboxes().catch(error=>console.warn(`Incomplete sandbox recovery: ${error.message}`));
const server=createDemoServer({apiOnly:true});
server.listen(Number(process.env.PORT || 8787),'127.0.0.1',()=>console.log('VERIFAI local API: http://127.0.0.1:8787'));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  server.shutdown().then(()=>process.exit(0),error=>{console.error(`Incomplete shutdown: ${error.message}`);process.exit(1);});
});
