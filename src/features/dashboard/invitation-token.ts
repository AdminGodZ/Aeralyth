/**
 * Reads a newly created invitation token from a URL fragment such as
 * `#invitation=<token>`. The shape matches what the API accepts as a token.
 */
export function invitationTokenFromFragment(fragment: string): string | null {
  const token = new URLSearchParams(fragment.replace(/^#/, ""))
    .get("invitation")
    ?.trim();
  return token && /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
}
