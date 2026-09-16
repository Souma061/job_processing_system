import { Queue } from "bullmq";
import dotenv from "dotenv";

dotenv.config();

// redis connection options

export const redisConnection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
};

//define the name of the shared queue
export const IMAGE_QUEUE_NAME = "image-processing-queue";

// producer: create a new queue instance for enqueuing jobs
export const imageQueue = new Queue(IMAGE_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // retry failed jobs up to 3 times
    backoff: {
      type: "exponential",
      delay: 2000, // initial delay of 2 seconds for retries
    },
    removeOnComplete: false, //keep in Redis so RedisInsight can show the completed jobs
    removeOnFail: false, //keep in Redis so RedisInsight can show the failed jobs
  },
});
