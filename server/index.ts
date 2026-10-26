import express from "express";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import type { ViteDevServer } from "vite";
import { config } from "./config";
import { api, errorHandler } from "./routes";
import { cleanSessions } from "./session-store";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use("/api", api);
app.use(errorHandler);

const cleanup = setInterval(cleanSessions, 60_000);
cleanup.unref();

let vite: ViteDevServer | undefined;

if (config.production) {
  app.use(express.static(resolve("dist/client")));
  app.get("/", (_request, response): void => {
    response.sendFile(resolve("dist/client/index.html"));
  });
} else {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

const server = createHttpServer(app);
let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  let finalExitCode = exitCode;

  clearInterval(cleanup);
  server.close();
  server.closeAllConnections();

  try {
    // Vite owns a separate HMR socket which otherwise survives a failed bind.
    await vite?.close();
  } catch (error) {
    console.error("Development server cleanup failed", error);
    finalExitCode = 1;
  }

  process.exit(finalExitCode);
}

server.once("error", (error): void => {
  console.error(error.message);
  void shutdown(1);
});

// Node's listening callback runs only on success. Express 5 also invokes its
// app.listen callback on errors, which previously printed a false ready message.
server.listen(config.PORT, "0.0.0.0", (): void => {
  console.info(
    `AFTER RAIN · http://localhost:${config.PORT} · ${config.APP_MODE}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (): void => {
    void shutdown(0);
  });
}
