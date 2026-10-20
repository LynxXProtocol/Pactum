import React from 'react';
import type { QueryFunction, QueryKey } from '@tanstack/react-query';

import { usePredictivePrefetch, type PrefetchTriggerMode } from '@/hooks/usePredictivePrefetch';

export interface PrefetchableCardProps<
  TData = unknown,
> extends React.HTMLAttributes<HTMLDivElement> {
  queryKey: QueryKey;
  queryFn: QueryFunction<TData>;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  bypassSaveData?: boolean;
  triggers?: PrefetchTriggerMode[];
  children: React.ReactNode;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

/**
 * A container card that automatically triggers predictive query prefetching
 * on viewport entry, hover intent, mouse enter, focus, or touch.
 */
export function PrefetchableCard<TData = unknown>({
  queryKey,
  queryFn,
  enabled = true,
  staleTime = 60_000,
  gcTime = 5 * 60_000,
  bypassSaveData = false,
  triggers = ['intersect', 'intent', 'hover', 'focus', 'touch'],
  children,
  className = '',
  onClick,
  onPointerEnter,
  onPointerLeave,
  onPointerMove,
  onFocus,
  onTouchStart,
  ...props
}: PrefetchableCardProps<TData>) {
  const { ref, handlers } = usePredictivePrefetch<HTMLDivElement, TData>({
    queryKey,
    queryFn,
    enabled,
    staleTime,
    gcTime,
    bypassSaveData,
    triggers,
  });

  return (
    <div
      ref={ref}
      className={className}
      onClick={onClick}
      onPointerEnter={(e) => {
        handlers.onPointerEnter();
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        handlers.onPointerLeave();
        onPointerLeave?.(e);
      }}
      onPointerMove={(e) => {
        handlers.onPointerMove(e);
        onPointerMove?.(e);
      }}
      onFocus={(e) => {
        handlers.onFocus();
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        handlers.onTouchStart();
        onTouchStart?.(e);
      }}
      {...props}
    >
      {children}
    </div>
  );
}
