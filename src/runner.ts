/**
 * Minimal reproduction: @effect/cluster shard acquisition stall
 *
 * Expected: Runner starts, acquires shards, registers ClusterCron, prints "tick" every 10s.
 * Actual: Runner logs "Shard acquisition loop" / "RunnerStorage sync" forever, never registers crons.
 *
 * Steps:
 *   1. bun run db:up
 *   2. bun run start          # single runner - may or may not stall
 *   3. bun run start:two      # two runners - always stalls
 *
 * Environment:
 *   - Bun 1.3.x
 *   - PostgreSQL 17 (via docker-compose)
 *   - @effect/cluster 0.56.1, effect 3.19.15
 */
import { ClusterCron, ClusterWorkflowEngine } from "@effect/cluster";
import { BunClusterSocket, BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Cron, Duration, Effect, Either, Layer, Redacted } from "effect";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";

// ---------------------------------------------------------------------------
// 1. Minimal ClusterCron - just logs "tick" every 10 seconds
// ---------------------------------------------------------------------------

const TickCron = ClusterCron.make({
    name: "TickCron",
    cron: Cron.parse("*/10 * * * * *").pipe(Either.getOrThrow),
    execute: Effect.gen(function* () {
        yield* Effect.log("tick - cron is running!");
    }),
});

// ---------------------------------------------------------------------------
// 2. PostgreSQL connection (provides SqlClient for cluster storage)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:25432/cluster_test";

const PgLive = PgClient.layer({
    url: Redacted.make(DATABASE_URL),
});

// ---------------------------------------------------------------------------
// 3. Cluster runner with SQL storage
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 34431);

const RunnerLive = BunClusterSocket.layer({
    storage: "sql",
    shardingConfig: {
        shardsPerGroup: 300, // default
        refreshAssignmentsInterval: Duration.seconds(3),
    },
});

// ---------------------------------------------------------------------------
// 4. Layer composition (matches production setup)
// ---------------------------------------------------------------------------

const EnvLayer = Layer.mergeAll(
    TickCron,
    ClusterWorkflowEngine.layer,
).pipe(
    Layer.provideMerge(RunnerLive),
    Layer.provideMerge(PgLive),
    Layer.provide(Logger.pretty),
    Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

// ---------------------------------------------------------------------------
// 5. Run
// ---------------------------------------------------------------------------

console.log(`Starting runner on port ${port}...`);
console.log(`DATABASE_URL: ${DATABASE_URL}`);
console.log(`Expected: "tick" logs every 10 seconds`);
console.log(`If you see only "Shard acquisition loop" / "RunnerStorage sync" - that's the bug.\n`);

Layer.launch(EnvLayer as unknown as Layer.Layer<never, any, never>).pipe(
    BunRuntime.runMain,
);
