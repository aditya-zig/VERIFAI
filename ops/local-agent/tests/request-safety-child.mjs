// Child process used by request-safety.test.mjs: runs the real serve-web HTTP
// server with an offline in-memory repository adapter so no clone, network or
// Docker can occur. Every accepted repositories.clone() is appended to
// VERIFIAI_TEST_CLONE_LOG so a parent process can prove which mutations
// actually reached repository admission. Prints "PORT <n>" when listening.
// With VERIFIAI_TEST_UPSTREAM_URL set, acts as the web/API splitting front
// that proxies /api/local/* to that upstream (serve-local-api mode).
import {appendFileSync} from 'node:fs';

const cloneLogPath=process.env.VERIFIAI_TEST_CLONE_LOG;
if(!cloneLogPath) throw new Error('VERIFIAI_TEST_CLONE_LOG is required');

const adapter={
  async clone(url){appendFileSync(cloneLogPath,`${JSON.stringify({url,at:Date.now()})}\n`);return {id:'offline-repo',repository:url,fullName:url,files:{count:1,items:['README']}};},
  get(){return undefined;},
  async cleanup(){return false;},
  async cleanupAll(){},
};

const upstreamUrl=process.env.VERIFIAI_TEST_UPSTREAM_URL;
const {createDemoServer}=await import('../../../scripts/serve-web.mjs');
const server=createDemoServer({repositories:adapter,apiUrl:upstreamUrl,apiOnly:Boolean(upstreamUrl)});
server.listen(0,'127.0.0.1',()=>{
  process.stdout.write(`PORT ${server.address().port}\n`);
});
process.on('SIGTERM',()=>{server.shutdown().catch(()=>{}).finally(()=>process.exit(0));});
