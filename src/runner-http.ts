/**
 * Same reproduction but using HttpRunner instead of SocketRunner (BunClusterSocket).
 * If this works, the bug is in the TCP socket transport, not the shard state machine.
 */
import { ClusterCron, ClusterWorkflowEngine, HttpRunner, SqlMessageStorage, SqlRunnerStorage, ShardingConfig, RunnerHealth, Runners } from "@effect/cluster";
import { FetchHttpClient } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { RpcSerialization } from "@effect/rpc";
import { Cron, Duration, Effect, Either, Layer, Redacted } from "effect";
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

// 3. HTTP transport runner - mirror BunClusterSocket's internal composition
const port = Number(process.env.PORT ?? 34431);

// Build the same way BunClusterSocket does, but with HttpRunner instead of SocketRunner
const clientProtocol = HttpRunner.layerClientProtocolHttpDefault.pipe(
    Layer.provide(RpcSerialization.layerMsgpack),
    Layer.provide(FetchHttpClient.layer),
);

const runnerHealth = RunnerHealth.layerPing.pipe(
    Layer.provide(Runners.layerRpc),
    Layer.provide(clientProtocol),
);

const RunnerLive = HttpRunner.layerHttp.pipe(
    Layer.provide(runnerHealth),
    Layer.provideMerge(Layer.orDie(SqlMessageStorage.layer)),
    Layer.provide(Layer.orDie(SqlRunnerStorage.layer)),
    Layer.provide(ShardingConfig.layerFromEnv({
        shardsPerGroup: 300,
        refreshAssignmentsInterval: Duration.seconds(3),
    })),
    Layer.provide(clientProtocol),
    Layer.provide(RpcSerialization.layerMsgpack),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(BunHttpServer.layer({ port })),
);

// 4. Stack
const EnvLayer = Layer.mergeAll(
    TickCron,
    ClusterWorkflowEngine.layer,
).pipe(
    Layer.provideMerge(RunnerLive),
    Layer.provideMerge(PgLive),
    Layer.provide(Logger.pretty),
    Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

console.log(`Starting HTTP runner on port ${port}...`);
console.log(`If you see "tick" logs - HttpRunner works (bug is in SocketRunner).\n`);

Layer.launch(EnvLayer as unknown as Layer.Layer<never, any, never>).pipe(BunRuntime.runMain);
