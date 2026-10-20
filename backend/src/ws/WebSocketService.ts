import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import Redis, { Cluster } from 'ioredis';
import { createRedisClientFromEnv } from '../cache/reputationCache';

export class WebSocketService {
  private wss: WebSocketServer;
  private redisSubscriber: Redis | Cluster;
  private pingInterval: NodeJS.Timeout;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.redisSubscriber = createRedisClientFromEnv();

    this.wss.on('connection', (ws: WebSocket) => {
      // Add 'isAlive' flag to the socket for heartbeat
      (ws as any).isAlive = true;
      ws.on('pong', () => {
        (ws as any).isAlive = true;
      });

      ws.on('error', (err) => {
        console.error('[WebSocket] Connection error:', err);
      });
    });

    // Heartbeat to clear stale connections
    this.pingInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if ((ws as any).isAlive === false) return ws.terminate();
        (ws as any).isAlive = false;
        ws.ping();
      });
    }, 30000);

    // Subscribe to events channel
    this.redisSubscriber.subscribe('pactum:events', (err) => {
      if (err) {
        console.error('[WebSocket] Failed to subscribe to redis channel', err);
      } else {
        console.log('[WebSocket] Subscribed to pactum:events');
      }
    });

    this.redisSubscriber.on('message', (channel, message) => {
      if (channel === 'pactum:events') {
        this.broadcast(message);
      }
    });

    this.wss.on('close', () => {
      clearInterval(this.pingInterval);
    });
  }

  private broadcast(data: string) {
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  public close() {
    this.redisSubscriber.disconnect();
    this.wss.close();
    clearInterval(this.pingInterval);
  }
}
