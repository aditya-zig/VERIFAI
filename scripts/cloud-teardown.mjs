import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

function allowProvisioning() {
  if (process.env.VERIFIAI_CLOUD_ALLOW_PROVISION !== 'true') {
    throw new Error('Real cloud mutation is blocked. Set VERIFIAI_CLOUD_ALLOW_PROVISION=true only after explicit authorization.');
  }
}

async function aws(args, {json = false} = {}) {
  const result = await execFileAsync('aws', args, {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return json ? JSON.parse(result.stdout || '{}') : result.stdout.trim();
}

function outputs(stack) {
  return Object.fromEntries((stack?.Outputs || []).map((item) => [item.OutputKey, item.OutputValue]));
}

export async function teardownCloudSmoke() {
  allowProvisioning();
  const region = process.env.AWS_REGION || 'ap-south-1';
  const stackName = process.env.VERIFIAI_CLOUD_STACK_NAME || 'verifiai-runtime-smoke';

  const described = await aws([
    'cloudformation', 'describe-stacks',
    '--region', region,
    '--stack-name', stackName,
  ], {json: true});
  const stack = described.Stacks?.[0];
  if (!stack) throw new Error('runtime stack not found');
  const values = outputs(stack);
  const cluster = values.ClusterArn;
  const bucket = values.ArtifactBucketName;
  if (!cluster || !bucket) throw new Error('runtime stack outputs are incomplete');

  const running = await aws([
    'ecs', 'list-tasks',
    '--region', region,
    '--cluster', cluster,
    '--desired-status', 'RUNNING',
  ], {json: true});
  if ((running.taskArns || []).length) {
    throw new Error('Refusing teardown: runtime cluster still has running tasks. Cancel the exact VERIFAI run first.');
  }

  await aws(['s3', 'rm', 's3://' + bucket, '--recursive', '--region', region]);
  await aws(['cloudformation', 'delete-stack', '--region', region, '--stack-name', stackName]);
  await aws(['cloudformation', 'wait', 'stack-delete-complete', '--region', region, '--stack-name', stackName]);

  console.log(JSON.stringify({
    deleted: true,
    stackName,
    artifactBucketEmptied: bucket,
    runningTasksBeforeDelete: 0,
  }, null, 2));
}

if (process.argv[1]?.endsWith('cloud-teardown.mjs')) {
  await teardownCloudSmoke();
}
