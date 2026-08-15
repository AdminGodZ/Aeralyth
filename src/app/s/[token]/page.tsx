import {
  ArrowRight,
  CalendarClock,
  CircleAlert,
  Download,
  Eye,
  File,
  Folder,
  Globe2,
  LockKeyhole,
  Pencil,
  ShieldAlert,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AeralythLogo } from "@/components/aeralyth-logo";
import { DottedSurface } from "@/components/dotted-surface";
import { Button } from "@/components/ui/button";
import {
  SharedEntryDeleteButton,
  ShareEditorUpload,
} from "@/features/sharing/share-link-controls";
import {
  getShareLinkState,
  type SharedLinkData,
  type SharedLinkEntry,
} from "@/lib/api";

export const metadata: Metadata = {
  title: "Shared item",
  description: "Open a secure Aeralyth share.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

const sharedSizeFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
});
const sharedDateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const sharedDateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

type SharedItemPageProps = {
  params: Promise<{
    token: string;
  }>;
  searchParams: Promise<{
    cursor?: string;
    folder?: string;
  }>;
};

export default async function SharedItemPage({
  params,
  searchParams,
}: SharedItemPageProps) {
  const [{ token }, { cursor, folder: folderId }] = await Promise.all([
    params,
    searchParams,
  ]);
  const shareState = await getShareLinkState(token, folderId, cursor);
  const returnPath = getSharePath(token, folderId, cursor);

  return (
    <main className="relative isolate min-h-dvh overflow-hidden bg-background px-4 py-8 text-foreground sm:px-6">
      <DottedSurface className="opacity-35" />
      <div className="relative z-10 mx-auto w-full max-w-5xl">
        <Link href="/login" className="mb-7 flex w-fit items-center gap-3">
          <AeralythLogo className="size-10" />
          <span className="font-display text-2xl font-semibold">Aeralyth</span>
        </Link>

        {shareState.status === "ready" ? (
          <SharedItemReady token={token} data={shareState.data} />
        ) : (
          <ShareStateCard status={shareState.status} returnPath={returnPath} />
        )}
      </div>
    </main>
  );
}

