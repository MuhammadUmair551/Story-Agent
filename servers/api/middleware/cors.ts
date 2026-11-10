import type { RequestHandler } from "express";
import { HTTP_STATUS } from "../constants/index.js";

export const createCorsMiddleware = ({ origin }: { origin: string }): RequestHandler => {
  const allowedOrigins = new Set(origin.split(",").map((value) => value.trim()));
  return (request, response, next) => {
    const requestOrigin = request.get("Origin");
    if (requestOrigin && allowedOrigins.has(requestOrigin)) {
      response.setHeader("Access-Control-Allow-Origin", requestOrigin);
    }
    response.vary("Origin");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
    response.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (request.method === "OPTIONS") {
      response.sendStatus(HTTP_STATUS.noContent);
      return;
    }
    next();
  };
};
