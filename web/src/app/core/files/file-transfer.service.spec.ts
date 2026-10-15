import { EnvironmentInjector, createEnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatService } from '../chat/chat.service';
import { ChatEvent, ReceivedChatEvent } from '../crypto/chat-crypto';
import { ChatEventBody, CryptoService } from '../crypto/crypto.service';
import { CHUNK_BYTES, frameIndex } from '../crypto/file-crypto';
import { MediaService } from '../media/media.service';
import { ParticipantDto, UsageDto } from '../signaling/signaling.types';
import { SignalingService } from '../signaling/signaling.service';
import {
  BATCH_MS,
  FileTransferService,
  MAX_ROUNDS,
  REQUEST_TIMEOUT_MS,
  STALL_MS,
  SharedFile,
  mergeRanges,
  missingRanges,
} from './file-transfer.service';
import { trackWebCrypto, webCryptoIdle } from '../../shared/testing/webcrypto-tracker';
// WebCrypto slower than the event loop, as on a busy CI runner: the specs must not depend on how fast it is.
const SLOW = 20;

const ROOM = 'room-1';

/** An SFU stand-in: published channels fan out to their subscribers (optionally dropping frames). */
class FakeSfu {
  readonly published = new Map<string, FakeChannel[]>();
  publishCount = 0;
  /** How long a subscriber's channel takes to open (its data transport waiting behind other negotiations). */
  subscribeDelayMs = 0;
  /** Return true to drop a frame on its way to a subscriber. */
  drop: (index: number, subscriber: string) => boolean = () => false;

  mediaFor(self: string): Partial<MediaService> {
    return {
      publishChannel: async (name: string) => {
        this.publishCount++;
        const subscribers: FakeChannel[] = [];
        this.published.set(name, subscribers);
        return new FakeChannel((frame) => {
          for (const s of subscribers) {
            if (!this.drop(frameIndex(frame), s.owner)) s.deliver(frame);
          }
        }, self) as unknown as RTCDataChannel;
      },
      subscribeChannel: async (_publisher: string, name: string) => {
        if (this.subscribeDelayMs) await new Promise((r) => setTimeout(r, this.subscribeDelayMs));
        const channel = new FakeChannel(() => undefined, self);
        this.published.get(name)?.push(channel);
        return channel as unknown as RTCDataChannel;
      },
      closeChannel: async (channel: RTCDataChannel) => channel.close(),
    };
  }
}

class FakeChannel {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage?: (e: { data: ArrayBuffer }) => void;
  onclose?: () => void;

  constructor(
    private readonly sink: (frame: ArrayBuffer) => void,
    readonly owner: string,
  ) {}

  send(frame: Uint8Array<ArrayBuffer>): void {
    const copy = frame.slice().buffer;
    queueMicrotask(() => this.sink(copy));
  }

  deliver(frame: ArrayBuffer): void {
    if (this.readyState === 'open') this.onmessage?.({ data: frame });
  }

