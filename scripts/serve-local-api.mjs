import {createDemoServer} from './serve-web.mjs';
import {recoverSandboxes} from '../services/local-sandbox.mjs';
import {recoverRepositoryWorkspaces} from '../services/repository-workspaces.mjs';

await recoverRepositoryWorkspaces();
await recoverSandboxes().catch(error=>console.warn(`Incomplete sandbox recovery: ${error.message}`));
const server=createDemoServer({apiOnly:true});
server.listen(Number(process.env.PORT || 8787),'127.0.0.1',()=>console.log('VERIFAI local API: http://127.0.0.1:8787'));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  server.shutdown().then(()=>process.exit(0),error=>{console.error(`Incomplete shutdown: ${error.message}`);process.exit(1);});
});
