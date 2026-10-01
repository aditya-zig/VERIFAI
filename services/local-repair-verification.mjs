import {createHash} from 'node:crypto';
import {cp, lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, resolve, sep} from 'node:path';

const MAX_PATCH_BYTES = 64 * 1024;
const MAX_DIFF_BYTES = 16 * 1024;
let repairBusy = false;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEvidence(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const status = ['Completed','Failed','Incomplete'].includes(raw.status) ? raw.status : 'Incomplete';
  return {
    status,
    ...(Number.isInteger(raw.exitCode) || raw.exitCode === null ? {exitCode:raw.exitCode} : {}),
    ...(typeof raw.stdout === 'string' ? {stdout:raw.stdout.slice(-8192)} : {}),
    ...(typeof raw.stderr === 'string' ? {stderr:raw.stderr.slice(-8192)} : {}),
    ...(typeof raw.durationMs === 'number' ? {durationMs:raw.durationMs} : {}),
  };
}

function assertPatch(patch) {
  if (!patch || !Array.isArray(patch.files) || patch.files.length !== 1) {
    throw new Error('Invalid patch: exactly one file change is supported');
  }
  const file = patch.files[0];
  if (!file || typeof file.path !== 'string' || !file.path || isAbsolute(file.path) || file.path.split(/[\\/]+/).includes('..')) {
    throw new Error('Invalid patch path');
  }
  if (typeof file.expected !== 'string' || typeof file.replacement !== 'string') {
    throw new Error('Invalid patch: expected and replacement text are required');
  }
  if (Buffer.byteLength(JSON.stringify(patch),'utf8') > MAX_PATCH_BYTES) {
    throw new Error('Invalid patch: patch exceeds 64 KiB');
  }
  return {files:[{path:file.path, expected:file.expected, replacement:file.replacement}]};
}

function inside(root, path) {
  const full = resolve(root, path);
  const prefix = resolve(root) + sep;
  if (!full.startsWith(prefix)) throw new Error('Invalid patch path outside candidate workspace');
  return full;
}

function timeoutError(label) {
  const error = new Error(`${label} timeout`);
  error.code = 'VERIFIAI_REPAIR_TIMEOUT';
  return error;
}

async function withDeadline(label, timeoutMs, externalSignal, run) {
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError(label));
          reject(timeoutError(label));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(check, label, workspacePath, timeoutMs, signal) {
  if (typeof check !== 'function') throw new Error(`${label} check is required`);
  const started = performance.now();
  const value = await withDeadline(label, timeoutMs, signal, (checkSignal) => check({workspacePath, signal:checkSignal, label}));
  const evidence = normalizeEvidence(value);
  if (evidence.durationMs === undefined) evidence.durationMs = Math.round(performance.now() - started);
  return evidence;
}

async function applyStructuredPatch(candidatePath, patch) {
  const change = patch.files[0];
  const filePath = inside(candidatePath, change.path);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid patch target: regular file required');
  const before = await readFile(filePath, 'utf8');
  const first = before.indexOf(change.expected);
  const last = before.lastIndexOf(change.expected);
  if (first < 0 || first !== last) throw new Error('Invalid patch: expected text must occur exactly once');
  const after = before.slice(0, first) + change.replacement + before.slice(first + change.expected.length);
  await writeFile(filePath, after, 'utf8');
  let diff = `--- a/${change.path}\n+++ b/${change.path}\n-${before}\n+${after}\n`;
  if (Buffer.byteLength(diff,'utf8') > MAX_DIFF_BYTES) {
    diff = Buffer.from(diff,'utf8').subarray(0,MAX_DIFF_BYTES).toString('utf8') + '\n...[diff truncated]\n';
  }
  return {
    path: change.path,
    beforeHash: hash(before),
    afterHash: hash(after),
    diff,
  };
}

