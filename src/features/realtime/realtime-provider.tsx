"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useTransition,
} from "react";

import {
  affectsRoute,
  parseChanges,
  type RealtimeChange,
  RefreshCoordinator,
} from "@/features/realtime/changes";
import { useVault } from "@/features/vault/vault-provider";

const noopEnd = () => {};
const MutationContext = createContext<() => () => void>(() => noopEnd);

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

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const vault = useVault();
  const [isRefreshing, startTransition] = useTransition();
  const coordinatorRef = useRef<RefreshCoordinator | null>(null);

  const refresh = useEffectEvent(
    (changes: RealtimeChange[], reset: boolean) => {
      vault.invalidateMetadata(changes, reset);
      if (!reset && !affectsRoute(changes, new URL(window.location.href)))
        return;
      coordinatorRef.current?.setRefreshing(true);
      startTransition(() => router.refresh());
    },
  );
  const expireSession = useEffectEvent(() => {
    void vault.lock().finally(() => router.replace("/login"));
  });

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
    let source: EventSource | null = null;
    let cursor = "";
    let lastMessage = Date.now();
    let disconnected = false;
    let lastFallback = 0;
    let expired = false;
    let stopped = false;

    const refreshAfterRecovery = async () => {
      try {
        const response = await fetch("/api/auth/csrf", {
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        });
        if (stopped || expired) return;
        if (response.ok) coordinator.request([], true);
        else if (response.status === 401) {
          expired = true;
          source?.close();
          source = null;
          expireSession();
        }
      } catch {
        // Keep the current page during an API outage. The next probe or
        // successful stream reconnect will reconcile it after recovery.
      }
    };

    const rememberCursor = (event: MessageEvent) => {
      if (/^\d{1,19}$/.test(event.lastEventId)) cursor = event.lastEventId;
      lastMessage = Date.now();
      disconnected = false;
    };
    const connect = () => {
      if (source || expired || document.hidden || !navigator.onLine) return;
      source = new EventSource(
        `/api/events${cursor ? `?cursor=${cursor}` : ""}`,
      );
      source.addEventListener("reset", (event: MessageEvent) => {
        rememberCursor(event);
        coordinator.request([], true);
      });
      source.addEventListener("changes", (event: MessageEvent) => {
        rememberCursor(event);
        const changes = parseChanges(event.data);
        coordinator.request(changes ?? [], changes === null);
      });
      source.addEventListener("checkpoint", rememberCursor);
      source.addEventListener("session-expired", () => {
        expired = true;
        source?.close();
        source = null;
        expireSession();
      });
      source.onerror = () => {
        disconnected = true;
      };
    };
    const resume = () => {
      coordinator.setVisible(!document.hidden);
      if (document.hidden || !navigator.onLine) {
        source?.close();
        source = null;
      } else {
        connect();
        // Covers suspended tabs, bfcache restores, and the initial SSR/stream gap.
        coordinator.request([], true);
      }
    };
    resume();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("pageshow", resume);
    const watchdog = setInterval(() => {
      if (expired || document.hidden || !navigator.onLine) return;
      const now = Date.now();
      if (now - lastMessage > 45_000) {
        source?.close();
        source = null;
        lastMessage = now;
        connect();
        disconnected = true;
      }
      if (disconnected && now - lastFallback >= 30_000) {
        lastFallback = now;
        void refreshAfterRecovery();
      }
    }, 5_000);
    return () => {
      stopped = true;
      source?.close();
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, []);

  // Account identity is also the component key in the dashboard frame. Keep
  // the stream lifetime independent of route refreshes and vault unlock state.
  useEffect(() => {
    if (vault.state === "unlocked") coordinatorRef.current?.request([], true);
  }, [vault.state]);

  return <MutationContext value={beginMutation}>{children}</MutationContext>;
}
