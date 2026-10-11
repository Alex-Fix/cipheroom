import { MediaRelayListener, SignalingService } from '../signaling/signaling.service';

/**
 * LiveKit mode (docs/plans/2026-10-11-livekit-media-mode-design.md): livekit-client's signaling socket, carried over
 * our SignalR connection instead of a WebSocket of its own. The api opens the real socket to the LiveKit server with
 * a token it creates; messages (SDP, ICE candidates) pass through both ways untouched. Only URLs on RELAY_HOST are
 * intercepted; every other WebSocket is the browser's own.
 */
export const RELAY_HOST = 'media-relay.invalid';
export const RELAY_URL = `wss://${RELAY_HOST}`;

/** What livekit-client is given as a token: the api attaches the real one, so this never authorizes anything. */
export const RELAY_TOKEN = 'relayed';

/** Where `WebSocket` lives (the page; tests pass their own). */
export interface WebSocketHost {
  WebSocket: typeof WebSocket;
}

/** Replaces `WebSocket` for RELAY_HOST until the returned function is called. */
export function installRelayWebSocket(
  signaling: SignalingService,
  win: WebSocketHost = globalThis as unknown as WebSocketHost,
): () => void {
  const Native = win.WebSocket;
  const sockets = new Map<string, RelayWebSocket>();
  const listener: MediaRelayListener = {
    received: (id, message, text) => sockets.get(id)?.deliver(text ? decodeText(message) : decodeBinary(message)),
    closed: (id, code) => sockets.get(id)?.finish(code, 'closed by the media server'),
    disconnected: () => [...sockets.values()].forEach((s) => s.finish(1006, 'signaling connection lost')),
  };
  const removeListener = signaling.onMediaRelay(listener);

  class RelayWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readyState = 0;
    binaryType: BinaryType = 'arraybuffer';
    readonly protocol = '';
    readonly extensions = '';
    readonly bufferedAmount = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;

    private readonly id = relayId();
    /** Messages that beat our own `open` (LiveKit answers the connect at once). */
    private readonly early: (string | ArrayBuffer)[] = [];

    constructor(readonly url: string) {
      super();
      const target = new URL(url);
      // Registered before asking: the join response can arrive before OpenMediaRelay returns.
      sockets.set(this.id, this);
      signaling.openMediaRelay(this.id, target.pathname, target.search.slice(1)).then(
        () => {
          if (this.readyState !== 0) {
            void signaling.closeMediaRelay(this.id).catch(() => undefined);
            return;
          }
          this.readyState = 1;
          this.emit('open', new Event('open'));
          for (const message of this.early.splice(0)) this.deliver(message);
        },
        () => {
          this.emit('error', new Event('error'));
          this.finish(1006, 'relay refused');
        },
      );
    }

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (this.readyState !== 1) throw new DOMException('The socket is not open.', 'InvalidStateError');
      if (typeof data === 'string') signaling.sendMediaRelay(this.id, encode(new TextEncoder().encode(data)), true);
      else signaling.sendMediaRelay(this.id, encode(bytesOf(data)), false);
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState >= 2) return;
      void signaling.closeMediaRelay(this.id).catch(() => undefined);
      this.finish(code, reason);
    }

    deliver(data: string | ArrayBuffer): void {
      if (this.readyState === 0) this.early.push(data);
      else if (this.readyState === 1) this.emit('message', new MessageEvent('message', { data }));
    }

    finish(code: number, reason: string): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this.id);
      this.emit('close', new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
    }

    private emit(type: 'open' | 'message' | 'error' | 'close', event: Event): void {
      const handler = this[`on${type}`] as ((e: Event) => void) | null;
      handler?.call(this, event);
      this.dispatchEvent(event);
    }
  }

  win.WebSocket = new Proxy(Native, {
    construct(target, args: [string | URL, (string | string[])?]) {
      if (isRelayUrl(args[0])) return new RelayWebSocket(String(args[0]));
      return new target(...args);
    },
  });

  return () => {
    win.WebSocket = Native;
    removeListener();
    [...sockets.values()].forEach((s) => s.close(1000, 'call ended'));
  };
}

function isRelayUrl(url: string | URL): boolean {
  try {
    return new URL(String(url)).hostname === RELAY_HOST;
  } catch {
    return false;
  }
}

/** 16 lowercase hex characters, as the api expects. */
function relayId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decodeBinary(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function decodeText(base64: string): string {
  return new TextDecoder().decode(decodeBinary(base64));
}
