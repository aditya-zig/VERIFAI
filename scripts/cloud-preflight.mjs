import {readFile} from 'node:fs/promises';

const templatePath = new URL('../infra/aws/runtime-cloudformation.json', import.meta.url);
const dockerPath = new URL('../infra/aws/runtime-worker.Dockerfile', import.meta.url);
const template = JSON.parse(await readFile(templatePath, 'utf8'));
const dockerfile = await readFile(dockerPath, 'utf8');

const text = JSON.stringify(template);
const forbidden = [
  'AWS::EKS::',
  'AWS::RDS::',
  'AWS::OpenSearchService::',
  'AWS::ElastiCache::',
  'AWS::MSK::',
  'AWS::StepFunctions::',
  'AWS::EC2::NatGateway',
  'AWS::AutoScaling::',
  'AWS::ECS::Service',
];
for (const value of forbidden) {
  if (text.includes(value)) throw new Error('forbidden cloud resource present: ' + value);
}

const resources = template.Resources || {};
const bucket = resources.ArtifactBucket?.Properties;
if (!bucket?.PublicAccessBlockConfiguration) throw new Error('artifact bucket public-access block missing');
for (const value of Object.values(bucket.PublicAccessBlockConfiguration)) {
  if (value !== true) throw new Error('artifact bucket public-access block must be fully enabled');
}

const task = resources.RuntimeTaskDefinition?.Properties;
if (task?.Cpu !== '512' || task?.Memory !== '1024') throw new Error('worker must stay at 0.5 vCPU / 1 GiB default');
if (task?.RequiresCompatibilities?.join(',') !== 'FARGATE') throw new Error('worker must be Fargate-only');

const statements = [];
function collect(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach(collect);
  if (value.Effect && value.Action && value.Resource) statements.push(value);
  for (const child of Object.values(value)) collect(child);
}
collect(template);
for (const statement of statements) {
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  const resourcesList = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
  if (actions.includes('*')) throw new Error('IAM Action wildcard is forbidden');
  if (resourcesList.includes('*')) {
    const onlyEcrToken = actions.length === 1 && actions[0] === 'ecr:GetAuthorizationToken' && statement.Sid === 'EcrAuthorizationToken';
    if (!onlyEcrToken) throw new Error('IAM Resource wildcard is forbidden except ECR authorization token API');
  }
}

if (!/^FROM node:[0-9]+\.[0-9]+\.[0-9]+-bookworm-slim/m.test(dockerfile)) throw new Error('worker base image must pin an explicit Node patch version');
if (/FROM\s+\S*:latest/i.test(dockerfile)) throw new Error('worker image may not use latest');
if (!/^USER 10001:10001$/m.test(dockerfile)) throw new Error('worker must run non-root');
if (!/ENTRYPOINT \["node", "scripts\/cloud-worker\.mjs"\]/.test(dockerfile)) throw new Error('worker entrypoint contract missing');
if (/docker\.sock|\/var\/run\/docker/i.test(dockerfile)) throw new Error('worker Docker socket is forbidden');

console.log(JSON.stringify({
  ok: true,
  iac: 'cloudformation',
  worker: {cpu: task.Cpu, memory: task.Memory, launch: 'FARGATE'},
  publicBucketBlocked: true,
  forbiddenResources: 'absent',
  iamWildcards: 'bounded',
}, null, 2));
