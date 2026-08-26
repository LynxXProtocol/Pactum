import React, { useState } from 'react';
import {
  X,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Terminal,
  Bug,
} from 'lucide-react';
import type { DecodedXdrError, DecodedDiagnosticEvent } from '@pactum/soroban-client';
import { decodeSorobanError, sanitizeErrorMessage } from '@pactum/soroban-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SorobanErrorModalProps {
  /** The raw error that was thrown */
  error: unknown;
  /** Optional diagnostic event blobs (base64-encoded XDR) from the simulation */
  diagnosticEventBlobs?: string[];
  /** Optional hint about which contract function was called */
  attemptedFunction?: string;
  /** Called when the user dismisses the modal */
  onDismiss: () => void;
  /** Optional callback to retry the transaction */
  onRetry?: () => void;
}

// ---------------------------------------------------------------------------
// Sub-Components
// ---------------------------------------------------------------------------

/**
 * Renders a single diagnostic event row with expandable details.
 */
const DiagnosticEventRow: React.FC<{ event: DecodedDiagnosticEvent }> = ({ event }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: '10px',
        marginBottom: '8px',
        overflow: 'hidden',
        background: event.inSuccessfulContractCall ? '#f0fdf4' : '#fff7ed',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: '10px 14px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: '12.5px',
          fontWeight: '600',
          color: event.inSuccessfulContractCall ? '#15803d' : '#c2410c',
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span
          style={{
            display: 'inline-block',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: event.inSuccessfulContractCall ? '#16a34a' : '#ea580c',
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }}>{event.summary}</span>
        {event.contractId && (
          <span
            style={{
              fontSize: '10px',
              fontWeight: '700',
              color: '#64748b',
              fontFamily: 'monospace',
              background: '#f8fafc',
              padding: '2px 6px',
              borderRadius: '4px',
            }}
          >
            {event.contractId.substring(0, 8)}...
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: '10px 14px 14px 34px',
            background: event.inSuccessfulContractCall ? '#f8fafc' : '#fff7ed',
            borderTop: '1px solid #e2e8f0',
            fontSize: '11.5px',
            color: '#475569',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div>
            <span style={{ fontWeight: '700', color: '#64748b' }}>Type: </span>
            <span>{event.type}</span>
          </div>
          {event.topics.length > 0 && (
            <div>
              <span style={{ fontWeight: '700', color: '#64748b' }}>Topics: </span>
              <div
                style={{
                  marginTop: '4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '3px',
                }}
              >
                {event.topics.map((topic, idx) => (
                  <code
                    key={idx}
                    style={{
                      display: 'block',
                      padding: '2px 6px',
                      background: '#f1f5f9',
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      wordBreak: 'break-all',
                    }}
                  >
                    [{idx}] {typeof topic === 'string' ? topic : JSON.stringify(topic)}
                  </code>
                ))}
              </div>
            </div>
          )}
          {event.data !== null && event.data !== undefined && (
            <div>
              <span style={{ fontWeight: '700', color: '#64748b' }}>Data: </span>
              <code
                style={{
                  display: 'block',
                  marginTop: '2px',
                  padding: '4px 6px',
                  background: '#f1f5f9',
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  wordBreak: 'break-all',
                }}
              >
                {JSON.stringify(event.data, null, 2)}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Renders the "attempted operation diff" section — shows what the contract
 * tried to do and where it failed.
 */
const AttemptedOperationDiff: React.FC<{
  op: NonNullable<DecodedXdrError['attemptedOperation']>;
}> = ({ op }) => {
  return (
    <div
      style={{
        border: '1px solid #bfdbfe',
        borderRadius: '10px',
        background: '#eff6ff',
        padding: '14px 16px',
        marginBottom: '16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '10px',
        }}
      >
        <Info size={16} color="#2563eb" />
        <span style={{ fontWeight: '800', fontSize: '13px', color: '#1e40af' }}>
          Attempted Operation
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          fontSize: '12.5px',
        }}
      >
        <div style={{ display: 'flex', gap: '6px' }}>
          <span style={{ fontWeight: '700', color: '#64748b', minWidth: '80px' }}>Function:</span>
          <code
            style={{
              fontFamily: 'monospace',
              fontWeight: '700',
              color: '#0f172a',
              background: '#dbeafe',
              padding: '1px 6px',
              borderRadius: '4px',
            }}
          >
            {op.operation}
          </code>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <span style={{ fontWeight: '700', color: '#64748b', minWidth: '80px' }}>Failed at:</span>
          <span style={{ color: '#dc2626', fontWeight: '600' }}>{op.failedAt}</span>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <span style={{ fontWeight: '700', color: '#64748b', minWidth: '80px' }}>Reason:</span>
          <span style={{ color: '#1e40af' }}>{op.trapReason}</span>
        </div>

        {Object.keys(op.arguments).length > 0 && (
          <div
            style={{
              marginTop: '6px',
              padding: '8px 10px',
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              fontFamily: 'monospace',
              fontSize: '11px',
            }}
          >
            <div
              style={{
                fontWeight: '700',
                color: '#64748b',
                marginBottom: '4px',
                fontSize: '11px',
              }}
            >
              Arguments:
            </div>
            {Object.entries(op.arguments).map(([key, value]) => (
              <div key={key} style={{ marginBottom: '2px' }}>
                <span style={{ color: '#6366f1', fontWeight: '600' }}>{key}:</span>{' '}
                <span style={{ color: '#334155' }}>
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const SorobanErrorModal: React.FC<SorobanErrorModalProps> = ({
  error,
  diagnosticEventBlobs = [],
  attemptedFunction = null,
  onDismiss,
  onRetry,
}) => {
  const [showRaw, setShowRaw] = useState(false);

  if (!error) return null;

  const decoded: DecodedXdrError = decodeSorobanError(
    error,
    diagnosticEventBlobs,
    attemptedFunction,
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10001,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        background: 'rgba(15, 23, 42, 0.5)',
        backdropFilter: 'blur(8px)',
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      {/* ── Modal Card ── */}
      <div
        style={{
          position: 'relative',
          maxWidth: '560px',
          width: '100%',
          maxHeight: '85vh',
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '20px',
          boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.2)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '24px 28px 16px 28px',
            borderBottom: '1px solid #f1f5f9',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
            <div
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '14px',
                background: '#fef2f2',
                color: '#dc2626',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                border: '1px solid #fecaca',
              }}
            >
              <AlertTriangle size={22} />
            </div>
            <div>
              <h3
                style={{
                  fontSize: '16px',
                  fontWeight: '800',
                  color: '#0f172a',
                  margin: '0 0 4px 0',
                  letterSpacing: '-0.02em',
                }}
              >
                Transaction Simulation Failed
              </h3>
              <p
                style={{
                  fontSize: '12.5px',
                  color: '#64748b',
                  margin: 0,
                  lineHeight: '1.4',
                }}
              >
                {decoded.message}
              </p>
            </div>
          </div>

          <button
            onClick={onDismiss}
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '50%',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#64748b',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Scrollable Body ── */}
        <div
          style={{
            overflowY: 'auto',
            padding: '20px 28px',
            flex: 1,
          }}
        >
          {/* Attempted Operation Diff */}
          {decoded.attemptedOperation && <AttemptedOperationDiff op={decoded.attemptedOperation} />}

          {/* Resolution Guidance */}
          {decoded.resolution && (
            <div
              style={{
                border: '1px solid #bbf7d0',
                borderRadius: '10px',
                background: '#f0fdf4',
                padding: '14px 16px',
                marginBottom: '16px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '4px',
                }}
              >
                <Info size={16} color="#16a34a" />
                <span
                  style={{
                    fontWeight: '800',
                    fontSize: '12.5px',
                    color: '#15803d',
                  }}
                >
                  Suggested Resolution
                </span>
              </div>
              <p
                style={{
                  fontSize: '12px',
                  color: '#166534',
                  margin: '4px 0 0 24px',
                  lineHeight: '1.5',
                }}
              >
                {decoded.resolution}
              </p>
            </div>
          )}

          {/* Diagnostic Events */}
          {decoded.diagnosticEvents.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '10px',
                }}
              >
                <Terminal size={15} color="#6366f1" />
                <span
                  style={{
                    fontWeight: '800',
                    fontSize: '12.5px',
                    color: '#4338ca',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Diagnostic Events ({decoded.diagnosticEvents.length})
                </span>
              </div>
              {decoded.diagnosticEvents.map((event, idx) => (
                <DiagnosticEventRow key={idx} event={event} />
              ))}
            </div>
          )}

          {/* Raw Error (collapsible) */}
          <div
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: '10px',
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => setShowRaw(!showRaw)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '10px 14px',
                background: '#f8fafc',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: '11.5px',
                fontWeight: '600',
                color: '#64748b',
              }}
            >
              {showRaw ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Bug size={13} />
              Raw Error Details
            </button>
            {showRaw && (
              <div style={{ padding: '12px 14px', borderTop: '1px solid #e2e8f0' }}>
                <pre
                  style={{
                    margin: 0,
                    fontSize: '11px',
                    fontFamily: 'monospace',
                    color: '#475569',
                    background: '#f8fafc',
                    padding: '10px',
                    borderRadius: '6px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: '200px',
                    overflowY: 'auto',
                  }}
                >
                  {sanitizeErrorMessage(decoded.rawError)}
                </pre>

                {decoded.rawXdrBlobs.length > 0 && (
                  <div style={{ marginTop: '8px' }}>
                    <div
                      style={{
                        fontWeight: '700',
                        fontSize: '10px',
                        color: '#94a3b8',
                        marginBottom: '4px',
                        textTransform: 'uppercase',
                      }}
                    >
                      Decoded XDR Blobs ({decoded.rawXdrBlobs.length})
                    </div>
                    {decoded.rawXdrBlobs.map((blob, idx) => (
                      <code
                        key={idx}
                        style={{
                          display: 'block',
                          fontSize: '10px',
                          color: '#6366f1',
                          wordBreak: 'break-all',
                          marginBottom: '4px',
                        }}
                      >
                        {blob.substring(0, 80)}
                        {blob.length > 80 ? '...' : ''}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            display: 'flex',
            gap: '10px',
            justifyContent: 'flex-end',
            padding: '16px 28px 24px 28px',
            borderTop: '1px solid #f1f5f9',
          }}
        >
          <button
            onClick={onDismiss}
            style={{
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              color: '#334155',
              fontWeight: '700',
              fontSize: '13px',
              padding: '10px 18px',
              borderRadius: '10px',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>

          {onRetry && (
            <button
              onClick={onRetry}
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
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Retry Transaction
            </button>
          )}

          <a
            href="https://developers.stellar.org/docs/smart-contracts/understanding-contract-errors"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              background: 'transparent',
              border: 'none',
              color: '#6366f1',
              fontWeight: '700',
              fontSize: '12px',
              padding: '10px 12px',
              cursor: 'pointer',
              textDecoration: 'none',
            }}
          >
            <ExternalLink size={12} />
            Soroban Docs
          </a>
        </div>
      </div>
    </div>
  );
};

export default SorobanErrorModal;
