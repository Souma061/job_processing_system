import dotenv from "dotenv";
import app from "./app.js";
import { initDb } from "./db.js";
import { startBullWorker } from "./worker.js";

dotenv.config();

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`Server is running on http://localhost:${PORT}`);

  // 1. Initialize schema and verify connection to Neon PostgreSQL
  await initDb();

  // 2. Start BullMQ worker process for this cluster node
  startBullWorker(`Worker-${PORT}`);
});
