import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {S3Client, PutObjectCommand} from '@aws-sdk/client-s3';
import {runRuntimeAudit} from '../services/runtime/engine.mjs';
import {CloudTaskRuntimeProvider} from '../services/cloud/task-runtime.mjs';
import {createArtifactBundle} from '../services/proof-artifacts.mjs';
import {cloudArtifactKey} from '../services/cloud/artifact-contract.mjs';
import {AwsS3RunStore} from '../services/cloud/s3-run-store.mjs';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

function structuredLog(event) {
  process.stdout.write(JSON.stringify({timestamp: new Date().toISOString(), ...event}) + '\n');
}

async function taskArn(env = process.env, fetchImpl = fetch) {
  const base = env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) return null;
  try {
    const response = await fetchImpl(base.replace(/\/$/, '') + '/task', {signal: AbortSignal.timeout(2000)});
    if (!response.ok) return null;
    const payload = await response.json();
    return typeof payload?.TaskARN === 'string' ? payload.TaskARN : null;
  } catch {
    return null;
  }
}

function exactRepository() {
  return {
    fullName: required('VERIFIAI_REPOSITORY_FULL_NAME'),
    url: required('VERIFIAI_REPOSITORY_URL'),
    commit: required('VERIFIAI_REPOSITORY_COMMIT'),
  };
}

async function files(root) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) out.push(path);
    }
  }
  await visit(root);
  return out;
}

function proofDescriptor(bundle) {
  return {
    runId: bundle.runId,
    manifest: {
      id: 'proof:' + bundle.runId + ':manifest',
      sha256: bundle.manifestSha256,
    },
    artifacts: bundle.manifest.artifacts.map((item) => ({
      name: item.name,
      status: item.status,
      path: item.path,
      sha256: item.sha256,
      reason: item.reason,
    })),
    screenshotRefs: bundle.manifest.references.screenshots,
    totalBytes: bundle.totalBytes,
  };
}

async function uploadBundle(s3, bucket, bundle) {
  const root = resolve(bundle.path);
  for (const path of await files(root)) {
    const rel = relative(root, path).split('\\').join('/');
    const body = await readFile(path);
    if (body.length > 50 * 1024 * 1024) throw new Error('artifact object exceeds 50 MiB cap');
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: cloudArtifactKey(bundle.runId, rel),
      Body: body,
      ServerSideEncryption: 'AES256',
      ContentType: rel.endsWith('.json') ? 'application/json' : rel.endsWith('.png') ? 'image/png' : 'text/plain',
    }));
  }
}

export async function runCloudWorker({env = process.env, s3} = {}) {
  const runId = env.VERIFIAI_RUN_ID;
  const bucket = env.VERIFIAI_ARTIFACT_BUCKET;
  if (!runId || !bucket) throw new Error('cloud worker run/bucket configuration missing');
  const deadlineMs = Number(env.VERIFIAI_CLOUD_DEADLINE_MS || 20 * 60 * 1000);
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 20 * 60 * 1000) {
    throw new Error('invalid cloud worker deadline');
  }

  const client = s3 || new S3Client({region: env.AWS_REGION || 'ap-south-1'});
  const store = new AwsS3RunStore({
    s3: client,
    bucket,
    environment: env.VERIFIAI_CLOUD_ENVIRONMENT || 'dev',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cloud worker deadline exceeded')), deadlineMs);
  const provider = new CloudTaskRuntimeProvider({env});
  const repository = exactRepository();
  const cloudTaskArn = await taskArn(env);
  let run;
  let root;

  structuredLog({
    event: 'run.started',
    runId,
    stage: 'launch',
    status: 'Running',
    taskArn: cloudTaskArn,
    provider: env.VERIFIAI_MODEL_PROVIDER || null,
    model: env.VERIFIAI_MODEL_ID || null,
  });

  try {
    run = await runRuntimeAudit(provider, {
      runId,
      repositoryUrl: repository.url.replace(/\.git$/, ''),
      repository,
      objective: env.VERIFIAI_CLOUD_OBJECTIVE || 'Run the bounded VERIFAI review.',
      timeoutMs: deadlineMs,
      commandTimeoutMs: Math.min(10000, deadlineMs - 500),
      signal: controller.signal,
    });

    for (const [stage, value] of Object.entries(run.stages || {})) {
      structuredLog({
        event: 'stage.terminal',
        runId,
        stage,
        status: value?.status,
        durationMs: value?.durationMs ?? null,
        taskArn: cloudTaskArn,
        provider: run.model?.provider || env.VERIFIAI_MODEL_PROVIDER || null,
        model: run.model?.model || env.VERIFIAI_MODEL_ID || null,
      });
    }

    root = await mkdtemp(join(tmpdir(), 'verifiai-cloud-artifacts-'));
    const bundle = await createArtifactBundle({
      rootDir: root,
      runId,
      data: {
        run: {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          durationMs: run.durationMs,
          failedStage: run.failedStage,
          failureCode: run.failureCode,
          error: run.error,
          stages: run.stages,
          provenance: run.provenance,
        },
        repository: run.repository,
        finding: run.finding,
        execution: run.execution,
        cleanup: run.cleanup,
        model: run.model,
      },
      knownSecrets: [env.VERIFIAI_PROVIDER_API_KEY].filter(Boolean),
    });
    await uploadBundle(client, bucket, bundle);
    run.proof = proofDescriptor(bundle);
    await store.putResult(runId, run);
    structuredLog({
      event: 'run.terminal',
      runId,
      stage: run.failedStage || 'complete',
      status: run.status,
      durationMs: run.durationMs ?? null,
      taskArn: cloudTaskArn,
      provider: run.model?.provider || env.VERIFIAI_MODEL_PROVIDER || null,
      model: run.model?.model || env.VERIFIAI_MODEL_ID || null,
      artifactRefs: run.proof?.artifacts?.filter((x) => x.status === 'Present').map((x) => x.path) || [],
      cleanup: run.cleanup || null,
    });
    return run;
  } catch (error) {
    const failed = {
      ...(run || {
        id: runId,
        repository,
        provenance: {runtime: 'cloud', contractVersion: 1},
      }),
      status: 'Incomplete',
      failedStage: run?.failedStage || 'artifact',
      failureCode: run?.failureCode || 'ArtifactUploadFailed',
      error: String(error?.message || error),
      finishedAt: new Date().toISOString(),
    };
    await store.putResult(runId, failed).catch(() => undefined);
    structuredLog({
      event: 'run.terminal',
      runId,
      stage: failed.failedStage,
      status: failed.status,
      taskArn: cloudTaskArn,
      provider: env.VERIFIAI_MODEL_PROVIDER || null,
      model: env.VERIFIAI_MODEL_ID || null,
      artifactRefs: [],
      cleanup: failed.cleanup || null,
      failureCode: failed.failureCode,
    });
    return failed;
  } finally {
    clearTimeout(timer);
    if (root) await rm(root, {recursive: true, force: true});
  }
}

if (process.argv.includes('--self-check')) {
  console.log(JSON.stringify({
    status: 'ok',
    worker: 'verifiai-cloud-runtime',
    node: process.version,
    dockerSocket: false,
  }));
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCloudWorker();
  console.log(JSON.stringify({
    runId: result.id,
    status: result.status,
    failedStage: result.failedStage,
    failureCode: result.failureCode,
  }));
  if (result.status === 'Incomplete' && ['artifact', 'cleanup'].includes(result.failedStage)) process.exitCode = 2;
}
