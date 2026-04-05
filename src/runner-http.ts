/**
 * Multi-runner test using HttpRunner (HTTP transport instead of TCP sockets).
 *
 * Run two instances:
 *   HOST=localhost PORT=34431 bun run src/runner-http.ts
 *   HOST=localhost PORT=34432 bun run src/runner-http.ts
 */
import {
    ClusterCron,
    ClusterWorkflowEngine,
    HttpRunner,
    SqlMessageStorage,
    SqlRunnerStorage,
    ShardingConfig,
    RunnerHealth,
    Runners,
} from "@effect/cluster";
import { FetchHttpClient } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { RpcSerialization } from "@effect/rpc";
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

// 3. HTTP runner - flat pipe chain (same pattern as BunClusterSocket source)
const port = Number(process.env.PORT ?? 34431);

const clientProtocol = HttpRunner.layerClientProtocolHttpDefault.pipe(
    Layer.provide(RpcSerialization.layerMsgPack),
    Layer.provide(FetchHttpClient.layer),
);

const health = RunnerHealth.layerPing.pipe(
    Layer.provide(Runners.layerRpc),
    Layer.provide(clientProtocol),
);

// Flat pipe: each Layer.provide satisfies one requirement of layerHttp
const RunnerLive = HttpRunner.layerHttp.pipe(
    Layer.provide(health),
    Layer.provide(clientProtocol),
    Layer.provideMerge(Layer.orDie(SqlMessageStorage.layer)),
    Layer.provide(Layer.orDie(SqlRunnerStorage.layer)),
    Layer.provide(ShardingConfig.layerFromEnv()),
    Layer.provide(RpcSerialization.layerMsgPack),
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
    Layer.provide(Logger.minimumLogLevel(LogLevel.Info)),
);

console.log(`Starting HTTP runner on port ${port}...`);

Layer.launch(EnvLayer as unknown as Layer.Layer<never, any, never>).pipe(BunRuntime.runMain);