  close(): void {
    this.readyState = 'closed';
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

interface Person {
  id: string;
  files: FileTransferService;
  listeners: ((e: ReceivedChatEvent) => void)[];
  sent: ChatEventBody[];
  participants: ReturnType<typeof signal<ParticipantDto[]>>;
  usage: ReturnType<typeof signal<UsageDto | undefined>>;
}

describe('FileTransferService', () => {
  let sfu: FakeSfu;
  let people: Person[];
  let seq: number;

  let untrackWebCrypto: () => void;

  beforeEach(() => {
    untrackWebCrypto = trackWebCrypto({ slow: SLOW });
    // Only timers are fake: WebCrypto and the relays finish on the real event loop (setImmediate).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    sfu = new FakeSfu();
    people = [];
    seq = 0;
  });

  afterEach(() => {
    untrackWebCrypto();
    vi.useRealTimers();
  });

  function person(id: string): Person {
    const p = { id, listeners: [], sent: [], participants: signal<ParticipantDto[]>([]), usage: signal<UsageDto | undefined>(undefined) } as unknown as Person;
    const broadcast = (event: ChatEventBody) => {
      p.sent.push(event);
      const received: ReceivedChatEvent = { fromId: id, authorPub: `pub-${id}`, event: { v: 1, seq: ++seq, ...event } as ChatEvent };
      for (const other of people) if (other !== p) other.listeners.forEach((l) => queueMicrotask(() => l(received)));
    };
    const chat = {
      ready: signal(true),
      shareFile: (card: ChatEventBody) => broadcast(card),
      sendEvent: async (body: ChatEventBody) => broadcast(body),
    };
    const crypto = {
      selfId: signal(id),
      roomId: signal(ROOM),
      onChatEvent: (l: (e: ReceivedChatEvent) => void) => {
        p.listeners.push(l);
        return () => undefined;
      },
    };
    const injector = createEnvironmentInjector(
      [
        FileTransferService,
        { provide: ChatService, useValue: chat },
        { provide: CryptoService, useValue: crypto },
        { provide: MediaService, useValue: sfu.mediaFor(id) },
        { provide: SignalingService, useValue: { participants: p.participants, usage: p.usage } },
      ],
      TestBed.inject(EnvironmentInjector),
    );
    p.files = injector.get(FileTransferService);
    people.push(p);
    for (const q of people) q.participants.set(people.filter((o) => o !== q).map((o) => ({ id: o.id }) as ParticipantDto));
    return p;
  }

  const file = (p: Person) => [...p.files.files().values()][0] as SharedFile;
  const run = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
  };
  /** Lets WebCrypto (real, so not on fake timers) and the microtask relays finish. */
  async function settle(until: () => boolean, ms = BATCH_MS + 3000) {
    for (let i = 0; i < 400 && !until(); i++) {
      // The real WebCrypto in flight finishes before the fake clock moves (its continuations schedule the timers).
      await webCryptoIdle();
      for (let j = 0; j < 5; j++) await new Promise((r) => (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(() => r(undefined)));
      await webCryptoIdle();
      await run(ms / 40);
    }
  }
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);
  const contents = async (f: SharedFile) => new Uint8Array(await (await fetch(f.url!)).arrayBuffer());

  it('shares a file: the recipient gets a card and downloads it on request', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    const data = bytes(3 * CHUNK_BYTES + 100);

    expect(hana.files.share([new File([data], 'notes.bin', { type: 'application/octet-stream' })])).toBeUndefined();
    await settle(() => !!bob.files.files().size);

    expect(file(hana).state).toBe('shared');
    expect(file(bob)).toMatchObject({ name: 'notes.bin', size: data.length, state: 'available', own: false, fromId: hana.id });

    bob.files.download(file(bob).id);
    await settle(() => file(bob).state === 'done');

    expect(file(bob).state).toBe('done');
    expect(await contents(file(bob))).toEqual(data);
    expect(sfu.publishCount).toBe(1);
  });

  it('small images download by themselves, one stream for everyone who asked', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    const carol = person('cccccccccccccccc');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...bytes(2 * CHUNK_BYTES)]);

    hana.files.share([new File([png], 'shot.png', { type: 'image/png' })]);
    await settle(() => [bob, carol].every((p) => file(p)?.state === 'done'));

