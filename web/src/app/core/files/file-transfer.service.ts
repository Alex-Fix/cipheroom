import { Injectable, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { ChatService } from '../chat/chat.service';
import type { ReceivedChatEvent } from '../crypto/chat-crypto';
import { CryptoService } from '../crypto/crypto.service';
import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import {
  CHUNK_BYTES,
  FileContext,
  MAX_FILE_BYTES,
  chunkCount,
  chunkHash,
  cleanFileName,
  contentHash,
  frameIndex,
  importFileKey,
  newFileId,
  newFileKey,
  openChunk,
  sealChunk,
} from '../crypto/file-crypto';
import { ChunkRange, FileCard, FileEvent, MAX_RANGES } from '../crypto/file-events';
import { FileChannel } from '../media/media-transport';
import { MediaService } from '../media/media.service';
import { SignalingService } from '../signaling/signaling.service';
import { canStrip, stripImageMetadata } from './image-metadata';
import { makeThumbnail } from './thumbnail';

/** Files per send. */
export const MAX_FILES_PER_SEND = 10;
/** Images up to this size download by themselves (so they show inline); bigger files wait for a click. */
export const AUTO_DOWNLOAD_BYTES = 5 * 1024 * 1024;
/** Downloads at a time; more wait in line. */
export const MAX_DOWNLOADS = 3;
/** Downloaded files kept in memory; the oldest go back to "Download" beyond this. */
export const MAX_DOWNLOADED_BYTES = 500 * 1024 * 1024;
/** The sender gathers requests this long, so one stream serves everyone who asked (the SFU fans it out). */
export const BATCH_MS = 1000;
/**
 * The sender starts streaming once every recipient is ready, or after this long with those who are (a recipient's
 * first transfer sets up its data transport, which can wait behind a slow video subscription). With nobody ready by
 * then the stream is skipped: recipients ask again.
 */
export const READY_WAIT_MS = 20_000;
/** A download with no new chunk for this long asks again for what's missing… */
export const STALL_MS = 5000;
/** …this many times before it shows Retry. */
export const MAX_ROUNDS = 3;
/** Waiting this long for the sender to start (they may be busy with another file) shows Retry. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** The sender's channel stays open this long after its last chunk (the SFU still forwards what it has). */
export const CLOSE_DELAY_MS = 10_000;
/** Pause sending above this much buffered data; resume below the low mark. */
export const BUFFER_HIGH = 1024 * 1024;
export const BUFFER_LOW = 256 * 1024;

/** Raster formats every browser we support decodes; anything else is a download, never rendered. */
const INLINE_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);

export type FileState =
  | 'preparing' // ours: stripping metadata, thumbnail, hash
  | 'shared' // ours: others can download it from us
  | 'available' // theirs: can be downloaded
  | 'queued' // waiting for a free download slot
  | 'waiting' // asked the sender, waiting for their stream
  | 'downloading'
  | 'done'
  | 'failed' // Retry
  | 'corrupted' // didn't match the signed hash
  | 'unavailable' // the sender left, or can't share it any more
  | 'paused'; // usage guard: file sharing paused

export interface SharedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Shown inline once we have it (a raster image type; rendering still needs a successful decode). */
  image: boolean;
  own: boolean;
  /** The sender's participant id. */
  fromId: string;
  /** Blob URL of the card's preview. */
  thumbUrl?: string;
  /** Blob URL of the whole file, once we have it (ours always). */
  url?: string;
  state: FileState;
  /** Download (theirs) or current upload (ours) progress, 0–1. */
  progress: number;
  /** Ours: metadata could not be removed (unknown or unparseable format). */
  metadataKept?: boolean;
}

/** Why a file can't be shared. */
export type ShareRejection = 'too-large' | 'empty' | 'too-many' | 'not-ready' | 'paused';

interface Offer {
  card: Omit<FileCard, 'v' | 'seq'>;
  source: Blob;
  context: FileContext;
}

interface Batch {
  fileId: string;
  /** Requester → chunk ranges they need. */
  requesters: Map<string, ChunkRange[]>;
}

interface Download {
  context: FileContext;
  hash: string;
  chunks: (Uint8Array<ArrayBuffer> | undefined)[];
  hashes: (Uint8Array | undefined)[];
  received: number;
  channel?: { name: string; data: FileChannel };
  rounds: number;
  stallTimer?: ReturnType<typeof setTimeout>;
  waitTimer?: ReturnType<typeof setTimeout>;
  /** Frames are decrypted one at a time, in order. */
  work: Promise<void>;
}

