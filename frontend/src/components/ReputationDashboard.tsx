import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import UserProfile from './UserProfile';
import { fetchCommitments, type CommitmentFilters, type CommitmentStatus, type Reputation, exportCommitments } from '../lib/api';
import { fetchVerifiedReputation, type ReputationIntegrity } from '../lib/verifiedReputation';
import {
  ChevronDown,
  ChevronUp,
  Layers,
  Sparkles,
} from 'lucide-react';

export interface CommitmentItem {
  id: number;
  issuer: string;
  counterparty: string;
  terms_hash: string;
  due_at: number;
  status: CommitmentStatus;
  created_at: number;
  attested_at: number | null;
  description?: string;
  notes?: string[];
  isExpanded?: boolean;
}

export interface ReputationDashboardProps {
  initialAddress?: string;
  onNavigateAddress?: (address: string) => void;
  onLaunchCreate?: () => void;
  commitments?: CommitmentItem[];
}

const STATUS_CONFIG: Record<
  CommitmentStatus,
  { label: string; bg: string; color: string; border: string; dotColor: string }
> = {
  Fulfilled: { label: 'Fulfilled', bg: '#dcfce7', color: '#15803d', border: '#bbf7d0', dotColor: '#22c55e' },
  Late: { label: 'Late', bg: '#fef3c7', color: '#b45309', border: '#fde68a', dotColor: '#f59e0b' },
  Breached: { label: 'Breached', bg: '#ffe4e6', color: '#be123c', border: '#fecdd3', dotColor: '#ef4444' },
  Pending: { label: 'Pending', bg: '#f1f5f9', color: '#475569', border: '#e2e8f0', dotColor: '#94a3b8' },
  Disputed: { label: 'Disputed', bg: '#f3e8ff', color: '#7e22ce', border: '#e9d5ff', dotColor: '#a855f7' },
};

const BASE_ADDRESS_1 = 'GAJKUMA6V4MJKQPFM4MXNMWQZX3CTMK2KMMCSZQPK5JXBZWBZM7S4C';
const BASE_ADDRESS_2 = 'GB4UFBX57KE2RPEXB4NCPQHXL5UZL7HSFBVQ2YEZQDZ2DXR2X3CHHZX';
const BASE_ADDRESS_3 = 'GCJUKUMADK5PKZF7MCQBBNLRH2AIZQPK5JXBZWBZM7S4CGAJKUMA6V4';
const BASE_ADDRESS_4 = 'GD7H8K9L0M1N2P3Q4R5S6T7U8V9W0X1Y2Z3A4B5C6D7E8F9G0H1I2J3K4L';
const POWER_USER_ADDRESS = 'GPOWERUSERVIRTUALIZEDLISTTEST999999999999999999999999999999';

// Base demo commitments with dynamic text lengths
const DEMO_COMMITMENTS: CommitmentItem[] = [
  {
    id: 1,
    issuer: BASE_ADDRESS_1,
    counterparty: BASE_ADDRESS_2,
    terms_hash: 'a3f9c1d2e4b5678901234567890abcdef1234567890abcdef1234567890ab',
    due_at: Math.floor(Date.now() / 1000) - 86400 * 5,
    status: 'Fulfilled',
    created_at: Math.floor(Date.now() / 1000) - 86400 * 20,
    attested_at: Math.floor(Date.now() / 1000) - 86400 * 4,
    description:
      'Deliver 500 validated oracle data points across Stellar Soroban testnet validators on time and verify deterministic quorum proofs.',
    notes: [
      'Milestone 1 completed 10 days prior',
      'Security audit signoff attached',
      'Final cryptographic checksum: 0x99a4c1',
    ],
  },
  {
    id: 2,
    issuer: BASE_ADDRESS_1,
    counterparty: BASE_ADDRESS_3,
    terms_hash: 'b7e2d1c3f5a6789012345678901abcdef234567890abcdef234567890abc',
    due_at: Math.floor(Date.now() / 1000) - 86400 * 10,
    status: 'Breached',
    created_at: Math.floor(Date.now() / 1000) - 86400 * 30,
    attested_at: Math.floor(Date.now() / 1000) - 86400 * 8,
    description:
      'Provide 99.99% uptime on cross-border liquidity pool balancer during high volatility window.',
    notes: [
      'Node downtime detected at ledger sequence 48102',
      'Dispute period elapsed without counter-proof',
    ],
  },
  {
    id: 3,
    issuer: BASE_ADDRESS_2,
    counterparty: BASE_ADDRESS_1,
    terms_hash: 'c8f3e2d4a6b7890123456789012abcdef345678901abcdef345678901abcd',
    due_at: Math.floor(Date.now() / 1000) - 86400 * 2,
    status: 'Fulfilled',
    created_at: Math.floor(Date.now() / 1000) - 86400 * 15,
    attested_at: Math.floor(Date.now() / 1000) - 86400 * 1,
    description:
      'Settle multi-sig escrow release within 48 hours of asset bridge lock notification.',
    notes: ['Transaction hash confirmed on Soroban RPC'],
  },
  {
    id: 4,
    issuer: BASE_ADDRESS_3,
    counterparty: BASE_ADDRESS_2,
    terms_hash: 'd9a4f3e5b7c8901234567890123abcdef456789012abcdef456789012abcde',
    due_at: Math.floor(Date.now() / 1000) + 86400 * 8,
    status: 'Pending',
    created_at: Math.floor(Date.now() / 1000) - 86400 * 2,
    attested_at: null,
    description:
      'Monthly protocol maintenance commitment covering Soroban smart contract upgrades and state snapshot archiving.',
  },
  {
    id: 5,
    issuer: BASE_ADDRESS_1,
    counterparty: BASE_ADDRESS_4,
    terms_hash: 'e0b5f4e6c8d9012345678901234abcdef56789012abcdef56789012abcdef',
    due_at: Math.floor(Date.now() / 1000) - 86400 * 1,
    status: 'Late',
    created_at: Math.floor(Date.now() / 1000) - 86400 * 12,
    attested_at: Math.floor(Date.now() / 1000),
    description: 'Submit end-of-cycle risk assessment report to governance council.',
    notes: [
      'Delayed by 24 hours due to upstream indexer latency',
    ],
  },
];

