import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { sha256Hex } from '../lib/hash'
import { stellarAddressSchema } from '../lib/stellar'
import { decodeRegistryContractError } from '../lib/errors'
import { useWallet } from '../context/WalletContext'
import { submitCreateCommitment, fundTestnetAccount, type CreateCommitmentResult } from '../lib/soroban'
import UserProfile from './UserProfile'
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Wallet,
  Hash,
  UserCheck,
  FileText,
  Calendar,
  Zap
} from 'lucide-react'

export interface CreateCommitmentPayload {
  counterparty: string
  termsHash: string
  dueAt: number
}

interface CreateCommitmentWizardProps {
  onSubmit?: (payload: CreateCommitmentPayload) => void
  onSuccess?: (result: CreateCommitmentResult) => void
}

const commitmentFormSchema = z.object({
  counterparty: stellarAddressSchema,
  terms: z.string().min(3, 'Terms must be at least 3 characters').max(2000, 'Terms must not exceed 2000 characters'),
  dueAt: z
    .string()
    .min(1, 'Due date is required')
    .refine((value) => new Date(value).getTime() > Date.now(), {
      message: 'Due date must be set in the future',
    }),
})

type CommitmentFormValues = z.infer<typeof commitmentFormSchema>

const STEPS = [
  {
    title: 'Counterparty',
    subtitle: 'Who is the commitment owed to?',
    fields: ['counterparty'] as const,
  },
  {
    title: 'Terms & Conditions',
    subtitle: 'Describe the commitment in plain language',
    fields: ['terms'] as const,
  },
  {
    title: 'Deadline & Review',
    subtitle: 'Set the due date and confirm the details',
    fields: ['dueAt'] as const,
  },
]

const STEP_COUNT = STEPS.length

function clearErrorToasts(): void {
  document.getElementById('toast-container')?.querySelectorAll('.toast.error').forEach((toast) => {
    toast.remove()
  })
}

function showErrorToast(message: string): void {
  const container = document.getElementById('toast-container')
  if (!container) {
    return
  }

  clearErrorToasts()

  const toast = document.createElement('div')
  toast.className = 'toast error'
  toast.setAttribute('role', 'alert')
  toast.textContent = message
  container.appendChild(toast)
}

