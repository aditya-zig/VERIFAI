// Finding/evidence ownership: one deep owner for claim-to-check meaning.
// Model text stays unchanged as hypothesis/opinion. Executed evidence attaches
// structurally with exact provenance. A single bounded command never confirms
// an arbitrary allegation, and never claims test/security/compatibility breadth.

export function isExecutedFailure(execution) {
  if (!execution || typeof execution !== 'object') return false;
  if (execution.timedOut === true || execution.aborted === true) return false;
  if (execution.executed === false) return false;
  if (typeof execution.command !== 'string' || !execution.command.trim()) return false;
  if (execution.status !== 'Failed') return false;
  if (execution.sandbox?.started !== true) return false;
  if (!Number.isInteger(execution.exitCode) || execution.exitCode === 0) return false;
  return true;
}

function isConsistentExecution(execution) {
  if (!execution || typeof execution !== 'object') return false;
  const { status, exitCode, timedOut, aborted } = execution;
  if (timedOut === true || aborted === true) return status === 'Incomplete';
  if (status === 'Completed') return exitCode === 0;
  if (status === 'Failed') return Number.isInteger(exitCode) && exitCode !== 0;
  if (status === 'Incomplete') return true;
  return false;
}

export function describeCheckScope(selectedCommand, execution) {
  const command = typeof selectedCommand === 'string' ? selectedCommand : execution?.command || '(unknown command)';
  const source = execution?.source || '';
  const isReadme = /ls-files.*readme/i.test(command) || /tracked README/i.test(source);
  const isVersion = /node --version/.test(command);
  const isCheck = /node --check/.test(command);
  const kind = isReadme ? 'tracked README presence check' : isVersion ? 'runtime version check' : isCheck ? 'single-file syntax check' : 'single bounded command';
  return `limited-check: ${kind} (${command}) — not a test suite, not security verification, not compatibility proof${source ? ` · source: ${source}` : ''}`;
}

export function describeRegressionCoverage({ count = 0, command = '' } = {}) {
  const label = `SAME-COMMAND REPLAY / limited coverage — ${count} replay check(s) of the same bounded command${command ? ` (${command})` : ''}, not independent regression breadth`;
  return { kind: 'same-command-replay', count, command, label };
}

export function composeFinding({ modelFinding, execution, selectedCommand, repository, auditId } = {}) {
  const title = modelFinding?.title || '(untitled model hypothesis)';
  const description = modelFinding?.description || '';
  const severity = modelFinding?.severity || 'info';
  const file = modelFinding?.evidence?.file || modelFinding?.file || '(unknown)';
  const command = typeof selectedCommand === 'string' ? selectedCommand : execution?.command;
  const scope = describeCheckScope(selectedCommand, execution);

  const provenance = {
    auditId: auditId || null,
    commit: repository?.commit || null,
    repository: repository?.fullName || null,
    command: command || null,
    source: execution?.source || null,
  };

  let findingState = 'Unknown';
  let reason = 'no executed check';
  let canAdmitRepair = false;

  if (!execution || typeof execution !== 'object') {
    findingState = 'Unknown';
    reason = 'missing execution evidence';
  } else if (execution.status === 'Incomplete' || execution.timedOut === true || execution.aborted === true) {
    findingState = 'Incomplete';
    reason = execution.timedOut ? 'bounded command timed out' : execution.aborted ? 'bounded command aborted' : 'bounded command did not complete';
  } else if (execution.executed === false) {
    findingState = 'Incomplete';
    reason = 'command was not executed; no executed check';
  } else if (execution.sandbox?.started !== true) {
    findingState = 'Incomplete';
    reason = 'sandbox did not start; no executed check';
  } else if (!Number.isInteger(execution?.exitCode)) {
    findingState = 'Incomplete';
    reason = 'non-integer or missing exit code; no executed outcome';
  } else if (!isConsistentExecution(execution)) {
    findingState = 'Incomplete';
    reason = 'inconsistent execution facts (status/exit mismatch)';
  } else if (typeof command === 'string' && command.length > 0 && execution.command !== command) {
    findingState = 'Incomplete';
    reason = !execution.command ? 'executed command is missing; re-verification required' : 'selected command differs from executed command; re-verification required';
  } else {
    // A single bounded command, pass or fail, never confirms the model allegation.
    findingState = 'Unconfirmed';
    reason = 'single limited check cannot confirm the model allegation';
    canAdmitRepair = isExecutedFailure(execution);
    if (!canAdmitRepair) {
      reason = execution.exitCode === 0
        ? 'limited check passed; allegation remains Unconfirmed and admits no repair'
        : 'limited check outcome does not meet strict repair predicate';
    } else {
      reason = 'executed command failure is verified as a repair target; model allegation remains Unconfirmed';
    }
  }

  const executedCheck = execution && typeof execution === 'object' ? {
    command: execution.command || command || null,
    source: execution.source || null,
    status: execution.status || 'Incomplete',
    exitCode: Number.isInteger(execution.exitCode) ? execution.exitCode : null,
    stdout: typeof execution.stdout === 'string' ? execution.stdout.slice(-8192) : undefined,
    stderr: typeof execution.stderr === 'string' ? execution.stderr.slice(-8192) : undefined,
    durationMs: typeof execution.durationMs === 'number' ? execution.durationMs : undefined,
    sandboxStarted: execution.sandbox?.started === true,
    scope,
  } : { command: command || null, status: 'Incomplete', exitCode: null, scope };

  const verifiedTarget = canAdmitRepair ? {
    kind: 'executed-command-failure',
    command: execution.command,
    exitCode: execution.exitCode,
    status: execution.status,
    sandboxStarted: true,
    provenance: { ...provenance, label: 'verified-repair-target' },
  } : null;

  return {
    title,
    description,
    severity,
    evidence: {
      file,
      execution: execution || null,
      selectedCommand: command || null,
      provenance,
    },
    hypothesis: {
      kind: 'model-hypothesis',
      title,
      description,
      severity,
      confidence: 'Unconfirmed',
      note: 'Model text is opinion, not verification. Executed evidence decides verdicts.',
    },
    executedCheck,
    assessment: {
      findingState,
      confidence: 'Unconfirmed',
      scope,
      coverage: { kind: 'single-command', label: 'single bounded command; not a suite' },
      canAdmitRepair,
      reason,
    },
    verifiedTarget,
  };
}

export function repairAdmissionForAudit(audit) {
  const execution = audit?.execution;
  const selectedCommand = audit?.selectedCommand;
  if (typeof selectedCommand !== 'string' || !selectedCommand.trim()) {
    return { eligible: false, reason: 'exact selected command is required before repair' };
  }
  const composed = composeFinding({
    modelFinding: audit?.finding && audit.finding.title ? { title: audit.finding.title, severity: audit.finding.severity || 'info', description: typeof audit.finding.description === 'string' ? audit.finding.description : '', evidence: audit.finding.evidence } : { title: '(untitled)', severity: 'info', description: '', evidence: { file: '(unknown)' } },
    execution,
    selectedCommand,
    repository: audit?.repository,
    auditId: audit?.id,
  });
  if (!audit?.repository?.fullName || !audit?.repository?.commit) {
    return { eligible: false, reason: 'exact repository commit provenance required', composed };
  }
  if (!composed.assessment.canAdmitRepair) {
    return { eligible: false, reason: composed.assessment.reason, composed };
  }
  if (selectedCommand && execution?.command && selectedCommand !== execution.command) {
    return { eligible: false, reason: 'verification command changed; re-verification required', composed };
  }
  return { eligible: true, reason: composed.assessment.reason, composed, verifiedTarget: composed.verifiedTarget };
}
