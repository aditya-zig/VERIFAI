import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DockerWorkerLauncher } from '../dist/services/agent-runtime/docker-launcher.js';
import { AGENT_WORKER_CONTRACT_VERSION } from '../dist/packages/contracts/src/index.js';

const provider = process.env.VERIFIAI_MODEL_PROVIDER ?? 'bedrock';
const modelId = process.env.VERIFIAI_BEDROCK_MODEL_ID ?? process.env.VERIFIAI_MODEL_ID;
if (provider !== 'bedrock') throw new Error('VERIFIAI_MODEL_PROVIDER must be bedrock');
if (!modelId) throw new Error('VERIFIAI_BEDROCK_MODEL_ID or VERIFIAI_MODEL_ID is required');
if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) throw new Error('AWS_REGION or AWS_DEFAULT_REGION is required');
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error('Local Docker worker requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials)');
}

const network = process.env.VERIFIAI_LOCAL_WORKER_NETWORK ?? 'verifiai-agent-local';
const workerImage = process.env.VERIFIAI_LOCAL_WORKER_IMAGE ?? 'verifiai-agent-worker:local';
const targetImage = 'verifiai-local-target:smoke';
const targetName = `verifiai-local-target-${randomUUID().slice(0, 8)}`;

function docker(args, options = {}) {
  return execFileSync('docker', args, { stdio: 'inherit', ...options });
}

try {
  docker(['build', '-f', 'infra/local/agent-worker.Dockerfile', '-t', workerImage, '.']);
  docker(['build', '-f', 'infra/local/target-smoke.Dockerfile', '-t', targetImage, '.']);
  try { docker(['network', 'create', network]); } catch {}
  docker([
    'run', '-d', '--rm', '--name', targetName,
    '--network', network,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--memory', '256m',
    '--cpus', '0.25',
    targetImage,
  ]);

  const auditId = `AUD-LOCAL-${randomUUID().slice(0, 8)}`;
  const workerId = `W-LOCAL-${randomUUID().slice(0, 8)}`;
  const events = [];
  const launcher = new DockerWorkerLauncher({
    image: workerImage,
    network,
    cpus: Number(process.env.VERIFIAI_LOCAL_WORKER_CPUS ?? 1),
    memory: process.env.VERIFIAI_LOCAL_WORKER_MEMORY ?? '1024m',
  });
  const session = await launcher.launch({
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId,
    workerId,
    role: 'security-secrets',
    objective: 'Prove the local Docker execution path uses the same real Strands worker contract and returns a structured report without inventing executed findings.',
    repository: {
      provider: 'github',
      fullName: 'aditya-zig/AWS-wemakedevs',
      url: 'https://github.com/aditya-zig/AWS-wemakedevs',
      branch: 'main',
      commitSha: process.env.GITHUB_SHA ?? 'local',
    },
    target: {
      id: targetName,
      url: 'http://verifiai-local-target:8081',
      environment: 'shared-observation',
      immutable: true,
    },
    tools: [],
    evidenceRefs: [],
    modelProfileId: `${provider}:${modelId}`,
    constraints: {
      timeoutMs: Number(process.env.VERIFIAI_LOCAL_WORKER_TIMEOUT_MS ?? 120000),
      maxToolCalls: 8,
      maxEvidenceItems: 20,
      destructiveAllowed: false,
      networkAllowlist: ['verifiai-local-target'],
      maxEstimatedSpendUsd: 0.25,
    },
  }, async (event) => {
    events.push(event);
    console.log(JSON.stringify(event));
  });

  const report = await session.result;
  await launcher.teardown(session);
  console.log(JSON.stringify({ report, events: events.length }, null, 2));
  if (report.outcome !== 'completed') process.exitCode = 1;
} finally {
  try { docker(['rm', '-f', targetName]); } catch {}
  try { docker(['network', 'rm', network]); } catch {}
}
