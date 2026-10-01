function clip(value, limit=4000) {
  const text=String(value ?? '');
  return text.length<=limit?text:text.slice(0,limit)+'...[truncated]';
}

function requireTransport(transport) {
  for (const method of ['createBranch','commitVerifiedPatch','pushBranch','openPullRequest']) {
    if (typeof transport?.[method] !== 'function') throw new Error('GitHub transport missing '+method+'()');
  }
}

function assertVerifiedRepair(repair) {
  if (repair?.verdict !== 'VerifiedRepair') throw new Error('PR creation requires repair.verdict == VerifiedRepair');
  if (repair?.before?.status !== 'Failed') throw new Error('PR creation requires executed before verification failure');
  if (repair?.after?.status !== 'Completed') throw new Error('PR creation requires completed after verification');
  if (!Array.isArray(repair?.regressions) || repair.regressions.some((item)=>item?.status!=='Completed')) {
    throw new Error('PR creation requires completed regression verification');
  }
  if (repair?.originalUnchanged !== true) throw new Error('PR creation requires proof that the original workspace stayed unchanged');
  if (repair?.cleanup?.candidateRemoved !== true) throw new Error('PR creation requires candidate cleanup proof');
  if (!repair?.patch || !Array.isArray(repair.patch.files) || repair.patch.files.length<1) {
    throw new Error('PR creation requires the verified patch');
  }
}

function assertRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must be owner/name');
  }
}

function safeBranch(runId) {
  const slug=String(runId ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48);
  if (!slug) throw new Error('runId is required to create a repair branch');
  return 'verifiai/repair-'+slug;
}

function evidenceLine(value) {
  if (!value || typeof value !== 'object') return 'Missing';
  const status=clip(value.status,80);
  const exit=Number.isInteger(value.exitCode)?' · exit '+value.exitCode:'';
  const stdout=typeof value.stdout==='string'&&value.stdout?'\n\nstdout:\n'+clip(value.stdout,1500):'';
  const stderr=typeof value.stderr==='string'&&value.stderr?'\n\nstderr:\n'+clip(value.stderr,1500):'';
  return status+exit+stdout+stderr;
}

function buildBody({finding,repair,artifactRefs}) {
  const regressions=repair.regressions.length
    ? repair.regressions.map((item,index)=>'- Regression '+(index+1)+': '+clip(item.status,80)+(Number.isInteger(item.exitCode)?' (exit '+item.exitCode+')':'')).join('\n')
    : '- No additional regression checks were configured.';
  const refs=artifactRefs.length?artifactRefs.map((ref)=>'- '+clip(ref,1000)).join('\n'):'- No proof artifact references supplied.';
  return '## Problem\n'+
    clip(finding?.title || 'Verified VERIFAI finding',300)+'\n\n'+
    clip(finding?.description || 'See attached verification evidence.',2500)+'\n\n'+
    '## Repair summary\nA candidate patch was tested in an isolated workspace. The original workspace remained unchanged and the candidate workspace was cleaned after verification.\n\n'+
    '## Original failure\n'+evidenceLine(repair.before)+'\n\n'+
    '## After repair\n'+evidenceLine(repair.after)+'\n\n'+
    '## Regression result\n'+regressions+'\n\n'+
    '## Proof artifacts\n'+refs+'\n\n'+
    '## Review gate\nThis pull request was prepared from a VerifiedRepair result. A human reviewer decides whether it is merged.\n';
}

export async function createVerifiedRepairPullRequest({
  transport,
  repository,
  baseBranch='main',
  runId,
  finding,
  repair,
  artifactRefs=[],
}={}) {
  requireTransport(transport);
  assertRepository(repository);
  assertVerifiedRepair(repair);
  if (typeof baseBranch!=='string'||!baseBranch||baseBranch.length>200) throw new Error('baseBranch is required');
  if (!Array.isArray(artifactRefs)||artifactRefs.length>20||artifactRefs.some((item)=>typeof item!=='string'||item.length>2000)) {
    throw new Error('artifactRefs must contain at most 20 bounded string references');
  }

  const branch=safeBranch(runId);
  const title='VERIFAI repair: '+clip(finding?.title || runId,120);
  const body=buildBody({finding,repair,artifactRefs});

  await transport.createBranch({repository,baseBranch,branch});
  const committed=await transport.commitVerifiedPatch({
    repository,
    baseBranch,
    branch,
    patch:repair.patch,
    commitMessage:'VERIFAI verified repair: '+clip(finding?.title || runId,120),
  });
  if (!committed?.commitSha) throw new Error('GitHub transport did not return commitSha');
  await transport.pushBranch({repository,branch,commitSha:committed.commitSha});
  const pullRequest=await transport.openPullRequest({
    repository,
    baseBranch,
    headBranch:branch,
    title,
    body,
  });
  if (!pullRequest) throw new Error('GitHub transport did not return a pull request');

  return {branch,commitSha:committed.commitSha,pullRequest};
}
