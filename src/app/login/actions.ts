"use server";

import { redirect } from "next/navigation";

import { signInWithPassword } from "@/lib/auth/session";

export async function requestSignIn(formData: FormData) {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const remember = formData.get("remember") === "on";

  const user = await signInWithPassword({ username, password, remember });

  if (!user) {
    redirect("/login?error=invalid");
  }

  redirect("/files");
}
