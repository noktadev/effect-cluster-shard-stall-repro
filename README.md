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

---

# Bug 2: HttpRunner route mismatch - POST returns 404

**Related issue:** [Effect-TS/effect#6155](https://github.com/Effect-TS/effect/issues/6155) (SocketRunner stall above is a separate bug in the same component)

## The bug

`HttpRunner.layerHttpOptions` registers RPC routes on `HttpRouter.Default` (old router), but `HttpRunner.layerHttp` serves via `HttpLayerRouter.serve()` which reads from `HttpLayerRouter.HttpRouter` (new router). These are different `Context.Tag` services, so POST `/` returns 404.

**Bug location:** `@effect/cluster@0.56.1` - `dist/esm/HttpRunner.js` line 92

```js
// BUGGY: uses layerProtocolHttp (registers on HttpRouter.Default)
export const layerHttpOptions = options =>
  RunnerServer.layerWithClients.pipe(
    Layer.provide(RpcServer.layerProtocolHttp(options))
  );

// This serves via HttpLayerRouter.serve (reads from HttpLayerRouter.HttpRouter)
export const layerHttp = HttpRouter.serve(layerHttpOptions({ path: "/" }))
  .pipe(Layer.provide(layerClientProtocolHttpDefault));
```

**Fix:** Change `layerProtocolHttp` to `layerProtocolHttpRouter`:

```js
// FIXED: uses layerProtocolHttpRouter (registers on HttpLayerRouter.HttpRouter)
export const layerHttpOptions = options =>
  RunnerServer.layerWithClients.pipe(
    Layer.provide(RpcServer.layerProtocolHttpRouter(options))
  );
```

## Reproduce (local Docker)

```bash
bun install

# Start PostgreSQL
bun run db:up

# Run 2 runners (buggy - POST / returns 404)
bun run start:http-buggy

# Probe the HTTP endpoints (in another terminal)
bun run start:probe
# Expected: POST / -> 200-ish (RPC handled)
# Actual: POST / -> 404 (route not found)
```

## Verify the fix

```bash
# Run 2 runners with the manual fix applied
bun run start:http-patched

# Crons should register and fire within 10s
```

## K8s reproduction (k3d)

The bug primarily manifests in multi-runner K8s deployments where runners must communicate via HTTP.

```bash
# Create local k3s cluster
k3d cluster create effect-cluster --config k3d-config.yaml

# Build and import runner image
docker build -t effect-cluster-runner:local .
k3d image import effect-cluster-runner:local -c effect-cluster

# Deploy PostgreSQL + 2 runner pods
kubectl apply -f k8s/

# Watch logs - runners start but inter-runner RPC fails
kubectl logs -l app=runner -f --tail=50 -n cluster-repro
```

## Files (HttpRunner repro)

| File | Description |
|------|-------------|
| `src/runner-http-buggy.ts` | Buggy runner using `HttpRunner.layerHttp` (POST / returns 404) |
| `src/runner-http-patched.ts` | Fixed runner using manual `layerProtocolHttpRouter` |
| `src/probe.ts` | Sends POST / to runners to verify the bug |
| `k3d-config.yaml` | Local k3s cluster config |
| `k8s/` | Kubernetes manifests for multi-runner deployment |
| `Dockerfile` | Runner container image |

## Cleanup

```bash
# Local Docker
bun run db:down

# k3d
k3d cluster delete effect-cluster
```
