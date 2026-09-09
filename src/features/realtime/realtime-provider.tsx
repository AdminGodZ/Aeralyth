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
  type RealtimeChange,
  RefreshCoordinator,
} from "@/features/realtime/changes";
import { RealtimeConnection } from "@/features/realtime/connection";
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
    const connection = new RealtimeConnection(
      (changes, reset) => coordinator.request(changes, reset),
      () => expireSession(),
    );
    const resume = () => {
      const active = !document.hidden && navigator.onLine;
      coordinator.setVisible(active);
      connection.setActive(active);
      // Covers suspended tabs, bfcache restores, and the initial SSR/stream gap.
      if (active) coordinator.request([], true);
    };
    resume();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      connection.dispose();
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
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
