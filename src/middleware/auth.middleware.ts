import { NextFunction, Request, Response } from "express";
import { API_KEYS, type ApiKeyUser } from "../config/constants.js";
import { logger } from "../logger.js";

declare global {
  namespace Express {
    interface Request {
      user?: ApiKeyUser;
    }
  }
}

/**
 * Extracts API Key from X-API-Key header or Authorization header
 */
function extractApiKey(req: Request): string | null {
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) {
    return xApiKey.trim();
  }

  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    // Supports: Bearer <key> or ApiKey <key>
    const parts = authHeader.trim().split(" ");
    if (parts.length === 2 && (parts[0] === "Bearer" || parts[0] === "ApiKey")) {
      return parts[1].trim();
    }
  }

  return null;
}

/**
 * API Key Authentication Middleware
 * Enforces valid credentials across protected endpoints
 */
export function apiKeyAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    logger.warn("AUTH", `Unauthorized access attempt to ${req.method} ${req.originalUrl} (No API key provided)`, {
      ip: req.ip,
      correlationId: req.correlationId,
    });
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "API Key required. Please provide a valid 'X-API-Key' header.",
      help: "Use header 'X-API-Key: key_std_prod_123' (Standard), 'key_vip_prod_456' (VIP), or 'key_admin_prod_789' (Admin).",
    });
  }

  const user = API_KEYS[apiKey];
  if (!user) {
    logger.warn("AUTH", `Forbidden access attempt with invalid API key: "${apiKey.slice(0, 8)}..."`, {
      ip: req.ip,
      correlationId: req.correlationId,
    });
    return res.status(401).json({
      error: "INVALID_API_KEY",
      message: "The provided API Key is invalid or expired.",
    });
  }

  // Attach authenticated identity to request context
  req.user = user;
  next();
}

/**
 * Role-Based Access Control (RBAC) Guard Middleware
 */
export function requireRole(allowedRoles: Array<"standard" | "vip" | "admin">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication required before role verification.",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn(
        "AUTH",
        `Access denied for user "${req.user.id}" (${req.user.role}). Required: [${allowedRoles.join(", ")}]`,
        {
          userId: req.user.id,
          role: req.user.role,
          requiredRoles: allowedRoles,
          correlationId: req.correlationId,
        },
      );
      return res.status(403).json({
        error: "FORBIDDEN",
        message: `Access denied. This action requires one of: [${allowedRoles.join(", ")}]. Current tier: '${req.user.role}'.`,
      });
    }

    next();
  };
}
