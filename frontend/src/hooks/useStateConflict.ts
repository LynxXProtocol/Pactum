import { useSyncExternalStore } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import { conflictEngine } from '../lib/queryClient';

/** Subscribes to conflict state for one query key, so only affected components re-render. */
export function useStateConflict(queryKey: QueryKey) {
  const conflict = useSyncExternalStore(
    (onStoreChange) => conflictEngine.subscribe(onStoreChange),
    () => conflictEngine.getConflict(queryKey),
  );
  return { conflict, clearConflict: () => conflictEngine.clearConflict(queryKey) };
}
