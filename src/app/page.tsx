import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Files",
};

export default function Home() {
  redirect("/files");
}
