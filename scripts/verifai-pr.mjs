#!/usr/bin/env node
/**
 * Thin, read-only PR candidate inspector.
 *
 * This only resolves immutable candidate identity through the public GitHub
 * API. It never starts verification, calls AWS, writes to GitHub or claims a
 * verdict. Auth is optional and read from the environment only.
 */

const usage = `Usage:
  node scripts/verifai-pr.mjs inspect --repository owner/repo --pr 123 --expected-head <sha>

Resolve a public same-repository PR's exact base/head identity and changed-file digest.
This command is read-only: it does not run checks, call AWS, write to GitHub or assert a verdict.

Optional environment (never printed):
  GITHUB_TOKEN or GH_TOKEN   Public GitHub API token, used only for api.github.com requests
`;

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage);
    process.exit(0);
  }

  const [command, ...rest] = argv;
  if (command !== 'inspect') throw new Error(`unknown command: ${command}`);

  const allowed = new Set(['repository', 'pr', 'expected-head']);
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    if (!allowed.has(name)) throw new Error(`unknown option: --${name}`);
    if (values.has(name)) throw new Error(`duplicate option: --${name}`);
    const value = separator === -1 ? rest[++index] : argument.slice(separator + 1);
    if (!value || (separator === -1 && value.startsWith('--'))) throw new Error(`missing value for --${name}`);
    values.set(name, value);
  }

  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`missing required option: --${name}`);
  }
  const prText = values.get('pr');
  if (!/^[1-9][0-9]*$/.test(prText) || !Number.isSafeInteger(Number(prText))) {
    throw new Error('--pr must be a positive integer');
  }

  return {
    repository: values.get('repository'),
    pullRequest: Number(prText),
    expectedHeadSha: values.get('expected-head'),
  };
}

function environmentToken() {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  return token || undefined;
}

function safeMessage(error, token) {
  const message = error instanceof Error ? error.message : 'unknown error';
  return token ? message.split(token).join('[redacted]') : message;
}

async function loadModules() {
  try {
    const [candidate, github] = await Promise.all([
      import('../dist/services/pr-verification/candidate.js'),
      import('../dist/packages/core/github/index.js'),
    ]);
    return { ...candidate, FetchGitHubTransport: github.FetchGitHubTransport };
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('compiled modules are missing; run "npm run build" first');
    }
    throw error;
  }
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const token = environmentToken();
  const modules = await loadModules();
  const candidate = await modules.resolveCandidate(input, new modules.FetchGitHubTransport(), { token });
  process.stdout.write(`${JSON.stringify({
    candidate,
    execution: {
      state: 'pending',
      runtimeChecksExecuted: false,
      detail: 'Candidate identity resolved only. No runtime verification was executed and no verdict is asserted.',
    },
    verdict: null,
  }, null, 2)}\n`);
}

main().catch((error) => {
  const token = environmentToken();
  if (error?.name === 'CandidateResolutionError') {
    process.stderr.write(`Candidate resolution rejected [${error.code}]: ${safeMessage(error, token)}\n`);
  } else {
    process.stderr.write(`Candidate resolution failed: ${safeMessage(error, token)}\n`);
  }
  process.exitCode = 1;
});
