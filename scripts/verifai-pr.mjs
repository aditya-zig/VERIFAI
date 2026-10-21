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
Each GitHub request is bounded by a 15 second timeout.

Optional environment (never printed):
  GITHUB_TOKEN or GH_TOKEN   Public GitHub API token, used only for api.github.com requests
`;

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
    const [candidate, github, cli] = await Promise.all([
      import('../dist/services/pr-verification/candidate.js'),
      import('../dist/packages/core/github/index.js'),
      import('../dist/services/pr-verification/cli.js'),
    ]);
    return {
      ...candidate,
      FetchGitHubTransport: github.FetchGitHubTransport,
      parseInspectArguments: cli.parseInspectArguments,
      formatInspectionResult: cli.formatInspectionResult,
      INSPECTION_REQUEST_TIMEOUT_MS: cli.INSPECTION_REQUEST_TIMEOUT_MS,
    };
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('compiled modules are missing; run "npm run build" first');
    }
    throw error;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage);
    return;
  }

  const modules = await loadModules();
  const input = modules.parseInspectArguments(argv);
  const token = environmentToken();
  const transport = new modules.FetchGitHubTransport({ timeoutMs: modules.INSPECTION_REQUEST_TIMEOUT_MS });
  const candidate = await modules.resolveCandidate(input, transport, { token });
  process.stdout.write(`${JSON.stringify(modules.formatInspectionResult(candidate), null, 2)}\n`);
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
