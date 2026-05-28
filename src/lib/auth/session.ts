import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { query } from "@/lib/db";

const SESSION_COOKIE = "aeralyth_session";
const DEFAULT_SESSION_DAYS = 1;
const REMEMBER_SESSION_DAYS = 30;

export type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "user";
};

type UserRow = CurrentUser;

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export async function signInWithPassword({
  username,
  password,
  remember,
}: {
  username: string;
  password: string;
  remember: boolean;
}) {
  const normalizedUsername = username.trim();

  if (!normalizedUsername || !password) {
    return null;
  }

  const result = await query<UserRow>(
    `
      SELECT id, username, role
      FROM users
      WHERE username = $1
        AND password_hash = crypt($2, password_hash)
      LIMIT 1
    `,
    [normalizedUsername, password],
  );

  const user = result.rows[0] ?? null;

  if (!user) {
    return null;
  }

  const sessionDays = remember ? REMEMBER_SESSION_DAYS : DEFAULT_SESSION_DAYS;
  const maxAge = sessionDays * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + maxAge * 1000);
  const token = createSessionToken();

  await query(
    `
      INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES ($1, $2, $3, $4)
    `,
    [crypto.randomUUID(), user.id, hashToken(token), expiresAt],
  );

  await query("DELETE FROM sessions WHERE expires_at <= now()");

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));

  return user;
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) {
    return null;
  }

  const result = await query<UserRow>(
    `
      SELECT users.id, users.username, users.role
      FROM sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1
        AND sessions.expires_at > now()
      LIMIT 1
    `,
    [hashToken(token)],
  );

  return result.rows[0] ?? null;
}

export async function requireUser() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

export async function signOut() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await query("DELETE FROM sessions WHERE token_hash = $1", [
      hashToken(token),
    ]);
  }

  cookieStore.delete(SESSION_COOKIE);
}
