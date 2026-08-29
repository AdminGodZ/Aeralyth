export const ONE_PASSWORD_AUTH_VERSION = 1;

export const ACCOUNT_AUTH_KDF = Object.freeze({
  algorithm: "argon2id13",
  operations: 3,
  memoryBytes: 64 * 1024 * 1024,
  outputBytes: 32,
});

export function normalizeAccountUsername(username: string): string {
  return username.trim().toLocaleLowerCase("en-US");
}