export default function CreateCommitmentWizard({ onSubmit, onSuccess }: CreateCommitmentWizardProps) {
  const { address: connectedAddress, isConnected, connectWallet } = useWallet()

  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [funding, setFunding] = useState(false)
  const [fundMessage, setFundMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [txResult, setTxResult] = useState<CreateCommitmentResult | null>(null)
  const [previewHash, setPreviewHash] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    trigger,
    watch,
    reset,
    formState: { errors },
  } = useForm<CommitmentFormValues>({
    resolver: zodResolver(commitmentFormSchema),
    mode: 'onChange',
    defaultValues: { counterparty: '', terms: '', dueAt: '' },
  })

  const values = watch()
  const dueAtMs = values.dueAt ? new Date(values.dueAt).getTime() : NaN
  const dueAtUnix = Number.isNaN(dueAtMs) ? null : Math.floor(dueAtMs / 1000)

  // Compute live SHA-256 hash when terms change
  useEffect(() => {
    if (values.terms && values.terms.trim().length > 0) {
      sha256Hex(values.terms).then((h) => setPreviewHash(h)).catch(() => setPreviewHash(null))
    } else {
      setPreviewHash(null)
    }
  }, [values.terms])

  const isSameAddress = Boolean(
    connectedAddress &&
    values.counterparty &&
    connectedAddress.trim().toUpperCase() === values.counterparty.trim().toUpperCase()
  )

  const handleFundWallet = async () => {
    if (!connectedAddress) return
    setFunding(true)
    setFundMessage(null)
    try {
      const ok = await fundTestnetAccount(connectedAddress)
      if (ok) {
        setFundMessage('Successfully requested 10,000 Testnet XLM from Friendbot!')
      } else {
        setFundMessage('Friendbot request submitted. Please check your balance in Freighter.')
      }
    } catch (e) {
      setFundMessage('Could not reach Friendbot automatically. You can also fund in Freighter extension settings.')
    } finally {
      setFunding(false)
    }
  }

  const handleNext = async () => {
    const valid = await trigger(STEPS[step].fields)
    if (valid) {
      setStep((current) => Math.min(current + 1, STEP_COUNT - 1))
    }
  }

  const handleBack = () => {
    setStep((current) => Math.max(current - 1, 0))
  }

  const handleFinalSubmit = handleSubmit(async (data) => {
    if (!isConnected || !connectedAddress) {
      showErrorToast('Please connect your Freighter wallet before submitting an on-chain commitment.')
      return
    }

    if (isSameAddress) {
      showErrorToast('Issuer and Counterparty addresses cannot be identical.')
      return
    }

    setSubmitting(true)
    clearErrorToasts()
    setTxResult(null)
    setStatusMessage('Preparing commitment data...')

    try {
      const termsHashHex = await sha256Hex(data.terms)
      const dueAtSeconds = Math.floor(new Date(data.dueAt).getTime() / 1000)

      onSubmit?.({
        counterparty: data.counterparty,
        termsHash: termsHashHex,
        dueAt: dueAtSeconds,
      })

      // Submit Soroban transaction to Stellar Testnet via Freighter
      const result = await submitCreateCommitment({
        issuerAddress: connectedAddress,
        counterpartyAddress: data.counterparty,
        termsHashHex,
        dueAtSeconds,
        onStatusUpdate: (msg: string) => setStatusMessage(msg),
      })

      setTxResult(result)
      onSuccess?.(result)
    } catch (err: unknown) {
      showErrorToast(decodeRegistryContractError(err))
    } finally {
      setSubmitting(false)
      setStatusMessage(null)
    }
  })

  const handleReset = () => {
    reset()
    setStep(0)
    setTxResult(null)
    clearErrorToasts()
    setPreviewHash(null)
    setStatusMessage(null)
    setFundMessage(null)
  }

  const isLastStep = step === STEP_COUNT - 1

  return (
    <div className="wizard">
      {/* Step Indicator */}
      <ol className="wizard-steps">
        {STEPS.map((s, index) => {
          const state = index === step ? 'active' : index < step ? 'done' : ''
          return (
            <li key={s.title} className={`wizard-step ${state}`}>
              <span className="wizard-step-dot">{index < step ? '✓' : index + 1}</span>
              <span className="wizard-step-label">{s.title}</span>
            </li>
          )
        })}
      </ol>

      <div className="wizard-progress">
        <div
          className="wizard-progress-fill"
          style={{ width: `${((step + 1) / STEP_COUNT) * 100}%` }}
        ></div>
      </div>

      {/* Success View */}
      {txResult ? (
        <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            background: '#f0fdf4',
            color: '#16a34a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px auto',
            border: '2px solid #bbf7d0'
          }}>
            <CheckCircle2 size={36} />
          </div>

          <h3 style={{ fontSize: '20px', fontWeight: '800', color: '#0f172a', margin: '0 0 6px 0' }}>
            Commitment Created On-Chain!
          </h3>
          <p style={{ fontSize: '13.5px', color: '#64748b', margin: '0 0 24px 0' }}>
            Your transaction has been confirmed on Stellar Testnet.
          </p>

          <div style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '14px',
            padding: '18px',
            textAlign: 'left',
            marginBottom: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}>
            {txResult.commitmentId !== undefined && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ color: '#64748b', fontWeight: '600' }}>Commitment ID:</span>
                <span style={{ fontWeight: '800', color: '#0f172a' }}>#{String(txResult.commitmentId)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', alignItems: 'center' }}>
              <span style={{ color: '#64748b', fontWeight: '600' }}>Tx Hash:</span>
              <span style={{ fontFamily: 'monospace', fontWeight: '700', color: '#334155' }}>
                {txResult.hash.substring(0, 10)}...{txResult.hash.substring(txResult.hash.length - 8)}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', alignItems: 'center' }}>
              <span style={{ color: '#64748b', fontWeight: '600' }}>Network:</span>
              <span style={{ fontSize: '11px', fontWeight: '800', color: '#16a34a', background: '#dcfce7', padding: '2px 8px', borderRadius: '100px' }}>
                Stellar Testnet
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${txResult.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                background: '#0f172a',
                color: '#ffffff',
                fontWeight: '700',
                fontSize: '13px',
                padding: '10px 18px',
                borderRadius: '10px',
                textDecoration: 'none'
              }}
            >
              View on Stellar Expert <ExternalLink size={14} />
            </a>
            <button
              onClick={handleReset}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                background: '#ffffff',
                border: '1px solid #cbd5e1',
                color: '#334155',
                fontWeight: '700',
                fontSize: '13px',
                padding: '10px 18px',
                borderRadius: '10px',
                cursor: 'pointer'
              }}
            >
              <RefreshCw size={14} /> Create Another
            </button>
          </div>
        </div>
      ) : (
        /* Wizard Card */
        <div className="card">
          <div className="card-header">
            <div className="card-title">{STEPS[step].title}</div>
          </div>
          <div className="card-body">
            {/* Wallet Status Banner with 1-Click Friendbot Fund Button */}
            <div style={{
              background: isConnected ? '#f0fdf4' : '#fff7ed',
              border: `1px solid ${isConnected ? '#bbf7d0' : '#fed7aa'}`,
              borderRadius: '12px',
              padding: '12px 16px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '10px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Wallet size={16} color={isConnected ? '#16a34a' : '#ea580c'} />
                <div>
                  <div style={{ fontSize: '11px', fontWeight: '800', color: isConnected ? '#15803d' : '#c2410c', textTransform: 'uppercase' }}>
                    {isConnected ? 'Issuer (Connected Wallet)' : 'Wallet Disconnected'}
                  </div>
                  <div style={{ fontSize: '12.5px', fontWeight: '700', color: '#0f172a', marginTop: '1px' }}>
                    {isConnected && connectedAddress ? (
                      <UserProfile address={connectedAddress} showAvatar={false} />
                    ) : (
                      'Connect Freighter wallet to submit on-chain'
                    )}
                  </div>
                </div>
              </div>

              {isConnected ? (
                <button
                  type="button"
                  onClick={handleFundWallet}
                  disabled={funding}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: '#ffffff',
                    border: '1px solid #bbf7d0',
                    color: '#15803d',
                    borderRadius: '8px',
                    padding: '6px 12px',
                    fontSize: '11.5px',
                    fontWeight: '700',
                    cursor: funding ? 'wait' : 'pointer'
                  }}
                  title="Fund account with 10,000 Testnet XLM via Friendbot"
                >
                  <Zap size={13} color="#16a34a" />
                  {funding ? 'Funding...' : 'Fund Testnet XLM'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => connectWallet()}
                  style={{
                    background: '#ea580c',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer'
                  }}
                >
                  Connect Wallet
                </button>
              )}
            </div>

            {fundMessage && (
              <div style={{
                marginBottom: '16px',
                background: '#f0fdf4',
                border: '1px solid #bbf7d0',
                borderRadius: '10px',
                padding: '10px 14px',
                fontSize: '12px',
                color: '#15803d',
                fontWeight: '600'
              }}>
                {fundMessage}
              </div>
            )}

            {step === 0 && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="wizard-counterparty" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <UserCheck size={14} color="#6366f1" /> Counterparty Address
                  </label>
                  <input
                    type="text"
                    className={`form-input ${errors.counterparty || isSameAddress ? 'has-error' : ''}`}
                    id="wizard-counterparty"
                    placeholder="G..."
                    autoComplete="off"
                    spellCheck="false"
                    disabled={submitting}
                    {...register('counterparty')}
                  />
                  {errors.counterparty ? (
                    <div className="form-error">{errors.counterparty.message}</div>
                  ) : isSameAddress ? (
                    <div className="form-error">Counterparty address cannot be identical to connected issuer address.</div>
                  ) : (
                    <div className="form-hint">The Stellar address to whom the commitment is owed. Must be a valid G... address.</div>
                  )}
                  {values.counterparty && !errors.counterparty && !isSameAddress && (
                    <div style={{ marginTop: '8px' }}>
                      <UserProfile address={values.counterparty} />
                    </div>
                  )}
                </div>
              </>
            )}

            {step === 1 && (
              <div className="form-group">
                <label className="form-label" htmlFor="wizard-terms" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <FileText size={14} color="#6366f1" /> Terms / Description
                </label>
                <textarea
                  className={`form-textarea ${errors.terms ? 'has-error' : ''}`}
                  id="wizard-terms"
                  placeholder="Describe the commitment terms in plain language. This will be hashed (SHA-256) before being stored on-chain."
                  disabled={submitting}
                  {...register('terms')}
                ></textarea>
                {errors.terms ? (
                  <div className="form-error">{errors.terms.message}</div>
                ) : (
                  <div className="form-hint">Stored as a SHA-256 hash on-chain. Keep a copy of the original off-chain.</div>
                )}
                {previewHash && (
                  <div style={{
                    marginTop: '8px',
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '11.5px',
                    color: '#475569'
                  }}>
                    <Hash size={13} color="#6366f1" />
                    <span style={{ fontWeight: '600' }}>SHA-256 Hash:</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: '700', wordBreak: 'break-all', color: '#0f172a' }}>
                      0x{previewHash}
                    </span>
                  </div>
                )}
              </div>
            )}

            {step === 2 && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="wizard-dueat" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Calendar size={14} color="#6366f1" /> Due Date
                  </label>
                  <input
                    type="datetime-local"
                    className={`form-input ${errors.dueAt ? 'has-error' : ''}`}
                    id="wizard-dueat"
                    disabled={submitting}
                    {...register('dueAt')}
                  />
                  {errors.dueAt ? (
                    <div className="form-error">{errors.dueAt.message}</div>
                  ) : (
                    <div className="form-hint">Must be a future date. Stored as a Unix timestamp on Stellar.</div>
                  )}
                </div>

                <div className="wizard-review">
                  <div className="wizard-review-title">Review Details</div>
                  <div className="detail-panel">
                    <div className="detail-row">
                      <span className="detail-key">Counterparty</span>
                      <span className="detail-val mono">{values.counterparty ? <UserProfile address={values.counterparty} /> : '—'}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Terms</span>
                      <span className="detail-val">{values.terms || '—'}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Due Date</span>
                      <span className="detail-val">
                        {values.dueAt ? new Date(values.dueAt).toLocaleString() : '—'}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Unix Ts</span>
                      <span className="detail-val mono">{dueAtUnix ?? '—'}</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* In-Flight Progress Banner */}
            {statusMessage && (
              <div style={{
                marginTop: '16px',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: '10px',
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                color: '#1d4ed8',
                fontSize: '12.5px',
                fontWeight: '600'
              }}>
                <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                <span>{statusMessage}</span>
              </div>
            )}

            <div className="wizard-nav" style={{ marginTop: '20px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleBack}
                disabled={step === 0 || submitting}
              >
                Back
              </button>

              {isLastStep ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: '1' }}
                  onClick={handleFinalSubmit}
                  disabled={submitting || !isConnected || isSameAddress}
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                      <span className="btn-text">Submitting to Soroban...</span>
                    </>
                  ) : isConnected ? (
                    <span className="btn-text">Create Commitment</span>
                  ) : (
                    <span className="btn-text">Connect Freighter to Submit</span>
                  )}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" style={{ flex: '1' }} onClick={handleNext}>
                  Continue
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8h10M9 4l4 4-4 4" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}