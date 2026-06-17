import {
  ClientMessage,
  ServerMessage,
  ServerMessageType,
} from './types.js';

export type MessageHandler = (payload: any) => void;

export class GameWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<ServerMessageType, MessageHandler[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private shouldReconnect = true;

  constructor(url?: string) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    this.url = url || `${proto}//${host}/ws`;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('[WS] Connected to', this.url);
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const msg: ServerMessage = JSON.parse(event.data);
            this.dispatch(msg);
          } catch (err) {
            console.error('[WS] Parse error:', err);
          }
        };

        this.ws.onerror = (err) => {
          console.error('[WS] Error:', err);
          reject(err);
        };

        this.ws.onclose = (event) => {
          console.warn('[WS] Closed:', event.code, event.reason);
          if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      this.connect().catch((err) => {
        console.error('[WS] Reconnect failed:', err);
      });
    }, delay);
  }

  on(type: ServerMessageType, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  off(type: ServerMessageType, handler: MessageHandler) {
    const list = this.handlers.get(type);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  once(type: ServerMessageType, handler: MessageHandler) {
    const wrapped: MessageHandler = (payload) => {
      this.off(type, wrapped);
      handler(payload);
    };
    this.on(type, wrapped);
  }

  private dispatch(msg: ServerMessage) {
    const list = this.handlers.get(msg.type);
    if (list) {
      for (const handler of list) {
        try {
          handler(msg.payload);
        } catch (err) {
          console.error(`[WS] Handler error for ${msg.type}:`, err);
        }
      }
    }
  }

  send(msg: ClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] Not connected, cannot send:', msg.type);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  ping() {
    this.send({ type: 'ping', payload: Date.now() });
  }

  close() {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
