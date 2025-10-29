
import pino from "pino";
import env from "./env";

let transport: { target: string; options: { colorize: boolean } } | undefined = undefined;
if (!env.isProduction) {
  try {
    // pino-pretty is optional
    require.resolve("pino-pretty");
    transport = { target: "pino-pretty", options: { colorize: true } };
  } catch {
    // optional pretty logging dependency not installed
  }
}

const logger = pino({
  level: env.LOG_LEVEL,
  ...(transport ? { transport } : {}),
});

export default logger;
