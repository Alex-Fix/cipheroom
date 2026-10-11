import { MediaRelayListener, SignalingService } from '../signaling/signaling.service';
import { RELAY_URL, WebSocketHost, installRelayWebSocket } from './relay-websocket';

class NativeSocket {
  constructor(readonly url: string) {}
}

function setup({ refuse = false } = {}) {
  let listener!: MediaRelayListener;
  let resolveOpen!: () => void;
  const signaling = {
    openMediaRelay: vi.fn(() => (refuse ? Promise.reject(new Error('Not admitted.')) : new Promise<void>((r) => (resolveOpen = r)))),
    sendMediaRelay: vi.fn(),
    closeMediaRelay: vi.fn().mockResolvedValue(undefined),
    onMediaRelay: vi.fn((l: MediaRelayListener) => {
      listener = l;
      return removeListener;
    }),
  };
  const removeListener = vi.fn();
  const host = { WebSocket: NativeSocket as unknown as typeof WebSocket } satisfies WebSocketHost;
  const uninstall = installRelayWebSocket(signaling as unknown as SignalingService, host);
  return { signaling, host, uninstall, removeListener, listener: () => listener, open: () => resolveOpen() };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('installRelayWebSocket', () => {
  it('leaves every other WebSocket to the browser', () => {
    const { host, signaling } = setup();
    const socket = new host.WebSocket('wss://example.org/socket');
    expect(socket).toBeInstanceOf(NativeSocket);
    expect(signaling.openMediaRelay).not.toHaveBeenCalled();
  });

  it('opens a relay with its own id, LiveKit’s path and query', () => {
    const { host, signaling } = setup();
    new host.WebSocket(`${RELAY_URL}/rtc/v1?join_request=AAAA&access_token=relayed`);

    const [id, path, query] = signaling.openMediaRelay.mock.calls[0] as unknown as [string, string, string];
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(path).toBe('/rtc/v1');
    expect(query).toBe('join_request=AAAA&access_token=relayed');
  });

  it('keeps messages that beat the open and delivers them after it, as ArrayBuffers', async () => {
    const { host, signaling, listener, open } = setup();
    const socket = new host.WebSocket(`${RELAY_URL}/rtc/v1`);
    const events: string[] = [];
    socket.onopen = () => events.push('open');
    socket.onmessage = (e: MessageEvent) => events.push(`message ${[...new Uint8Array(e.data as ArrayBuffer)]}`);
    const [id] = signaling.openMediaRelay.mock.calls[0] as unknown as [string];

    listener().received(id, b64([1, 2]), false); // LiveKit's join response, before OpenMediaRelay returned
    open();
    await settle();
    listener().received(id, b64([3]), false);

    expect(events).toEqual(['open', 'message 1,2', 'message 3']);
  });

  it('sends binary and text messages base64-encoded, and fails before it is open', async () => {
    const { host, signaling, open } = setup();
    const socket = new host.WebSocket(`${RELAY_URL}/rtc/v1`);
    expect(() => socket.send(new Uint8Array([1]))).toThrow();
    open();
    await settle();
    const [id] = signaling.openMediaRelay.mock.calls[0] as unknown as [string];

    socket.send(new Uint8Array([9, 8, 7]).buffer);
    socket.send('{"ping":1}');

    expect(signaling.sendMediaRelay.mock.calls).toEqual([
      [id, b64([9, 8, 7]), false],
      [id, btoa('{"ping":1}'), true],
    ]);
  });

  it('a close from the media server, or SignalR dropping, reaches livekit-client as a close event', async () => {
    const { host, signaling, listener, open } = setup();
    const a = new host.WebSocket(`${RELAY_URL}/rtc/v1`);
    const b = new host.WebSocket(`${RELAY_URL}/rtc/v1`);
    const closes: number[] = [];
    a.onclose = (e: CloseEvent) => closes.push(e.code);
    b.addEventListener('close', (e) => closes.push((e as CloseEvent).code));
    open();
    await settle();
    const [idA] = signaling.openMediaRelay.mock.calls[0] as unknown as [string];

    listener().closed(idA, 1011);
    listener().disconnected();

    expect(closes).toEqual([1011, 1006]);
    expect(a.readyState).toBe(3);
  });

  it('closing tells the api', async () => {
    const { host, signaling, open } = setup();
    const socket = new host.WebSocket(`${RELAY_URL}/rtc/v1`);
    open();
    await settle();
    const [id] = signaling.openMediaRelay.mock.calls[0] as unknown as [string];

    socket.close();

    expect(signaling.closeMediaRelay).toHaveBeenCalledWith(id);
    expect(socket.readyState).toBe(3);
  });

  it('a refused relay errors and closes (livekit-client retries)', async () => {
    const { host } = setup({ refuse: true });
    const socket = new host.WebSocket(`${RELAY_URL}/rtc/v1`);
    const events: string[] = [];
    socket.onerror = () => events.push('error');
    socket.onclose = (e: CloseEvent) => events.push(`close ${e.code}`);
    await settle();
    expect(events).toEqual(['error', 'close 1006']);
  });

  it('uninstalling restores the browser’s WebSocket and closes open relays', async () => {
    const { host, uninstall, removeListener, signaling, open } = setup();
    const socket = new host.WebSocket(`${RELAY_URL}/rtc/v1`);
    open();
    await settle();

    uninstall();

    expect(host.WebSocket).toBe(NativeSocket);
    expect(removeListener).toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
    expect(signaling.closeMediaRelay).toHaveBeenCalled();
  });
});
