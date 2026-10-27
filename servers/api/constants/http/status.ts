export const HTTP_STATUS = Object.freeze({
  ok: 200,
  accepted: 202,
  noContent: 204,
  badRequest: 400,
  tooManyRequests: 429,
  notFound: 404,
  serviceUnavailable: 503,
  internalServerError: 500
} as const);
