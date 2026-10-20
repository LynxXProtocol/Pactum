import type { QueryClient, QueryFunction, QueryKey } from '@tanstack/react-query';

export interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g';
  downlink?: number;
  rtt?: number;
}

declare global {
  interface Navigator {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  }
}

export interface PrefetchOptions<TData = unknown> {
  queryClient: QueryClient;
  queryKey: QueryKey;
  queryFn: QueryFunction<TData>;
  staleTime?: number;
  gcTime?: number;
  bypassSaveData?: boolean;
}

/**
 * In-flight cache of active prefetches to deduplicate concurrent requests.
 */
const activePrefetchKeys = new Set<string>();

/**
 * Deterministically serializes a QueryKey into a cache string.
 */
export function serializeQueryKey(key: QueryKey): string {
  try {
    return JSON.stringify(key);
  } catch {
    return String(key);
  }
}

/**
 * Checks whether prefetching should be allowed based on network conditions and user preferences (e.g. Save-Data header).
 */
export function shouldAllowPrefetch(options: { bypassSaveData?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return false;

  // Respect offline state
  if (typeof navigator !== 'undefined' && 'onLine' in navigator && !navigator.onLine) {
    return false;
  }

  if (options.bypassSaveData) {
    return true;
  }

  const connection = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;

  if (connection) {
    // Respect user's Save-Data browser header/preference
    if (connection.saveData === true) {
      return false;
    }

    // Do not aggressively prefetch on very slow / constrained networks
    if (connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g') {
      return false;
    }
  }

  return true;
}

/**
 * Immediately triggers a query prefetch if network conditions permit and query is not already cached/prefetched.
 */
export async function executePrefetch<TData = unknown>({
  queryClient,
  queryKey,
  queryFn,
  staleTime = 60_000,
  gcTime = 5 * 60_000,
  bypassSaveData = false,
}: PrefetchOptions<TData>): Promise<boolean> {
  if (!shouldAllowPrefetch({ bypassSaveData })) {
    return false;
  }

  const keyString = serializeQueryKey(queryKey);
  if (activePrefetchKeys.has(keyString)) {
    return false;
  }

  // Check if existing cache entry is already fresh
  const queryState = queryClient.getQueryState(queryKey);
  if (queryState?.data !== undefined && queryState.dataUpdatedAt > 0) {
    const isStale = Date.now() - queryState.dataUpdatedAt > staleTime;
    if (!isStale) {
      return false;
    }
  }

  activePrefetchKeys.add(keyString);

  try {
    await queryClient.prefetchQuery({
      queryKey,
      queryFn,
      staleTime,
      gcTime,
    });
    return true;
  } catch {
    return false;
  } finally {
    activePrefetchKeys.delete(keyString);
  }
}

export interface CursorPosition {
  x: number;
  y: number;
  timestamp: number;
}

/**
 * Calculates cursor velocity (px/ms) and trajectory towards a target element bounding rectangle.
 */
export function calculateHoverIntent(
  positions: CursorPosition[],
  targetRect: DOMRect,
  velocityThreshold = 0.15, // px/ms
): { hasIntent: boolean; velocity: number } {
  if (positions.length < 2) {
    return { hasIntent: false, velocity: 0 };
  }

  const latest = positions[positions.length - 1];
  const previous = positions[0];
  const dt = latest.timestamp - previous.timestamp;

  if (dt <= 0) {
    return { hasIntent: false, velocity: 0 };
  }

  const dx = latest.x - previous.x;
  const dy = latest.y - previous.y;
  const distance = Math.hypot(dx, dy);
  const velocity = distance / dt;

  // Check if cursor is already inside the bounding box
  const isInside =
    latest.x >= targetRect.left &&
    latest.x <= targetRect.right &&
    latest.y >= targetRect.top &&
    latest.y <= targetRect.bottom;

  if (isInside) {
    // Inside target: only signal intent if moving with sufficient velocity
    return { hasIntent: velocity >= velocityThreshold, velocity };
  }

  // Vector towards center of the bounding box
  const centerX = targetRect.left + targetRect.width / 2;
  const centerY = targetRect.top + targetRect.height / 2;

  const toTargetX = centerX - latest.x;
  const toTargetY = centerY - latest.y;
  const toTargetDistance = Math.hypot(toTargetX, toTargetY);

  // If reasonably close (< 250px) and moving towards target with sufficient velocity
  if (toTargetDistance < 250 && velocity >= velocityThreshold) {
    // Dot product to verify direction alignment
    const dotProduct = dx * toTargetX + dy * toTargetY;
    const isHeadingTowards = dotProduct > 0;

    if (isHeadingTowards) {
      return { hasIntent: true, velocity };
    }
  }

  return { hasIntent: false, velocity };
}
