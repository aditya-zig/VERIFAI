import test from 'node:test';
import assert from 'node:assert/strict';
import { AwsTargetLifecycle, AwsTargetLifecycleError, buildArbitraryRepoBuildspec, type AwsTargetLifecycleConfig } from '../services/bootstrap/aws-target-lifecycle.js';

const config: AwsTargetLifecycleConfig = {
  region: 'us-west-2', codeBuildProject: 'build', ecrRepository: 'targets',
  ecrRegistry: 'example.registry', ecsCluster: 'cluster', taskDefinition: 'target',
  containerName: 'target', containerPort: 3000, subnetIds: [], securityGroupIds: [],
};
const request = {
  repoUrl: 'https://github.com/example/app', branch: 'main',
  commitSha: 'a'.repeat(40), imageTag: 'audit',
};

for (const dockerfile of [
  'Dockerfile; echo marker #', 'Dockerfile\necho marker', '../Dockerfile',
  'docker/../../Dockerfile', '/etc/passwd', './Dockerfile', 'docker//Dockerfile',
  '-Dockerfile', 'docker/../Dockerfile', 'Dockerfile\u0000', ' Dockerfile',
  'docker\\Dockerfile', 'docker/./Dockerfile', 'docker/Dockerfile ',
  'Dockerfile$(id)', "Dockerfile'", 'docker/', '',
]) {
  test(`rejects unsafe Dockerfile path ${JSON.stringify(dockerfile)} before any cloud call`, async () => {
    let calls = 0;
    const client = { async send() { calls++; throw new Error('cloud must not be called'); } };
    const lifecycle = new AwsTargetLifecycle(config, { codebuild: client, ecs: client, ecr: client, lambda: client });
    await assert.rejects(() => lifecycle.start({ ...request, dockerfile }), (error: unknown) => {
      if (!(error instanceof AwsTargetLifecycleError)) throw error;
      assert.equal(error.phase, 'build');
      assert.match(error.message, /Dockerfile path/);
      return true;
    });
    assert.equal(calls, 0);
  });
}

test('supports default and bounded nested Dockerfile paths', () => {
  assert.ok(buildArbitraryRepoBuildspec(request, config));
  assert.ok(buildArbitraryRepoBuildspec({ ...request, dockerfile: 'docker/api/Dockerfile.node-22' }, config));
});
