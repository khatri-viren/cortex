import pino from "pino";

export function loggerOptions(packaged = process.env.CORTEX_PACKAGED === "1") {
  const options: Parameters<typeof pino>[0] = {
    level: process.env.CORTEX_LOG_LEVEL ?? "info",
  };
  if (!packaged) {
    // MCP stdio reserves stdout for protocol frames. Detect the command at
    // module-load time because the logger is constructed before the CLI
    // dispatches to runMcpServer. The explicit environment flag also covers
    // embedders that invoke the server without the CLI command token.
    const mcpStdio = process.env.CORTEX_MCP_STDIO === "1"
      || (process.argv.includes("mcp") && !process.argv.includes("--check"));
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
        ...(mcpStdio ? { destination: 2 } : {}),
      },
    };
  }
  return options;
}

function mcpStdioRequested(): boolean {
  return process.env.CORTEX_MCP_STDIO === "1"
    || (process.argv.includes("mcp") && !process.argv.includes("--check"));
}

const mcpStdio = mcpStdioRequested();
const options = loggerOptions();

// Packaged Pino has no pretty transport, so give MCP an explicit stderr
// destination. In development the pretty transport receives destination: 2
// from loggerOptions above. In both modes stdout remains protocol-only.
export const logger = process.env.CORTEX_PACKAGED === "1" && mcpStdio
  ? pino(options, pino.destination(2))
  : pino(options);
