import pino from "pino";

export function loggerOptions(packaged = process.env.CORTEX_PACKAGED === "1") {
  const options: Parameters<typeof pino>[0] = {
    level: process.env.CORTEX_LOG_LEVEL ?? "info",
  };
  if (!packaged) {
    options.transport = {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
    };
  }
  return options;
}

export const logger = pino(loggerOptions());
