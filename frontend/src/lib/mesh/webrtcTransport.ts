import type {
  MeshProtocolMessage,
  PeerCandidate,
  PeerExchangeMessage,
  PingMessage,
  PongMessage,
} from './types.ts';
import { PlumtreeEngine } from './plumtreeEngine.ts';
import { PeerScoringManager } from './peerScoring.ts';

export interface WebRtcTransportConfig {
  peerId?: string;
  maxPeers?: number;
  signalingChannelName?: string;
  iceServers?: RTCIceServer[];
  pingIntervalMs?: number;
  pexIntervalMs?: number;
}

interface PeerConnectionState {
  peerId: string;
  connection: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  isConnected: boolean;
  lastPing: number;
  lastPong: number;
}

export class WebRtcMeshTransport {
  public localPeerId: string;
  private maxPeers: number;
  private signalingChannel: BroadcastChannel | null = null;
  private connections: Map<string, PeerConnectionState> = new Map();
  private knownPeerCandidates: Map<string, PeerCandidate> = new Map();
  private iceServers: RTCIceServer[];

  public plumtree: PlumtreeEngine;
  public scoring: PeerScoringManager;

  private pingInterval: any = null;
  private pexInterval: any = null;

  constructor(
    config: WebRtcTransportConfig = {},
    onEventDeliver?: (event: any, senderId: string) => void,
  ) {
    this.localPeerId = config.peerId || this.generatePeerId();
    this.maxPeers = config.maxPeers ?? 8;
    this.iceServers = config.iceServers ?? [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ];

    this.scoring = new PeerScoringManager();
    this.plumtree = new PlumtreeEngine(
      { localPeerId: this.localPeerId },
      this.scoring,
      (targetId, msg) => this.sendToPeer(targetId, msg),
      (event, senderId) => {
        if (onEventDeliver) onEventDeliver(event, senderId);
      },
    );

    this.initSignaling(config.signalingChannelName ?? 'pactum-webrtc-mesh-signaling');
    this.startHeartbeat(config.pingIntervalMs ?? 15000);
    this.startPexLoop(config.pexIntervalMs ?? 30000);
  }

  private generatePeerId(): string {
    return (
      'peer_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36).substring(4)
    );
  }

  private initSignaling(channelName: string): void {
    if (typeof BroadcastChannel !== 'undefined') {
      this.signalingChannel = new BroadcastChannel(channelName);
      this.signalingChannel.onmessage = (event) => {
        this.handleSignalingMessage(event.data);
      };

      // Announce presence
      this.broadcastSignaling({
        type: 'DISCOVER',
        senderId: this.localPeerId,
      });
    }
  }

  private broadcastSignaling(data: any): void {
    if (this.signalingChannel) {
      this.signalingChannel.postMessage(data);
    }
  }

  private async handleSignalingMessage(data: any): Promise<void> {
    if (!data || data.senderId === this.localPeerId) return;

    const senderId = data.senderId;

    if (this.scoring.isPeerBanned(senderId)) {
      return;
    }

    if (data.type === 'DISCOVER') {
      if (this.connections.size < this.maxPeers && !this.connections.has(senderId)) {
        // Initiate WebRTC offer if sender has lower ID to avoid dual-offer race
        if (this.localPeerId < senderId) {
          await this.initiateOffer(senderId);
        }
      }
    } else if (data.type === 'OFFER' && data.targetId === this.localPeerId) {
      await this.handleOffer(senderId, data.offer);
    } else if (data.type === 'ANSWER' && data.targetId === this.localPeerId) {
      await this.handleAnswer(senderId, data.answer);
    } else if (data.type === 'CANDIDATE' && data.targetId === this.localPeerId) {
      await this.handleIceCandidate(senderId, data.candidate);
    }
  }

  public async initiateOffer(targetPeerId: string): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') return;
    if (this.connections.size >= this.maxPeers || this.connections.has(targetPeerId)) {
      return;
    }

    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const dataChannel = pc.createDataChannel('pactum-gossip', {
        ordered: true,
      });

      const peerState: PeerConnectionState = {
        peerId: targetPeerId,
        connection: pc,
        dataChannel,
        isConnected: false,
        lastPing: Date.now(),
        lastPong: Date.now(),
      };

