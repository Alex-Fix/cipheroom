import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { BackupError } from '../../core/crypto/host-key-backup';
import { HostKeysService, Meeting } from '../../core/crypto/host-keys.service';
import { DISPLAY_NAME_KEY } from '../../core/settings/display-name';
import { APP_ICONS } from '../../core/ui/icons';
import { Home } from './home';

const ROOM = 'efddmex6ms7upv5eyuy3bo5oqm';

function fakeHostKeys() {
  return {
    meetings: signal<Meeting[]>([]),
    canHost: signal(true),
    refresh: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(ROOM),
    backup: vi.fn().mockResolvedValue({ fileName: 'cipheroom-host-efddmex6.key', contents: '{}' }),
    discardPendingBackup: vi.fn(),
    import: vi.fn().mockResolvedValue(ROOM),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup({ name = '', room }: { name?: string; room?: string } = {}) {
  localStorage.setItem(DISPLAY_NAME_KEY, name);
  const hostKeys = fakeHostKeys();
  TestBed.configureTestingModule({
    imports: [Home],
    providers: [
      provideRouter([]),
      provideNzIcons(APP_ICONS),
      { provide: HostKeysService, useValue: hostKeys },
      { provide: NzMessageService, useValue: { error: vi.fn(), success: vi.fn() } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(room ? { room } : {}) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(Home);
  // The instance Home uses (NzModalModule provides it at component level). Confirmations aren't rendered here.
  const modal = {
    confirm: vi
      .spyOn(fixture.debugElement.injector.get(NzModalService), 'confirm')
      .mockReturnValue(undefined as never),
  };
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  await fixture.whenStable();
  const el: HTMLElement = fixture.nativeElement;
  const type = async (id: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const button = (selector: string) => el.querySelector<HTMLButtonElement>(selector)!;
  return { fixture, el, navigate, type, button, hostKeys, modal };
}

describe('Home', () => {
  afterEach(() =>
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()),
  );

  // A browser that can do encrypted calls (jsdom has WebCrypto Ed25519/X25519 but no encoded transforms).
  beforeEach(() => vi.stubGlobal('RTCRtpScriptTransform', class {}));
  afterEach(() => vi.unstubAllGlobals());

  it('tells browsers that can’t encrypt calls they can’t join, and disables everything', async () => {
    vi.stubGlobal('RTCRtpScriptTransform', undefined);
    vi.stubGlobal('RTCRtpSender', class {});
    const { el, fixture, button } = await setup({ name: 'Alex' });
    await fixture.whenStable();

    expect(el.textContent).toContain("This browser can't join encrypted calls.");
    expect(button('.new-meeting').disabled).toBe(true);
  });

  it('creates a meeting, offers the one-time backup, then opens it', async () => {
    const { fixture, button, hostKeys, navigate } = await setup({ name: 'Alex' });
    button('.new-meeting').click();
    await fixture.whenStable();

    expect(hostKeys.create).toHaveBeenCalled();
    const dialog = fixture.debugElement.query((d) => d.name === 'app-backup-dialog');
    expect(dialog.componentInstance.open()).toBe(true);

    dialog.triggerEventHandler('save', 'correct horse battery staple');
    await fixture.whenStable();
    expect(hostKeys.backup).toHaveBeenCalledWith(ROOM, 'correct horse battery staple');
    expect(dialog.componentInstance.saved()).toBe(true);

    dialog.triggerEventHandler('done');
    expect(hostKeys.discardPendingBackup).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/r', ROOM]);
    expect(localStorage.getItem(DISPLAY_NAME_KEY)).toBe('Alex');
  });

  it('asks before skipping the backup', async () => {
    const { fixture, button, modal } = await setup({ name: 'Alex' });
    button('.new-meeting').click();
    await fixture.whenStable();
    fixture.debugElement.query((d) => d.name === 'app-backup-dialog').triggerEventHandler('skip');
    expect(modal.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ nzTitle: 'Skip the backup?' }),
    );
  });

  it('joins from a pasted link, and says when it isn’t one', async () => {
    const { el, type, button, navigate } = await setup({ name: 'Alex' });
    await type('link', 'https://evil.example/');
    expect(el.textContent).toContain("That isn't a Cipheroom invite link.");
    expect(button('.join').disabled).toBe(true);

    await type('link', `https://cipheroom.example/r/${ROOM}`);
    button('.join').click();
    expect(navigate).toHaveBeenCalledWith(['/r', ROOM]);
  });

  it('keeps the meeting someone was sent here from', async () => {
    const { el } = await setup({ room: ROOM });
    expect(el.querySelector<HTMLInputElement>('#link')!.value).toBe(ROOM);
  });

  it('lists hosted meetings and starts them', async () => {
    const { el, fixture, hostKeys, navigate, button } = await setup({ name: 'Alex' });
    hostKeys.meetings.set([{ roomId: ROOM, createdAt: 1 }]);
    fixture.detectChanges();

    expect(el.querySelector('.meeting .code')!.textContent).toBe('efdd-mex6');
    button('.meeting .open').click();
    expect(navigate).toHaveBeenCalledWith(['/r', ROOM]);
  });

  it('explains a failed import without echoing the file', async () => {
    const { fixture, hostKeys } = await setup({ name: 'Alex' });
    hostKeys.import.mockRejectedValue(new BackupError('locked'));
    const dialog = fixture.debugElement.query((d) => d.name === 'app-import-dialog');

    dialog.triggerEventHandler('unlock', { contents: '<script>', passphrase: 'x' });
    await fixture.whenStable();
    expect(dialog.componentInstance.error()).toBe('Wrong passphrase, or the file was changed.');
  });
});
