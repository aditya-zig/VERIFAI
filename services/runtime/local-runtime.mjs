import {analyzeRepository} from '../local-analysis.mjs';
import {selectCommand} from '../local-command.mjs';
import {executeSandbox} from '../local-sandbox.mjs';

export class LocalRuntimeProvider {
  name = 'local';

  constructor({
    repositories,
    analyze = analyzeRepository,
    select = selectCommand,
    execute = executeSandbox,
    browser,
    specialist,
    repair,
    artifact,
    pullRequest,
    env = process.env,
  } = {}) {
    if (!repositories || typeof repositories.clone !== 'function' || typeof repositories.cleanup !== 'function') {
      throw new Error('LocalRuntimeProvider requires repository clone/cleanup service');
    }
    this.repositories = repositories;
    this.analyze = analyze;
    this.select = select;
    this.executeCommand = execute;
    this.browserOperation = browser;
    this.specialistOperation = specialist;
    this.repairOperation = repair;
    this.artifactOperation = artifact;
    this.pullRequestOperation = pullRequest;
    this.env = env;
  }

  async repository(input, {signal} = {}) {
    return this.repositories.clone(input.repositoryUrl, {signal});
  }

  async model(record, input, {run, signal} = {}) {
    return this.analyze(record, {env: this.env, signal, auditId: run.id, execution: input.execution});
  }

  async execute(record, input, {signal} = {}) {
    const command = input.command || await this.select(record.clone.workspacePath, record.files.items);
    const result = await this.executeCommand(record.clone.workspacePath, command, {
      timeoutMs: input.timeoutMs,
      signal,
    });
    return {
      ...result,
      command: result.command || [command.executable, ...(command.args || [])].join(' '),
    };
  }

  async browser(record, input, context) {
    if (!this.browserOperation) return {status: 'Incomplete', error: 'browser operation not configured'};
    return this.browserOperation(record, input, context);
  }

  async specialist(record, input, context) {
    if (!this.specialistOperation) return {status: 'Incomplete', error: 'specialist operation not configured'};
    return this.specialistOperation(record, input, context);
  }

  async repair(record, input, context) {
    if (!this.repairOperation) return {verdict: 'RejectedRepair', reason: 'repair operation not configured'};
    return this.repairOperation(record, input, context);
  }

  async artifact(record, input, context) {
    if (!this.artifactOperation) return null;
    return this.artifactOperation(record, input, context);
  }

  async pullRequest(record, input, context) {
    if (!this.pullRequestOperation) throw new Error('approval/PR operation not configured');
    return this.pullRequestOperation(record, input, context);
  }

  async cleanup(record) {
    if (!record) return {status: 'Completed', repositoryRemoved: true};
    const removed = await this.repositories.cleanup(record.id);
    return {status: 'Completed', repositoryRemoved: removed !== false};
  }
}