/**
 * Encrypted files in chat (docs/plans/2026-10-10-encrypted-files-design.md). Sharing makes a card (name, size, type,
 * preview, hash and the file's key) and sends it as a chat event. The file itself stays in our tab: when others ask
 * for it (encrypted `file-request` events), we gather requests for a second, publish a data channel on the SFU,
 * announce it (`file-channel`, also encrypted) and stream the encrypted chunks once — the SFU copies them to every
 * subscriber. The server sees channels open and close, never names, keys or content.
 *
 * Provided per room route, like ChatService: everything is gone when the room is left.
 */
@Injectable()
export class FileTransferService implements OnDestroy {
  private readonly crypto = inject(CryptoService);
  private readonly chat = inject(ChatService);
  private readonly media = inject(MediaService);
  private readonly signaling = inject(SignalingService);

  private readonly state = signal<ReadonlyMap<string, SharedFile>>(new Map());
  private readonly offers = new Map<string, Offer>();
  private readonly downloads = new Map<string, Download>();
  /** Requests being gathered per file, then served one file at a time. */
  private readonly gathering = new Map<string, { batch: Batch; timer: ReturnType<typeof setTimeout> }>();
  private readonly uploadQueue: Batch[] = [];
  private uploading = false;
  /** `file-ready` from recipients of the stream being prepared, per channel name. */
  private readonly readiness = new Map<string, { waiting: Set<string>; done: () => void }>();
  private readonly downloadQueue: string[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;
  private destroyed = false;

  /** Every file in this call's chat, by id. */
  readonly files = this.state.asReadonly();
  /** File sharing is allowed now (usage guard below audio-only). */
  readonly allowed = computed(() => {
    const level = this.signaling.usage()?.level;
    return level !== 'audio-only' && level !== 'paused';
  });

  constructor() {
    this.unsubscribe = this.crypto.onChatEvent((e) => this.receive(e));
    // A sender who left takes their files with them.
    effect(() => {
      const present = new Set(this.signaling.participants().map((p) => p.id));
      for (const file of this.state().values()) {
        if (!file.own && !present.has(file.fromId) && file.state !== 'done' && file.state !== 'unavailable') {
          this.giveUp(file.id, 'unavailable');
        }
      }
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.timers.forEach((t) => clearTimeout(t));
    this.gathering.forEach((g) => clearTimeout(g.timer));
    for (const id of this.downloads.keys()) this.dropDownload(id);
    for (const file of this.state().values()) {
      if (file.url) URL.revokeObjectURL(file.url);
      if (file.thumbUrl) URL.revokeObjectURL(file.thumbUrl);
    }
  }

  /** Why these files can't be shared, if they can't (checked before anything is read). */
  check(files: readonly File[]): ShareRejection | undefined {
    if (!this.allowed()) return 'paused';
    if (!this.chat.ready() || !this.crypto.selfId()) return 'not-ready';
    if (files.length > MAX_FILES_PER_SEND) return 'too-many';
    if (files.some((f) => f.size === 0)) return 'empty';
    if (files.some((f) => f.size > MAX_FILE_BYTES)) return 'too-large';
    return undefined;
  }

  /** Shares files in chat (see check). Each gets a card at once and is prepared in the background. */
  share(files: readonly File[]): ShareRejection | undefined {
    const rejection = this.check(files);
    if (rejection) return rejection;
    for (const file of files) void this.prepare(file);
    return undefined;
  }

  /** Downloads someone's file (a click, or automatically for small images). */
  download(id: string): void {
    const file = this.state().get(id);
    if (!file || file.own || !['available', 'failed', 'paused'].includes(file.state)) return;
    if (!this.allowed()) {
      this.patch(id, { state: 'paused' });
      return;
    }
    const download = this.downloads.get(id);
    if (download) download.rounds = 0;
    if (this.activeDownloads() >= MAX_DOWNLOADS) {
      this.patch(id, { state: 'queued' });
      this.downloadQueue.push(id);
      return;
    }
    void this.request(id);
  }

  /** Stops a download (or takes it out of the line); it can be started again. */
  cancel(id: string): void {
    const file = this.state().get(id);
    if (!file || file.own) return;
    this.removeFromQueue(id);
    this.dropDownload(id);
    if (['queued', 'waiting', 'downloading'].includes(file.state)) this.patch(id, { state: 'available', progress: 0 });
    this.startQueued();
  }

  // --- sending ----------------------------------------------------------------------------------------------------

  private async prepare(file: File): Promise<void> {
    const selfId = this.crypto.selfId()!;
    const id = newFileId();
    const name = cleanFileName(file.name);
    const mime = cleanMime(file.type);
    this.put({ id, name, size: file.size, mime, image: INLINE_IMAGES.has(mime), own: true, fromId: selfId, state: 'preparing', progress: 0 });
    try {
      let source: Blob = file;
      let metadataKept: boolean | undefined;
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (canStrip(head)) {
        const { bytes, stripped } = stripImageMetadata(new Uint8Array(await file.arrayBuffer()));
        source = new Blob([bytes], { type: mime });
        metadataKept = !stripped;
      } else if (mime.startsWith('image/')) {
        metadataKept = true; // HEIC, GIF, …: we can't strip these
      }
      const size = source.size;
      const thumb = INLINE_IMAGES.has(mime) ? await makeThumbnail(source) : undefined;
      const hashes: Uint8Array[] = [];
      for (let i = 0; i < chunkCount(size); i++) hashes.push(await chunkHash(await readChunk(source, i)));
      const hash = await contentHash(size, hashes);
      const { raw, key } = await newFileKey();
      const roomId = this.roomId();
      if (this.destroyed || !roomId) return;

      const card: Omit<FileCard, 'v' | 'seq'> = { type: 'file', id, name, size, mime, hash, key: raw, ...(thumb ? { thumb } : {}) };
      this.offers.set(id, { card, source, context: { roomId, fileId: id, total: chunkCount(size), key } });
      this.patch(id, {
        size,
        state: 'shared',
        url: URL.createObjectURL(source),
        thumbUrl: thumb ? thumbnailUrl(thumb) : undefined,
        metadataKept,
      });
      this.chat.shareFile(card);
    } catch {
      this.patch(id, { state: 'failed' });
    }
  }

  private onRequest(fromId: string, fileId: string, ranges: ChunkRange[] | undefined): void {
    const offer = this.offers.get(fileId);
    if (!offer || !this.allowed()) return;
    const wanted = ranges ?? [[0, offer.context.total]];
    if (wanted.some(([, end]) => end > offer.context.total)) return;
    const gathering = this.gathering.get(fileId);
    if (gathering) {
      gathering.batch.requesters.set(fromId, wanted);
      return;
    }
    const batch: Batch = { fileId, requesters: new Map([[fromId, wanted]]) };
    const timer = setTimeout(() => {
      this.gathering.delete(fileId);
      this.uploadQueue.push(batch);
      void this.serveNext();
    }, BATCH_MS);
    this.gathering.set(fileId, { batch, timer });
  }

  private async serveNext(): Promise<void> {
    if (this.uploading || this.destroyed) return;
    const batch = this.uploadQueue.shift();
    if (!batch) return;
    this.uploading = true;
    try {
      await this.serve(batch);
    } catch (error) {
      // The channel failed or closed: recipients ask again for what they're missing. The cause, for debugging
      // (never file names or contents):
      console.warn('[cipheroom] file transfer failed', error instanceof Error ? error.message : error);
    } finally {
      this.uploading = false;
      this.patch(batch.fileId, { progress: 0 });
      void this.serveNext();
    }
  }

  private async serve(batch: Batch): Promise<void> {
    const offer = this.offers.get(batch.fileId);
    const present = new Set(this.signaling.participants().map((p) => p.id));
    const to = [...batch.requesters.keys()].filter((id) => present.has(id));
    if (!offer || !to.length || !this.allowed()) return;

    const name = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const channel = await this.media.publishChannel(name, to);
    try {
      // Everyone gets the union of what was asked; each keeps what it lacks.
      const ranges = mergeRanges(to.flatMap((id) => batch.requesters.get(id)!)).slice(0, MAX_RANGES);
      const ready = this.awaitReady(name, to);
      await this.chat.sendEvent({ type: 'file-channel', file: batch.fileId, channel: name, to, ranges });
      // Nobody ready in time: skip the stream rather than send it to no one (they ask again when they can).
      if ((await ready) === 0) return;
      await this.pump(offer, channel, ranges);
      await this.sleep(CLOSE_DELAY_MS);
    } finally {
      this.readiness.delete(name);
      await this.media.closeChannel(channel, name).catch(() => undefined);
    }
  }

  /** Resolves with how many recipients are ready: all of them, or those ready after READY_WAIT_MS. */
  private awaitReady(channelName: string, to: string[]): Promise<number> {
    return new Promise((resolve) => {
      const waiting = new Set(to);
      const timer = setTimeout(done, READY_WAIT_MS);
      this.timers.add(timer);
      this.readiness.set(channelName, { waiting, done });
      function done() {
        clearTimeout(timer);
        resolve(to.length - waiting.size);
      }
    });
  }

  private onReady(fromId: string, channelName: string): void {
    const entry = this.readiness.get(channelName);
    if (!entry) return;
    entry.waiting.delete(fromId);
    if (entry.waiting.size === 0) entry.done();
  }

  private async pump(offer: Offer, channel: FileChannel, ranges: ChunkRange[]): Promise<void> {
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    const total = ranges.reduce((n, [a, b]) => n + b - a, 0);
    let sent = 0;
    for (const [start, end] of ranges) {
      for (let i = start; i < end; i++) {
        if (channel.readyState !== 'open') throw new Error('Channel closed.');
        let chunk: Uint8Array<ArrayBuffer>;
        try {
          chunk = await readChunk(offer.source, i);
        } catch {
          await this.withdraw(offer.card.id);
          throw new Error('File can no longer be read.');
        }
        const frame = await sealChunk(offer.context, i, chunk);
        if (channel.bufferedAmount > BUFFER_HIGH) await drained(channel);
        channel.send(frame);
        this.progress(offer.card.id, ++sent / total);
      }
    }
    while (channel.bufferedAmount > 0 && channel.readyState === 'open') await this.sleep(50);
  }

  /** Our file became unreadable (deleted or changed on disk): tell everyone it's gone. */
  private async withdraw(fileId: string): Promise<void> {
    if (!this.offers.delete(fileId)) return;
    this.patch(fileId, { state: 'unavailable' });
    await this.chat.sendEvent({ type: 'file-gone', file: fileId }).catch(() => undefined);
  }

  // --- receiving --------------------------------------------------------------------------------------------------

  private receive({ fromId, event }: ReceivedChatEvent): void {
    if (!isFileEventType(event)) return;
    switch (event.type) {
      case 'file':
        void this.onCard(fromId, event);
        return;
      case 'file-request':
        this.onRequest(fromId, event.file, event.ranges);
        return;
      case 'file-ready':
        this.onReady(fromId, event.channel);
        return;
      case 'file-channel':
        if (this.crypto.selfId() && event.to.includes(this.crypto.selfId()!)) {
          void this.onChannel(fromId, event.file, event.channel);
        }
        return;
      case 'file-gone':
        if (this.state().get(event.file)?.fromId === fromId) this.giveUp(event.file, 'unavailable');
        return;
    }
  }

  private async onCard(fromId: string, card: FileCard): Promise<void> {
    if (this.state().has(card.id)) return; // a resent copy
    const roomId = this.roomId();
    if (!roomId) return;
    const image = INLINE_IMAGES.has(card.mime);
    this.put({
      id: card.id,
      name: card.name,
      size: card.size,
      mime: card.mime,
      image,
      own: false,
      fromId,
      thumbUrl: card.thumb ? thumbnailUrl(card.thumb) : undefined,
      state: this.allowed() ? 'available' : 'paused',
      progress: 0,
    });
    const total = chunkCount(card.size);
    this.downloads.set(card.id, {
      context: { roomId, fileId: card.id, total, key: await importFileKey(card.key) },
      hash: card.hash,
      chunks: new Array(total),
      hashes: new Array(total),
      received: 0,
      rounds: 0,
      work: Promise.resolve(),
    });
    const auto = image && card.size <= AUTO_DOWNLOAD_BYTES && this.signaling.usage()?.level !== 'saving';
    if (auto && this.allowed()) this.download(card.id);
  }

  private async request(id: string): Promise<void> {
    const download = this.downloads.get(id);
    if (!download) return;
    this.patch(id, { state: 'waiting' });
    clearTimeout(download.waitTimer);
    download.waitTimer = this.later(() => this.fail(id), REQUEST_TIMEOUT_MS);
    const missing = missingRanges(download.chunks);
    const ranges = download.received === 0 ? undefined : missing.slice(0, MAX_RANGES);
    try {
      await this.chat.sendEvent({ type: 'file-request', file: id, ...(ranges ? { ranges } : {}) });
    } catch {
      this.fail(id);
    }
  }

  private async onChannel(fromId: string, fileId: string, channelName: string): Promise<void> {
    const file = this.state().get(fileId);
    const download = this.downloads.get(fileId);
    // Only the card's author streams its file, and only when we asked.
    if (!file || !download || file.fromId !== fromId || !['waiting', 'downloading'].includes(file.state)) return;
    clearTimeout(download.waitTimer);
    await this.closeChannel(fileId, download);
    let data: FileChannel;
    try {
      data = await this.media.subscribeChannel(fromId, channelName);
    } catch {
      this.stalled(fileId);
      return;
    }
    if (this.downloads.get(fileId) !== download) {
      await this.media.closeChannel(data, channelName, fromId).catch(() => undefined);
      return;
    }
    download.channel = { name: channelName, data };
    data.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      download.work = download.work.then(() => this.onFrame(fileId, download, e.data)).catch(() => undefined);
    };
    data.onclose = () => {
      if (download.channel?.data === data) this.stalled(fileId);
    };
    this.patch(fileId, { state: 'downloading' });
    this.armStall(fileId, download);
    await this.chat.sendEvent({ type: 'file-ready', file: fileId, channel: channelName }).catch(() => undefined);
  }

  private async onFrame(fileId: string, download: Download, frame: ArrayBuffer): Promise<void> {
    if (this.downloads.get(fileId) !== download || !(frame instanceof ArrayBuffer)) return;
    let index: number;
    try {
      index = frameIndex(frame);
    } catch {
      return;
    }
    if (download.chunks[index]) return; // already have it (someone else's resend)
    let chunk: Uint8Array<ArrayBuffer>;
    try {
      ({ chunk } = await openChunk(download.context, frame));
    } catch {
      return; // not ours, tampered, or for another file: ignored
    }
    if (download.chunks[index] || this.downloads.get(fileId) !== download) return;
    download.chunks[index] = chunk;
    download.hashes[index] = await chunkHash(chunk);
    download.received++;
    download.rounds = 0;
    this.armStall(fileId, download);
    this.progress(fileId, download.received / download.context.total);
    if (download.received === download.context.total) await this.complete(fileId, download);
  }

  private async complete(fileId: string, download: Download): Promise<void> {
    clearTimeout(download.stallTimer);
    const file = this.state().get(fileId)!;
    const hash = await contentHash(file.size, download.hashes as Uint8Array[]);
    const blob = hash === download.hash ? new Blob(download.chunks as Uint8Array<ArrayBuffer>[], { type: file.image ? file.mime : 'application/octet-stream' }) : undefined;
    this.dropDownload(fileId);
    if (!blob) {
      this.patch(fileId, { state: 'corrupted', progress: 0 });
    } else {
      this.patch(fileId, { state: 'done', progress: 1, url: URL.createObjectURL(blob) });
      this.evictOldDownloads();
    }
    this.startQueued();
  }

  private armStall(fileId: string, download: Download): void {
    clearTimeout(download.stallTimer);
    download.stallTimer = this.later(() => this.stalled(fileId), STALL_MS);
  }

  /** No progress: drop the channel and ask for what's missing, a few times. */
  private stalled(fileId: string): void {
    const download = this.downloads.get(fileId);
    const file = this.state().get(fileId);
    if (!download || !file || !['waiting', 'downloading'].includes(file.state)) return;
    clearTimeout(download.stallTimer);
    void this.closeChannel(fileId, download);
    if (++download.rounds >= MAX_ROUNDS) {
      this.fail(fileId);
      return;
    }
    void this.request(fileId);
  }

  private fail(fileId: string): void {
    const download = this.downloads.get(fileId);
    if (download) {
      clearTimeout(download.stallTimer);
      clearTimeout(download.waitTimer);
      void this.closeChannel(fileId, download);
    }
    this.patch(fileId, { state: 'failed' });
    this.startQueued();
  }

  private giveUp(fileId: string, state: 'unavailable'): void {
    this.removeFromQueue(fileId);
    this.dropDownload(fileId);
    this.downloads.delete(fileId);
    this.patch(fileId, { state, progress: 0 });
    this.startQueued();
  }

  private async closeChannel(fileId: string, download: Download): Promise<void> {
    const channel = download.channel;
    if (!channel) return;
    download.channel = undefined;
    const fromId = this.state().get(fileId)?.fromId;
    await this.media.closeChannel(channel.data, channel.name, fromId).catch(() => undefined);
  }

  /** Forgets a download's chunks and channel (the key stays for a retry). */
  private dropDownload(fileId: string): void {
    const download = this.downloads.get(fileId);
    if (!download) return;
    clearTimeout(download.stallTimer);
    clearTimeout(download.waitTimer);
    void this.closeChannel(fileId, download);
    this.downloads.set(fileId, {
      ...download,
      chunks: new Array(download.context.total),
      hashes: new Array(download.context.total),
      received: 0,
      channel: undefined,
      stallTimer: undefined,
      waitTimer: undefined,
      work: Promise.resolve(),
    });
  }

  private evictOldDownloads(): void {
    const done = [...this.state().values()].filter((f) => !f.own && f.state === 'done' && f.url);
    let total = done.reduce((n, f) => n + f.size, 0);
    for (const file of done) {
      if (total <= MAX_DOWNLOADED_BYTES) break;
      URL.revokeObjectURL(file.url!);
      total -= file.size;
      this.patch(file.id, { state: 'available', url: undefined, progress: 0 });
    }
  }

  private activeDownloads(): number {
    return [...this.state().values()].filter((f) => f.state === 'waiting' || f.state === 'downloading').length;
  }

  private startQueued(): void {
    while (this.downloadQueue.length && this.activeDownloads() < MAX_DOWNLOADS) {
      const id = this.downloadQueue.shift()!;
      if (this.state().get(id)?.state === 'queued') void this.request(id);
    }
  }

  private removeFromQueue(id: string): void {
    const index = this.downloadQueue.indexOf(id);
    if (index >= 0) this.downloadQueue.splice(index, 1);
  }

  // --- helpers ----------------------------------------------------------------------------------------------------

  private roomId(): string | undefined {
    return this.crypto.roomId();
  }

  private put(file: SharedFile): void {
    this.state.update((files) => new Map(files).set(file.id, file));
  }

  private patch(id: string, change: Partial<SharedFile>): void {
    this.state.update((files) => {
      const file = files.get(id);
      return file ? new Map(files).set(id, { ...file, ...change }) : files;
    });
  }

  /** Progress in whole percent steps (a 100 MB file has 6,400 chunks). */
  private progress(id: string, value: number): void {
    const current = this.state().get(id)?.progress ?? 0;
    if (Math.floor(value * 100) !== Math.floor(current * 100) || value === 1) this.patch(id, { progress: value });
  }

  private later(work: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      work();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.later(resolve, ms));
  }
}

const FILE_EVENT_TYPES = new Set(['file', 'file-request', 'file-channel', 'file-ready', 'file-gone']);
const isFileEventType = (event: { type: string }): event is FileEvent => FILE_EVENT_TYPES.has(event.type);

/** A browser-reported type we can put in a card (lowercase, no parameters); empty if it isn't one. */
function cleanMime(type: string): string {
  const mime = type.toLowerCase().split(';')[0].trim();
  return /^[\w.+-]+\/[\w.+-]+$/.test(mime) && mime.length <= 127 ? mime : '';
}

function thumbnailUrl(thumb: string): string {
  return URL.createObjectURL(new Blob([fromBase64Url(thumb)], { type: 'image/jpeg' }));
}

async function readChunk(source: Blob, index: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await source.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).arrayBuffer());
}

function drained(channel: FileChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
  });
}

/** The chunk ranges we don't have yet. */
export function missingRanges(chunks: readonly unknown[]): ChunkRange[] {
  const ranges: ChunkRange[] = [];
  let start = -1;
  for (let i = 0; i <= chunks.length; i++) {
    const missing = i < chunks.length && !chunks[i];
    if (missing && start < 0) start = i;
    if (!missing && start >= 0) {
      ranges.push([start, i]);
      start = -1;
    }
  }
  return ranges;
}

/** Sorted, overlapping and touching ranges joined. */
export function mergeRanges(ranges: readonly ChunkRange[]): ChunkRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: ChunkRange[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
