import { Loader2, X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { SimulationPreview } from '../lib/soroban';

interface SimulationPreviewModalProps {
  preview: SimulationPreview | null;
  onConfirm: () => void;
  onCancel: () => void;
  isOpen: boolean;
}

export default function SimulationPreviewModal({ preview, onConfirm, onCancel, isOpen }: SimulationPreviewModalProps) {
  if (!isOpen) return null;
  const isLoading = preview === null;
  const isSuccess = preview?.success === true;
  const cost = preview?.cost;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sim-modal-title"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: 'rgba(2, 6, 23, 0.72)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{ background: '#ffffff', borderRadius: '20px', boxShadow: '0 32px 80px rgba(0,0,0,0.28)', width: '100%', maxWidth: '480px', overflow: 'hidden', animation: 'slideUp 0.22s cubic-bezier(0.34,1.56,0.64,1)' }}>
        <div style={{ background: isLoading ? 'linear-gradient(135deg, #1e1b4b, #4338ca)' : isSuccess ? 'linear-gradient(135deg, #14532d, #22c55e)' : 'linear-gradient(135deg, #7f1d1d, #dc2626)', padding: '24px 24px 20px', position: 'relative' }}>
          <button type="button" onClick={onCancel} aria-label="Close preview modal" style={{ position: 'absolute', top: '16px', right: '16px', background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '8px', color: '#fff', width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <X size={15} />
          </button>
          <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: 'rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '14px' }}>
            {isLoading ? <Loader2 size={24} color="#ffffff" style={{ animation: 'spin 1s linear infinite' }} /> : isSuccess ? <CheckCircle2 size={24} color="#ffffff" /> : <AlertTriangle size={24} color="#ffffff" />}
          </div>
          <h2 id="sim-modal-title" style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#ffffff' }}>
            {isLoading ? 'Simulating Transaction' : isSuccess ? 'Transaction Preview' : 'Transaction Would Fail'}
          </h2>
          <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: 'rgba(255,255,255,0.8)' }}>
            {isLoading ? 'Evaluating contract execution on Soroban RPC...' : isSuccess ? 'Preflight simulation succeeded. Review estimated costs below.' : 'Simulation encountered an error. The transaction cannot be executed.'}
          </p>
        </div>

        <div style={{ padding: '20px 24px 24px' }}>
          {isLoading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '24px 0', color: '#4338ca', fontSize: '14px', fontWeight: '600' }}>
              <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /> Simulating transaction...
            </div>
          )}

          {!isLoading && !isSuccess && (
            <div style={{ marginBottom: '18px' }}>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#991b1b', marginBottom: '8px' }}>Error Details:</div>
              <code style={{ display: 'block', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px', fontSize: '12px', color: '#b91c1c', wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: '160px', overflowY: 'auto' }}>
                {preview?.error || 'Simulation failed with unknown error.'}
              </code>
            </div>
          )}

          {!isLoading && isSuccess && cost && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '10px 14px' }}>
                <div style={{ fontSize: '11px', fontWeight: '800', color: '#64748b', textTransform: 'uppercase', marginBottom: '2px' }}>Fee</div>
                <div style={{ fontSize: '13px', fontWeight: '700', color: '#0f172a' }}>Estimated Fee: {cost.feeXlm} XLM ({cost.feeStroops} stroops)</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '10px 14px' }}>
                <div style={{ fontSize: '11px', fontWeight: '800', color: '#64748b', textTransform: 'uppercase', marginBottom: '2px' }}>Resources</div>
                <div style={{ fontSize: '12.5px', color: '#334155', fontWeight: '600' }}>CPU: {cost.cpuInsns} instructions | Memory: {cost.memBytes} bytes</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '10px 14px' }}>
                <div style={{ fontSize: '11px', fontWeight: '800', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Required Authorizations</div>
                {preview.requiredAuths.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {preview.requiredAuths.map((auth, idx) => (
                      <div key={idx} style={{ fontSize: '11.5px', fontFamily: 'monospace', color: '#0f172a', background: '#e2e8f0', padding: '2px 6px', borderRadius: '4px' }}>
                        {auth}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: '#64748b' }}>None</div>
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" id="sim-modal-cancel" onClick={onCancel} style={{ flex: 1, padding: '11px', borderRadius: '10px', border: '1px solid #e2e8f0', background: '#ffffff', color: '#334155', fontWeight: '700', fontSize: '13px', cursor: 'pointer' }}>
              Cancel
            </button>
            {!isLoading && isSuccess && (
              <button type="button" id="sim-modal-confirm" onClick={onConfirm} style={{ flex: 2, padding: '11px', borderRadius: '10px', border: 'none', background: 'linear-gradient(135deg, #15803d, #22c55e)', color: '#ffffff', fontWeight: '800', fontSize: '13px', cursor: 'pointer' }}>
                Sign & Submit
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
