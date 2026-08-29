import type { CurrentUser } from "@/lib/api";

export type AccountAuthInfo = {
  authVersion: number;
  salt: string;
};

export type AccountLoginResult = {
  user: CurrentUser;
  csrfToken: string;
  next: string;
};

export async function getAccountAuthInfo(
  username: string,
  signal?: AbortSignal,
): Promise<AccountAuthInfo> {
  const response = await fetch(
    `/api/auth/info?username=${encodeURIComponent(username)}`,
    { credentials: "same-origin", signal },
  );
  if (!response.ok) {
    throw new Error("Account authentication is unavailable.");
  }
  return response.json();
}

export async function loginAccount(
  input: {
    username: string;
    credential?: string;
    legacyPassword?: string;
    remember: boolean;
    next?: string;
  },
  signal?: AbortSignal,
): Promise<AccountLoginResult> {
  const response = await fetch("/api/auth/login-json", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 401) {
      throw new Error("Invalid username or password.");
    }
    if (response.status === 429) {
      throw new Error("Too many login attempts. Wait a moment and try again.");
    }
    throw new Error(detail || "Sign in failed.");
  }
  return response.json();
}

export async function enrollOnePassword(
  csrfToken: string,
  input: {
    currentPassword: string;
    credential: string;
    salt: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/auth/enroll-one-password", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    throw new Error((await response.text()) || "Account migration failed.");
  }
}
