// Reads the validated request and maps the service result to the response DTO.
// The job queue has no HTTP endpoints, so there is nothing to map.
export function createJobsController() {
  return {};
}
export type JobsController = ReturnType<typeof createJobsController>;
