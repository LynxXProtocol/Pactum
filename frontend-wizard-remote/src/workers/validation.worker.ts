import initWasm, { validate_commitment_params } from '../wasm/pactum-validation/pactum_validation.js'
import wasmUrl from '../wasm/pactum-validation/pactum_validation_bg.wasm?url'

export interface ValidationRequest {
  id: string
  dueAt: number
  currentTime: number
  milestoneCount: number
}

export interface ValidationResponse {
  id: string
  isValid: boolean
  error?: string
}

let wasmInitialized = false
let initPromise: Promise<void> | null = null

async function ensureWasmInitialized(): Promise<void> {
  if (wasmInitialized) return
  if (!initPromise) {
    initPromise = initWasm(wasmUrl).then(() => {
      wasmInitialized = true
    })
  }
  await initPromise
}

self.onmessage = async (event: MessageEvent<ValidationRequest>) => {
  const { id, dueAt, currentTime, milestoneCount } = event.data
  try {
    await ensureWasmInitialized()
    validate_commitment_params(BigInt(dueAt), BigInt(currentTime), milestoneCount)
    const response: ValidationResponse = { id, isValid: true }
    self.postMessage(response)
  } catch (err: any) {
    const errorMsg = typeof err === 'string' ? err : err?.message || 'WASM validation failed.'
    const response: ValidationResponse = { id, isValid: false, error: errorMsg }
    self.postMessage(response)
  }
}
