# @effect/cluster shard acquisition stall reproduction

Minimal reproduction of a shard acquisition stall in `@effect/cluster` when using `BunClusterSocket.layer({ storage: "sql" })`.

## Bug

The runner registers in PostgreSQL and receives shard assignments, but never transitions to entity/cron registration. The shard acquisition loop runs indefinitely, logging `RunnerStorage sync` / `New shard assignments` without progressing.

## Expected behavior

Runner starts, acquires shards, registers `ClusterCron`, prints "tick" every 10 seconds.

## Actual behavior

Runner logs `Shard acquisition loop` / `RunnerStorage sync` forever. No crons register. No entities start.

## Environment

| Package | Version |
|---------|---------|
| effect | 3.19.15 |
| @effect/cluster | 0.56.1 |
| @effect/platform-bun | 0.87.1 |
| @effect/sql-pg | 0.50.1 |
| Bun | 1.3.x |
| PostgreSQL | 17 |

## Steps to reproduce

```bash
# 1. Start PostgreSQL
bun run db:up

# 2. Install dependencies
bun install

# 3. Run a single runner
bun run start

# 4. Wait 30+ seconds - observe logs
# Expected: "tick - cron is running!" every 10s
# Actual: endless "Shard acquisition loop" / "RunnerStorage sync"

# 5. (Optional) Try with 2 runners - stall is more consistent
bun run start:two
```

## Cleanup

```bash
# Clean PostgreSQL cluster state
bun run db:clean

# Stop PostgreSQL
bun run db:down
```

## Observations

- The runner registers in `cluster_runners` table (verified via psql)
- Shard assignments are received (visible in DEBUG logs)
- The runner never progresses past shard acquisition to entity registration
- Truncating `cluster_runners`, `cluster_messages`, `cluster_replies`, `cluster_locks` and restarting sometimes (but not always) resolves the stall
- Ghost runners accumulate in `cluster_runners` across restarts (no deregistration on shutdown)
- The stall occurs with both 1 and 2 runners
- `SingleRunner.layer({ runnerStorage: "memory" })` (in-process, no SQL) works fine

## Context

Discovered in production Kubernetes deployment with:
- `noktaapp-runner` pods using `BunClusterSocket.layer({ storage: "sql" })` 
- PostgreSQL for cluster state
- Durable-streams for workflow execution (separate from cluster coordination)
- Multiple pod restarts accumulating ghost entries in `cluster_runners`
