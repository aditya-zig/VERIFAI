import type { CandidateRevision, PrVerificationRequest } from '../../packages/contracts/src/index.js';

/**
 * Bounded wait for one read-only GitHub request from the inspection CLI. The
 * transport aborts the underlying fetch when this elapses.
 */
export const INSPECTION_REQUEST_TIMEOUT_MS = 15_000;

export const INSPECTION_PENDING_DETAIL =
  'Candidate identity resolved only. No runtime verification was executed and no verdict is asserted.';

const inspectOptions = ['repository', 'pr', 'expected-head'] as const;

export interface InspectionOutput {
  candidate: CandidateRevision;
  execution: {
    state: 'pending';
    runtimeChecksExecuted: false;
    detail: string;
  };
  verdict: null;
}

/**
 * Parse `inspect` arguments into a verification request. This mirrors the CLI
 * contract without touching the network, so invocation errors stay testable.
 */
export function parseInspectArguments(argv: readonly string[]): PrVerificationRequest {
  const [command, ...rest] = argv;
  if (command !== 'inspect') {
    throw new Error(command === undefined ? 'missing command: inspect' : `unknown command: ${command}`);
  }

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    if (!(inspectOptions as readonly string[]).includes(name)) throw new Error(`unknown option: --${name}`);
    if (values.has(name)) throw new Error(`duplicate option: --${name}`);
    const value = separator === -1 ? rest[++index] : argument.slice(separator + 1);
    if (!value || (separator === -1 && value.startsWith('--'))) throw new Error(`missing value for --${name}`);
    values.set(name, value);
  }

  for (const name of inspectOptions) {
    if (!values.has(name)) throw new Error(`missing required option: --${name}`);
  }

  const prText = values.get('pr') as string;
  if (!/^[1-9][0-9]*$/.test(prText) || !Number.isSafeInteger(Number(prText))) {
    throw new Error('--pr must be a positive integer');
  }

  return {
    repository: values.get('repository') as string,
    pullRequest: Number(prText),
    expectedHeadSha: values.get('expected-head') as string,
  };
}

/**
 * Shape the CLI output. Resolution is intake only, so execution stays pending
 * and the verdict stays null by construction.
 */
export function formatInspectionResult(candidate: CandidateRevision): InspectionOutput {
  return {
    candidate,
    execution: {
      state: 'pending',
      runtimeChecksExecuted: false,
      detail: INSPECTION_PENDING_DETAIL,
    },
    verdict: null,
  };
}
