// The shared limiter has no HTTP endpoints, so there is nothing to map.
export function createRateLimitController() {
  return {};
}
export type RateLimitController = ReturnType<typeof createRateLimitController>;
