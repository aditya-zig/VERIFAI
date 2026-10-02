# Docker

Docker is deferred to M4 (#10). It is not required for M1/M2/M3 work,
and nothing in LA0–LA5 builds images or pulls containers.

## Inspect only

```bash
docker version
docker info
./ops/local-agent/scripts/check-docker.sh
```

`check-docker.sh` is read-only and label-scoped. It reports status
informationally and never starts, stops, or removes anything.

## M4 limits (when the milestone arrives)

- one VERIFAI container/heavy engine at a time (8 GB machine);
- <= 2 GB memory and <= 2 CPUs per task/container unless measured
  evidence justifies a change;
- never privileged mode;
- stop/remove task-owned resources on success, failure,
  cancellation, or timeout.

## Cleanup bounds

`cleanup-local.sh` selects containers strictly by the exact ownership
label `dev.verifiai.local-agent.owner=<repo-id>`. It never selects by
name and never runs global destructive commands. These are forbidden:

```text
docker system prune -a
docker rm / docker stop / docker kill by name
docker volume / docker network prune or remove
```

When free disk is under 20 GB, doctor warns and M4 stays deferred.
Do not pull images to "fix" that.
