"use client";

import { LoaderCircle, LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  forgetVaultDerivedLanguages,
  loadRepositoryLanguages,
  peekRepositoryLanguages,
} from "@/features/repositories/repository-language-stats-data";
import type { RepositoryLanguage } from "@/features/repositories/repository-languages";
import { useVault, VAULT_LOCKING_EVENT } from "@/features/vault/vault-provider";
import type { RepositorySummary } from "@/lib/api";

type LanguageState =
  | { status: "loading" }
  | { status: "locked" }
  | { status: "ready"; languages: RepositoryLanguage[] }
  | { status: "error"; message: string };

const IDLE_ACTIVATION_TIMEOUT_MS = 2_000;

export function RepositoryLanguageStats({
  repository,
}: {
  repository: RepositorySummary;
}) {
  const vault = useVault();
  const sectionRef = useRef<HTMLElement>(null);
  const contentVersion = repository.contentVersion;
  const requestKey = `${repository.id}\u0000${contentVersion ?? ""}\u0000${vault.state}`;
  const cached = peekRepositoryLanguages(
    repository.id,
    contentVersion,
    vault.state,
  );
  const [activated, setActivated] = useState(cached !== null);
  const [loaded, setLoaded] = useState<{
    key: string;
    state: LanguageState;
  } | null>(null);
  const state: LanguageState =
    cached ??
    (loaded?.key === requestKey ? loaded.state : { status: "loading" });
  const { openNode, resolveMetadata, state: vaultState } = vault;

  useEffect(() => {
    window.addEventListener(VAULT_LOCKING_EVENT, forgetVaultDerivedLanguages);
    return () =>
      window.removeEventListener(
        VAULT_LOCKING_EVENT,
        forgetVaultDerivedLanguages,
      );
  }, []);

  // The bar sits below the fold on small screens; analyze once it is seen or
  // the browser has nothing more urgent to do.
  useEffect(() => {
    if (activated) return;
    const activate = () => setActivated(true);
    const section = sectionRef.current;
    const observer =
      section && typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) activate();
          })
        : null;
    if (section) observer?.observe(section);
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(activate, {
            timeout: IDLE_ACTIVATION_TIMEOUT_MS,
          })
        : null;
    const timer = idle === null ? window.setTimeout(activate, 0) : null;
    return () => {
      observer?.disconnect();
      if (idle !== null) window.cancelIdleCallback(idle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activated]);

  useEffect(() => {
    if (!activated) return;
    if (peekRepositoryLanguages(repository.id, contentVersion, vaultState)) {
      return;
    }
    const controller = new AbortController();
    const key = `${repository.id}\u0000${contentVersion ?? ""}\u0000${vaultState}`;

    void loadRepositoryLanguages({
      repositoryId: repository.id,
      contentVersion,
      vault: { state: vaultState, openNode, resolveMetadata },
      signal: controller.signal,
    })
      .then((nextState) => {
        if (!controller.signal.aborted) setLoaded({ key, state: nextState });
      })
      .catch((failure: unknown) => {
        if (
          controller.signal.aborted ||
          (failure instanceof DOMException && failure.name === "AbortError")
        ) {
          return;
        }
        setLoaded({
          key,
          state: {
            status: "error",
            message:
              failure instanceof Error
                ? failure.message
                : "Repository languages could not be calculated.",
          },
        });
      });

    return () => controller.abort();
  }, [
    activated,
    contentVersion,
    openNode,
    repository.id,
    resolveMetadata,
    vaultState,
  ]);

  return (
    <section ref={sectionRef} className="border-t pt-4">
      <h2 className="font-display text-base font-semibold">Languages</h2>
      <LanguageStatsContent
        state={
          state.status === "locked" && vault.state === "unlocked"
            ? { status: "loading" }
            : state
        }
        unlocking={vault.state === "unlocking"}
        onUnlock={vault.requestUnlock}
      />
    </section>
  );
}

function LanguageStatsContent({
  state,
  unlocking,
  onUnlock,
}: {
  state: LanguageState;
  unlocking: boolean;
  onUnlock(): void;
}) {
  if (state.status === "loading") {
    return (
      <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Analyzing source files…
      </div>
    );
  }

  if (state.status === "locked") {
    return (
      <div className="mt-3 space-y-3">
        <p className="text-sm leading-5 text-muted-foreground">
          Unlock the vault to analyze encrypted filenames and sizes.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={unlocking}
          onClick={onUnlock}
        >
          {unlocking ? (
            <LoaderCircle
              className="size-3.5 animate-spin"
              aria-hidden="true"
            />
          ) : (
            <LockKeyhole className="size-3.5" aria-hidden="true" />
          )}
          {unlocking ? "Unlocking…" : "Unlock vault"}
        </Button>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p className="mt-3 text-sm leading-5 text-destructive" role="alert">
        {state.message}
      </p>
    );
  }

  if (state.languages.length === 0) {
    return (
      <p className="mt-3 text-sm leading-5 text-muted-foreground">
        No recognized source-language files yet.
      </p>
    );
  }

  const summary = state.languages
    .map(
      (language) => `${language.name} ${formatPercentage(language.percentage)}`,
    )
    .join(", ");

  return (
    <div className="mt-3">
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`Language usage: ${summary}`}
      >
        {state.languages.map((language) => (
          <span
            key={language.name}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              backgroundColor: language.color,
              width: `${language.percentage}%`,
            }}
            title={`${language.name} ${formatPercentage(language.percentage)}`}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {state.languages.map((language) => (
          <li key={language.name} className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: language.color }}
              aria-hidden="true"
            />
            <span className="font-medium">{language.name}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatPercentage(language.percentage)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatPercentage(value: number) {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}
