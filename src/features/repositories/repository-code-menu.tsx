"use client";

import {
  Check,
  ChevronDown,
  Clipboard,
  Code2,
  Download,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { RepositoryArchiveProgress } from "@/features/repositories/repository-archive";
import { useVault, VAULT_LOCKING_EVENT } from "@/features/vault/vault-provider";
import type { RepositorySummary } from "@/lib/api";

export function RepositoryCodeMenu({
  repository,
  repositoryName,
}: {
  repository: RepositorySummary;
  repositoryName: string;
}) {
  const vault = useVault();
  const repositoryPath = `/repositories/${encodeURIComponent(repository.id)}`;
  const [open, setOpen] = useState(false);
  const [repositoryUrl, setRepositoryUrl] = useState(repositoryPath);
  const [copied, setCopied] = useState(false);
  const [archiveProgress, setArchiveProgress] =
    useState<RepositoryArchiveProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archiveAbortRef = useRef<AbortController | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const vaultStateRef = useRef(vault.state);

  useEffect(() => {
    vaultStateRef.current = vault.state;
    if (vault.state !== "unlocked" && archiveAbortRef.current) {
      archiveAbortRef.current.abort(
        new DOMException("The vault locked during the download.", "AbortError"),
      );
      setArchiveProgress(null);
    }
  }, [vault.state]);

  useEffect(() => {
    const abortForVaultLock = () => {
      vaultStateRef.current = "locked";
      archiveAbortRef.current?.abort(
        new DOMException("The vault locked during the download.", "AbortError"),
      );
      setArchiveProgress(null);
    };
    window.addEventListener(VAULT_LOCKING_EVENT, abortForVaultLock);
    return () =>
      window.removeEventListener(VAULT_LOCKING_EVENT, abortForVaultLock);
  }, []);

  useEffect(() => {
    return () => {
      archiveAbortRef.current?.abort();
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  function changeOpen(nextOpen: boolean) {
    if (nextOpen) {
      setRepositoryUrl(new URL(repositoryPath, window.location.origin).href);
    }
    setOpen(nextOpen);
  }

  async function copyRepositoryUrl() {
    setError(null);
    const absoluteUrl = new URL(repositoryPath, window.location.origin).href;
    setRepositoryUrl(absoluteUrl);
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 2_000);
    } catch {
      setError("Copying was blocked. Select the URL and copy it manually.");
    }
  }

  async function downloadZip() {
    if (archiveAbortRef.current) return;
    setError(null);
    const controller = new AbortController();
    archiveAbortRef.current = controller;
    setArchiveProgress({
      label: "Reading repository tree…",
      percentage: null,
    });
    try {
      const { downloadRepositoryArchive } = await import(
        "@/features/repositories/repository-archive"
      );
      await downloadRepositoryArchive({
        repository,
        repositoryName,
        vault: {
          state: vault.state,
          client: vault.client,
          requestUnlock: vault.requestUnlock,
          openNode: vault.openNode,
          isUnlocked: () => vaultStateRef.current === "unlocked",
        },
        signal: controller.signal,
        onProgress: setArchiveProgress,
      });
      setOpen(false);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") {
        return;
      }
      setError(
        failure instanceof Error
          ? failure.message
          : "The repository ZIP download failed.",
      );
    } finally {
      if (archiveAbortRef.current === controller) {
        archiveAbortRef.current = null;
        setArchiveProgress(null);
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button type="button" className="rounded-md">
          <Code2 className="size-4" aria-hidden="true" />
          Code
          <ChevronDown className="size-4 opacity-75" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(28rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <div className="border-b px-4 pt-4">
          <h2 className="font-display text-base font-semibold">Repository</h2>
          <div className="mt-3 flex h-9 items-end">
            <span className="border-b-2 border-primary px-1 pb-2 text-sm font-semibold">
              HTTPS
            </span>
          </div>
        </div>

        <div className="p-4">
          <p className="text-sm font-semibold">Repository URL</p>
          <div className="mt-2 flex items-center gap-2">
            <Input
              readOnly
              value={repositoryUrl}
              aria-label="Repository HTTPS URL"
              className="h-10 rounded-md border bg-background px-3 font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10 shrink-0 rounded-md"
              aria-label={
                copied ? "Repository URL copied" : "Copy repository URL"
              }
              title={copied ? "Copied" : "Copy URL"}
              onClick={() => void copyRepositoryUrl()}
            >
              {copied ? (
                <Check className="size-4 text-primary" aria-hidden="true" />
              ) : (
                <Clipboard className="size-4" aria-hidden="true" />
              )}
            </Button>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Copy the HTTPS link to open this repository in Aeralyth.
          </p>
        </div>

        <div className="border-t p-2">
          <button
            type="button"
            className="flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 disabled:cursor-wait disabled:opacity-70"
            disabled={Boolean(archiveProgress)}
            onClick={() => void downloadZip()}
          >
            {archiveProgress ? (
              <LoaderCircle
                className="mt-0.5 size-4 shrink-0 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Download className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                {archiveProgress ? "Preparing ZIP" : "Download ZIP"}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {archiveProgress?.label ??
                  `${repositoryName}-${repository.defaultBranch}.zip`}
              </span>
              {archiveProgress && archiveProgress.percentage !== null ? (
                <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary transition-[width]"
                    style={{
                      width: `${Math.max(2, archiveProgress.percentage ?? 2)}%`,
                    }}
                  />
                </span>
              ) : null}
            </span>
          </button>
        </div>

        {error ? (
          <p
            role="alert"
            className="border-t px-4 py-3 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
