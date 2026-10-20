import { useStore, type ContractEvent } from '../store/useStore';

class WSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Infinity;
  private initialReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Assuming backend is at VITE_API_URL or same origin
    const apiUrl = import.meta.env.VITE_API_URL ?? window.location.origin;
    // Replace http:// with ws:// and https:// with wss://
    this.url = apiUrl.replace(/^http/, 'ws') + '/ws';
  }

  public connect() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WSClient] Connected to', this.url);
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ContractEvent;
        // Broadcast into Zustand store
        useStore.getState().applyEvent(data);
      } catch (err) {
        console.error('[WSClient] Failed to parse message', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[WSClient] Disconnected');
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WSClient] Error:', err);
      // onclose will be called after onerror, which handles reconnection
    };
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WSClient] Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(
      this.initialReconnectDelay * 2 ** this.reconnectAttempts,
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;

    console.log(`[WSClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  public disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const wsClient = new WSClient();
