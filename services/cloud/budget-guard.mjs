export const DEFAULT_CLOUD_LIMITS = Object.freeze({
  maxRuntimeMs: 20 * 60 * 1000,
  maxModelCalls: 4,
  maxTaskCount: 1,
  maxRetries: 1,
  maxEstimatedSpendUsd: 2,
});

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function normalizeCloudLimits(value = {}) {
  return {
    maxRuntimeMs: positiveInteger(value.maxRuntimeMs, DEFAULT_CLOUD_LIMITS.maxRuntimeMs),
    maxModelCalls: positiveInteger(value.maxModelCalls, DEFAULT_CLOUD_LIMITS.maxModelCalls),
    maxTaskCount: positiveInteger(value.maxTaskCount, DEFAULT_CLOUD_LIMITS.maxTaskCount),
    maxRetries: positiveInteger(value.maxRetries, DEFAULT_CLOUD_LIMITS.maxRetries),
    maxEstimatedSpendUsd: Number.isFinite(value.maxEstimatedSpendUsd) && value.maxEstimatedSpendUsd >= 0
      ? value.maxEstimatedSpendUsd
      : DEFAULT_CLOUD_LIMITS.maxEstimatedSpendUsd,
  };
}

export function checkCloudBudget(request = {}, configured = {}) {
  const limits = normalizeCloudLimits(configured);
  const proposed = {
    runtimeMs: positiveInteger(request.runtimeMs, limits.maxRuntimeMs),
    modelCalls: positiveInteger(request.modelCalls, 1),
    taskCount: positiveInteger(request.taskCount, 1),
    retries: positiveInteger(request.retries, 0),
    estimatedSpendUsd: Number.isFinite(request.estimatedSpendUsd) && request.estimatedSpendUsd >= 0
      ? request.estimatedSpendUsd
      : null,
  };

  const violations = [];
  if (proposed.runtimeMs > limits.maxRuntimeMs) violations.push('max runtime');
  if (proposed.modelCalls > limits.maxModelCalls) violations.push('max model calls');
  if (proposed.taskCount > limits.maxTaskCount) violations.push('max task count');
  if (proposed.retries > limits.maxRetries) violations.push('max retries');
  if (proposed.estimatedSpendUsd !== null && proposed.estimatedSpendUsd > limits.maxEstimatedSpendUsd) {
    violations.push('max estimated spend');
  }

  return {
    ok: violations.length === 0,
    status: violations.length === 0 ? 'Allowed' : 'Incomplete',
    failureCode: violations.length === 0 ? undefined : 'BudgetLimit',
    violations,
    limits,
    proposed,
  };
}
