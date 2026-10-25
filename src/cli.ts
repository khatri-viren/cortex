import { resolve } from "node:path";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (["mcp", "dev", "runtime:serve"].includes(command ?? "") && !args.some(arg => ["--help", "-h", "--check"].includes(arg))) {
    const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    const vault = value("--vault") ?? process.env.CORTEX_VAULT_ROOT ?? process.env.CLAUDE_PROJECT_DIR;
    if (!vault) throw new Error("A vault is required. Pass --vault <path> or set CORTEX_VAULT_ROOT.");
    const options = { workspaceRoot: value("--workspace") };
    if (command === "mcp") {
      const { runMcpBridge } = await import("./mcp/bridge.js");
      await runMcpBridge(resolve(vault), options);
    } else {
      const shared = await import("./core/shared-runtime.js");
      if (command === "runtime:serve") await shared.runSharedRuntime(resolve(vault), options);
      else await shared.runSharedApi(resolve(vault), Number(value("--port") ?? 4170), options);
    }
    return;
  }
  const { runCommands } = await import("./commands.js");
  await runCommands();
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
