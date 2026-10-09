import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { ChatEventBody, CryptoService } from '../crypto/crypto.service';
import { cleanChatText, newChatId } from '../crypto/chat-crypto';
import type { ReceivedChatEvent } from '../crypto/chat-crypto';
import { SignalingService } from '../signaling/signaling.service';
import { isReactionEmoji } from './emoji';
import { TextSegment, linkify } from './links';

/** Items kept per call; older ones are dropped. */
export const MAX_CHAT_ITEMS = 500;

export type ChatStatus = 'sending' | 'sent' | 'failed';

export interface ReactionView {
  emoji: string;
  count: number;
  /** We reacted with this emoji (clicking the chip takes it back). */
  mine: boolean;
  /** Who reacted, for the chip's tooltip ("You" for us). */
  names: string[];
}

export interface ChatMessage {
  kind: 'message';
  id: string;
  /** Author's identity key: groups consecutive messages and survives their rejoin. */
  authorPub: string;
  /** As the author signed it in their key envelope ("You" for ours). */
  authorName: string;
  own: boolean;
  text: string;
  segments: TextSegment[];
  /** Local time we sent or received it (ms). */
  at: number;
  status: ChatStatus;
  reactions: ReactionView[];
}

/** "Bob joined" / "Bob left": where a newcomer's history starts. */
export interface ChatNotice {
  kind: 'notice';
  id: string;
  text: string;
  at: number;
}

export type ChatItem = ChatMessage | ChatNotice;

interface MessageEntry extends Omit<ChatMessage, 'reactions'> {
  /** emoji → reactor identity → reactor name, in the order they came. */
  reactors: Map<string, Map<string, string>>;
}

type Entry = MessageEntry | ChatNotice;

/**
 * The call's chat, end to end encrypted (docs/plans/2026-10-09-encrypted-chat-design.md): messages, reactions, join
 * and leave notices, unread count. Lives in memory only — gone when the room is left; provided per room route.
 * CryptoService does all the crypto (sealing, opening, signatures, replays); this service never sees a key.
 */
@Injectable()
export class ChatService implements OnDestroy {
  private readonly crypto = inject(CryptoService);
  private readonly signaling = inject(SignalingService);

  private readonly entries = signal<readonly Entry[]>([]);
  private open = false;
  /** Sends go out one at a time: sequence numbers must reach others in order. */
  private outbox: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;

  /** Messages can be sent (we hold a chat key). */
  readonly ready = this.crypto.chatReady;
  readonly unread = signal(0);
  /** The newest message from someone else (for the "Alice: …" notice while chat is closed). */
  readonly latest = signal<ChatMessage | undefined>(undefined);

  readonly items = computed<ChatItem[]>(() => {
    const self = this.crypto.identityPub();
    return this.entries().map((e) => (e.kind === 'notice' ? e : toMessage(e, self)));
  });

  constructor() {
    this.unsubscribe = this.crypto.onChatEvent((e) => this.receive(e));
  }

  ngOnDestroy(): void {
    this.unsubscribe();
  }

  /** The chat panel opened or closed; opening reads everything. */
  setOpen(open: boolean): void {
    this.open = open;
    if (open) this.unread.set(0);
  }

  /** Sends a message; false if there was nothing to send after cleaning. */
  send(text: string): boolean {
    const cleaned = cleanChatText(text);
    const self = this.crypto.identityPub();
    if (!cleaned || !self) return false;
    const entry: MessageEntry = {
      kind: 'message',
      id: newChatId(),
      authorPub: self,
      authorName: 'You',
      own: true,
      text: cleaned,
      segments: linkify(cleaned),
      at: Date.now(),
      status: 'sending',
      reactors: new Map(),
    };
    this.append(entry);
    void this.deliver(entry);
    return true;
  }

  /** Sends a failed message again (same id: anyone who did get it ignores the copy). */
  retry(id: string): void {
    const entry = this.find(id);
    if (entry?.own && entry.status === 'failed') void this.deliver(entry);
  }

  /** Adds our reaction with `emoji` to a message, or takes it back if it's there. */
  react(messageId: string, emoji: string): void {
    const self = this.crypto.identityPub();
    const entry = this.find(messageId);
    if (!self || !entry || entry.status !== 'sent' || !isReactionEmoji(emoji)) return;
    const on = !entry.reactors.get(emoji)?.has(self);
    this.setReaction(messageId, emoji, self, 'You', on);
    void this.enqueue({ type: 'reaction', target: messageId, emoji, on }).catch(() =>
      this.setReaction(messageId, emoji, self, 'You', !on),
    );
  }

  notice(text: string): void {
    this.append({ kind: 'notice', id: newChatId(), text, at: Date.now() });
  }

  private async deliver(entry: MessageEntry): Promise<void> {
    this.update(entry.id, (e) => ({ ...e, status: 'sending' }));
    try {
      await this.enqueue({ type: 'message', id: entry.id, text: entry.text });
      this.update(entry.id, (e) => ({ ...e, status: 'sent' }));
    } catch {
      this.update(entry.id, (e) => ({ ...e, status: 'failed' }));
    }
  }

  private enqueue(body: ChatEventBody): Promise<void> {
    const run = this.outbox.then(async () =>
      this.signaling.sendChat(await this.crypto.sealChat(body)),
    );
    this.outbox = run.catch(() => undefined);
    return run;
  }

  private receive({ fromId, authorPub, event }: ReceivedChatEvent): void {
    const name = this.crypto.names().get(fromId) ?? 'Someone';
    if (event.type === 'reaction') {
      if (isReactionEmoji(event.emoji) && this.find(event.target)?.status === 'sent') {
        this.setReaction(event.target, event.emoji, authorPub, name, event.on);
      }
      return;
    }
    if (this.entries().some((e) => e.id === event.id)) return; // a resent copy
    const entry: MessageEntry = {
      kind: 'message',
      id: event.id,
      authorPub,
      authorName: name,
      own: false,
      text: event.text,
      segments: linkify(event.text),
      at: Date.now(),
      status: 'sent',
      reactors: new Map(),
    };
    this.append(entry);
    this.latest.set(toMessage(entry, this.crypto.identityPub()));
    if (!this.open) this.unread.update((n) => n + 1);
  }

  private setReaction(id: string, emoji: string, pub: string, name: string, on: boolean): void {
    this.update(id, (e) => {
      const reactors = new Map(e.reactors);
      const who = new Map(reactors.get(emoji));
      if (on) who.set(pub, name);
      else who.delete(pub);
      if (who.size) reactors.set(emoji, who);
      else reactors.delete(emoji);
      return { ...e, reactors };
    });
  }

  private append(entry: Entry): void {
    this.entries.update((list) => [...list, entry].slice(-MAX_CHAT_ITEMS));
  }

  private find(id: string): MessageEntry | undefined {
    const entry = this.entries().find((e) => e.id === id);
    return entry?.kind === 'message' ? entry : undefined;
  }

  private update(id: string, change: (e: MessageEntry) => MessageEntry): void {
    this.entries.update((list) =>
      list.map((e) => (e.id === id && e.kind === 'message' ? change(e) : e)),
    );
  }
}

function toMessage(entry: MessageEntry, self: string | undefined): ChatMessage {
  const { reactors, ...message } = entry;
  return {
    ...message,
    reactions: [...reactors].map(([emoji, who]) => ({
      emoji,
      count: who.size,
      mine: !!self && who.has(self),
      names: [...who.values()],
    })),
  };
}
