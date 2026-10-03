import {spawnSync} from 'node:child_process';

const structural=[
  'tests-e2e/command-safety.test.mjs',
  'tests-e2e/local-browser.test.mjs',
  'tests-e2e/local-repository.test.mjs',
  'tests-e2e/local-sandbox.test.mjs',
  'tests-e2e/master-failure.test.mjs',
];
const provider=[
  'tests-e2e/local-analysis.test.mjs',
  'tests-e2e/local-audit.test.mjs',
  'tests-e2e/local-command.test.mjs',
  'tests-e2e/browser-route.test.mjs',
  'tests-e2e/sandbox-interruption.test.mjs',
];

function run(label,files){
  console.log(`CI lane: ${label}`);
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{stdio:'inherit',env:process.env});
  if(result.error) throw result.error;
  if(result.status!==0) process.exit(result.status ?? 1);
}

run('credential-independent structural E2E',structural);

// Live Bedrock requests can incur AWS charges. Credentials alone never opt in.
if(process.env.VERIFIAI_RUN_AWS_E2E!=='1'){
  console.log('Real AWS Bedrock E2E: SKIPPED — set VERIFIAI_RUN_AWS_E2E=1 to opt in');
  process.exit(0);
}
const providerName=process.env.VERIFIAI_MODEL_PROVIDER || 'bedrock';
const modelId=(process.env.VERIFIAI_BEDROCK_MODEL_ID || process.env.VERIFIAI_MODEL_ID || '').trim();
const region=(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '').trim();
if(providerName!=='bedrock' || !modelId || !region){
  console.log('Real AWS Bedrock E2E: SKIPPED — requires bedrock, VERIFIAI_BEDROCK_MODEL_ID/VERIFIAI_MODEL_ID, and AWS_REGION/AWS_DEFAULT_REGION');
  process.exit(0);
}
// Credentials are resolved by the standard AWS SDK chain, including IAM roles.
run('explicitly opted-in real AWS Bedrock E2E',provider);
