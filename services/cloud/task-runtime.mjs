import {RuntimeIncompleteError} from '../runtime/contract.mjs';
import {analyzeRepository} from '../local-analysis.mjs';
import {selectCommand, executeCommand} from '../local-command.mjs';
import {LocalRepositoryService} from '../local-repository.mjs';

function providerEnv(env) {
  const copy = {...env};
  const secret = env.VERIFIAI_PROVIDER_API_KEY;
  if (!secret) return copy;
  const keyByProvider = {
    xkiro: 'XKIRO_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    'ollama-cloud': 'OLLAMA_API_KEY',
  };
  const target = keyByProvider[env.VERIFIAI_MODEL_PROVIDER || 'xkiro'];
  if (target) copy[target] = secret;
  return copy;
}

export class CloudTaskRuntimeProvider {
  name = 'cloud';

  constructor({
    repositories = new LocalRepositoryService(),
    analyze = analyzeRepository,
    select = selectCommand,
    execute = executeCommand,
    env = process.env,
  } = {}) {
    this.repositories = repositories;
    this.analyze = analyze;
    this.select = select;
    this.executeCommand = execute;
    this.env = providerEnv(env);
  }

  async repository(input, {signal} = {}) {
    const record = await this.repositories.clone(input.repositoryUrl, {signal});
    if (record.repository.commit !== input.repository?.commit) {
      await this.repositories.cleanup(record.id);
      throw new RuntimeIncompleteError(
        'clone',
        'Repository HEAD does not match the exact submitted commit; resubmit from the current exact commit',
        'RepositoryCommitChanged',
      );
    }
    return record;
  }

  async model(record, input, {run, signal} = {}) {
    return this.analyze(record, {
      env: this.env,
      signal,
      auditId: run.id,
    });
  }

  async execute(record, input, {signal} = {}) {
    const selected = input.command || await this.select(record.clone.workspacePath, record.files.items);
    const result = await this.executeCommand(record.clone.workspacePath, selected, {
      timeoutMs: Math.min(input.commandTimeoutMs || 10000, 119000),
      signal,
    });
    return {
      ...result,
      sandbox: {
        started: true,
        removed: true,
        engine: 'ecs-fargate',
        name: this.env.ECS_CONTAINER_METADATA_URI_V4 ? 'fargate-task' : 'cloud-task-fixture',
        network: 'awsvpc',
        privileged: false,
        dockerSocket: false,
      },
    };
  }

  async cleanup(record) {
    if (!record) return {status: 'Completed', repositoryRemoved: true, taskOwned: true};
    const removed = await this.repositories.cleanup(record.id);
    return {
      status: 'Completed',
      repositoryRemoved: removed !== false,
      taskOwned: true,
    };
  }
}
