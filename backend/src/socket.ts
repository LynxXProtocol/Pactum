import { Server, Socket } from 'socket.io';
import http from 'http';
import { StrKey } from '@stellar/stellar-sdk';

interface SocketServiceConfig {
  maxConnectionsPerIp: number;
  windowMs: number;
}

const DEFAULT_CONFIG: SocketServiceConfig = {
  maxConnectionsPerIp: 5,
  windowMs: 60 * 1000,
};

class SocketService {
  private io: Server | null = null;
  private connections: Map<string, number[]> = new Map();

  /**
   * Initializes the Socket.io server and attaches it to the provided HTTP server.
   */
  init(server: http.Server, config: SocketServiceConfig = DEFAULT_CONFIG): void {
    this.io = new Server(server, {
      cors: {
        origin: '*', // In production, this should be restricted to the frontend domain
      },
    });

    this.io.use((socket, next) => {
      const ip = socket.handshake.address;
      const now = Date.now();
      const windowStart = now - config.windowMs;

      let timestamps = this.connections.get(ip) ?? [];
      timestamps = timestamps.filter(ts => ts > windowStart);

      if (timestamps.length >= config.maxConnectionsPerIp) {
        return next(new Error('Too many connection attempts, please try again later.'));
      }

      timestamps.push(now);
      this.connections.set(ip, timestamps);
      next();
    });

    this.io.on('connection', (socket: Socket) => {
      console.log(`[socket]: Client connected: ${socket.id}`);

      socket.on('subscribe', (address: string) => {
        if (!StrKey.isValidEd25519PublicKey(address)) {
          socket.emit('error', { message: 'Invalid Stellar address' });
          return;
        }
        socket.join(address);
        console.log(`[socket]: ${socket.id} subscribed to ${address}`);
      });

      socket.on('unsubscribe', (address: string) => {
        if (!StrKey.isValidEd25519PublicKey(address)) {
          socket.emit('error', { message: 'Invalid Stellar address' });
          return;
        }
        socket.leave(address);
        console.log(`[socket]: ${socket.id} unsubscribed from ${address}`);
      });

      socket.on('disconnect', () => {
        console.log(`[socket]: Client disconnected: ${socket.id}`);
      });
    });
  }

  /**
   * Broadcasts an event to all clients subscribed to a specific address.
   */
  emitEvent(address: string, event: string, data: any): void {
    if (!this.io) {
      console.error('[socket]: SocketService not initialized. Call init() first.');
      return;
    }
    this.io.to(address).emit(event, {
      timestamp: new Date().toISOString(),
      ...data,
    });
  }

  /**
   * Closes the Socket.io server.
   */
  close(): void {
    if (this.io) {
      this.io.close();
      this.io = null;
    }
  }
}

export const socketService = new SocketService();
