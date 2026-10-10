import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { ChatItem, ChatMessage } from '../../../core/chat/chat.service';
import { linkify } from '../../../core/chat/links';
import { APP_ICONS } from '../../../core/ui/icons';
import { ChatPanel, GROUP_GAP_MS } from './chat-panel';

const T0 = new Date(2026, 9, 9, 14, 30).getTime();

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const text = overrides.text ?? 'hello';
  return {
    kind: 'message',
    id: `m${Math.random()}`,
    authorPub: 'bob',
    authorName: 'Bob',
    own: false,
    text,
    segments: linkify(text),
    at: T0,
    status: 'sent',
    reactions: [],
    ...overrides,
  };
}

/** nz-drawer renders its content into a CDK overlay on document.body. */
async function render(items: ChatItem[], ready = true) {
  TestBed.configureTestingModule({ imports: [ChatPanel], providers: [provideNzIcons(APP_ICONS)] });
  const fixture = TestBed.createComponent(ChatPanel);
  fixture.componentRef.setInput('open', true);
  fixture.componentRef.setInput('items', items);
  fixture.componentRef.setInput('ready', ready);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const panel = fixture.componentInstance;
  const out = {
    sent: [] as string[],
    retried: [] as string[],
    reacted: [] as { id: string; emoji: string }[],
  };
  panel.send.subscribe((t) => out.sent.push(t));
  panel.retry.subscribe((id) => out.retried.push(id));
  panel.react.subscribe((r) => out.reacted.push(r));
  const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel);
  const qa = <T extends Element = HTMLElement>(sel: string) => [
    ...document.body.querySelectorAll<T>(sel),
  ];
  return { fixture, out, q, qa };
}

describe('ChatPanel', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('says chat is end-to-end encrypted and ephemeral', async () => {
    const { q } = await render([]);
    expect(q('.intro')!.textContent).toContain('end-to-end encrypted and disappear when you leave');
  });

  it('groups consecutive messages from one author', async () => {
    const { qa } = await render([
      message({ text: 'one' }),
      message({ text: 'two', at: T0 + 1000 }),
      message({ text: 'later', at: T0 + GROUP_GAP_MS + 2000 }),
      message({
        text: 'carol',
        authorPub: 'carol',
        authorName: 'Carol',
        at: T0 + GROUP_GAP_MS + 3000,
      }),
    ]);
    expect(qa('.message').map((m) => m.classList.contains('grouped'))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(qa('.author').map((a) => a.textContent)).toEqual(['Bob', 'Bob', 'Carol']);
  });

  it('renders text as text and only http(s) links as anchors', async () => {
    const { q, qa } = await render([
      message({ text: '<img src=x onerror=alert(1)> see https://example.org now' }),
    ]);
    expect(q('.bubble img')).toBeNull();
    expect(q('.bubble')!.textContent).toContain('<img src=x onerror=alert(1)>');
    const [link] = qa<HTMLAnchorElement>('.bubble a');
    expect(link.href).toBe('https://example.org/');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('shows notices, sending and failed states, and retries', async () => {
    const failed = message({ own: true, status: 'failed', authorName: 'You', authorPub: 'me' });
    const { q, qa, out } = await render([
      { kind: 'notice', id: 'n1', text: 'Bob joined', at: T0 },
      message({ own: true, status: 'sending', authorName: 'You', authorPub: 'me', text: 'wait' }),
      failed,
    ]);
    expect(q('.system')!.textContent).toBe('Bob joined');
    expect(qa('.status').map((s) => s.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Sending…',
      'Not sent · Retry',
    ]);
    // No reacting to messages others haven't got.
    expect(qa('.react')).toHaveLength(0);
    q<HTMLButtonElement>('.retry')!.click();
    expect(out.retried).toEqual([failed.id]);
  });

  it('shows reaction chips and toggles ours', async () => {
    const m = message({
      reactions: [
        { emoji: '👍', count: 2, mine: true, names: ['You', 'Carol'] },
        { emoji: '🎉', count: 1, mine: false, names: ['Carol'] },
      ],
    });
    const { qa, out } = await render([m]);
    const chips = qa<HTMLButtonElement>('.chip');
    expect(chips.map((c) => c.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['👍 2', '🎉 1']);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    chips[1].click();
    expect(out.reacted).toEqual([{ id: m.id, emoji: '🎉' }]);
  });

  it('sends with Enter, keeps Shift+Enter for new lines, and clears the field', async () => {
    const { fixture, q, out } = await render([]);
    const field = q<HTMLTextAreaElement>('textarea')!;
    field.value = 'hi there';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(out.sent).toEqual([]);

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(out.sent).toEqual(['hi there']);
    expect(field.value).toBe('');
  });

  it('clears the field even when Enter comes before a render', async () => {
    const { q, out } = await render([]);
    const field = q<HTMLTextAreaElement>('textarea')!;
    field.value = 'quick';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(out.sent).toEqual(['quick']);
    expect(field.value).toBe('');
  });

  it('sends with the button, never blank text', async () => {
    const { fixture, q, out } = await render([]);
    const send = q<HTMLButtonElement>('button.send')!;
    expect(send.disabled).toBe(true);
    const field = q<HTMLTextAreaElement>('textarea')!;
    field.value = '   ';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(send.disabled).toBe(true);

    field.value = 'ok';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    send.click();
    expect(out.sent).toEqual(['ok']);
  });

  it('inserts a picked emoji at the caret, ready to keep typing', async () => {
    const { fixture, q, qa } = await render([]);
    const field = q<HTMLTextAreaElement>('textarea')!;
    field.value = 'ab';
    field.dispatchEvent(new Event('input'));
    field.setSelectionRange(1, 1);

    q<HTMLButtonElement>('.composer .icon-button')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    qa<HTMLButtonElement>('app-emoji-picker .grid button')
      .find((b) => b.textContent!.trim() === '🎉')!
      .click();

    expect(field.value).toBe('a🎉b');
    expect(field.selectionStart).toBe(3);
  });

  it('can’t send without a chat key', async () => {
    const { q } = await render([], false);
    expect(q<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
    expect(q<HTMLTextAreaElement>('textarea')!.placeholder).toBe('Securing…');
  });
});
