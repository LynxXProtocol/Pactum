import { WebRtcMeshTransport } from './webrtcTransport.ts';
import type { SorobanIndexedEvent } from './types.ts';

export class MeshServiceWorkerCoordinator {
  private transport: WebRtcMeshTransport | null = null;
  private isRegistered: boolean = false;
  private eventListeners: Set<(event: SorobanIndexedEvent) => void> = new Set();

  /**
   * Registers the background service worker mesh if supported.
   */
  public async registerServiceWorker(swPath: string = '/sw-mesh.js'): Promise<boolean> {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register(swPath, {
          scope: '/',
        });

        navigator.serviceWorker.addEventListener('message', (event) => {
          this.handleWorkerMessage(event.data);
        });

        this.isRegistered = true;
        console.log('[MeshSW] Service Worker registered with scope:', registration.scope);
        return true;
      } catch (err) {
        console.warn(
          '[MeshSW] Failed to register service worker, falling back to window thread:',
          err,
        );
        return false;
      }
    }
    return false;
  }

  public isServiceWorkerRegistered(): boolean {
    return this.isRegistered;
  }

  /**
   * Initializes in-window fallback or mesh client.
   */
  public initInWindowMesh(onEvent: (event: SorobanIndexedEvent) => void): WebRtcMeshTransport {
    if (!this.transport) {
      this.transport = new WebRtcMeshTransport({}, (event) => {
        onEvent(event);
        this.notifyListeners(event);
      });
    }
    return this.transport;
  }

  public subscribe(callback: (event: SorobanIndexedEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  private notifyListeners(event: SorobanIndexedEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private handleWorkerMessage(data: any): void {
    if (data && data.type === 'SOROBAN_EVENT_DISSEMINATED' && data.event) {
      this.notifyListeners(data.event);
    }
  }

  public publishEvent(event: SorobanIndexedEvent): void {
    if (this.transport) {
      this.transport.plumtree.publishEvent(event);
    } else if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'PUBLISH_SOROBAN_EVENT',
        event,
      });
    }
  }

  public destroy(): void {
    if (this.transport) {
      this.transport.destroy();
      this.transport = null;
    }
    this.eventListeners.clear();
  }
}
