import { headers } from "next/headers";

type HeaderSource = {
  get(name: string): string | null;
};

export type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled";
};

export type AuthState =
  | {
      status: "authenticated";
      user: CurrentUser;
    }
  | {
      status: "anonymous";
    }
  | {
      status: "unavailable";
    };

function getApiOrigin() {
  return process.env.AERALYTH_API_ORIGIN?.trim() || "http://127.0.0.1:8080";
}

export async function getAuthState(): Promise<AuthState> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");

  try {
    const response = await fetch(`${getApiOrigin()}/api/auth/me`, {
      headers: getForwardedHeaders(requestHeaders, cookie),
      cache: "no-store",
    });

    if (response.status === 401) {
      return { status: "anonymous" };
    }

    if (!response.ok) {
      return { status: "unavailable" };
    }

    const data = (await response.json()) as { user: CurrentUser | null };

    if (!data.user) {
      return { status: "anonymous" };
    }

    return { status: "authenticated", user: data.user };
  } catch {
    return { status: "unavailable" };
  }
}

function getForwardedHeaders(requestHeaders: HeaderSource, cookie: string | null) {
  const forwardedHeaders = new Headers({
    accept: "application/json",
  });
  const forwardedFor = requestHeaders.get("x-forwarded-for");

  if (cookie) {
    forwardedHeaders.set("cookie", cookie);
  }

  if (forwardedFor) {
    forwardedHeaders.set("x-forwarded-for", forwardedFor);
  }

  return forwardedHeaders;
}
