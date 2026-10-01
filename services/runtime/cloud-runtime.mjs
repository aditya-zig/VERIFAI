export class CloudRuntime {
  name = 'cloud';

  constructor(controlPlane) {
    if (!controlPlane || typeof controlPlane.start !== 'function' || typeof controlPlane.refresh !== 'function') {
      throw new Error('CloudRuntime requires an AWS cloud control plane');
    }
    this.controlPlane = controlPlane;
  }

  async start(job) {
    return this.controlPlane.start(job);
  }

  async get(runId) {
    return this.controlPlane.refresh(runId);
  }

  async cancel(runId, options) {
    return this.controlPlane.cancel(runId, options);
  }

  async reap(runId, options) {
    return this.controlPlane.reap(runId, options);
  }
}
