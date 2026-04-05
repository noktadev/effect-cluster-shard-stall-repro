/**
 * Patched runner: demonstrates the fix by monkey-patching HttpRunner.layerHttpOptions
 * to use RpcServer.layerProtocolHttpRouter instead of RpcServer.layerProtocolHttp.
 *
 * This file uses the same setup as runner-http-buggy.ts but constructs the layer manually
 * to work around the bug. If this version works (inter-runner RPC succeeds)
 * while runner-http-buggy.ts doesn't, the bug is confirmed.
 *
 * Run:
 *   bun run db:up
 *   concurrently 'HOST=localhost PORT=34431 bun run src/runner-http-patched.ts' \
 *                 'HOST=localhost PORT=34432 bun run src/runner-http-patched.ts'
 */
import {
  ClusterCron,
  ClusterWorkflowEngine,
  HttpRunner,
  RunnerServer,
  SqlMessageStorage,
  SqlRunnerStorage,
  ShardingConfig,
  RunnerHealth,
  Runners,
} from "@effect/cluster";
import { FetchHttpClient, HttpLayerRouter } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { PgClient } from "@effect/sql-pg";
import { Cron, Effect, Either, Layer, Redacted } from "effect";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";

// Same cron as runner-http-buggy.ts
const TickCron = ClusterCron.make({
  name: "TickCron",
  cron: Cron.parse("*/10 * * * * *").pipe(Either.getOrThrow),
  execute: Effect.log("tick - cron is running! (PATCHED)"),
});

// Same PostgreSQL
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:25432/cluster_test";
const PgLive = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

const port = Number(process.env.PORT ?? 34431);

console.log(`[runner-patched] Starting on port ${port}`);

// Client protocol (same as runner-http-buggy.ts)
const clientProtocol = HttpRunner.layerClientProtocolHttpDefault.pipe(
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(FetchHttpClient.layer),
);

const health = RunnerHealth.layerPing.pipe(
  Layer.provide(Runners.layerRpc),
  Layer.provide(clientProtocol),
);

// --------------------------------------------------------------------------
// THE FIX: manually construct layerHttpOptions using layerProtocolHttpRouter
// instead of layerProtocolHttp.
//
// Original (buggy):
//   RunnerServer.layerWithClients.pipe(
//     Layer.provide(RpcServer.layerProtocolHttp({ path: "/" }))
//   )
//
// Fixed:
//   RunnerServer.layerWithClients.pipe(
//     Layer.provide(RpcServer.layerProtocolHttpRouter({ path: "/" }))
//   )
// --------------------------------------------------------------------------

const layerHttpOptionsFixed = RunnerServer.layerWithClients.pipe(
  Layer.provide(RpcServer.layerProtocolHttpRouter({ path: "/" })),
);

// Reconstruct layerHttp using the fixed options layer
const RunnerLive = HttpLayerRouter.serve(layerHttpOptionsFixed).pipe(
  Layer.provide(HttpRunner.layerClientProtocolHttpDefault),
  Layer.provide(health),
  Layer.provide(clientProtocol),
  Layer.provideMerge(Layer.orDie(SqlMessageStorage.layer)),
  Layer.provide(Layer.orDie(SqlRunnerStorage.layer)),
  Layer.provide(ShardingConfig.layerFromEnv()),
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(BunHttpServer.layer({ port })),
);

// Full stack
const EnvLayer = Layer.mergeAll(TickCron, ClusterWorkflowEngine.layer).pipe(
  Layer.provideMerge(RunnerLive),
  Layer.provideMerge(PgLive),
  Layer.provide(Logger.pretty),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

console.log(`\nThis is the PATCHED runner using layerProtocolHttpRouter.`);
console.log(
  `If this works and runner-http-buggy.ts doesn't, the bug is confirmed.\n`,
);

Layer.launch(EnvLayer as unknown as Layer.Layer<never, any, never>).pipe(
  BunRuntime.runMain,
);
