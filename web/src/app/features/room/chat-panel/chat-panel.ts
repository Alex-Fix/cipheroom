import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzPopoverModule } from 'ng-zorro-antd/popover';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { ChatItem } from '../../../core/chat/chat.service';
import { QUICK_REACTIONS } from '../../../core/chat/emoji';
import { MAX_CHAT_TEXT } from '../../../core/crypto/chat-crypto';
import { SharedFile } from '../../../core/files/file-transfer.service';
import { EmojiPicker } from '../emoji-picker/emoji-picker';
import { FileCard } from '../file-card/file-card';
import { ImageLightbox } from '../image-lightbox/image-lightbox';

/** Messages closer together than this from one author share one name/time header. */
export const GROUP_GAP_MS = 5 * 60_000;
/** Scrolled this close to the end still counts as "following" the conversation. */
const STICK_PX = 80;

/**
 * The call's chat: messages, reactions and join/leave notices, and the composer. Presentational — ChatService owns
 * the state. Text is rendered by interpolation only; links are plain anchors to http(s) URLs (no previews).
 */
@Component({
  selector: 'app-chat-panel',
  imports: [
    DatePipe,
    EmojiPicker,
    FileCard,
    ImageLightbox,
    NzButtonModule,
    NzDrawerModule,
    NzIconModule,
    NzPopoverModule,
    NzTooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-panel.html',
  styleUrl: './chat-panel.less',
})
export class ChatPanel {
  readonly open = input.required<boolean>();
  readonly items = input.required<ChatItem[]>();
  /** We hold a chat key (false before the first key and while reconnecting). */
  readonly ready = input(false);
  /** Shared files by id (FileTransferService). */
  readonly files = input<ReadonlyMap<string, SharedFile>>(new Map());
  /** Files can be shared now (usage guard). */
  readonly canShare = input(true);

  readonly closed = output();
  readonly send = output<string>();
  readonly retry = output<string>();
  readonly react = output<{ id: string; emoji: string }>();
  readonly attach = output<File[]>();
  readonly download = output<string>();
  readonly cancelDownload = output<string>();

  protected readonly maxLength = MAX_CHAT_TEXT;
  protected readonly quickReactions = QUICK_REACTIONS;
  /** "Who reacted" opens towards the middle: chips sit at the screen's edge on phones. */
  protected readonly tipOthers = ['topLeft', 'bottomLeft'];
  protected readonly tipOwn = ['topRight', 'bottomRight'];
  /** The reaction picker is nearly as wide as a phone: it opens centred on the whole message row, not the button. */
  protected readonly pickerPlacement = ['top', 'bottom'];
  private readonly origins = new WeakMap<HTMLElement, ElementRef<HTMLElement>>();
  protected readonly draft = signal('');
  protected readonly pickerOpen = signal(false);
  /** The message whose reaction picker is open. */
  protected readonly reactingTo = signal<string | undefined>(undefined);
  /** The image open in the lightbox. */
  protected readonly viewing = signal<string | undefined>(undefined);
  protected readonly viewed = computed(() => {
    const id = this.viewing();
    return id ? this.files().get(id) : undefined;
  });
  /** Files are being dragged over the panel. */
  protected readonly dragging = signal(false);

  /** Each item, and whether it starts a new group (name and time shown). */
  protected readonly rows = computed(() =>
    this.items().map((item, i, all) => {
      const prev = all[i - 1];
      const header =
        item.kind === 'message' &&
        (prev?.kind !== 'message' ||
          prev.authorPub !== item.authorPub ||
          item.at - prev.at > GROUP_GAP_MS);
      return { item, header };
    }),
  );

  private readonly list = viewChild<ElementRef<HTMLElement>>('messages');
  private stick = true;

  constructor() {
    // Follow new messages unless the reader scrolled up.
    afterRenderEffect(() => {
      this.items();
      const list = this.list()?.nativeElement;
      if (list && this.open() && this.stick) list.scrollTop = list.scrollHeight;
    });
  }

  /** A stable ElementRef per row (a new one on every check would re-position the popover). */
  protected originOf(el: HTMLElement): ElementRef<HTMLElement> {
    let ref = this.origins.get(el);
    if (!ref) this.origins.set(el, (ref = new ElementRef(el)));
    return ref;
  }

  protected onScroll(list: HTMLElement): void {
    this.stick = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;
  }

  protected onEnter(event: Event, field: HTMLTextAreaElement): void {
    const key = event as KeyboardEvent;
    if (key.shiftKey || key.isComposing) return;
    event.preventDefault();
    this.submit(field);
  }

  protected submit(field: HTMLTextAreaElement): void {
    const text = field.value;
    if (!this.ready() || !text.trim()) return;
    this.send.emit(text);
    // Straight into the field as well: Enter may come before the [value] binding caught up with typing.
    field.value = '';
    this.draft.set('');
    this.stick = true;
  }

  protected insert(emoji: string, field: HTMLTextAreaElement): void {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const caret = start + emoji.length;
    // Straight into the field as well: typing may go on before the [value] binding renders.
    field.value = field.value.slice(0, start) + emoji + field.value.slice(end);
    field.setSelectionRange(caret, caret);
    this.draft.set(field.value);
    this.pickerOpen.set(false);
    field.focus();
  }

  protected pick(input: HTMLInputElement): void {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) this.share(files);
  }

  protected onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragging.set(true);
  }

  protected onDrop(event: DragEvent): void {
    this.dragging.set(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    this.share(files);
  }

  /** Pasted screenshots and files are shared; pasted text goes into the field as usual. */
  protected onPaste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    this.share(files);
  }

  private share(files: File[]): void {
    if (!this.ready() || !this.canShare()) return;
    this.stick = true;
    this.attach.emit(files);
  }

  protected reactWith(id: string, emoji: string): void {
    this.reactingTo.set(undefined);
    this.react.emit({ id, emoji });
  }
}
