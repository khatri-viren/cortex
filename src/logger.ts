import pino from "pino";

export const logger = pino({
  level: process.env.CORTEX_LOG_LEVEL ?? "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
  },
});
