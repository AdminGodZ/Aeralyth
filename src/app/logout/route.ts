import { redirect } from "next/navigation";

import { signOut } from "@/lib/auth/session";

export async function GET() {
  await signOut();
  redirect("/login");
}
