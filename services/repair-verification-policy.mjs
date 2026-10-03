import {createHash} from 'node:crypto';

function executedCheck(value,status,exitMatches){
  return value?.status===status&&value.executed===true
    &&Number.isInteger(value.exitCode)&&exitMatches(value.exitCode)
    &&typeof value.command==='string'&&value.command.trim().length>0
    &&value.timedOut!==true&&value.aborted!==true;
}

// Server-owned evidence is the input. A verdict supplied by an agent is never
// sufficient. The producer and the PR boundary enforce this same policy.
export function repairVerificationGate(repair){
  const deny=reason=>({eligible:false,reason});
  if(!executedCheck(repair?.before,'Failed',exit=>exit!==0))return deny('BEFORE verification requires an uninterrupted executed failure and command');
  if(!executedCheck(repair?.after,'Completed',exit=>exit===0))return deny('AFTER verification requires an uninterrupted executed success and command');
  if(repair.before.command!==repair.after.command)return deny('Verification command changed between BEFORE and AFTER');
  if(!Array.isArray(repair.regressions)||repair.regressions.length<1||repair.regressions.length>8)return deny('At least one regression check is required (maximum 8)');
  if(repair.regressions.some(value=>!executedCheck(value,'Completed',exit=>exit===0)))return deny('Every regression requires an uninterrupted executed success and command');
  if(repair.originalUnchanged!==true)return deny('Original workspace integrity is not verified');
  if(repair.cleanup?.candidateRemoved!==true)return deny('Candidate cleanup is not verified');
  const files=repair.patch?.files;
  if(!Array.isArray(files)||files.length<1||files.length>8)return deny('Verified patch files are required');
  if(files.some(file=>typeof file?.path!=='string'||!file.path||file.path.startsWith('/')
    ||file.path.split(/[\\/]+/).includes('..')||typeof file.expected!=='string'||typeof file.replacement!=='string'))return deny('Invalid verified patch file');
  const paths=files.map(file=>file.path);
  if(new Set(paths).size!==paths.length)return deny('Duplicate verified patch file');
  const patchDigest=createHash('sha256').update(JSON.stringify(repair.patch)).digest('hex');
  if(repair.patchDigest!==patchDigest)return deny('Repair patch digest mismatch; re-verification required');
  if(!Array.isArray(repair.changedFiles)||repair.changedFiles.length!==files.length)return deny('Verified file hashes are required');
  const verifiedPaths=new Set();
  for(const file of repair.changedFiles){
    if(!paths.includes(file?.path)||verifiedPaths.has(file.path)
      ||!/^[0-9a-f]{64}$/i.test(file.beforeHash??'')||!/^[0-9a-f]{64}$/i.test(file.afterHash??''))return deny('Verified file hashes must match the exact patch files');
    verifiedPaths.add(file.path);
  }
  return {eligible:true,reason:'Executed verification, regression, integrity and cleanup gates passed'};
}
