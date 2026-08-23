import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMeshNetwork } from '../hooks/useMeshNetwork';
import { Activity, ShieldCheck, Share2, AlertTriangle, Radio, ServerOff } from 'lucide-react';

export const MeshNetworkMonitor: React.FC = () => {
  const { t } = useTranslation();
  const { events, stats, publishEvent } = useMeshNetwork();
  const [topicInput, setTopicInput] = useState('reputation_updated');

  const handleBroadcastTest = () => {
    const mockEvent = {
      id: 'evt_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36),
      contractId: 'CA3D...PACTUM',
      topic: topicInput,
      xdrPayload: btoa(JSON.stringify({ score: 95, timestamp: Date.now() })),
      ledgerSeq: 104520 + Math.floor(Math.random() * 100),
      txHash: '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
      timestamp: Date.now(),
      originPeerId: stats.peerId,
    };
    publishEvent(mockEvent);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl text-white">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-6">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-indigo-500/10 border border-indigo-500/30 rounded-lg text-indigo-400">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h3 className="font-semibold text-lg text-slate-100">{t('mesh.title')}</h3>
            <span className="text-xs text-slate-400">
                          {t('mesh.peerId')} <span className="font-mono text-indigo-300">{stats.peerId}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-ping"></span>
            {t('mesh.active')}
          </span>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-xs">{t('mesh.eager')}</span>
            <Share2 className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <p className="text-xl font-bold text-slate-100">{stats.activeNeighbors.length}</p>
          <span className="text-[10px] text-slate-400">{t('mesh.lowLatency')}</span>
        </div>

        <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-xs">{t('mesh.lazyOverlay')}</span>
            <Activity className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <p className="text-xl font-bold text-slate-100">{stats.passiveNeighbors.length}</p>
          <span className="text-[10px] text-slate-400">{t('mesh.iHaveGraph')}</span>
        </div>

        <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-xs">{t('mesh.byzantineDropped')}</span>
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <p className="text-xl font-bold text-amber-300">{stats.byzantineDropped}</p>
          <span className="text-[10px] text-slate-400">{t('stateConflict.invalidXdr')}</span>
        </div>

        <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-xs">{t('mesh.rpcOffload')}</span>
            <ServerOff className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <p className="text-xl font-bold text-emerald-300">{stats.rpcOffloadRatio}%</p>
          <span className="text-[10px] text-slate-400">{t('mesh.bandwidth')}</span>
        </div>
      </div>

      {/* Broadcast controls */}
      <div className="flex items-center gap-3 mb-6 bg-slate-800/30 p-3 rounded-lg border border-slate-700/30">
        <input
          type="text"
          value={topicInput}
          onChange={(e) => setTopicInput(e.target.value)}
          placeholder={t('mesh.searchTopic')}
          className="flex-1 bg-slate-900 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
        />
        <button
          onClick={handleBroadcastTest}
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm font-medium transition-colors cursor-pointer"
        >
          {t('mesh.disseminate')}
        </button>
      </div>

      {/* Disseminated Events Feed */}
      <div>
        <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
          {t('mesh.liveFeed', { count: events.length })}
        </h4>
        <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
          {events.length === 0 ? (
            <p className="text-xs text-slate-500 italic py-4 text-center">
              {t('mesh.listening')}
            </p>
          ) : (
            events.map((evt) => (
              <div
                key={evt.id}
                className="bg-slate-800/60 border border-slate-700/40 rounded-lg p-2.5 flex items-center justify-between text-xs"
              >
                <div>
                  <span className="font-mono text-indigo-300 font-medium mr-2">{evt.topic}</span>
                  <span className="text-slate-400 font-mono text-[10px]">Seq #{evt.ledgerSeq}</span>
                </div>
                <div className="text-right">
                  <span className="text-slate-400 font-mono text-[10px] block">
                    Origin: {evt.originPeerId.substring(0, 10)}...
                  </span>
                  <span className="text-slate-500 text-[9px]">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
