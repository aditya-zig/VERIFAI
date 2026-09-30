import { selectCommand } from './local-command.mjs';
import { executeSandbox } from './local-sandbox.mjs';
import { analyzeRepository } from './local-analysis.mjs';

let busy = false;
let activeController;
export function abortActiveAudit() { activeController?.abort(new Error('Server stopping')); }

export function acquireLocalAudit(signal) {
  if (busy) {
    const error = new Error('Busy: one local command audit is already running');
    error.statusCode = 429;
    throw error;
  }
  busy = true;
  activeController = new AbortController();
  const controller = activeController;
  return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    release() { if (activeController === controller) { busy = false; activeController = undefined; } } };
}

export async function auditRepository(record, { timeoutMs = 10_000, env = process.env, signal } = {}) {
  const lease = acquireLocalAudit(signal);
  const auditSignal = lease.signal;
  let execution;
  try {
    const command = await selectCommand(record.clone.workspacePath, record.files.items);
    execution = await executeSandbox(record.clone.workspacePath, command, { timeoutMs, signal: auditSignal });
    if (execution.status === 'Incomplete') return { status: 'Incomplete', failedStage: 'execution', execution, finding: null };
    const analysis = await analyzeRepository(record, { env, execution, signal: auditSignal });
    return { status: execution.status, execution, model: analysis.model,
      finding: { ...analysis.finding, evidence: { ...analysis.finding.evidence, execution } } };
  } catch (error) {
    return { status: 'Incomplete', failedStage: execution ? 'analysis' : 'execution',
      error: String(error.message), execution, finding: null };
  } finally { lease.release(); }
}
