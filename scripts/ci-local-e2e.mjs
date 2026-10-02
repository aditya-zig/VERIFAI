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

if(!process.env.XKIRO_API_KEY){
  console.log('Real provider E2E: SKIPPED — credential unavailable');
  process.exit(0);
}

run('credential-required real provider E2E',provider);