export async function runRepairVerification({
  workspacePath,
  finding,
  patch,
  verify,
  regressions = [],
  timeoutMs = 10_000,
  signal,
} = {}) {
  if (repairBusy) return {verdict:'Incomplete', error:'Busy: one repair verification at a time', cleanup:{candidateRemoved:true}};
  repairBusy = true;

  let candidatePath;
  let normalizedPatch;
  let targetPath;
  let originalBefore;
  const result = {
    verdict:'Incomplete',
    regressions:[],
    cleanup:{candidateRemoved:false},
    originalUnchanged:false,
  };

  try {
    if (!workspacePath || typeof workspacePath !== 'string') throw new Error('workspacePath is required');
    if (!(finding?.status === 'Confirmed' || finding?.findingState === 'Confirmed')) {
      throw new Error('Verified failure required before repair');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) {
      throw new Error('timeoutMs must be between 10 and 60000');
    }
    if (!Array.isArray(regressions) || regressions.length > 8 || regressions.some((item) => typeof item !== 'function')) {
      throw new Error('regressions must contain at most 8 checks');
    }

    normalizedPatch = assertPatch(patch);
    targetPath = inside(workspacePath, normalizedPatch.files[0].path);
    const targetStat = await lstat(targetPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('Invalid patch target: regular file required');
    originalBefore = await readFile(targetPath);

    candidatePath = await mkdtemp(join(tmpdir(),'verifai-repair-'));
    await cp(workspacePath, candidatePath, {recursive:true, dereference:false, preserveTimestamps:false});

    result.before = await runCheck(verify, 'before verification', candidatePath, timeoutMs, signal);
    if (result.before.status === 'Incomplete') {
      result.error = 'Before verification was Incomplete';
      return result;
    }
    if (result.before.status !== 'Failed') {
      result.error = 'Verified failure was not reproduced before repair';
      return result;
    }

    const applied = await applyStructuredPatch(candidatePath, normalizedPatch);
    result.diff = applied.diff;
    result.patch = normalizedPatch;
    result.changedFiles = [{path:applied.path,beforeHash:applied.beforeHash,afterHash:applied.afterHash}];

    result.after = await runCheck(verify, 'after verification', candidatePath, timeoutMs, signal);
    if (result.after.status === 'Incomplete') {
      result.error = 'After verification was Incomplete';
      return result;
    }
    if (result.after.status !== 'Completed') {
      result.verdict = 'RejectedRepair';
      result.error = 'Original failure still reproduces after repair';
      return result;
    }

    for (let index=0; index<regressions.length; index += 1) {
      const evidence = await runCheck(regressions[index], `regression ${index + 1}`, candidatePath, timeoutMs, signal);
      result.regressions.push(evidence);
      if (evidence.status === 'Incomplete') {
        result.error = `Regression ${index + 1} was Incomplete`;
        return result;
      }
      if (evidence.status !== 'Completed') {
        result.verdict = 'RejectedRepair';
        result.error = `Regression ${index + 1} failed`;
        return result;
      }
    }

    result.verdict = 'VerifiedRepair';
    return result;
  } catch (error) {
    result.verdict = 'Incomplete';
    result.error = String(error?.message || error);
    return result;
  } finally {
    if (candidatePath) {
      try {
        await rm(candidatePath,{recursive:true,force:true});
        result.cleanup.candidateRemoved = true;
      } catch (error) {
        result.cleanup.candidateRemoved = false;
        result.verdict = 'Incomplete';
        result.error = `Candidate cleanup failed: ${String(error?.message || error)}`;
      }
    } else {
      result.cleanup.candidateRemoved = true;
    }

    if (targetPath && originalBefore) {
      try {
        const originalAfter = await readFile(targetPath);
        result.originalUnchanged = originalBefore.equals(originalAfter);
        if (!result.originalUnchanged) {
          result.verdict = 'Incomplete';
          result.error = 'Original workspace changed during repair verification';
        }
      } catch (error) {
        result.verdict = 'Incomplete';
        result.error = `Could not verify original workspace integrity: ${String(error?.message || error)}`;
      }
    }
    repairBusy = false;
  }
}
