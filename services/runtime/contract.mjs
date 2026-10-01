const CORE_STAGES = ['clone', 'analysis', 'sandbox', 'execution', 'finding', 'cleanup'];
const TERMINAL = new Set(['Completed', 'Failed', 'Incomplete']);
const STAGE_STATES = new Set(['Pending', 'Running', 'Completed', 'Failed', 'Incomplete', 'Skipped']);

export class RuntimeIncompleteError extends Error {
  constructor(stage, message, code = 'RuntimeIncomplete') {
    super(message);
    this.name = 'RuntimeIncompleteError';
    this.stage = stage;
    this.code = code;
  }
}

export function createRuntimeRun({runId, runtime, startedAt = new Date().toISOString()} = {}) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('runId must be a stable path-safe identifier');
  }
  return {
    id: runId,
    status: 'Running',
    startedAt,
    stages: Object.fromEntries(CORE_STAGES.map((name) => [name, {status: 'Pending'}])),
    provenance: {
      runtime,
      contractVersion: 1,
    },
  };
}

export function markRuntimeStage(run, name, status, detail) {
  if (!CORE_STAGES.includes(name)) throw new Error('unknown runtime stage: ' + name);
  if (!STAGE_STATES.has(status)) throw new Error('invalid stage status: ' + status);
  const previous = run.stages[name] || {status: 'Pending'};
  const now = Date.now();
  run.stages[name] = {
    ...previous,
    status,
    ...(detail ? {detail} : {}),
    ...(status === 'Running' && !previous.startedMs ? {startedMs: now, startedAt: new Date(now).toISOString()} : {}),
    ...(['Completed', 'Failed', 'Incomplete', 'Skipped'].includes(status)
      ? {durationMs: previous.startedMs ? Math.max(0, now - previous.startedMs) : 0}
      : {}),
  };
}

export function finishPendingStages(run) {
  for (const name of CORE_STAGES) {
    const state = run.stages[name]?.status;
    if (state === 'Pending') run.stages[name] = {...run.stages[name], status: 'Skipped'};
    if (state === 'Running') run.stages[name] = {...run.stages[name], status: 'Incomplete'};
  }
}

export function assertRuntimeResult(run) {
  if (!run || typeof run !== 'object') throw new Error('runtime result must be an object');
  if (typeof run.id !== 'string' || !run.id) throw new Error('runtime result id is required');
  if (!TERMINAL.has(run.status)) throw new Error('runtime result must be terminal');
  if (!run.stages || typeof run.stages !== 'object') throw new Error('runtime stages are required');

  for (const name of CORE_STAGES) {
    const state = run.stages[name]?.status;
    if (!STAGE_STATES.has(state)) throw new Error('invalid stage state for ' + name);
  }

  if (run.repository) {
    if (typeof run.repository.fullName !== 'string' || !run.repository.fullName.includes('/')) {
      throw new Error('repository fullName is required');
    }
    if (typeof run.repository.commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(run.repository.commit)) {
      throw new Error('repository exact commit is required');
    }
  }

  if (run.status === 'Completed') {
    for (const name of CORE_STAGES) {
      if (run.stages[name]?.status !== 'Completed') throw new Error('Completed run has non-completed stage: ' + name);
    }
    if (run.failedStage) throw new Error('Completed run cannot have failedStage');
  }

  if (run.cleanup && run.cleanup.status && !TERMINAL.has(run.cleanup.status)) {
    throw new Error('invalid cleanup terminal status');
  }

  if (!run.provenance || typeof run.provenance.runtime !== 'string' || !run.provenance.runtime) {
    throw new Error('runtime provenance is required');
  }
  if (run.provenance.contractVersion !== 1) throw new Error('unsupported runtime contract version');

  return run;
}

export function cloneRuntimeResult(run) {
  return structuredClone(run);
}

export const runtimeContract = Object.freeze({
  version: 1,
  coreStages: [...CORE_STAGES],
  terminalStates: [...TERMINAL],
});
