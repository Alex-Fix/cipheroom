import { EnvironmentInjector, createEnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatEvent, ReceivedChatEvent, newChatId } from '../crypto/chat-crypto';
import { ChatEventBody, CryptoService } from '../crypto/crypto.service';
import { SignalingService } from '../signaling/signaling.service';
import { ChatMessage, ChatService, MAX_CHAT_ITEMS } from './chat.service';

/** Lets the outbox's promise chain run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('ChatService', () => {
  let chat: ChatService;
  let deliver: (e: ReceivedChatEvent) => void;
  let sealed: ChatEventBody[];
  let sendChat: ReturnType<typeof vi.fn>;
  let seq: number;
  const names = signal<ReadonlyMap<string, string>>(
    new Map([
      ['p-bob', 'Bob'],
      ['p-carol', 'Carol'],
    ]),
  );

  beforeEach(() => {
    sealed = [];
    seq = 0;
    sendChat = vi.fn(async () => undefined);
    const crypto = {
      chatReady: signal(true),
      identityPub: signal('me'),
      names,
      sealChat: vi.fn(async (body: ChatEventBody) => {
        sealed.push(body);
        return `blob-${sealed.length}`;
      }),
      onChatEvent: (listener: (e: ReceivedChatEvent) => void) => {
        deliver = listener;
        return () => undefined;
      },
    };
    const injector = createEnvironmentInjector(
      [
        ChatService,
        { provide: CryptoService, useValue: crypto },
        { provide: SignalingService, useValue: { sendChat } },
      ],
      TestBed.inject(EnvironmentInjector),
    );
    chat = injector.get(ChatService);
  });

  const fromBob = (event: Partial<ChatEvent> & Pick<ChatEvent, 'type'>, pub = 'bob') =>
    deliver({
      fromId: pub === 'bob' ? 'p-bob' : 'p-carol',
      authorPub: pub,
      event: { v: 1, seq: ++seq, ...event } as ChatEvent,
    });
  const messages = () => chat.items().filter((i): i is ChatMessage => i.kind === 'message');

  it('sends a cleaned message and shows it as ours until the server accepts it', async () => {
    let accept!: () => void;
    sendChat.mockImplementationOnce(() => new Promise<void>((r) => (accept = r)));

    expect(chat.send('  hi https://x.test  ')).toBe(true);
    expect(messages()[0]).toMatchObject({
      own: true,
      authorName: 'You',
      text: 'hi https://x.test',
      status: 'sending',
      segments: [{ text: 'hi ' }, { text: 'https://x.test', href: 'https://x.test/' }],
    });
    await flush();
    expect(sealed).toEqual([{ type: 'message', id: messages()[0].id, text: 'hi https://x.test' }]);
    expect(sendChat).toHaveBeenCalledWith('blob-1');

    accept();
    await flush();
    expect(messages()[0].status).toBe('sent');
  });

  it('sends nothing for blank text', () => {
    expect(chat.send('  \n ')).toBe(false);
    expect(chat.items()).toEqual([]);
  });

  it('marks a failed send and retries it with the same id', async () => {
    sendChat.mockRejectedValueOnce(new Error('Too many requests.'));
    chat.send('hello');
    await flush();
    const [failed] = messages();
    expect(failed.status).toBe('failed');

    chat.retry(failed.id);
    await flush();
    expect(messages()[0].status).toBe('sent');
    expect(sealed.map((b) => (b as { id: string }).id)).toEqual([failed.id, failed.id]);
  });

  it('sends one event at a time, in order', async () => {
    const order: string[] = [];
    sendChat.mockImplementation(async (blob: string) => {
      order.push(`start ${blob}`);
      await flush();
      order.push(`end ${blob}`);
    });
    chat.send('one');
    chat.send('two');
    await vi.waitFor(() => expect(order).toHaveLength(4));
    expect(order).toEqual(['start blob-1', 'end blob-1', 'start blob-2', 'end blob-2']);
  });

  it('shows others’ messages with the name from their key envelope, once', () => {
    const id = newChatId();
    fromBob({ type: 'message', id, text: 'hey' });
    fromBob({ type: 'message', id, text: 'hey' });

    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({
      own: false,
      authorName: 'Bob',
      authorPub: 'bob',
      text: 'hey',
    });
    expect(chat.latest()?.text).toBe('hey');
  });

  it('counts unread messages while chat is closed', () => {
    fromBob({ type: 'message', id: newChatId(), text: '1' });
    fromBob({ type: 'message', id: newChatId(), text: '2' });
    expect(chat.unread()).toBe(2);

    chat.setOpen(true);
    expect(chat.unread()).toBe(0);
    fromBob({ type: 'message', id: newChatId(), text: '3' });
    expect(chat.unread()).toBe(0);
  });

  describe('reactions', () => {
    let id: string;
    const reactions = () => messages()[0].reactions;

    beforeEach(() => {
      id = newChatId();
      fromBob({ type: 'message', id, text: 'ship it?' });
    });

    it('collects reactions per emoji with who reacted', () => {
      fromBob({ type: 'reaction', target: id, emoji: '👍', on: true });
      fromBob({ type: 'reaction', target: id, emoji: '👍', on: true }, 'carol');
      fromBob({ type: 'reaction', target: id, emoji: '🎉', on: true }, 'carol');

      expect(reactions()).toEqual([
        { emoji: '👍', count: 2, mine: false, names: ['Bob', 'Carol'] },
        { emoji: '🎉', count: 1, mine: false, names: ['Carol'] },
      ]);

      fromBob({ type: 'reaction', target: id, emoji: '🎉', on: false }, 'carol');
      expect(reactions().map((r) => r.emoji)).toEqual(['👍']);
    });

    it('toggles our own reaction and sends each change', async () => {
      chat.react(id, '❤️');
      expect(reactions()).toEqual([{ emoji: '❤️', count: 1, mine: true, names: ['You'] }]);
      chat.react(id, '❤️');
      expect(reactions()).toEqual([]);
      await flush();
      expect(sealed).toEqual([
        { type: 'reaction', target: id, emoji: '❤️', on: true },
        { type: 'reaction', target: id, emoji: '❤️', on: false },
      ]);
    });

    it('takes our reaction back if it couldn’t be sent', async () => {
      sendChat.mockRejectedValueOnce(new Error('offline'));
      chat.react(id, '👍');
      await flush();
      expect(reactions()).toEqual([]);
    });

    it('ignores emoji outside our set and messages we don’t have', () => {
      fromBob({ type: 'reaction', target: id, emoji: 'lol', on: true });
      fromBob({ type: 'reaction', target: newChatId(), emoji: '👍', on: true });
      chat.react(id, 'x');
      expect(reactions()).toEqual([]);
    });

    it('can’t react to our own message before it was sent', async () => {
      sendChat.mockRejectedValueOnce(new Error('offline'));
      chat.send('mine');
      await flush();
      const own = messages()[1];
      chat.react(own.id, '👍');
      expect(messages()[1].reactions).toEqual([]);
    });
  });

  it('shows join and leave notices between messages', () => {
    chat.notice('Bob joined');
    fromBob({ type: 'message', id: newChatId(), text: 'hi' });
    expect(chat.items().map((i) => i.kind)).toEqual(['notice', 'message']);
    expect(chat.unread()).toBe(1);
  });

  it('keeps at most MAX_CHAT_ITEMS', () => {
    for (let i = 0; i < MAX_CHAT_ITEMS + 3; i++) chat.notice(`n${i}`);
    expect(chat.items()).toHaveLength(MAX_CHAT_ITEMS);
    expect(chat.items()[0]).toMatchObject({ text: 'n3' });
  });
});
