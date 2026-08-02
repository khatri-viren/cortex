#!/usr/bin/env bun
const args = process.argv.slice(2);

const backend = Bun.spawn(["bun", "run", "src/cli.ts", "dev", ...args], {
  stdout: "inherit",
  stderr: "inherit",
});

const ui = Bun.spawn(["bun", "run", "dev"], {
  cwd: "ui",
  stdout: "inherit",
  stderr: "inherit",
});

function shutdown(): void {
  backend.kill();
  ui.kill();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

const exitCode = await Promise.race([backend.exited, ui.exited]);
shutdown();
process.exit(exitCode);
