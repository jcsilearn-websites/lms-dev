/** Shown while a sign-in is being retried by itself. */
export function BusyNotice() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Many people are signing in, please wait. We are trying again for you.
    </p>
  );
}
