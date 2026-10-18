import pino from "pino";
import { NODE_ENV, isProduction } from "./config";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction() ? "info" : "debug"),
  base: { env: NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
