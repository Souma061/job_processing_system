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

// Strict Whitelist: Alphanumeric, hyphens, underscores, dots, 1 to 64 characters
export const CORRELATION_ID_REGEX = /^[a-zA-Z0-9_\-\.]{1,64}$/;

/**
 * Sanitizes and validates client-provided correlation IDs.
 * Defends against CRLF log injection, ANSI escape bombs, XSS, and memory exhaustion.
 */
export function sanitizeCorrelationId(raw: unknown): {
  correlationId: string;
  wasSanitized: boolean;
} {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (CORRELATION_ID_REGEX.test(trimmed)) {
      return { correlationId: trimmed, wasSanitized: false };
    }
  }
  // Safe fallback if missing, invalid, oversized, or poisoned
  return {
    correlationId: `corr-${crypto.randomUUID()}`,
    wasSanitized: raw !== undefined,
  };
}

export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Read existing header and sanitize against log injection / bloat
  const rawHeader = req.headers["x-correlation-id"];
  const { correlationId, wasSanitized } = sanitizeCorrelationId(rawHeader);

  if (wasSanitized && rawHeader) {
    logger.warn(
      "SECURITY",
      `Poisoned or invalid X-Correlation-Id discarded from ${req.ip}`,
      {
        rawHeaderLength: typeof rawHeader === "string" ? rawHeader.length : 0,
        assignedCorrelationId: correlationId,
      },
    );
  }

  // attach to req so downstream controllers can pass it to BullMq jobs
  req.correlationId = correlationId;

  // return clean correlation id to the client in the response header
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
