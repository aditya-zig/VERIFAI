const allowedStatuses = new Set(['Completed', 'Incomplete']);
const DEFAULT_MAX_SPECIALISTS = 1;
const HARD_MAX_SPECIALISTS = 4;
const DEFAULT_MAX_MODEL_CALLS = 1;
const HARD_MAX_MODEL_CALLS = 4;
const DEFAULT_MAX_STATE_BYTES = 1024 * 1024;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeResult(id, value) {
  const raw = value && typeof value === 'object' ? value : {};
  const status = allowedStatuses.has(raw.status) ? raw.status : 'Incomplete';
  const findings = Array.isArray(raw.findings) ? raw.findings : [];
  const evidenceRefs = Array.isArray(raw.evidenceRefs)
    ? [...new Set(raw.evidenceRefs.filter((item) => typeof item === 'string' && item.length <= 512))]
    : [];
  return {
    id,
    status,
    findings,
    evidenceRefs,
    ...(raw.model && typeof raw.model === 'object' ? {model: raw.model} : {}),
    ...(typeof raw.error === 'string' ? {error: raw.error} : {}),
  };
}

function assertBounds(maxSpecialists, maxModelCalls, maxStateBytes) {
  if (!Number.isInteger(maxSpecialists) || maxSpecialists < 1 || maxSpecialists > HARD_MAX_SPECIALISTS) {
    throw new Error(`maxSpecialists must be between 1 and ${HARD_MAX_SPECIALISTS}`);
  }
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > HARD_MAX_MODEL_CALLS) {
    throw new Error(`maxModelCalls must be between 0 and ${HARD_MAX_MODEL_CALLS}`);
  }
  if (!Number.isInteger(maxStateBytes) || maxStateBytes < 1024 || maxStateBytes >= DEFAULT_MAX_STATE_BYTES) {
    throw new Error('maxStateBytes must be at least 1024 bytes and strictly below 1 MiB');
  }
}

export async function runSequentialSpecialists({
  specialists,
  persist,
  context = {},
  maxSpecialists = DEFAULT_MAX_SPECIALISTS,
  maxModelCalls = DEFAULT_MAX_MODEL_CALLS,
  maxStateBytes = DEFAULT_MAX_STATE_BYTES - 1,
  signal,
} = {}) {
  if (!Array.isArray(specialists) || specialists.length === 0) {
    return {status:'Completed', results:[], evidenceRefs:[], modelCalls:0};
  }
  if (typeof persist !== 'function') throw new Error('persist callback is required');
  assertBounds(maxSpecialists, maxModelCalls, maxStateBytes);
  if (specialists.length > maxSpecialists) {
    throw new Error(`specialist limit exceeded: ${specialists.length} > ${maxSpecialists}`);
  }

  const ids = specialists.map((specialist) => specialist?.id);
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error('specialist id must be a stable lowercase identifier');
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error('duplicate specialist execution is not allowed');
  for (const specialist of specialists) {
    if (typeof specialist.run !== 'function') throw new Error(`specialist ${specialist.id} is missing run()`);
  }

  const results = [];
  const evidenceRefs = [];
  const executed = new Set();
  let modelCalls = 0;

  // One lease for every model call in this orchestrator run. A specialist may
  // attempt Promise.all(callModel(...), callModel(...)); the provider calls
  // still execute one-at-a-time.
  let modelTail = Promise.resolve();
  const callModel = async (invoke) => {
    signal?.throwIfAborted();
    if (typeof invoke !== 'function') throw new Error('callModel requires a function');
    if (modelCalls >= maxModelCalls) throw new Error(`model call limit exceeded (${maxModelCalls})`);
    modelCalls += 1;
    let release;
    const previous = modelTail;
    modelTail = new Promise((resolve) => { release = resolve; });
    await previous;
    signal?.throwIfAborted();
    try {
      return await invoke();
    } finally {
      release();
    }
  };

  const persistSnapshot = async () => {
    const snapshot = {
      status: results.some((item) => item.status === 'Incomplete') ? 'Incomplete' : 'Completed',
      results: clone(results),
      evidenceRefs: [...evidenceRefs],
      modelCalls,
    };
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (bytes >= 1024 * 1024 || bytes > maxStateBytes) {
      throw new Error(`specialist shared state exceeds ${maxStateBytes} bytes`);
    }
    await persist(snapshot);
  };

  for (const specialist of specialists) {
    signal?.throwIfAborted();
    if (executed.has(specialist.id)) throw new Error(`duplicate specialist execution: ${specialist.id}`);
    executed.add(specialist.id);

    let result;
    try {
      const raw = await specialist.run({
        ...context,
        signal,
        callModel,
        specialistId: specialist.id,
      });
      result = normalizeResult(specialist.id, raw);
    } catch (error) {
      result = {
        id: specialist.id,
        status: 'Incomplete',
        findings: [],
        evidenceRefs: [],
        error: String(error?.message || error),
      };
    }

    results.push(result);
    for (const ref of result.evidenceRefs) if (!evidenceRefs.includes(ref)) evidenceRefs.push(ref);
    try {
      await persistSnapshot();
    } catch (error) {
      result.status = 'Incomplete';
      result.error = `persist failed: ${String(error?.message || error)}`;
      throw error;
    }
  }

  return {
    status: results.some((item) => item.status === 'Incomplete') ? 'Incomplete' : 'Completed',
    results,
    evidenceRefs,
    modelCalls,
  };
}

export function createSecuritySpecialist(review) {
  if (typeof review !== 'function') throw new Error('security review function is required');
  return {
    id: 'security',
    async run({callModel, record, auditId, signal}) {
      return callModel(() => review(record, {auditId, signal}));
    },
  };
}
