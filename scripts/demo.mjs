import { spawn } from "node:child_process";

let child;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}
async function run(command, args, env = process.env) {
  if (stopping) process.exit(130);
  await new Promise((resolve, reject) => {
    child = spawn(command, args, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}
try {
  await run("npm", ["ci"]);
  await run("npm", ["run", "build"]);
  await run(process.execPath, ["dist/server/index.js", "--production"], {
    ...process.env,
    APP_MODE: "mock",
    ENABLE_DEMO_FAULTS: "true",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "启动失败");
  process.exitCode = stopping ? 130 : 1;
}
