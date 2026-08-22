import { useEffect, useRef, useCallback } from 'react'
import type { ValidationRequest, ValidationResponse } from '../workers/validation.worker'

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
    // Instantiate Vite Web Worker
    const worker = new Worker(new URL('../workers/validation.worker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = (event: MessageEvent<ValidationResponse>) => {
      console.log('[DEBUG] Worker onmessage:', event.data)
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
      for (const [id, callbacks] of pendingMapRef.current.entries()) {
        callbacks.resolve({
          isValid: false,
          error: 'WASM Web Worker initialization or execution failed.',
        })
        pendingMapRef.current.delete(id)
      }
    }

    workerRef.current = worker

    return () => {
      worker.terminate()
      workerRef.current = null
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

        console.log('[DEBUG] Posting to worker:', payload)
        workerRef.current.postMessage(payload)
      })
    },
    []
  )

  return { validateCommitmentWithWasm }
}
