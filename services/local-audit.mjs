import { selectCommand } from './local-command.mjs';
import { executeSandbox } from './local-sandbox.mjs';
import { analyzeRepository } from './local-analysis.mjs';

let busy = false;
let activeController;
export function abortActiveAudit() { activeController?.abort(new Error('Server stopping')); }

export async function auditRepository(record, { timeoutMs = 10_000, env = process.env, signal } = {}) {
  if (busy) {
    const error = new Error('Busy: one local command audit is already running');
    error.statusCode = 429;
    throw error;
  }
  busy = true;
  activeController = new AbortController();
  const auditSignal = signal ? AbortSignal.any([signal, activeController.signal]) : activeController.signal;
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
  } finally { busy = false; activeController = undefined; }
}
