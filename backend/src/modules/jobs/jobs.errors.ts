// The queue has no module-specific API errors: handler failures are recorded on the job row
// (jobs.last_error) and retried, never shown to API clients.
export {};
