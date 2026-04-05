/**
 * Test SingleRunner with SQL storage (no socket transport).
 * If this works, the shard stall is in the socket transport layer.
 * If this also stalls, the bug is in the SQL storage / shard state machine.
 */
import { ClusterCron, ClusterWorkflowEngine, SingleRunner } from "@effect/cluster";
import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Cron, Effect, Either, Layer, Redacted } from "effect";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";

// 1. Minimal cron
const TickCron = ClusterCron.make({
    name: "TickCron",
    cron: Cron.parse("*/10 * * * * *").pipe(Either.getOrThrow),
    execute: Effect.log("tick - cron is running!"),
});

// 2. PostgreSQL
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:25432/cluster_test";
const PgLive = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

// 3. SingleRunner with SQL storage (same SQL backend, no socket transport)
const RunnerLive = ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({ runnerStorage: "sql" })),
);

// 4. Stack
const EnvLayer = Layer.mergeAll(TickCron).pipe(
    Layer.provideMerge(RunnerLive),
    Layer.provideMerge(PgLive),
    Layer.provide(Logger.pretty),
    Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

console.log(`Starting SingleRunner with SQL storage...`);
console.log(`If you see "tick" logs - SQL storage works, bug is in SocketRunner transport.\n`);

Layer.launch(EnvLayer as unknown as Layer.Layer<never, any, never>).pipe(BunRuntime.runMain);