function generateLargeDataset(count: number, targetAddress: string): CommitmentItem[] {
  const statuses: CommitmentItem['status'][] = ['Fulfilled', 'Late', 'Breached', 'Pending', 'Disputed'];
  const counterparties = [BASE_ADDRESS_1, BASE_ADDRESS_2, BASE_ADDRESS_3, BASE_ADDRESS_4];
  const sampleDescriptions = [
    'Deliver 500 validated oracle data points across Stellar Soroban testnet validators on time.',
    'Provide 99.99% uptime on cross-border liquidity pool balancer during high volatility window with continuous telemetry monitoring.',
    'Short term liquidity deposit.',
    'Multi-party cryptographic settlement and dispute mediation protocol execution with variable delay conditions and secondary attestations required by counterparty.',
    'Execute algorithmic token swap on DEX aggregator.',
    'Provide 24/7 technical on-call response for bridge relayer architecture including emergency pause key rotation and key recovery protocol verification.',
  ];

  const now = Math.floor(Date.now() / 1000);
  const items: CommitmentItem[] = [];

  for (let i = 1; i <= count; i++) {
    const isIssuer = i % 2 === 0;
    const status = statuses[i % statuses.length];
    const cp = counterparties[i % counterparties.length];
    const desc = sampleDescriptions[i % sampleDescriptions.length];

    items.push({
      id: 1000 + i,
      issuer: isIssuer ? targetAddress : cp,
      counterparty: isIssuer ? cp : targetAddress,
      terms_hash: `hash_${i.toString().padStart(6, '0')}_${(i * 31337).toString(16).padEnd(32, '0')}`,
      due_at: now - (count - i) * 3600,
      status,
      created_at: now - (count - i) * 7200,
      attested_at: status !== 'Pending' ? now - (count - i) * 1800 : null,
      description: `[#${1000 + i}] ${desc}`,
      notes: i % 3 === 0 ? [`Audit trail verified for batch ${i}`, `Ledger index #${50000 + i}`] : undefined,
    });
  }

  return items;
}

const PRESETS = [
  {
    label: 'Issuer Demo (GAJK...)',
    address: 'GAJKUMA6V4MJKQPFM4MXNMWQZX3CTMK2KMMCSZQPK5JXBZWBZM7S4C',
  },
  {
    label: 'Counterparty (GB4U...)',
    address: 'GB4UFBX57KE2RPEXB4NCPQHXL5UZL7HSFBVQ2YEZQDZ2DXR2X3CHHZX',
  },
  {
    label: 'Empty Account (GNEW...)',
    address: 'GNEWADDRESSWITHNOCOMMITMENTSHISTORY123456789012345678',
  },
];

