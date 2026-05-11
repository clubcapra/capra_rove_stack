// WebSocket subscription for project change events. Auto-reconnects.

export interface ServerEvent {
  type: string;
  payload: Record<string, unknown>;
}

type Listener = (e: ServerEvent) => void;

class EventStream {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectDelay = 500;

  start(): void {
    if (this.ws) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/events`;
    const ws = new WebSocket(url);
    ws.onopen = () => {
      this.reconnectDelay = 500;
    };
    ws.onmessage = (m) => {
      try {
        const event = JSON.parse(m.data) as ServerEvent;
        this.listeners.forEach((l) => l(event));
      } catch {
        // ignore malformed payloads
      }
    };
    ws.onclose = () => {
      this.ws = null;
      const delay = Math.min(this.reconnectDelay, 5000);
      this.reconnectDelay = delay * 2;
      setTimeout(() => this.start(), delay);
    };
    ws.onerror = () => ws.close();
    this.ws = ws;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const eventStream = new EventStream();
