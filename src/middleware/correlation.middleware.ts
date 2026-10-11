// so the correlation id middleware is the bridge between incoming HTTP reqs and the async BullMQ jobs, allowing us to trace the entire lifecycle of a request through the system.

import { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { logger } from "../logger.js";

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // read existing header or generate a new correlation id
  const correlationId =
    (req.headers["x-correlation-id"] as string) ||
    `corr-${crypto.randomUUID()}`;

  // attach to req so downstream controllers can pass it to BullMq jobs
  req.correlationId = correlationId;

  //return it to the client in the response header
  res.setHeader("x-correlation-id", correlationId);

  //log incoming request with correlation id
  const startTime = Date.now();
  logger.info("HTTP", `--> ${req.method} ${req.originalUrl}`, {
    correlationId,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
  });
  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level](
      "HTTP",
      `<-- ${req.method} ${req.originalUrl} [${res.statusCode}]`,
      {
        correlationId,
        durationMs,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
      },
    );
  });
  next();
}
