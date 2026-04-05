/**
 * Minimal reproduction: @effect/cluster HttpRunner route mismatch
 *
 * BUG: `HttpRunner.layerHttpOptions` calls `RpcServer.layerProtocolHttp(options)`
 * which registers routes on `HttpRouter.Default` (from @effect/platform/HttpRouter).
 * But `HttpRunner.layerHttp` serves the app via `HttpLayerRouter.serve()` which
 * creates its own `HttpLayerRouter.HttpRouter` - a DIFFERENT service tag.
 *
 * Result: POST / returns 404 because the route handler is registered on
 * HttpRouter.Default but the HTTP server reads from HttpLayerRouter.HttpRouter.
 *
 * This works locally with a single runner (no inter-runner RPC needed), but
 * fails in multi-runner K8s deployments where runners must communicate via HTTP.
 *
 * Run:
 *   bun run db:up
 *   bun run start:two    # starts 2 runners
 *   bun run start:probe  # sends POST / to each runner - expect 404
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
import { RpcSerialization } from "@effect/rpc";
import { PgClient } from "@effect/sql-pg";
import { Cron, Effect, Either, Layer, Redacted } from "effect";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";

// ---------------------------------------------------------------------------
// 1. Minimal ClusterCron - just logs "tick" every 10 seconds
// ---------------------------------------------------------------------------

const TickCron = ClusterCron.make({
  name: "TickCron",
  cron: Cron.parse("*/10 * * * * *").pipe(Either.getOrThrow),
  execute: Effect.log("tick - cron is running!"),
});

// ---------------------------------------------------------------------------
// 2. PostgreSQL connection
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:25432/cluster_test";

const PgLive = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

// ---------------------------------------------------------------------------
// 3. HttpRunner setup (contains the bug)
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 34431);
const host = process.env.HOST ?? "localhost";

console.log(`[runner] Starting on ${host}:${port}`);
console.log(`[runner] DATABASE_URL: ${DATABASE_URL}`);

// Client protocol: how runners talk to each other
const clientProtocol = HttpRunner.layerClientProtocolHttpDefault.pipe(
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(FetchHttpClient.layer),
);

const health = RunnerHealth.layerPing.pipe(
  Layer.provide(Runners.layerRpc),
  Layer.provide(clientProtocol),
);

// --------------------------------------------------------------------------
// THE BUG IS HERE (inside @effect/cluster):
//
//   HttpRunner.layerHttpOptions = (options) =>
//     RunnerServer.layerWithClients.pipe(
//       Layer.provide(RpcServer.layerProtocolHttp(options))  // <-- WRONG
//     )
//
//   RpcServer.layerProtocolHttp registers the POST route on HttpRouter.Default
//   (from @effect/platform/HttpRouter - the "old" router).
//
//   HttpRunner.layerHttp = HttpLayerRouter.serve(layerHttpOptions({ path: "/" }))
//
//   HttpLayerRouter.serve creates a NEW HttpLayerRouter.HttpRouter instance and
//   builds the HTTP server from that. It never reads from HttpRouter.Default.
//
//   So the route goes to the wrong router, and POST / returns 404.
//
// FIX: Change layerProtocolHttp -> layerProtocolHttpRouter in HttpRunner.js:92
//
//   HttpRunner.layerHttpOptions = (options) =>
//     RunnerServer.layerWithClients.pipe(
//       Layer.provide(RpcServer.layerProtocolHttpRouter(options))  // <-- FIXED
//     )
//
//   RpcServer.layerProtocolHttpRouter registers on HttpLayerRouter.HttpRouter,
//   which is the same service that HttpLayerRouter.serve reads from.
// --------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 4. Full layer stack
// ---------------------------------------------------------------------------

const EnvLayer = Layer.mergeAll(TickCron, ClusterWorkflowEngine.layer).pipe(
  Layer.provideMerge(RunnerLive),
  Layer.provideMerge(PgLive),
  Layer.provide(Logger.pretty),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

// ---------------------------------------------------------------------------
// 5. Run
// ---------------------------------------------------------------------------

console.log(`\nExpected: "tick" logs every 10s (works with 1 runner locally)`);
console.log(
  `Bug: with 2 runners, inter-runner POST / returns 404 (routes on wrong router)\n`,
);

Layer.launch(EnvLayer as unknown as Layer.Layer<never, any, never>).pipe(
  BunRuntime.runMain,
);
