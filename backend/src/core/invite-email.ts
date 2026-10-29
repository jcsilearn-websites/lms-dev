/**
 * The invite email. `origin` is built by the caller from the VALIDATED tenant slug and the base
 * domain (never from raw Host text); the token is the single-use secret (only its hash is stored).
 */
export function inviteEmail(args: { origin: string; token: string; days: number }): {
  subject: string;
  text: string;
} {
  return {
    subject: "You've been invited",
    text: `You have been invited. Accept within ${args.days} days:\n${args.origin}/accept-invite?token=${args.token}`,
  };
}
