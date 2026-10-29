/** Shown on a college host that does not exist or is suspended (the API answers 404 tenant_not_found). */
export function TenantNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-semibold">We could not find this college</h1>
      <p className="text-muted-foreground">
        The address may be mistyped, or the college is not active right now. Check the link you were
        given, or contact your college administrator.
      </p>
    </main>
  );
}
