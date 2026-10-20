import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryFunction, type QueryKey } from '@tanstack/react-query';

import {
  calculateHoverIntent,
  executePrefetch,
  shouldAllowPrefetch,
  type CursorPosition,
} from '@/lib/prefetchEngine';

export type PrefetchTriggerMode = 'intersect' | 'hover' | 'intent' | 'focus' | 'touch';

export interface UsePredictivePrefetchOptions<TData = unknown> {
  queryKey: QueryKey;
  queryFn: QueryFunction<TData>;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  bypassSaveData?: boolean;
  triggers?: PrefetchTriggerMode[];
  intersectionRootMargin?: string;
  intersectionThreshold?: number;
  intentDelayMs?: number;
  velocityThreshold?: number;
}

export function usePredictivePrefetch<TElement extends HTMLElement = HTMLElement, TData = unknown>({
  queryKey,
  queryFn,
  enabled = true,
  staleTime = 60_000,
  gcTime = 5 * 60_000,
  bypassSaveData = false,
  triggers = ['intersect', 'intent', 'hover', 'focus', 'touch'],
  intersectionRootMargin = '150px',
  intersectionThreshold = 0.1,
  intentDelayMs = 40,
  velocityThreshold = 0.15,
}: UsePredictivePrefetchOptions<TData>) {
  const queryClient = useQueryClient();
  const [isPrefetched, setIsPrefetched] = useState(false);
  const elementRef = useRef<TElement | null>(null);
  const cursorHistoryRef = useRef<CursorPosition[]>([]);
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerPrefetch = useCallback(async () => {
    if (!enabled) return false;

    const success = await executePrefetch({
      queryClient,
      queryKey,
      queryFn,
      staleTime,
      gcTime,
      bypassSaveData,
    });

    if (success) {
      setIsPrefetched(true);
    }

    return success;
  }, [enabled, queryClient, queryKey, queryFn, staleTime, gcTime, bypassSaveData]);

  // 1. IntersectionObserver setup
  useEffect(() => {
    if (!enabled || !triggers.includes('intersect')) return;
    if (!shouldAllowPrefetch({ bypassSaveData })) return;

    const node = elementRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void triggerPrefetch();
            observer.unobserve(entry.target);
          }
        }
      },
      {
        rootMargin: intersectionRootMargin,
        threshold: intersectionThreshold,
      },
    );

    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [
    enabled,
    triggers,
    intersectionRootMargin,
    intersectionThreshold,
    bypassSaveData,
    triggerPrefetch,
  ]);

  // 2. Global pointer movement tracking before entry for velocity & trajectory gating
  useEffect(() => {
    if (!enabled || !triggers.includes('intent')) return;

    const handlePointerMove = (e: PointerEvent) => {
      const now = performance.now();
      const currentPos: CursorPosition = { x: e.clientX, y: e.clientY, timestamp: now };

      const history = cursorHistoryRef.current;
      history.push(currentPos);

      while (history.length > 0 && now - history[0].timestamp > 200) {
        history.shift();
      }

      const node = elementRef.current;
      if (!node) return;

      const rect = node.getBoundingClientRect();
      const { hasIntent } = calculateHoverIntent(history, rect, velocityThreshold);

      if (hasIntent) {
        if (!intentTimerRef.current) {
          intentTimerRef.current = setTimeout(() => {
            void triggerPrefetch();
            intentTimerRef.current = null;
          }, intentDelayMs);
        }
      } else {
        if (intentTimerRef.current) {
          clearTimeout(intentTimerRef.current);
          intentTimerRef.current = null;
        }
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      if (intentTimerRef.current) {
        clearTimeout(intentTimerRef.current);
        intentTimerRef.current = null;
      }
    };
  }, [enabled, triggers, velocityThreshold, intentDelayMs, triggerPrefetch]);

  // Event handlers for local events
  const onPointerMove = useCallback(
    (e: React.PointerEvent<TElement>) => {
      if (!enabled || !triggers.includes('intent')) return;

      const now = performance.now();
      const currentPos: CursorPosition = { x: e.clientX, y: e.clientY, timestamp: now };

      const history = cursorHistoryRef.current;
      history.push(currentPos);

      while (history.length > 0 && now - history[0].timestamp > 200) {
        history.shift();
      }

      const node = elementRef.current;
      if (!node) return;

      const rect = node.getBoundingClientRect();
      const { hasIntent } = calculateHoverIntent(history, rect, velocityThreshold);

      if (hasIntent) {
        if (!intentTimerRef.current) {
          intentTimerRef.current = setTimeout(() => {
            void triggerPrefetch();
            intentTimerRef.current = null;
          }, intentDelayMs);
        }
      } else {
        if (intentTimerRef.current) {
          clearTimeout(intentTimerRef.current);
          intentTimerRef.current = null;
        }
      }
    },
    [enabled, triggers, velocityThreshold, intentDelayMs, triggerPrefetch],
  );

  const onPointerEnter = useCallback(() => {
    if (!enabled) return;

    if (triggers.includes('hover')) {
      void triggerPrefetch();
    }
    // Intent trigger requires trajectory/velocity confirmation handled by pointer listeners
  }, [enabled, triggers, triggerPrefetch]);

  const onPointerLeave = useCallback(() => {
    if (intentTimerRef.current) {
      clearTimeout(intentTimerRef.current);
      intentTimerRef.current = null;
    }
  }, []);

  const onFocus = useCallback(() => {
    if (enabled && triggers.includes('focus')) {
      void triggerPrefetch();
    }
  }, [enabled, triggers, triggerPrefetch]);

  const onTouchStart = useCallback(() => {
    if (enabled && triggers.includes('touch')) {
      void triggerPrefetch();
    }
  }, [enabled, triggers, triggerPrefetch]);

  const setRef = useCallback((node: TElement | null) => {
    elementRef.current = node;
  }, []);

  return {
    ref: setRef,
    elementRef,
    prefetch: triggerPrefetch,
    isPrefetched,
    handlers: {
      onPointerEnter,
      onPointerLeave,
      onPointerMove,
      onFocus,
      onTouchStart,
    },
  };
}
