import { useTranslation } from 'react-i18next'
import type { QueryKey } from '@tanstack/react-query'
import { AlertTriangle, X } from 'lucide-react'
import { useStateConflict } from '../hooks/useStateConflict'

export interface StateConflictBannerProps {
  queryKey: QueryKey
  className?: string
}

/** Warns that a concurrent on-chain change overrode this view's optimistic assumption. */
export function StateConflictBanner({ queryKey, className }: StateConflictBannerProps) {
  const { t } = useTranslation()
  const { conflict, clearConflict } = useStateConflict(queryKey)
  if (!conflict) return null

  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950 dark:text-amber-200 ${className ?? ''}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">{t('stateConflict.title')}</p>
        <p>{conflict.message}</p>
      </div>
      <button
        type="button"
        onClick={clearConflict}
        aria-label={t('wallet.dismiss')}
        className="shrink-0 opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
