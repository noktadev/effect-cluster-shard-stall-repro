/**
 * Probe script: sends POST / to each runner to verify the route mismatch.
 *
 * Expected behavior: POST / should be handled by the RPC server.
 * Actual behavior: POST / returns 404 because the route is registered on
 * HttpRouter.Default but served via HttpLayerRouter.HttpRouter.
 *
 * Usage:
 *   bun run start:two       # in another terminal
 *   bun run src/probe.ts    # run this
 */

const ports = [34431, 34432];

async function probe() {
  console.log("Probing runner HTTP endpoints...\n");

  for (const port of ports) {
    const url = `http://localhost:${port}/`;

    // Test POST / (the RPC endpoint)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array([]),
      });
      console.log(`POST ${url} -> ${res.status} ${res.statusText}`);
      if (res.status === 404) {
        console.log(
          `  ^ BUG: route not found. layerProtocolHttp registered on wrong router.\n`,
        );
      } else {
        console.log(`  ^ Route found (status ${res.status}).\n`);
      }
    } catch (e: any) {
      console.log(`POST ${url} -> ERROR: ${e.message}\n`);
    }

    // Test GET / (should also 404 - no GET route registered)
    try {
      const res = await fetch(url, { method: "GET" });
      console.log(`GET  ${url} -> ${res.status} ${res.statusText}`);
    } catch (e: any) {
      console.log(`GET  ${url} -> ERROR: ${e.message}`);
    }

    console.log("---");
  }

  console.log("\nIf POST / returns 404, the bug is confirmed.");
  console.log("Routes are registered on HttpRouter.Default (old router)");
  console.log(
    "but HttpLayerRouter.serve() reads from HttpLayerRouter.HttpRouter (new router).",
  );
  console.log(
    "\nFix: HttpRunner.js line 92 should use RpcServer.layerProtocolHttpRouter instead of RpcServer.layerProtocolHttp",
  );
}

probe();
