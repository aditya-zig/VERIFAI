import { selectCommand, executeCommand } from './local-command.mjs';
import { analyzeRepository } from './local-analysis.mjs';

let busy = false;

export async function auditRepository(record, { timeoutMs = 10_000, env = process.env } = {}) {
  if (busy) {
    const error = new Error('Busy: one local command audit is already running');
    error.statusCode = 429;
    throw error;
  }
  busy = true;
  let execution;
  try {
    const command = await selectCommand(record.clone.workspacePath, record.files.items);
    execution = await executeCommand(record.clone.workspacePath, command, { timeoutMs });
    if (execution.status === 'Incomplete') return { status: 'Incomplete', failedStage: 'execution', execution, finding: null };
    const analysis = await analyzeRepository(record, { env, execution });
    return { status: execution.status, execution, model: analysis.model,
      finding: { ...analysis.finding, evidence: { ...analysis.finding.evidence, execution } } };
  } catch (error) {
    return { status: 'Incomplete', failedStage: execution ? 'analysis' : 'execution',
      error: String(error.message), execution, finding: null };
  } finally { busy = false; }
}
