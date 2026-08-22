import { useState, useEffect, useRef } from 'react';
import { WebRtcMeshTransport } from '../lib/mesh/webrtcTransport.ts';
import { MeshServiceWorkerCoordinator } from '../lib/mesh/meshServiceWorker.ts';
import type { SorobanIndexedEvent, MeshTopologyStats } from '../lib/mesh/types.ts';

export function useMeshNetwork() {
  const [events, setEvents] = useState<SorobanIndexedEvent[]>([]);
  const [stats, setStats] = useState<MeshTopologyStats>({
    peerId: 'initializing...',
    activeNeighbors: [],
    passiveNeighbors: [],
    totalPeers: 0,
    messagesReceived: 0,
    messagesRelayed: 0,
    duplicatesPruned: 0,
    byzantineDropped: 0,
    rpcOffloadRatio: 0,
  });

  const transportRef = useRef<WebRtcMeshTransport | null>(null);
  const coordinatorRef = useRef<MeshServiceWorkerCoordinator | null>(null);

  useEffect(() => {
    const coordinator = new MeshServiceWorkerCoordinator();
    coordinatorRef.current = coordinator;

    const transport = coordinator.initInWindowMesh((event: SorobanIndexedEvent) => {
      setEvents((prev) => [event, ...prev.slice(0, 49)]);
    });
    transportRef.current = transport;

    coordinator.registerServiceWorker();

    const interval = setInterval(() => {
      if (transportRef.current) {
        const t = transportRef.current;
        const active = t.getActivePeers();
        const passive = t.getPassivePeers();
        const total = t.getConnectedPeerCount();
        const received = t.plumtree.messagesReceivedCount;
        const relayed = t.plumtree.messagesRelayedCount;
        const pruned = t.plumtree.duplicatesPrunedCount;
        const dropped = t.plumtree.byzantineDroppedCount;

        const offload =
          received > 0 ? Math.min(100, Math.round((received / (received + 1)) * 100)) : 0;

        setStats({
          peerId: t.localPeerId,
          activeNeighbors: active,
          passiveNeighbors: passive,
          totalPeers: total,
          messagesReceived: received,
          messagesRelayed: relayed,
          duplicatesPruned: pruned,
          byzantineDropped: dropped,
          rpcOffloadRatio: offload,
        });
      }
    }, 1000);

    return () => {
      clearInterval(interval);
      coordinator.destroy();
    };
  }, []);

  const publishEvent = (event: SorobanIndexedEvent) => {
    if (coordinatorRef.current) {
      coordinatorRef.current.publishEvent(event);
      setEvents((prev) => [event, ...prev.slice(0, 49)]);
    }
  };

  return {
    events,
    stats,
    publishEvent,
  };
}
