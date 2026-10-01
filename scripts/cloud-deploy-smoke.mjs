import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {ECSClient} from '@aws-sdk/client-ecs';
import {S3Client} from '@aws-sdk/client-s3';
import {AwsCloudControlPlane} from '../services/cloud/aws-control-plane.mjs';
import {AwsS3RunStore} from '../services/cloud/s3-run-store.mjs';

const execFileAsync = promisify(execFile);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

function allowProvisioning() {
  if (process.env.VERIFIAI_CLOUD_ALLOW_PROVISION !== 'true') {
    throw new Error('Real cloud provisioning is blocked. Set VERIFIAI_CLOUD_ALLOW_PROVISION=true only after explicit authorization.');
  }
}

async function aws(args, {json = false} = {}) {
  const result = await execFileAsync('aws', args, {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return json ? JSON.parse(result.stdout || '{}') : result.stdout.trim();
}

function outputMap(stack) {
  return Object.fromEntries((stack?.Outputs || []).map((item) => [item.OutputKey, item.OutputValue]));
}

async function deployStack({region, stackName, imageUri, repositoryArn, secretArn, environment}) {
  const overrides = [
    'WorkerImageUri=' + imageUri,
    'WorkerRepositoryArn=' + repositoryArn,
    'Environment=' + environment,
  ];
  if (secretArn) overrides.push('ProviderSecretArn=' + secretArn);

  await aws([
    'cloudformation', 'deploy',
    '--region', region,
    '--stack-name', stackName,
    '--template-file', 'infra/aws/runtime-cloudformation.json',
    '--capabilities', 'CAPABILITY_IAM',
    '--no-fail-on-empty-changeset',
    '--parameter-overrides', ...overrides,
    '--tags', 'project=verifiai', 'environment=' + environment,
  ]);

  const described = await aws([
    'cloudformation', 'describe-stacks',
    '--region', region,
    '--stack-name', stackName,
  ], {json: true});
  const stack = described.Stacks?.[0];
  if (!stack) throw new Error('deployed stack not found');
  return outputMap(stack);
}

async function waitForTerminal(runtime, runId, deadlineMs) {
  const end = Date.now() + deadlineMs + 60_000;
  while (Date.now() < end) {
    const state = await runtime.refresh(runId);
    if (state && ['Completed', 'Failed', 'Incomplete'].includes(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return runtime.cancel(runId, {waitMs: 30_000});
}

export async function deployCloudSmoke() {
  allowProvisioning();

  const region = process.env.AWS_REGION || 'ap-south-1';
  const environment = process.env.VERIFIAI_CLOUD_ENVIRONMENT || 'smoke';
  const stackName = process.env.VERIFIAI_CLOUD_STACK_NAME || 'verifiai-runtime-smoke';
  const imageUri = required('VERIFIAI_CLOUD_WORKER_IMAGE_URI');
  const repositoryArn = required('VERIFIAI_CLOUD_WORKER_REPOSITORY_ARN');
  const subnets = required('VERIFIAI_CLOUD_PUBLIC_SUBNETS').split(',').map((x) => x.trim()).filter(Boolean);
  const securityGroups = (process.env.VERIFIAI_CLOUD_SECURITY_GROUPS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!subnets.length) throw new Error('VERIFIAI_CLOUD_PUBLIC_SUBNETS must contain at least one subnet');

  const outputs = await deployStack({
    region,
    stackName,
    imageUri,
    repositoryArn,
    secretArn: process.env.VERIFIAI_CLOUD_PROVIDER_SECRET_ARN,
    environment,
  });

  const bucket = outputs.ArtifactBucketName;
  const cluster = outputs.ClusterArn;
  const taskDefinition = outputs.TaskDefinitionArn;
  if (!bucket || !cluster || !taskDefinition) throw new Error('runtime stack outputs are incomplete');

  const runId = process.env.VERIFIAI_CLOUD_RUN_ID || ('smoke-' + randomUUID());
  const deadlineMs = Number(process.env.VERIFIAI_CLOUD_DEADLINE_MS || 5 * 60 * 1000);
  const repository = {
    fullName: required('VERIFIAI_SMOKE_REPOSITORY_FULL_NAME'),
    url: required('VERIFIAI_SMOKE_REPOSITORY_URL'),
    commit: required('VERIFIAI_SMOKE_REPOSITORY_COMMIT'),
  };
  const model = {
    provider: required('VERIFIAI_MODEL_PROVIDER'),
    name: required('VERIFIAI_MODEL_ID'),
  };

  const s3 = new S3Client({region});
  const ecs = new ECSClient({region});
  const store = new AwsS3RunStore({s3, bucket, environment});
  const runtime = new AwsCloudControlPlane({
    ecs,
    store,
    cluster,
    taskDefinition,
    subnets,
    securityGroups,
    environment,
    assignPublicIp: true,
  });

  const started = await runtime.start({
    runId,
    repository,
    model,
    capabilities: ['repository:read', 'execution:bounded', 'artifact:write'],
    deadlineMs,
    maxModelCalls: 1,
    taskCount: 1,
    retries: 0,
    estimatedSpendUsd: Number(process.env.VERIFIAI_CLOUD_ESTIMATED_SPEND_USD || 0.25),
  });

  if (started.status !== 'Running') {
    console.log(JSON.stringify({stackName, outputs, run: started}, null, 2));
    process.exitCode = 2;
    return started;
  }

  const terminal = await waitForTerminal(runtime, runId, deadlineMs);
  console.log(JSON.stringify({
    stackName,
    artifactBucket: bucket,
    runId,
    status: terminal?.status,
    failedStage: terminal?.failedStage,
    failureCode: terminal?.failureCode,
    proof: terminal?.proof,
    cleanup: terminal?.cleanup,
  }, null, 2));

  if (terminal?.status !== 'Completed') process.exitCode = 2;
  return terminal;
}

if (process.argv[1]?.endsWith('cloud-deploy-smoke.mjs')) {
  await deployCloudSmoke();
}
