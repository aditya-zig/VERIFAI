import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';

const DEFAULT_MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;
const SECRET_KEY = /(authorization|api[-_]?key|token|secret|password|passwd|cookie|credential)/i;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function redactString(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi,'[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,'[REDACTED]');
}

function redact(value, key='') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(canonical(redact(value)), null, 2) + '\n','utf8');
}

function textBytes(value, maxTextBytes) {
  const redacted = Buffer.from(redactString(value ?? ''),'utf8');
  if (redacted.length <= maxTextBytes) return {buffer:redacted,truncated:false};
  return {buffer:redacted.subarray(0,maxTextBytes),truncated:true};
}

function artifact(name, path, buffer, extra={}) {
  return {name,path,status:'Present',bytes:buffer.length,sha256:sha256(buffer),...extra};
}

function missing(name, reason) {
  return {name,status:'Missing',reason};
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || runId === '.' || runId === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('runId must be a stable path-safe identifier');
  }
}

function bundlePath(rootDir, runId) {
  const root = resolve(rootDir);
  const path = resolve(root, runId);
  if (!path.startsWith(root + sep)) throw new Error('artifact path escapes root');
  return path;
}

export async function createArtifactBundle({
  rootDir,
  runId,
  data = {},
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
  maxBundleBytes = DEFAULT_MAX_BUNDLE_BYTES,
} = {}) {
  if (!rootDir || typeof rootDir !== 'string') throw new Error('rootDir is required');
  assertRunId(runId);
  if (!Number.isInteger(maxTextBytes) || maxTextBytes < 64 || maxTextBytes > 1024 * 1024) {
    throw new Error('maxTextBytes must be between 64 bytes and 1 MiB');
  }
  if (!Number.isInteger(maxBundleBytes) || maxBundleBytes < 1024 || maxBundleBytes > DEFAULT_MAX_BUNDLE_BYTES) {
    throw new Error('maxBundleBytes must be between 1 KiB and 50 MiB');
  }

  const files = new Map();
  const artifacts = [];
  const addJson = (name, path, value) => {
    if (value === undefined || value === null) {
      artifacts.push(missing(name, `${name} evidence not present`));
      return;
    }
    const buffer = jsonBytes(value);
    files.set(path, buffer);
    artifacts.push(artifact(name,path,buffer));
  };
  const addText = (name, path, value) => {
    if (value === undefined || value === null) {
      artifacts.push(missing(name, `${name} evidence not present`));
      return;
    }
    const {buffer,truncated}=textBytes(value,maxTextBytes);
    files.set(path,buffer);
    artifacts.push(artifact(name,path,buffer,{...(truncated?{truncated:true}:{})}));
  };

  addJson('run','run.json',data.run ?? {id:runId,status:'Incomplete',note:'Run metadata not supplied'});
  addJson('repository','repo.json',data.repository);
  addJson('finding','finding.json',data.finding);

  if (data.execution) {
    const {stdout,stderr,...executionMeta}=data.execution;
    addJson('execution','execution.json',executionMeta);
    addText('stdout','stdout.txt',stdout ?? '');
    addText('stderr','stderr.txt',stderr ?? '');
  } else {
    artifacts.push(missing('execution','execution evidence not present'));
    artifacts.push(missing('stdout','execution evidence not present'));
    artifacts.push(missing('stderr','execution evidence not present'));
  }

  addJson('browser','browser.json',data.browser);

  if (data.repair) {
    addText('repair-diff','repair.diff',data.repair.diff);
    addJson('before-verification','before.json',data.repair.before);
    addJson('after-verification','after.json',data.repair.after);
    addJson('regressions','regressions.json',data.repair.regressions);
  } else {
    artifacts.push(missing('repair-diff','repair evidence not present'));
    artifacts.push(missing('before-verification','repair evidence not present'));
    artifacts.push(missing('after-verification','repair evidence not present'));
    artifacts.push(missing('regressions','repair evidence not present'));
  }

  addJson('cleanup','cleanup.json',data.cleanup);
  addJson('model','model.json',data.model);

  const references = {
    screenshots: Array.isArray(data.browser?.screenshotRefs)
      ? data.browser.screenshotRefs.filter((item) => typeof item === 'string' && item.length <= 1024)
      : [],
  };

  const payloadBytes = [...files.values()].reduce((sum,buffer)=>sum+buffer.length,0);
  const manifest = {
    version:1,
    runId,
    artifacts,
    references,
    totalBytes:0,
  };
  let manifestBuffer;
  let totalBytes=0;
  for (let index=0; index<4; index += 1) {
    manifestBuffer=jsonBytes(manifest);
    totalBytes=payloadBytes+manifestBuffer.length;
    if (manifest.totalBytes===totalBytes) break;
    manifest.totalBytes=totalBytes;
  }
  manifestBuffer=jsonBytes(manifest);
  totalBytes=payloadBytes+manifestBuffer.length;
  manifest.totalBytes=totalBytes;
  manifestBuffer=jsonBytes(manifest);
  totalBytes=payloadBytes+manifestBuffer.length;
  manifest.totalBytes=totalBytes;
  manifestBuffer=jsonBytes(manifest);

  if (totalBytes > maxBundleBytes) {
    throw new Error(`Artifact bundle exceeds ${maxBundleBytes} bytes`);
  }

  const path=bundlePath(rootDir,runId);
  await mkdir(resolve(rootDir),{recursive:true,mode:0o700});
  await mkdir(path,{recursive:false,mode:0o700});
  for (const [name,buffer] of files) {
    await writeFile(resolve(path,name),buffer,{mode:0o600,flag:'wx'});
  }
  await writeFile(resolve(path,'manifest.json'),manifestBuffer,{mode:0o600,flag:'wx'});

  return {runId,path,manifest:canonical(manifest),totalBytes};
}
