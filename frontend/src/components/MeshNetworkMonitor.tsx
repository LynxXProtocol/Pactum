import React, { useState } from 'react';
import { useMeshNetwork } from '../hooks/useMeshNetwork';
import { Activity, ShieldCheck, Share2, AlertTriangle, Radio, ServerOff } from 'lucide-react';

export const MeshNetworkMonitor: React.FC = () => {
  const { events, stats, publishEvent } = useMeshNetwork();
  const [topicInput, setTopicInput] = useState('reputation_updated');

  const handleBroadcastTest = () => {
    const mockEvent = {
      id: 'evt_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36),
      contractId: 'CA3D...PACTUM',
      topic: topicInput,
      xdrPayload: btoa(JSON.stringify({ score: 95, timestamp: Date.now() })),
      ledgerSeq: 104520 + Math.floor(Math.random() * 100),
      txHash:
        '0x' +
        Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
      timestamp: Date.now(),
      originPeerId: stats.peerId,
    };
    publishEvent(mockEvent);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-xl text-slate-900 transition-colors dark:border-slate-800 dark:bg-slate-900 dark:text-white">
      <div className="mb-6 flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
        <div className="flex items-center space-x-3">
          <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-2 text-indigo-600 dark:text-indigo-400">
            <Radio className="h-5 w-5 animate-pulse" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              BFT Service Worker Mesh Monitor
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Peer ID:{' '}
              <span className="font-mono text-indigo-600 dark:text-indigo-300">{stats.peerId}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <span className="mr-1.5 h-1.5 w-1.5 animate-ping rounded-full bg-emerald-500 dark:bg-emerald-400"></span>
            Mesh Active
          </span>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-slate-100 p-3 dark:border-slate-700/50 dark:bg-slate-800/50">
          <div className="mb-1 flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span className="text-xs">Eager (Active) Tree</span>
            <Share2 className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <p className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {stats.activeNeighbors.length}
          </p>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            Low-latency spanning tree
          </span>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-100 p-3 dark:border-slate-700/50 dark:bg-slate-800/50">
          <div className="mb-1 flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span className="text-xs">Lazy Overlay</span>
            <Activity className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
          </div>
          <p className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {stats.passiveNeighbors.length}
          </p>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            IHAVE announcement graph
          </span>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-100 p-3 dark:border-slate-700/50 dark:bg-slate-800/50">
          <div className="mb-1 flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span className="text-xs">Byzantine Dropped</span>
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </div>
          <p className="text-xl font-bold text-amber-700 dark:text-amber-300">
            {stats.byzantineDropped}
          </p>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            Invalid XDR/spam neutralized
          </span>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-100 p-3 dark:border-slate-700/50 dark:bg-slate-800/50">
          <div className="mb-1 flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span className="text-xs">RPC Offload Ratio</span>
            <ServerOff className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <p className="text-xl font-bold text-emerald-700 dark:text-emerald-300">
            {stats.rpcOffloadRatio}%
          </p>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            P2P mesh bandwidth savings
          </span>
        </div>
      </div>

      {/* Broadcast controls */}
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-100 p-3 dark:border-slate-700/30 dark:bg-slate-800/30">
        <input
          type="text"
          value={topicInput}
          onChange={(e) => setTopicInput(e.target.value)}
          placeholder="Event topic name..."
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        />
        <button
          onClick={handleBroadcastTest}
          className="cursor-pointer rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
        >
          Disseminate Event
        </button>
      </div>

      {/* Disseminated Events Feed */}
      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <ShieldCheck className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          Live Mesh Event Feed ({events.length})
        </h4>
        <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
          {events.length === 0 ? (
            <p className="py-4 text-center text-xs italic text-slate-500 dark:text-slate-500">
              Listening for P2P Soroban events across service worker mesh...
            </p>
          ) : (
            events.map((evt) => (
              <div
                key={evt.id}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-100 p-2.5 text-xs dark:border-slate-700/40 dark:bg-slate-800/60"
              >
                <div>
                  <span className="mr-2 font-medium font-mono text-indigo-600 dark:text-indigo-300">
                    {evt.topic}
                  </span>
                  <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                    Seq #{evt.ledgerSeq}
                  </span>
                </div>
                <div className="text-right">
                  <span className="block font-mono text-[10px] text-slate-500 dark:text-slate-400">
                    Origin: {evt.originPeerId.substring(0, 10)}...
                  </span>
                  <span className="text-[9px] text-slate-400 dark:text-slate-500">
                    {new Date(evt.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
