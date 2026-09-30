import {mkdir,readdir,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {sandboxStateRoot,sandboxOwner,ensureOwnedDirectory,processIdentity} from './local-sandbox.mjs';
export const repositoryWorkspaceRoot=join(sandboxStateRoot,'repositories');

export async function registerWorkspace(id) {
  await ensureOwnedDirectory(sandboxStateRoot);
  await ensureOwnedDirectory(repositoryWorkspaceRoot);
  const workspacePath=join(repositoryWorkspaceRoot,`verifai-repository-${id}`);
  const registry=join(repositoryWorkspaceRoot,`.owner-${id}.json`);
  // Persist verified ownership BEFORE creating files: abrupt termination has
  // no unregistered mkdir window. Registry is OUTSIDE the cloned repository.
  await writeFile(registry,JSON.stringify({owner:sandboxOwner,pid:process.pid,start:await processIdentity(process.pid),workspacePath}),{mode:0o600,flag:'wx'});
  try { await mkdir(workspacePath,{mode:0o700}); }
  catch(error) { await rm(registry,{force:true}); throw error; }
  return {workspacePath,registry};
}
export async function removeWorkspace(workspacePath,registry) {
  await rm(workspacePath,{recursive:true,force:true});
  await rm(registry,{force:true});
}
export async function recoverRepositoryWorkspaces() {
  await ensureOwnedDirectory(sandboxStateRoot);
  await ensureOwnedDirectory(repositoryWorkspaceRoot);
  for(const name of await readdir(repositoryWorkspaceRoot)) {
    const match=name.match(/^\.owner-([a-f0-9-]{36})\.json$/);
    if(!match)continue;
    const registry=join(repositoryWorkspaceRoot,name);
    const info=await lstat(registry);
    if(!info.isFile() || info.uid!==process.getuid())throw new Error('Incomplete: repository registry ownership not verified');
    const owner=JSON.parse(await readFile(registry,'utf8'));
    const expected=join(repositoryWorkspaceRoot,`verifai-repository-${match[1]}`);
    if(owner.owner!==sandboxOwner || owner.workspacePath!==expected || !Number.isInteger(owner.pid) || !owner.start)throw new Error('Incomplete: invalid repository workspace ownership record');
    if(await processIdentity(owner.pid)===owner.start)continue;
    const workspace=await lstat(expected).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(workspace && (!workspace.isDirectory() || workspace.uid!==process.getuid()))throw new Error('Incomplete: repository workspace ownership not verified');
    await removeWorkspace(expected,registry);
  }
}
