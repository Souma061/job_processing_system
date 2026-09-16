import { NextFunction, Request, Response } from "express";

interface RateLimitOptions {
  windowMs: number; // time window in ms
  maxReqs: number; // max requests allowed in the window
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxReqs } = options;
  const requestLog = new Map<string, number[]>();

  // periodically clean up stale IPs every 2 minute to prevent memory leak
  setInterval(
    () => {
      const now = Date.now();
      for (const [ip, timeStamp] of requestLog.entries()) {
        const valid = timeStamp.filter((t) => now - t < windowMs);
        if (valid.length === 0) {
          requestLog.delete(ip);
        } else {
          requestLog.set(ip, valid);
        }
      }
    },
    2 * 60 * 1000,
  ); // 2 minutes
  return (req: Request, res: Response, next: NextFunction) => {
    const clientKey =
      (req.headers["x-forwarded-for"] as string) ||
      req.socket.remoteAddress ||
      "unknown";
    const now = Date.now();
    const timestamps = requestLog.get(clientKey) || [];
    //filter out timestamps that are outside the window
    const validTimestamps = timestamps.filter((time) => now - time < windowMs);
    const remaining = Math.max(0, maxReqs - validTimestamps.length);
    const resetTimesec = Math.ceil(
      (windowMs - (now - (validTimestamps[0] || now))) / 1000,
    );
    res.setHeader("X-RateLimit-Limit", maxReqs);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetTimesec);
    if (validTimestamps.length >= maxReqs) {
      res.setHeader("Retry-After", resetTimesec);
      return res.status(429).json({
        error: "Too Many Requests",
        message: `Rate limit exceeded. Maximum ${maxReqs} requests per ${windowMs / 1000}s.`,
        retryAfterSeconds: resetTimesec,
      });
    } else {
      validTimestamps.push(now);
      requestLog.set(clientKey, validTimestamps);
      next();
    }
  };
}
