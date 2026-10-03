export type ModelProviderName = 'bedrock';

export interface ModelProviderProfile {
  provider: ModelProviderName;
  transport: 'bedrock-converse';
}

export const MODEL_PROVIDER_PROFILES: Readonly<Record<ModelProviderName, ModelProviderProfile>> = Object.freeze({
  bedrock: { provider: 'bedrock', transport: 'bedrock-converse' },
});

export interface ModelRunSelectionInput {
  provider?: ModelProviderName;
  modelId?: string;
  region?: string;
}

export interface ResolvedModelRunSelection {
  profileId: string;
  provider: ModelProviderName;
  modelId: string;
  region: string;
  transport: 'bedrock-converse';
  credentialSource: 'aws-default-chain';
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

export async function resolveModelRunSelection(
  input: ModelRunSelectionInput = {},
  options: { env?: Record<string, string | undefined> } = {},
): Promise<ResolvedModelRunSelection> {
  const env = options.env ?? process.env;
  const provider = input.provider ?? env.VERIFIAI_MODEL_PROVIDER ?? 'bedrock';
  if (provider !== 'bedrock') throw new Error('Unsupported model provider: use AWS Bedrock');
  if (['VERIFIAI_MODEL_BASE_URL', 'VERIFIAI_MODEL_SECRET_ID', 'VERIFIAI_MODEL_SECRET_FIELD', 'VERIFIAI_AGENT_HARNESS'].some((name) => env[name])) {
    throw new Error('AWS Bedrock uses the AWS SDK; remove retired model configuration');
  }
  const modelId = required(input.modelId ?? env.VERIFIAI_BEDROCK_MODEL_ID ?? env.VERIFIAI_MODEL_ID, 'VERIFIAI_BEDROCK_MODEL_ID or VERIFIAI_MODEL_ID');
  const region = required(input.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION, 'AWS_REGION or AWS_DEFAULT_REGION');
  const secrets = [
    env.AWS_ACCESS_KEY_ID, env.AWS_BEARER_TOKEN_BEDROCK,
    ...Object.entries(env).filter(([name]) => /(?:^|_)(?:KEY|TOKEN|SECRET)$/.test(name)).map(([, value]) => value),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.:\-]{0,2047}$/.test(modelId) || modelId.includes('://')
    || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)
    || secrets.some((value) => modelId.includes(value) || region.includes(value))) {
    throw new Error('Invalid Bedrock model configuration');
  }
  // BedrockModel resolves credentials at invocation through the AWS SDK default
  // chain, including the AgentCore execution role. Never resolve or serialize keys.
  return { profileId: `bedrock:${modelId}`, provider, modelId, region, transport: 'bedrock-converse', credentialSource: 'aws-default-chain' };
}

export function publicModelRunSelection(selection: ResolvedModelRunSelection): ResolvedModelRunSelection {
  return { ...selection };
}

export function redactProviderSecrets(value: unknown, secrets: readonly string[] = []): unknown {
  const explicit = secrets.filter(Boolean);
  const visit = (input: unknown, key = ''): unknown => {
    if (typeof input === 'string') {
      let out = input;
      for (const secret of explicit) out = out.split(secret).join('[REDACTED]');
      if (/(api[_-]?key|access[_-]?key|secret|token|authorization|credential)/i.test(key)) return '[REDACTED]';
      return out;
    }
    if (Array.isArray(input)) return input.map((item) => visit(item, key));
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, visit(v, k)]));
    }
    return input;
  };
  return visit(value);
}
