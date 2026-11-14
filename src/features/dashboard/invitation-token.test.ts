import { describe, expect, it } from "vitest";

import { invitationTokenFromFragment } from "./invitation-token";

describe("invitationTokenFromFragment", () => {
  const token = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4";

  it("reads the token the API appends after creating an invitation", () => {
    expect(invitationTokenFromFragment(`#invitation=${token}`)).toBe(token);
    expect(invitationTokenFromFragment(`invitation=${token}`)).toBe(token);
  });

  it("ignores fragments that carry no usable token", () => {
    expect(invitationTokenFromFragment("")).toBeNull();
    expect(invitationTokenFromFragment("#accounts")).toBeNull();
    expect(invitationTokenFromFragment("#invitation=")).toBeNull();
    expect(invitationTokenFromFragment("#invitation=short")).toBeNull();
    expect(
      invitationTokenFromFragment(`#invitation=${token}/../../files`),
    ).toBeNull();
    expect(invitationTokenFromFragment(`#token=${token}`)).toBeNull();
  });
});