    expect(file(bob).state).toBe('done');
    expect(file(carol).state).toBe('done');
    expect(file(bob).image).toBe(true);
    expect(sfu.publishCount).toBe(1);
    const announced = hana.sent.filter((e) => e.type === 'file-channel');
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ to: [bob.id, carol.id].sort((a, b) => (a < b ? -1 : 1)) });
  });

  it('asks again for chunks that were lost on the way', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    const data = bytes(5 * CHUNK_BYTES);
    let dropped = false;
    sfu.drop = (index) => {
      if (index !== 2 || dropped) return false;
      dropped = true;
      return true;
    };

    hana.files.share([new File([data], 'a.bin')]);
    await settle(() => !!bob.files.files().size);
    bob.files.download(file(bob).id);
    await settle(() => file(bob).state === 'done', STALL_MS * 3);

    expect(file(bob).state).toBe('done');
    expect(await contents(file(bob))).toEqual(data);
    const requests = bob.sent.filter((e) => e.type === 'file-request');
    expect(requests[1]).toMatchObject({ ranges: [[2, 3]] });
  });

  it('waits for a recipient who is slow to get ready instead of streaming to no one', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    sfu.subscribeDelayMs = 10_000;
    const data = bytes(2 * CHUNK_BYTES);

    hana.files.share([new File([data], 'a.bin')]);
    await settle(() => !!bob.files.files().size);
    bob.files.download(file(bob).id);
    await settle(() => file(bob).state === 'done', 30_000);

    expect(await contents(file(bob))).toEqual(data);
    expect(bob.sent.filter((e) => e.type === 'file-request')).toHaveLength(1);
    expect(sfu.publishCount).toBe(1);
  });

  it('gives up after repeated stalls and offers Retry', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    sfu.drop = () => true;

    hana.files.share([new File([bytes(100)], 'a.bin')]);
    await settle(() => !!bob.files.files().size);
    bob.files.download(file(bob).id);
    await settle(() => file(bob).state === 'failed', STALL_MS * (MAX_ROUNDS + 2) * 2);

    expect(file(bob).state).toBe('failed');
  });

  it('a file that changed on the sender’s disk fails the signed hash', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    const original = bytes(2 * CHUNK_BYTES);
    let reads = 0;
    const changing = new File([original], 'a.bin');
    const slice = changing.slice.bind(changing);
    changing.slice = (start?: number, end?: number) => {
      // Reads for the hash see the original; reads for sending see other bytes.
      return ++reads > 2 ? new Blob([bytes((end ?? 0) - (start ?? 0)).map((b) => b ^ 1)]) : slice(start, end);
    };

    hana.files.share([changing]);
    await settle(() => !!bob.files.files().size);
    bob.files.download(file(bob).id);
    await settle(() => ['done', 'corrupted'].includes(file(bob).state));

    expect(file(bob).state).toBe('corrupted');
    expect(file(bob).url).toBeUndefined();
  });

  it('files of someone who left become unavailable', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    hana.files.share([new File([bytes(10)], 'a.bin')]);
    await settle(() => !!bob.files.files().size);

    bob.participants.set([]);
    TestBed.tick();

    expect(file(bob).state).toBe('unavailable');
  });

  it('waits a long time for a busy sender, then offers Retry', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    hana.files.share([new File([bytes(10)], 'a.bin')]);
    await settle(() => !!bob.files.files().size);
    hana.listeners.length = 0; // Hana stops answering

    bob.files.download(file(bob).id);
    await run(REQUEST_TIMEOUT_MS - 1000);
    expect(file(bob).state).toBe('waiting');
    await run(1000);
    expect(file(bob).state).toBe('failed');
  });

  it('refuses to share while the usage guard pauses file sharing, and checks sizes', () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    expect(hana.files.share([new File([], 'empty')])).toBe('empty');
    expect(hana.files.share(Array.from({ length: 11 }, () => new File([bytes(1)], 'x')))).toBe('too-many');
    const huge = new File([bytes(1)], 'big');
    Object.defineProperty(huge, 'size', { value: 100 * 1024 * 1024 + 1 });
    expect(hana.files.share([huge])).toBe('too-large');

    hana.usage.set({ level: 'audio-only', percent: 95, resetsAt: '' });
    expect(hana.files.share([new File([bytes(1)], 'x')])).toBe('paused');
  });

  it('does not download images automatically while saving', async () => {
    const hana = person('aaaaaaaaaaaaaaaa');
    const bob = person('bbbbbbbbbbbbbbbb');
    bob.usage.set({ level: 'saving', percent: 85, resetsAt: '' });

    hana.files.share([new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], 's.png', { type: 'image/png' })]);
    await settle(() => !!bob.files.files().size);
    await run(BATCH_MS * 3);

    expect(file(bob).state).toBe('available');
  });

  it('computes missing and merged ranges', () => {
    expect(missingRanges([1, undefined, undefined, 1, undefined])).toEqual([[1, 3], [4, 5]]);
    expect(missingRanges([1, 1])).toEqual([]);
    expect(mergeRanges([[4, 6], [0, 2], [2, 3], [5, 8]])).toEqual([[0, 3], [4, 8]]);
  });
});