export const ReputationDashboard: React.FC<ReputationDashboardProps> = ({
  initialAddress = BASE_ADDRESS_1,
  onNavigateAddress,
  onLaunchCreate,
  commitments: externalCommitments,
}) => {
  const [searchQuery, setSearchQuery] = useState(initialAddress);
  const [activeAddress, setActiveAddress] = useState(initialAddress);
  const [isLoading, setIsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);

  // Pagination & Data State
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [reputationIntegrity, setReputationIntegrity] = useState<ReputationIntegrity | null>(null);
  const [securityWarning, setSecurityWarning] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isFetchingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const itemsPerPage = 50;

  // Dynamic commitment items state (allows dynamic expansion, async note updates, etc.)
  const [commitmentsState, setCommitmentsState] = useState<CommitmentItem[]>(() => {
    if (externalCommitments) return externalCommitments;
    return DEMO_COMMITMENTS;
  });

  // Expanded items state by item ID
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // Dynamic measurement cache: stores measured heights by commitment item ID
  const dynamicSizeCacheRef = useRef<Map<number, number>>(new Map());
  const lastCacheSizeRef = useRef(0);
  const [cachedCount, setCachedCount] = useState(0);

  // Container viewport ref for virtualizer
  const parentRef = useRef<HTMLDivElement>(null);

  // Sync external commitments if provided
  useEffect(() => {
    if (externalCommitments) {
      setCommitmentsState(externalCommitments);
    }
  }, [externalCommitments]);

  // Handle address changes and generate power-user data if requested
  useEffect(() => {
    if (initialAddress && initialAddress !== activeAddress) {
      setSearchQuery(initialAddress);
      setActiveAddress(initialAddress);
    }
  }, [initialAddress, activeAddress]);

  const triggerAddressChange = useCallback((addr: string) => {
    if (addr === activeAddress && !isLoading) {
      setSearchQuery(addr);
      return;
    }
    abortRef.current?.abort();
    setIsLoading(true);
    setActiveAddress(addr);
    setSearchQuery(addr);
    setReputation(null);
    setReputationIntegrity(null);
    setSecurityWarning(null);
    setCommitmentsState([]);
    setPage(1);
    setHasMore(true);

    if (addr === POWER_USER_ADDRESS) {
      const generated = generateLargeDataset(500, POWER_USER_ADDRESS);
      setCommitmentsState(generated);
      dynamicSizeCacheRef.current.clear();
      lastCacheSizeRef.current = 0;
      setCachedCount(0);
      setIsLoading(false);
    } else if (!externalCommitments) {
      setCommitmentsState(DEMO_COMMITMENTS);
    }

    if (onNavigateAddress) {
      onNavigateAddress(addr);
    }
  }, [activeAddress, isLoading, externalCommitments, onNavigateAddress]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    triggerAddressChange(searchQuery.trim());
  };

  const loadCommitments = React.useCallback(
    async (pageNum: number, isAppend = false, signal?: AbortSignal) => {
      const filters: CommitmentFilters = {
        address: activeAddress,
        status: statusFilter === 'All' ? undefined : (statusFilter as CommitmentStatus),
        page: pageNum,
        limit: itemsPerPage,
      };
      const data = await fetchCommitments(filters, signal);

      if (signal?.aborted) return;
      const mapped: CommitmentItem[] = data.map((c) => ({
        id: c.id,
        issuer: c.issuer,
        counterparty: c.counterparty,
        terms_hash: c.terms_hash,
        due_at: c.due_at,
        status: c.status,
        created_at: c.created_at ?? Math.floor(Date.now() / 1000),
        attested_at: c.attested_at ?? (c.status === 'Fulfilled' || c.status === 'Late' || c.status === 'Breached' ? c.due_at : null),
      }));
      setCommitmentsState((prev) => (isAppend ? [...prev, ...mapped] : mapped));
      setHasMore(data.length === itemsPerPage);
      return data;
    },
    [activeAddress, statusFilter],
  );

  const loadMore = React.useCallback(async () => {
    if (isLoading || isFetchingRef.current || !hasMore) return;
    isFetchingRef.current = true;
    setIsFetchingMore(true);
    setFetchError(null);

    try {
      const nextPage = page + 1;
      await loadCommitments(nextPage, true, abortRef.current?.signal);
      setPage(nextPage);
    } catch (error) {
      setFetchError('Failed to load more commitments. Please try again.');
      console.error('Load more error:', error);
    } finally {
      setIsFetchingMore(false);
      isFetchingRef.current = false;
    }
  }, [isLoading, hasMore, page, loadCommitments]);

  const addressCommitments = useMemo(() => {
    return commitmentsState.filter(
      (c) => c.issuer === activeAddress || c.counterparty === activeAddress,
    );
  }, [commitmentsState, activeAddress]);

  const filteredCommitments = useMemo(() => {
    return addressCommitments.filter((c) => {
      if (statusFilter === 'All') return true;
      return c.status === statusFilter;
    });
  }, [addressCommitments, statusFilter]);

  const estimateItemSize = useCallback(
    (index: number) => {
      const item = filteredCommitments[index];
      if (!item) return 120;

      const cached = dynamicSizeCacheRef.current.get(item.id);
      if (cached !== undefined && cached > 0) {
        return cached;
      }

      let estimate = 110;
      if (item.description) {
        const lines = Math.ceil(item.description.length / 60);
        estimate += Math.max(0, (lines - 1) * 20);
      }
      if (expandedIds.has(item.id)) {
        estimate += 120;
      }
      return estimate;
    },
    [filteredCommitments, expandedIds],
  );

  const rowVirtualizer = useVirtualizer({
    count: filteredCommitments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: estimateItemSize,
    getItemKey: (index: number) => filteredCommitments[index]?.id ?? index,
    overscan: 5,
    measureElement: (element) => {
      if (!element) return 0;
      return element.getBoundingClientRect().height;
    },
  });

  useEffect(() => {
    const size = dynamicSizeCacheRef.current.size;
    if (size !== lastCacheSizeRef.current) {
      lastCacheSizeRef.current = size;
      setCachedCount(size);
    }
  }, []);

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const triggerAsyncUpdate = useCallback((id: number) => {
    if (!import.meta.env.DEV) return;
    setCommitmentsState((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          const asyncNote = `[Dev Note @ ${new Date().toLocaleTimeString()}]: Dynamic height change test for commitment #${id}.`;
          const currentNotes = item.notes || [];
          return {
            ...item,
            notes: [...currentNotes, asyncNote],
          };
        }
        return item;
      }),
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    const initializeData = async () => {
      setIsLoading(true);
      try {
        // Demo addresses have no backend proof; skip verification and use placeholder reputation
        const demoAddresses = [BASE_ADDRESS_1, BASE_ADDRESS_2, BASE_ADDRESS_3, BASE_ADDRESS_4];
        if (demoAddresses.includes(activeAddress)) {
          // Provide dummy reputation data for demo accounts
          setReputation({
            address: activeAddress,
            fulfilled: 0,
            late: 0,
            breached: 0,
            total: 0,
          });
          setReputationIntegrity('verified');
          setSecurityWarning(null);
          await loadCommitments(1, false, signal);
        } else {
          const verifiedResult = await fetchVerifiedReputation(activeAddress, signal);

          if (!signal.aborted) {
            setReputation(verifiedResult.reputation);
            setReputationIntegrity(verifiedResult.integrity);
            setSecurityWarning(verifiedResult.warning ?? null);

            if (verifiedResult.integrity === 'verified') {
              await loadCommitments(1, false, signal);
            } else {
              setCommitmentsState([]);
              setHasMore(false);
            }
          }
        }
      } catch (err: unknown) {
        const error = err as Error;
        if (error.name !== 'AbortError') {
          console.error('Initialization error:', error);
        }
      } finally {
        if (!signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    initializeData();

    return () => controller.abort();
  }, [activeAddress, statusFilter, loadCommitments]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0.1 },
    );

    if (bottomRef.current) {
      observer.observe(bottomRef.current);
    }

    return () => observer.disconnect();
  }, [hasMore, isFetchingMore, loadMore]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalCount = reputation?.total ?? 0;
  const fulfilledCount = reputation?.fulfilled ?? 0;
  const lateCount = reputation?.late ?? 0;
  const breachedCount = reputation?.breached ?? 0;
  const calculatedPending = reputation
    ? reputation.total - (reputation.fulfilled + reputation.late + reputation.breached)
    : 0;
  const fulfillmentRate = totalCount > 0 ? Math.round((fulfilledCount / totalCount) * 100) : 0;

  const strokeDashoffset = 226 - (226 * fulfillmentRate) / 100;

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', color: '#1e293b' }}>
      {securityWarning && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            background: '#450a0a',
            color: '#fee2e2',
            border: '2px solid #ef4444',
            borderRadius: '16px',
            padding: '16px 20px',
            marginBottom: '20px',
            fontSize: '14px',
            fontWeight: '700',
            lineHeight: 1.5,
          }}
        >
          {securityWarning}
        </div>
      )}

      {reputationIntegrity && !securityWarning && (
        <div
          role="status"
          style={{
            background: '#ecfdf5',
            color: '#065f46',
            border: '1px solid #6ee7b7',
            borderRadius: '12px',
            padding: '10px 14px',
            marginBottom: '20px',
            fontSize: '13px',
            fontWeight: '700',
          }}
        >
          Cryptographic proof verified against the latest Soroban ledger.
        </div>
      )}
      {/* ── Search Bar Section ── */}
      <div
        style={{
          background: 'rgba(255, 255, 255, 0.6)',
          backdropFilter: 'saturate(180%) blur(40px)',
          WebkitBackdropFilter: 'saturate(180%) blur(40px)',
          border: '1px solid rgba(255, 255, 255, 0.8)',
          borderRadius: '24px',
          padding: '20px 24px',
          marginBottom: '24px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.04)',
        }}
      >
        <form
          onSubmit={handleSearchSubmit}
          style={{ display: 'flex', gap: '12px', alignItems: 'center' }}
        >
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              background: '#f8fafc',
              border: '1.5px solid #cbd5e1',
              borderRadius: '12px',
              padding: '10px 16px',
              transition: 'border-color 0.2s ease',
            }}
          >
            <svg
              width="18"
              height="18"
              fill="none"
              stroke="#64748b"
              strokeWidth="2"
              strokeLinecap="round"
              style={{ marginRight: '12px', flexShrink: 0 }}
            >
              <circle cx="8" cy="8" r="6" />
              <path d="M16 16l-3.5-3.5" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search Stellar account address (G...)"
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#0f172a',
                fontFamily: 'monospace',
                fontSize: '13.5px',
                fontWeight: '600',
              }}
            />
          </div>

          <button
            type="submit"
            style={{
              background: '#1d1d1f',
              color: '#ffffff',
              border: 'none',
              borderRadius: '9999px',
              padding: '12px 24px',
              fontSize: '13.5px',
              fontWeight: '500',
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              transition: 'transform 0.15s ease, background 0.15s ease',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-1px)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0)')}
          >
            Lookup Account
          </button>
        </form>

        {/* Quick Preset Pills */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginTop: '14px',
            paddingTop: '14px',
            borderTop: '1px solid #f1f5f9',
          }}
        >
          <span
            style={{
              fontSize: '11px',
              fontWeight: '800',
              color: '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Quick Presets:
          </span>
          {PRESETS.map((preset) => (
            <button
              key={preset.address}
              onClick={() => triggerAddressChange(preset.address)}
              style={{
                fontSize: '12px',
                fontFamily: 'monospace',
                padding: '6px 14px',
                borderRadius: '100px',
                border:
                  activeAddress === preset.address ? '1.5px solid #6366f1' : '1px solid #e2e8f0',
                background: activeAddress === preset.address ? '#e0e7ff' : '#f8fafc',
                color: activeAddress === preset.address ? '#3730a3' : '#475569',
                fontWeight: activeAddress === preset.address ? '700' : '500',
                cursor: 'pointer',
                transition: 'all 0.16s ease',
                boxShadow:
                  activeAddress === preset.address ? '0 2px 8px rgba(99,102,241,0.18)' : 'none',
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Export Buttons ── */}
      {activeAddress && (
        <div
          style={{
            display: 'flex',
            gap: '10px',
            marginBottom: '24px',
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={() => exportCommitments(activeAddress, 'csv')}
            title="Download commitment history as CSV"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: '#f8fafc',
              border: '1.5px solid #e2e8f0',
              borderRadius: '12px',
              padding: '10px 18px',
              fontSize: '13px',
              fontWeight: '600',
              color: '#1e293b',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#6366f1';
              e.currentTarget.style.background = '#eef2ff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#e2e8f0';
              e.currentTarget.style.background = '#f8fafc';
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export CSV
          </button>
          <button
            onClick={() => exportCommitments(activeAddress, 'pdf')}
            title="Download commitment history as PDF"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: '#f8fafc',
              border: '1.5px solid #e2e8f0',
              borderRadius: '12px',
              padding: '10px 18px',
              fontSize: '13px',
              fontWeight: '600',
              color: '#1e293b',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#6366f1';
              e.currentTarget.style.background = '#eef2ff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#e2e8f0';
              e.currentTarget.style.background = '#f8fafc';
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            Export PDF
          </button>
        </div>
      )}

      {/* ── Light Pastel Hero Identity Card ── */}
      <div
        style={{
          background: 'rgba(255, 255, 255, 0.6)',
          backdropFilter: 'saturate(180%) blur(40px)',
          WebkitBackdropFilter: 'saturate(180%) blur(40px)',
          border: '1px solid rgba(255, 255, 255, 0.8)',
          borderRadius: '24px',
          padding: '26px 32px',
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '24px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
          <div>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}
            >
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#6366f1',
                }}
              >
                Stellar Account Record
              </span>
              <span
                style={{
                  fontSize: '11px',
                  background: '#dcfce7',
                  color: '#15803d',
                  fontWeight: '700',
                  padding: '3px 10px',
                  borderRadius: '100px',
                  border: '1px solid #bbf7d0',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: '#22c55e',
                  }}
                ></span>
                Stellar Testnet Live
              </span>
            </div>

            <UserProfile address={activeAddress} avatarSize={44} showDomain={true} />
          </div>
        </div>

        {/* Circular Reliability Gauge */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '18px',
            background: 'rgba(255, 255, 255, 0.7)',
            padding: '14px 22px',
            borderRadius: '20px',
            border: '1px solid rgba(255, 255, 255, 0.9)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.03)',
          }}
        >
          <div style={{ textAlign: 'right' }}>
            <div
              style={{
                fontSize: '11px',
                fontWeight: '800',
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Reliability Score
            </div>
            <div
              style={{
                fontSize: '26px',
                fontWeight: '900',
                color:
                  fulfillmentRate >= 70 ? '#16a34a' : fulfillmentRate >= 40 ? '#d97706' : '#dc2626',
              }}
            >
              {totalCount > 0 ? `${fulfillmentRate}%` : 'N/A'}
            </div>
          </div>

          <div
            style={{
              position: 'relative',
              width: '52px',
              height: '52px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="52" height="52" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="36" stroke="#f1f5f9" strokeWidth="8" fill="none" />
              <circle
                cx="40"
                cy="40"
                r="36"
                stroke={
                  fulfillmentRate >= 70 ? '#22c55e' : fulfillmentRate >= 40 ? '#f59e0b' : '#ef4444'
                }
                strokeWidth="8"
                fill="none"
                strokeDasharray="226"
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                transform="rotate(-90 40 40)"
                style={{ transition: 'stroke-dashoffset 0.5s ease-out' }}
              />
            </svg>
            <span
              style={{
                position: 'absolute',
                fontSize: '12px',
                fontWeight: '900',
                color: '#0f172a',
              }}
            >
              {totalCount > 0 ? `${fulfillmentRate}` : '0'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Soft Pastel Scorecards Grid ── */}
      {isLoading ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '18px',
            marginBottom: '24px',
          }}
        >
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '18px',
                padding: '24px',
                height: '110px',
                animation: 'pulse 1.5s infinite',
              }}
            >
              <div
                style={{
                  width: '45%',
                  height: '12px',
                  background: '#f1f5f9',
                  borderRadius: '4px',
                  marginBottom: '14px',
                }}
              ></div>
              <div
                style={{ width: '30%', height: '28px', background: '#e2e8f0', borderRadius: '6px' }}
              ></div>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '18px',
            marginBottom: '24px',
          }}
        >
          {/* Total Commitments Card (Soft Lavender) */}
          <div
            onMouseEnter={() => setHoveredCard('total')}
            onMouseLeave={() => setHoveredCard(null)}
            style={{
              background: 'rgba(255, 255, 255, 0.6)',
              backdropFilter: 'saturate(180%) blur(40px)',
              WebkitBackdropFilter: 'saturate(180%) blur(40px)',
              border: '1px solid rgba(255, 255, 255, 0.9)',
              borderRadius: '20px',
              padding: '24px',
              boxShadow:
                hoveredCard === 'total'
                  ? '0 12px 28px -6px rgba(0,0,0,0.08)'
                  : '0 4px 12px rgba(0,0,0,0.03)',
              transform: hoveredCard === 'total' ? 'translateY(-3px)' : 'translateY(0)',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <div
              style={{
                fontSize: '11.5px',
                fontWeight: '800',
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: '8px',
              }}
            >
              Total Commitments
            </div>
            <div style={{ fontSize: '38px', fontWeight: '900', color: '#0f172a', lineHeight: '1' }}>
              {totalCount}
            </div>
            <div
              style={{ fontSize: '12px', color: '#64748b', marginTop: '10px', fontWeight: '500' }}
            >
              On-chain record ({calculatedPending} pending)
            </div>
          </div>

          {/* Fulfilled Card */}
          <div
            onMouseEnter={() => setHoveredCard('fulfilled')}
            onMouseLeave={() => setHoveredCard(null)}
            style={{
              background: 'rgba(52, 199, 89, 0.1)',
              backdropFilter: 'saturate(180%) blur(40px)',
              WebkitBackdropFilter: 'saturate(180%) blur(40px)',
              border: '1px solid rgba(52, 199, 89, 0.3)',
              borderRadius: '20px',
              padding: '24px',
              boxShadow:
                hoveredCard === 'fulfilled'
                  ? '0 12px 28px -6px rgba(52, 199, 89, 0.2)'
                  : '0 4px 12px rgba(0,0,0,0.03)',
              transform: hoveredCard === 'fulfilled' ? 'translateY(-3px)' : 'translateY(0)',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '8px',
              }}
            >
              <span
                style={{
                  fontSize: '11.5px',
                  fontWeight: '800',
                  color: '#166534',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Fulfilled
              </span>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  padding: '3px 10px',
                  borderRadius: '100px',
                  background: '#ffffff',
                  color: '#15803d',
                  border: '1px solid #bbf7d0',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}
              >
                ✓ On Time
              </span>
            </div>
            <div style={{ fontSize: '38px', fontWeight: '900', color: '#15803d', lineHeight: '1' }}>
              {fulfilledCount}
            </div>
            <div
              style={{ fontSize: '12px', fontWeight: '600', color: '#166534', marginTop: '10px' }}
            >
              Met on time
            </div>
          </div>

          {/* Late Card */}
          <div
            onMouseEnter={() => setHoveredCard('late')}
            onMouseLeave={() => setHoveredCard(null)}
            style={{
              background: 'rgba(245, 158, 11, 0.1)',
              backdropFilter: 'saturate(180%) blur(40px)',
              WebkitBackdropFilter: 'saturate(180%) blur(40px)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              borderRadius: '20px',
              padding: '24px',
              boxShadow:
                hoveredCard === 'late'
                  ? '0 12px 28px -6px rgba(245, 158, 11, 0.2)'
                  : '0 4px 12px rgba(0,0,0,0.03)',
              transform: hoveredCard === 'late' ? 'translateY(-3px)' : 'translateY(0)',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '8px',
              }}
            >
              <span
                style={{
                  fontSize: '11.5px',
                  fontWeight: '800',
                  color: '#92400e',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Late
              </span>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  padding: '3px 10px',
                  borderRadius: '100px',
                  background: '#ffffff',
                  color: '#b45309',
                  border: '1px solid #fde68a',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}
              >
                ⏰ Delayed
              </span>
            </div>
            <div style={{ fontSize: '38px', fontWeight: '900', color: '#b45309', lineHeight: '1' }}>
              {lateCount}
            </div>
            <div
              style={{ fontSize: '12px', fontWeight: '600', color: '#92400e', marginTop: '10px' }}
            >
              Attested after due date
            </div>
          </div>

          {/* Breached Card */}
          <div
            onMouseEnter={() => setHoveredCard('breached')}
            onMouseLeave={() => setHoveredCard(null)}
            style={{
              background: 'rgba(255, 59, 48, 0.1)',
              backdropFilter: 'saturate(180%) blur(40px)',
              WebkitBackdropFilter: 'saturate(180%) blur(40px)',
              border: '1px solid rgba(255, 59, 48, 0.3)',
              borderRadius: '20px',
              padding: '24px',
              boxShadow:
                hoveredCard === 'breached'
                  ? '0 12px 28px -6px rgba(255, 59, 48, 0.2)'
                  : '0 4px 12px rgba(0,0,0,0.03)',
              transform: hoveredCard === 'breached' ? 'translateY(-3px)' : 'translateY(0)',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '8px',
              }}
            >
              <span
                style={{
                  fontSize: '11.5px',
                  fontWeight: '800',
                  color: '#9f1239',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Breached
              </span>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  padding: '3px 10px',
                  borderRadius: '100px',
                  background: '#ffffff',
                  color: '#be123c',
                  border: '1px solid #fecdd3',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}
              >
                ✕ Breached
              </span>
            </div>
            <div style={{ fontSize: '38px', fontWeight: '900', color: '#be123c', lineHeight: '1' }}>
              {breachedCount}
            </div>
            <div
              style={{ fontSize: '12px', fontWeight: '600', color: '#9f1239', marginTop: '10px' }}
            >
              Failed or unfulfilled
            </div>
          </div>
        </div>
      )}

      {/* ── Deterministic DOM Virtualized Commitment Histories ── */}
      {/* ── Associated Commitments ── */}
      <div
        style={{
          background: '#ffffff',
          border: '1.5px solid #e2e8f0',
          borderRadius: '24px',
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.04)',
          marginBottom: '32px',
        }}
      >
        {/* Header with Title and Filter Tabs */}
        <div
          style={{
            padding: '22px 28px',
            borderBottom: '1px solid #f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '14px',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: '800', color: '#0f172a', margin: 0 }}>
                Associated Commitments
              </h3>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  background: '#e0e7ff',
                  color: '#4338ca',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <Layers size={12} />
                Virtualized
              </span>
            </div>
            <p style={{ fontSize: '13px', color: '#64748b', margin: '3px 0 0 0' }}>
              Deterministic DOM virtualization for unlimited commitment histories
            </p>
          </div>

          {/* Filter Tabs */}
          <div
            style={{
              display: 'flex',
              gap: '4px',
              background: '#f1f5f9',
              padding: '4px',
              borderRadius: '10px',
              border: '1px solid #e2e8f0',
            }}
          >
            {['All', 'Fulfilled', 'Late', 'Breached', 'Pending', 'Disputed'].map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setStatusFilter(tab);
                  setPage(1);
                }}
                style={{
                  fontSize: '12px',
                  fontWeight: statusFilter === tab ? '800' : '500',
                  padding: '6px 14px',
                  borderRadius: '7px',
                  border: 'none',
                  background: statusFilter === tab ? '#ffffff' : 'transparent',
                  color: statusFilter === tab ? '#0f172a' : '#64748b',
                  boxShadow: statusFilter === tab ? '0 2px 6px rgba(0,0,0,0.06)' : 'none',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* Live Virtualization Metrics Bar */}
        <div
          style={{
            padding: '10px 28px',
            background: '#f8fafc',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
            fontSize: '12px',
            color: '#64748b',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <span>
              Total in History:{' '}
              <strong style={{ color: '#0f172a' }}>{filteredCommitments.length}</strong>
            </span>
            <span style={{ color: '#cbd5e1' }}>•</span>
            <span id="virtual-dom-count">
              Active in DOM (Viewport + Overscan):{' '}
              <strong style={{ color: '#16a34a' }}>{virtualItems.length} nodes</strong>
            </span>
            <span style={{ color: '#cbd5e1' }}>•</span>
            <span>
              Dynamic Size Cache:{' '}
              <strong style={{ color: '#6366f1' }}>{cachedCount} measured</strong>
            </span>
          </div>
        </div>

        {/* Empty State Requirement: "No commitments found for this address" */}
        {filteredCommitments.length === 0 && !isLoading ? (
          <div style={{ padding: '72px 24px', textAlign: 'center' }}>
            <div
              style={{
                width: '64px',
                height: '64px',
                background: '#f8fafc',
                color: '#94a3b8',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 18px auto',
                fontSize: '28px',
                border: '1px solid #e2e8f0',
              }}
            >
              📭
            </div>
            <h4
              style={{ fontSize: '18px', fontWeight: '800', color: '#0f172a', margin: '0 0 6px 0' }}
            >
              No commitments found for this address
            </h4>
            <p
              style={{
                fontSize: '13.5px',
                color: '#64748b',
                maxWidth: '400px',
                margin: '0 auto 22px auto',
              }}
            >
              This account currently has no registered commitment activity matching this filter on
              Pactum Stellar Testnet.
            </p>
            {onLaunchCreate && (
              <button
                onClick={onLaunchCreate}
                style={{
                  padding: '10px 22px',
                  background: '#0f172a',
                  color: '#ffffff',
                  fontSize: '13px',
                  fontWeight: '700',
                  borderRadius: '10px',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(15,23,42,0.15)',
                }}
              >
                + Create Commitment for this Address
              </button>
            )}
          </div>
        ) : (
          /* ── Virtualized Scroll Container ── */
          <div
            ref={parentRef}
            id="virtualized-commitments-viewport"
            style={{
              height: '560px',
              overflowY: 'auto',
              position: 'relative',
              contain: 'strict',
              padding: '0 12px',
            }}
          >
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualRow) => {
                const c = filteredCommitments[virtualRow.index];
                if (!c) return null;

                const isIssuer = c.issuer === activeAddress;
                const counterpartyAddr = isIssuer ? c.counterparty : c.issuer;
                const isExpanded = expandedIds.has(c.id);

                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={(node) => {
                      if (node) {
                        rowVirtualizer.measureElement(node);
                        const measured = node.getBoundingClientRect().height;
                        if (measured > 0) {
                          dynamicSizeCacheRef.current.set(c.id, measured);
                        }
                      }
                    }}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                      padding: '8px 0',
                    }}
                  >
                    {/* ── Virtualized Dynamic Commitment Card ── */}
                    <div
                      className="commitment-card-item"
                      style={{
                        background: '#ffffff',
                        border: '1px solid #e2e8f0',
                        borderRadius: '16px',
                        padding: '18px 20px',
                        transition: 'box-shadow 0.18s ease, border-color 0.18s ease',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = '#cbd5e1';
                        e.currentTarget.style.boxShadow = '0 6px 18px rgba(0,0,0,0.06)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = '#e2e8f0';
                        e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.02)';
                      }}
                    >
                      {/* Top Row: ID, Role, Counterparty, Status, and Controls */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: '12px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span
                            style={{
                              fontSize: '15px',
                              fontWeight: '900',
                              color: '#0f172a',
                              fontFamily: 'monospace',
                            }}
                          >
                            #{c.id}
                          </span>

                          <span style={{
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: '800',
                            background: isIssuer ? '#e0e7ff' : '#f1f5f9',
                            color: isIssuer ? '#3730a3' : '#475569',
                            border: isIssuer ? '1px solid #c7d2fe' : '1px solid #e2e8f0'
                          }}>
                            {isIssuer ? 'Issuer' : 'Counterparty'}
                          </span>

                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#94a3b8', fontWeight: '600' }}>vs</span>
                            <UserProfile address={counterpartyAddr} avatarSize={24} showDomain={false} />
                          </div>
                        </div>

                        {/* Status Badge & Expand Action */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span
                            style={{
                              padding: '4px 12px',
                              borderRadius: '100px',
                              fontSize: '12px',
                              fontWeight: '800',
                              background: (STATUS_CONFIG[c.status] || STATUS_CONFIG.Pending).bg,
                              color: (STATUS_CONFIG[c.status] || STATUS_CONFIG.Pending).color,
                              border: `1px solid ${(STATUS_CONFIG[c.status] || STATUS_CONFIG.Pending).border}`,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            <span
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                background: (STATUS_CONFIG[c.status] || STATUS_CONFIG.Pending).dotColor,
                              }}
                            />
                            {(STATUS_CONFIG[c.status] || STATUS_CONFIG.Pending).label}
                          </span>

                          <button
                            onClick={() => toggleExpand(c.id)}
                            aria-expanded={isExpanded}
                            aria-controls={`commitment-details-${c.id}`}
                            style={{
                              background: '#f8fafc',
                              border: '1px solid #e2e8f0',
                              borderRadius: '8px',
                              padding: '5px 8px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              fontSize: '11.5px',
                              fontWeight: '700',
                              color: '#475569',
                              cursor: 'pointer',
                            }}
                            title={isExpanded ? 'Collapse card details' : 'Expand card details'}
                          >
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            <span>{isExpanded ? 'Less' : 'Details'}</span>
                          </button>
                        </div>
                      </div>

                      {/* Middle: Dynamic Description Text */}
                      {c.description && (
                        <div
                          style={{
                            marginTop: '12px',
                            fontSize: '13.5px',
                            color: '#334155',
                            lineHeight: '1.5',
                            fontWeight: '500',
                          }}
                        >
                          {c.description}
                        </div>
                      )}

                      {/* Bottom Info: Due Date, Terms Hash, and Async Trigger */}
                      <div
                        style={{
                          marginTop: '12px',
                          paddingTop: '10px',
                          borderTop: '1px solid #f8fafc',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: '10px',
                          fontSize: '12px',
                          color: '#64748b',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '14px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <span>
                            Due:{' '}
                            <strong style={{ color: '#0f172a' }}>{formatDate(c.due_at)}</strong>
                          </span>
                          <span>•</span>
                          <span title={c.terms_hash} style={{ fontFamily: 'monospace' }}>
                            Terms: {c.terms_hash.substring(0, 16)}...
                          </span>
                          {c.attested_at && (
                            <>
                              <span>•</span>
                              <span>Attested: {formatDate(c.attested_at)}</span>
                            </>
                          )}
                        </div>

                        {/* Test action to simulate async height shift and prove scroll position stability */}
                        {import.meta.env.DEV && (
                          <button
                            onClick={() => triggerAsyncUpdate(c.id)}
                            style={{
                              background: 'transparent',
                              border: '1px dashed #cbd5e1',
                              borderRadius: '6px',
                              padding: '3px 8px',
                              fontSize: '11px',
                              fontWeight: '600',
                              color: '#6366f1',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px'
                            }}
                            title="Simulates asynchronous height changes above viewport to verify scroll anchoring"
                          >
                            <Sparkles size={11} />
                            Dev: Test Async Height
                          </button>
                        )}
                      </div>

                      {/* Expanded Dynamic Details Drawer */}
                      {isExpanded && (
                        <div
                          id={`commitment-details-${c.id}`}
                          style={{
                            marginTop: '14px',
                            padding: '14px',
                            background: '#f8fafc',
                            borderRadius: '12px',
                            border: '1px solid #e2e8f0',
                            animation: 'fadeIn 0.15s ease'
                          }}
                        >
                          <div style={{ fontSize: '11.5px', fontWeight: '800', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                            Cryptographic Terms & Audit Log
                          </div>
                          <div
                            style={{
                              fontFamily: 'monospace',
                              fontSize: '11.5px',
                              color: '#64748b',
                              wordBreak: 'break-all',
                              marginBottom: '8px',
                            }}
                          >
                            Full SHA-256 Terms Hash: {c.terms_hash}
                          </div>

                          {c.notes && c.notes.length > 0 ? (
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '4px',
                                marginTop: '6px',
                              }}
                            >
                              {c.notes.map((note, nIdx) => (
                                <div
                                  key={nIdx}
                                  style={{
                                    fontSize: '12px',
                                    color: '#334155',
                                    display: 'flex',
                                    alignItems: 'baseline',
                                    gap: '6px',
                                  }}
                                >
                                  <span style={{ color: '#6366f1' }}>•</span>
                                  <span>{note}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                              No additional asynchronous notes registered for this commitment.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {fetchError && (
              <div style={{ textAlign: 'center', color: '#ef4444', padding: '16px', fontSize: '13px' }}>
                {fetchError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReputationDashboard;
