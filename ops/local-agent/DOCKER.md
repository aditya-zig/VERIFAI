# Docker

Docker is documented here for M4 and later. It is not mandatory for M1/M2/M3.

## Install

See `SETUP.md` for OS-specific commands. After installation:

```bash
docker version
docker info
./ops/local-agent/scripts/check-docker.sh
```

## Inspect resource use

```bash
docker stats --no-stream
docker ps -a --filter 'name=verifiai'
```

## M4 limits

- one VERIFAI container/heavy engine at a time;
- <= 2 GB memory per task/container unless measured evidence justifies a change;
- <= 2 CPUs;
- never privileged mode;
- stop/remove task-owned resources on success, failure, cancellation, or timeout.

The local-agent cleanup script removes only containers carrying the kit ownership label. It does not delete containers just because their name contains `verifiai`.

Never automate destructive global commands such as:

```text
docker system prune -a
```
