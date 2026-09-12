"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";

import {
  affectsRoute,
  mergeChanges,
  type RealtimeChange,
  RefreshCoordinator,
  SnapshotHistory,
} from "@/features/realtime/changes";
import {
  RealtimeConnection,
  validCursor,
} from "@/features/realtime/connection";
import { useVault } from "@/features/vault/vault-provider";
import { SnapshotRetry } from "./snapshot-retry";
import { type FileSummary, SummaryResource } from "./summary-resource";

const noopEnd = () => {};
const MutationContext = createContext<() => () => void>(() => noopEnd);
const SummaryContext = createContext<SummaryResource | null>(null);
const FolderScopeContext = createContext<
  (folders: readonly string[]) => () => void
>(() => noopEnd);
const SnapshotContext = createContext<
  (cursor: string | undefined, ready: boolean) => void
>(() => {});

export function RealtimeSnapshotFence({
  children,
  cursor,
  ready = true,
}: {
  children: ReactNode;
  cursor?: string;
  ready?: boolean;
}) {
  const reconcile = useContext(SnapshotContext);
  // A new RSC payload can have the same cursor; replay any events consumed
  // during its render/navigation before treating that snapshot as current.
  useLayoutEffect(() => reconcile(cursor, ready));
  return children;
}

const emptySubscribe = () => noopEnd;
const emptySnapshot = () => null;

export function useFileSummary(initialSummary: FileSummary): FileSummary {
  const resource = useContext(SummaryContext);
  useLayoutEffect(
    () => resource?.acceptSnapshot(initialSummary),
    [resource, initialSummary],
  );
  return (
    useSyncExternalStore(
      resource?.subscribe ?? emptySubscribe,
      resource?.getSnapshot ?? emptySnapshot,
      emptySnapshot,
    ) ?? initialSummary
  );
}

export function RealtimeFolderScope({
  children,
  folderIds,
}: {
  children: ReactNode;
  folderIds: readonly string[];
}) {
  const register = useContext(FolderScopeContext);
  useLayoutEffect(() => register(folderIds), [folderIds, register]);
  return children;
}

export function useRealtimeMutation(): () => () => void {
  return useContext(MutationContext);
}

export function useRealtimeActivity(active: boolean): void {
  const beginMutation = useRealtimeMutation();
  useEffect(
    () => (active ? beginMutation() : undefined),
    [active, beginMutation],
  );
}

export function RealtimeProvider({
  children,
  initialCursor,
}: {
  children: ReactNode;
  initialCursor?: string;
}) {
  const router = useRouter();
  const vault = useVault();
  const [isRefreshing, startTransition] = useTransition();
  const coordinatorRef = useRef<RefreshCoordinator | null>(null);
  const snapshotCursor = useRef(initialCursor);
  const snapshotRetryRef = useRef<SnapshotRetry | null>(null);
  const snapshotReadyRef = useRef(true);
  const pendingSnapshotRef = useRef<{
    changes: RealtimeChange[];
    reset: boolean;
  } | null>(null);
  const [history] = useState(
    () => new SnapshotHistory(validCursor(initialCursor) ? initialCursor : "0"),
  );
  const reconcileSnapshot = useCallback(
    (cursor: string | undefined, ready: boolean) => {
      snapshotReadyRef.current = ready;
      snapshotRetryRef.current?.setReady(ready);
      const pending = validCursor(cursor)
        ? history.since(cursor)
        : { changes: [], reset: true };
      if (coordinatorRef.current)
        coordinatorRef.current.request(pending.changes, pending.reset);
      else {
        const previous = pendingSnapshotRef.current;
        pendingSnapshotRef.current = {
          changes: mergeChanges(previous?.changes ?? [], pending.changes),
          reset: Boolean(previous?.reset || pending.reset),
        };
      }
    },
    [history],
  );
  const scopeRef = useRef<{ href: string; folders: readonly string[] } | null>(
    null,
  );
  const registerScope = useCallback((folders: readonly string[]) => {
    const scope = {
      href: `${window.location.pathname}${window.location.search}`,
      folders,
    };
    scopeRef.current = scope;
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, []);
  const expireSession = useEffectEvent(() => {
    void vault.lock().finally(() => router.replace("/login"));
  });
  const [summaryResource] = useState(
    () => new SummaryResource(() => expireSession()),
  );

  const refresh = useEffectEvent(
    (changes: RealtimeChange[], reset: boolean) => {
      vault.invalidateMetadata(changes, reset);
      if (
        reset ||
        changes.some(({ scope }) => scope === "files" || scope === "shared")
      )
        summaryResource.invalidate();
      const scope = scopeRef.current;
      const folders =
        scope?.href === `${window.location.pathname}${window.location.search}`
          ? scope.folders
          : [];
      if (
        !reset &&
        !affectsRoute(changes, new URL(window.location.href), folders)
      )
        return;
      coordinatorRef.current?.setRefreshing(true);
      startTransition(() => router.refresh());
    },
  );
  const beginMutation = useCallback(
    () => coordinatorRef.current?.beginMutation() ?? noopEnd,
    [],
  );

  useEffect(() => {
    coordinatorRef.current?.setRefreshing(isRefreshing);
  }, [isRefreshing]);

  useEffect(() => {
    const coordinator = new RefreshCoordinator((changes, reset) =>
      refresh(changes, reset),
    );
    coordinatorRef.current = coordinator;
    if (pendingSnapshotRef.current) {
      const pending = pendingSnapshotRef.current;
      pendingSnapshotRef.current = null;
      coordinator.request(pending.changes, pending.reset);
    }
    const retry = new SnapshotRetry(() => coordinator.request([], true));
    snapshotRetryRef.current = retry;
    retry.setReady(snapshotReadyRef.current);
    const connection = new RealtimeConnection(
      (changes, reset) => coordinator.request(changes, reset),
      () => expireSession(),
      snapshotCursor.current,
      (changes, reset, cursor) => {
        if (changes.length || reset) history.record(changes, reset, cursor);
        else history.checkpoint(cursor);
      },
    );
    const resume = () => {
      const active = !document.hidden && navigator.onLine;
      coordinator.setVisible(active);
      retry.setActive(active);
      summaryResource.setActive(active);
      connection.setActive(active);
      // The cursor precedes the SSR reads. Replay covers the entire snapshot
      // race and resume interval; only missing coverage requires a full reset.
      if (active && !validCursor(snapshotCursor.current))
        coordinator.request([], true);
    };
    const suspend = () => {
      coordinator.setVisible(false);
      retry.setActive(false);
      summaryResource.setActive(false);
      connection.setActive(false);
    };
    resume();
    window.addEventListener("pagehide", suspend);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      connection.dispose();
      retry.setActive(false);
      if (snapshotRetryRef.current === retry) snapshotRetryRef.current = null;
      summaryResource.setActive(false);
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("pagehide", suspend);
    };
  }, [summaryResource, history]);

  // Account identity is the component key. Vault/security events and replay
  // gaps still reset metadata; unlocking alone does not change the snapshot.
  return (
    <MutationContext value={beginMutation}>
      <SummaryContext value={summaryResource}>
        <FolderScopeContext value={registerScope}>
          <SnapshotContext value={reconcileSnapshot}>
            {children}
          </SnapshotContext>
        </FolderScopeContext>
      </SummaryContext>
    </MutationContext>
  );
}
