import dotenv from "dotenv";
import app from "./app.js";
import { initDb } from "./db.js";
import { startBullWorker } from "./worker.js";
import {
  prewarmMetricsCache,
  startMetricsRefresher,
} from "./services/metrics-refresher.js";
import { logger } from "./logger.js";

dotenv.config();

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  try {
    // 1. Initialize schema and verify connection to Neon PostgreSQL
    await initDb();

    // 2. Point 5: Cold Start Hydration - Pre-warm metrics cache before traffic arrives
    await prewarmMetricsCache();

    // 3. Start self-scheduling background metrics refresher (Points 2, 3 & 4)
    startMetricsRefresher();

    // 4. Start BullMQ worker process for this cluster node
    startBullWorker(`Worker-${PORT}`);

    // 5. Start listening for incoming HTTP connections
    app.listen(PORT, () => {
      logger.info(
        "SERVER",
        `Server running on http://localhost:${PORT} [PID: ${process.pid}]`,
      );
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (err: any) {
    logger.error("SERVER", `Bootstrap failure: ${err.message}`, { error: err });
    process.exit(1);
  }
}

bootstrap();