      this.connections.set(targetPeerId, peerState);
      this.setupDataChannel(targetPeerId, dataChannel);
      this.setupPeerConnectionEvents(targetPeerId, pc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.broadcastSignaling({
        type: 'OFFER',
        senderId: this.localPeerId,
        targetId: targetPeerId,
        offer,
      });
    } catch (err) {
      console.error(`Failed to initiate WebRTC offer to ${targetPeerId}:`, err);
      this.connections.delete(targetPeerId);
    }
  }

  private async handleOffer(senderId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') return;

    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const peerState: PeerConnectionState = {
        peerId: senderId,
        connection: pc,
        isConnected: false,
        lastPing: Date.now(),
        lastPong: Date.now(),
      };

      this.connections.set(senderId, peerState);

      pc.ondatachannel = (ev) => {
        peerState.dataChannel = ev.channel;
        this.setupDataChannel(senderId, ev.channel);
      };

      this.setupPeerConnectionEvents(senderId, pc);

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.broadcastSignaling({
        type: 'ANSWER',
        senderId: this.localPeerId,
        targetId: senderId,
        answer,
      });
    } catch (err) {
      console.error(`Failed to handle WebRTC offer from ${senderId}:`, err);
      this.connections.delete(senderId);
    }
  }

  private async handleAnswer(senderId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const peer = this.connections.get(senderId);
    if (peer && peer.connection) {
      try {
        await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error(`Failed to set remote description from ${senderId}:`, err);
      }
    }
  }

  private async handleIceCandidate(
    senderId: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const peer = this.connections.get(senderId);
    if (peer && peer.connection && candidate) {
      try {
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(`Failed to add ICE candidate from ${senderId}:`, err);
      }
    }
  }

  private setupPeerConnectionEvents(peerId: string, pc: RTCPeerConnection): void {
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.broadcastSignaling({
          type: 'CANDIDATE',
          senderId: this.localPeerId,
          targetId: peerId,
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        this.disconnectPeer(peerId);
      }
    };
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel): void {
    channel.onopen = () => {
      const peer = this.connections.get(peerId);
      if (peer) {
        peer.isConnected = true;
        this.plumtree.addPeer(peerId);
        this.knownPeerCandidates.set(peerId, { peerId, lastSeen: Date.now() });
      }
    };

    channel.onclose = () => {
      this.disconnectPeer(peerId);
    };

    channel.onerror = (err) => {
      console.error(`Data channel error with ${peerId}:`, err);
      this.disconnectPeer(peerId);
    };

    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as MeshProtocolMessage;
        this.handleIncomingMeshMessage(peerId, msg);
      } catch (err) {
        console.error(`Failed to decode mesh message from ${peerId}:`, err);
        this.scoring.recordInvalidMessage(peerId, false);
      }
    };
  }

  private handleIncomingMeshMessage(senderId: string, msg: MeshProtocolMessage): void {
    if (msg.type === 'PING') {
      const pong: PongMessage = {
        type: 'PONG',
        senderId: this.localPeerId,
        timestamp: Date.now(),
      };
      this.sendToPeer(senderId, pong);
      return;
    }

    if (msg.type === 'PONG') {
      const peer = this.connections.get(senderId);
      if (peer) {
        peer.lastPong = Date.now();
      }
      return;
    }

    if (msg.type === 'PEER_EXCHANGE') {
      this.handlePeerExchange(msg as PeerExchangeMessage);
      return;
    }

    // Pass to Plumtree engine
    this.plumtree.handleMessage(senderId, msg);
  }

  private handlePeerExchange(msg: PeerExchangeMessage): void {
    for (const candidate of msg.peers) {
      if (candidate.peerId !== this.localPeerId && !this.connections.has(candidate.peerId)) {
        this.knownPeerCandidates.set(candidate.peerId, candidate);
      }
    }
  }

  public sendToPeer(targetPeerId: string, message: MeshProtocolMessage): void {
    const peer = this.connections.get(targetPeerId);
    if (peer && peer.dataChannel && peer.dataChannel.readyState === 'open') {
      try {
        peer.dataChannel.send(JSON.stringify(message));
      } catch (err) {
        console.error(`Error sending message to ${targetPeerId}:`, err);
      }
    }
  }

  public disconnectPeer(peerId: string): void {
    const peer = this.connections.get(peerId);
    if (peer) {
      if (peer.dataChannel) {
        peer.dataChannel.close();
      }
      if (peer.connection) {
        peer.connection.close();
      }
      this.connections.delete(peerId);
      this.plumtree.removePeer(peerId);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      for (const [peerId, peer] of this.connections.entries()) {
        if (peer.isConnected) {
          // Check if peer is dead
          if (now - peer.lastPong > intervalMs * 3) {
            this.disconnectPeer(peerId);
            continue;
          }

          // Check if peer was banned
          if (this.scoring.isPeerBanned(peerId)) {
            this.disconnectPeer(peerId);
            continue;
          }

          const ping: PingMessage = {
            type: 'PING',
            senderId: this.localPeerId,
            timestamp: now,
          };
          this.sendToPeer(peerId, ping);
        }
      }

      this.scoring.decayScores();
    }, intervalMs);
  }

  private startPexLoop(intervalMs: number): void {
    this.pexInterval = setInterval(() => {
      if (this.connections.size === 0) return;

      const candidates: PeerCandidate[] = Array.from(this.connections.keys()).map((id) => ({
        peerId: id,
        lastSeen: Date.now(),
      }));

      const pexMsg: PeerExchangeMessage = {
        type: 'PEER_EXCHANGE',
        peers: candidates,
        senderId: this.localPeerId,
        timestamp: Date.now(),
      };

      for (const peerId of this.connections.keys()) {
        this.sendToPeer(peerId, pexMsg);
      }
    }, intervalMs);
  }

  public destroy(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.pexInterval) clearInterval(this.pexInterval);
    if (this.signalingChannel) this.signalingChannel.close();

    for (const peerId of Array.from(this.connections.keys())) {
      this.disconnectPeer(peerId);
    }

    this.plumtree.destroy();
  }

  public getConnectedPeerCount(): number {
    return this.connections.size;
  }

  public getActivePeers(): string[] {
    return this.plumtree.getEagerNeighbors();
  }

  public getPassivePeers(): string[] {
    return this.plumtree.getLazyNeighbors();
  }
}
