import { useEffect, useRef, useCallback } from 'react'
import type { ValidationRequest, ValidationResponse } from '../workers/validation.worker'
// `?worker&url` (rather than the more common `new Worker(new URL('./x.ts', import.meta.url))`
// inline pattern) is Vite's explicit, non-fragile way to ask for a worker's *built* URL as a
// plain string: it still triggers the same worker-bundling Vite does for the inline pattern, but
// doesn't depend on Vite's static analysis recognizing a `new Worker(new URL(...))` call shape
// wherever it happens to appear in the code — which matters here because this hook doesn't call
// `new Worker(url)` directly (see below for why). With `base` set to this remote's own absolute
// origin (vite.config.ts), the resulting URL — and the wasm binary's own `?url` import inside
// the worker's bundled output — are both absolute, so they resolve correctly regardless of what
// origin the worker actually ends up executing from.
import workerScriptUrl from '../workers/validation.worker.ts?worker&url'

export interface WasmValidationResult {
  isValid: boolean
  error?: string
}

export function useWasmValidation() {
  const workerRef = useRef<Worker | null>(null)
  const pendingMapRef = useRef<Map<string, { resolve: (res: WasmValidationResult) => void; reject: (err: any) => void }>>(
    new Map()
  )

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null

    const setupFailureFallback = () => {
      for (const [id, callbacks] of pendingMapRef.current.entries()) {
        callbacks.resolve({
          isValid: false,
          error: 'WASM Web Worker initialization or execution failed.',
        })
        pendingMapRef.current.delete(id)
      }
    }

    // `new Worker(crossOriginUrl)` is blocked by the browser's same-origin policy: this remote
    // is loaded into the host over Module Federation, so its own script URLs (this one
    // included) are cross-origin relative to the page (a different remote entry port in dev, or
    // a different deployment host in production). Fetching the script ourselves and
    // constructing the worker from a same-origin `blob:` URL is the standard workaround — blob
    // URLs are exempt from that restriction regardless of where the underlying bytes came from.
    // (The worker's own internal asset references stay correct across that origin switch
    // because they're absolute — see the `?worker&url` import comment above.)
    fetch(workerScriptUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch validation worker script: ${res.status}`)
        return res.text()
      })
      .then((scriptText) => {
        if (cancelled) return

        objectUrl = URL.createObjectURL(new Blob([scriptText], { type: 'text/javascript' }))
        const worker = new Worker(objectUrl, { type: 'module' })

        worker.onmessage = (event: MessageEvent<ValidationResponse>) => {
          const { id, isValid, error } = event.data
          const callbacks = pendingMapRef.current.get(id)
          if (callbacks) {
            callbacks.resolve({ isValid, error })
            pendingMapRef.current.delete(id)
          }
        }

        worker.onerror = (err) => {
          console.error('[WasmValidationWorker Error]', err)
          // Resolve pending calls as invalid with worker failure error to safely fail closed
          setupFailureFallback()
        }

        workerRef.current = worker
      })
      .catch((err) => {
        console.error('[WasmValidationWorker] Failed to start worker:', err)
        setupFailureFallback()
      })

    return () => {
      cancelled = true
      workerRef.current?.terminate()
      workerRef.current = null
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [])

  const validateCommitmentWithWasm = useCallback(
    (dueAt: number, currentTime: number = Math.floor(Date.now() / 1000), milestoneCount: number = 1): Promise<WasmValidationResult> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          resolve({ isValid: false, error: 'WASM validation worker is unavailable.' })
          return
        }

        const id = Math.random().toString(36).substring(2, 9)
        pendingMapRef.current.set(id, { resolve, reject })

        const payload: ValidationRequest = {
          id,
          dueAt,
          currentTime,
          milestoneCount,
        }

        workerRef.current.postMessage(payload)
      })
    },
    []
  )

  return { validateCommitmentWithWasm }
}
