import { parentPort,workerData} from "node:worker_threads"


console.log(`[Thread] Worker thread started for ${workerData.jobId}`);

// heavy cpu math running on a seperate OS core

const start = Date.now();
// Burn CPU on the main thread for 10000ms
while (Date.now() - start < 10000) {
  Math.sqrt(Math.random() * 1000000);
}

parentPort?.postMessage({ status: "completed", jobId: workerData.jobId });
