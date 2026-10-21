#!/usr/bin/env node
import { runPrJobCommand } from '../services/pr-verification/client.mjs';

const redact = text => {
  const token = process.env.VERIFIAI_AGENT_TOKEN;
  for (const value of [token, token?.trim()].filter(Boolean)) text = text.split(value).join('[redacted]');
  return text;
};
try {
  const result = await runPrJobCommand(process.argv.slice(2));
  process.stdout.write(redact(result.help ?? `${JSON.stringify(result, null, 2)}\n`));
} catch (error) {
  process.stderr.write(`${redact(String(error.message))}\n`);
  process.exitCode = 1;
}