function SharedItemReady({
  token,
  data,
}: {
  token: string;
  data: SharedLinkData;
}) {
  const isFolder = data.root.entryType === "folder";
  const canEdit = data.permission === "editor";

  return (
    <section className="overflow-hidden rounded-3xl bg-card/90 shadow-2xl shadow-black/10 backdrop-blur-xl dark:bg-card/80 dark:shadow-black/30">
      <header className="min-w-0 px-5 py-6 sm:px-8 sm:py-7">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {isFolder ? (
              <Folder className="size-5" aria-hidden="true" />
            ) : (
              <File className="size-5" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-semibold">
              {data.root.name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Shared by {data.ownerUsername}
            </p>
          </div>
        </div>
        <SharedLinkFacts
          accessScope={data.accessScope}
          canEdit={canEdit}
          expiresAt={data.expiresAt}
        />
      </header>

      <div className="bg-muted/40 p-3 sm:p-5">
        {isFolder ? (
          <SharedFolderView token={token} data={data} />
        ) : (
          <SharedFileView token={token} data={data} />
        )}
      </div>
    </section>
  );
}

function SharedLinkFacts({
  accessScope,
  canEdit,
  expiresAt,
}: {
  accessScope: SharedLinkData["accessScope"];
  canEdit: boolean;
  expiresAt: string | null;
}) {
  const AccessIcon = accessScope === "public" ? Globe2 : LockKeyhole;
  const PermissionIcon = canEdit ? Pencil : Eye;

  return (
    <dl
      aria-label="Share details"
      className="mt-5 grid gap-4 rounded-2xl bg-muted/45 px-4 py-3 sm:grid-cols-3"
    >
      <SharedLinkFact
        icon={AccessIcon}
        label="Access"
        value={accessScope === "public" ? "Anyone with link" : "Account only"}
      />
      <SharedLinkFact
        icon={PermissionIcon}
        label="Permission"
        value={canEdit ? "Can modify" : "View and download"}
      />
      <SharedLinkFact
        icon={CalendarClock}
        label="Expires"
        value={expirationValue(expiresAt)}
      />
    </dl>
  );
}

function SharedLinkFact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Globe2;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/65 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <dt className="text-xs leading-4 text-muted-foreground">{label}</dt>
        <dd className="break-words text-sm font-medium">{value}</dd>
      </div>
    </div>
  );
}

function SharedFolderView({
  token,
  data,
}: {
  token: string;
  data: SharedLinkData;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-xl bg-background/70 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between dark:bg-background/45">
        <nav
          aria-label="Shared folder breadcrumbs"
          className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
        >
          {data.breadcrumbs.map((breadcrumb, index) => (
            <span
              key={breadcrumb.id}
              className="flex min-w-0 items-center gap-1"
            >
              {index > 0 ? (
                <span className="text-muted-foreground">/</span>
              ) : null}
              <Link
                href={getSharePath(
                  token,
                  index === 0 ? undefined : breadcrumb.id,
                )}
                className="max-w-52 truncate rounded px-1 py-0.5 hover:bg-muted"
              >
                {breadcrumb.name}
              </Link>
            </span>
          ))}
        </nav>
        {data.permission === "editor" ? (
          <ShareEditorUpload
            token={token}
            parentFolderId={data.currentFolderId}
          />
        ) : null}
      </div>

      <div>
        {data.entries.length > 0 ? (
          <>
            <div className="space-y-2">
              {data.entries.map((entry) => (
                <SharedEntryRow
                  key={entry.id}
                  token={token}
                  entry={entry}
                  canEdit={data.permission === "editor"}
                />
              ))}
            </div>
            {data.hasMore && data.nextCursor ? (
              <div className="mt-3 flex justify-end">
                <Button asChild variant="outline">
                  <Link
                    href={getSharePath(
                      token,
                      data.currentFolderId ?? undefined,
                      data.nextCursor,
                    )}
                  >
                    Next page
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="rounded-2xl bg-background/70 px-5 py-12 text-center shadow-sm shadow-black/5 dark:bg-background/45">
            <Folder
              className="mx-auto size-8 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="mt-3 font-medium">This folder is empty</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.permission === "editor"
                ? "Use Upload to add files or folders."
                : "There is nothing to download yet."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SharedEntryRow({
  token,
  entry,
  canEdit,
}: {
  token: string;
  entry: SharedLinkEntry;
  canEdit: boolean;
}) {
  const isFolder = entry.entryType === "folder";
  const Icon = isFolder ? Folder : File;

  return (
    <div className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl bg-background/70 px-3 py-3 shadow-sm shadow-black/5 transition-colors hover:bg-background/95 dark:bg-background/45 dark:hover:bg-background/70">
      {isFolder ? (
        <Link
          href={getSharePath(token, entry.id)}
          className="flex min-w-0 items-center gap-3"
        >
          <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{entry.name}</span>
            <span className="text-xs text-muted-foreground">Folder</span>
          </span>
        </Link>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{entry.name}</span>
            <span className="text-xs text-muted-foreground">
              {formatBytes(entry.sizeBytes)}
              {" · "}
              {formatDate(entry.updatedAt)}
            </span>
          </span>
        </div>
      )}
      <div className="flex items-center gap-1">
        {!isFolder ? (
          <Button asChild variant="ghost" size="sm">
            <a href={getDownloadPath(token, entry.id)}>
              <Download className="size-4" aria-hidden="true" />
              Download
            </a>
          </Button>
        ) : (
          <Button asChild variant="ghost" size="sm">
            <Link href={getSharePath(token, entry.id)}>
              Open
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        )}
        {canEdit ? (
          <SharedEntryDeleteButton
            token={token}
            entryId={entry.id}
            entryName={entry.name}
            entryType={entry.entryType}
          />
        ) : null}
      </div>
    </div>
  );
}

function SharedFileView({
  token,
  data,
}: {
  token: string;
  data: SharedLinkData;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-background/80 px-4 py-4 shadow-sm shadow-black/5 sm:flex-row sm:items-center sm:justify-between dark:bg-background/50">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <File className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="truncate font-medium">{data.root.name}</p>
          <p className="text-sm text-muted-foreground">
            {formatBytes(data.root.sizeBytes)}
            {" · "}
            Updated {formatDate(data.root.updatedAt)}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {data.permission === "editor" ? (
          <ShareEditorUpload token={token} replacementFileId={data.root.id} />
        ) : null}
        <Button asChild>
          <a href={getDownloadPath(token, data.root.id)}>
            <Download className="size-4" aria-hidden="true" />
            Download
          </a>
        </Button>
      </div>
    </div>
  );
}

function ShareStateCard({
  status,
  returnPath,
}: {
  status: "authentication-required" | "forbidden" | "invalid" | "unavailable";
  returnPath: string;
}) {
  const needsSignIn = status === "authentication-required";
  const forbidden = status === "forbidden";
  const unavailable = status === "unavailable";
  const Icon = needsSignIn
    ? LockKeyhole
    : unavailable
      ? CircleAlert
      : ShieldAlert;

  return (
    <section className="mx-auto max-w-lg overflow-hidden rounded-3xl bg-card/90 text-center shadow-2xl shadow-black/10 backdrop-blur-xl dark:bg-card/80 dark:shadow-black/30">
      <div className="flex flex-col items-center px-6 py-12 sm:px-10">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold">
          {needsSignIn
            ? "Sign in to open this share"
            : forbidden
              ? "This link is for another account"
              : unavailable
                ? "Sharing service unavailable"
                : "Share link unavailable"}
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          {needsSignIn
            ? "The owner limited this link to one Aeralyth account."
            : forbidden
              ? "Use the account selected by the owner, or ask them for a different link."
              : unavailable
                ? "Aeralyth could not reach the sharing API. Try again shortly."
                : "This link is invalid, expired, revoked, or its item was removed."}
        </p>
        {needsSignIn ? (
          <Button asChild className="mt-6">
            <Link
              href={
                "/login?" +
                new URLSearchParams({
                  next: returnPath,
                })
              }
            >
              Sign in
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        ) : (
          <Button asChild variant="outline" className="mt-6">
            <Link href="/login">Go to Aeralyth</Link>
          </Button>
        )}
      </div>
    </section>
  );
}

function getSharePath(
  token: string,
  folderId?: string,
  cursor?: string,
): string {
  const basePath = `/s/${encodeURIComponent(token)}`;
  const params = new URLSearchParams({
    ...(folderId ? { folder: folderId } : {}),
    ...(cursor ? { cursor } : {}),
  });
  return params.size > 0 ? `${basePath}?${params}` : basePath;
}

function getDownloadPath(token: string, fileId: string): string {
  return (
    "/api/share-links/access/" +
    encodeURIComponent(token) +
    "/files/" +
    encodeURIComponent(fileId) +
    "/download"
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${sharedSizeFormatter.format(value)} ${units[unitIndex]}`;
}

function formatDate(value: string): string {
  return sharedDateFormatter.format(new Date(value));
}

function formatDateTime(value: string): string {
  return `${sharedDateTimeFormatter.format(new Date(value))} UTC`;
}

function expirationValue(value: string | null): string {
  return value ? formatDateTime(value) : "Never";
}
