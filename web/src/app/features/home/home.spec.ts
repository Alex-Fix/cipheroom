import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { BackupError } from '../../core/crypto/host-key-backup';
import { HostKeysService, Meeting } from '../../core/crypto/host-keys.service';
import { DeviceIdentityStatus, DeviceKeysService } from '../../core/crypto/device-keys.service';
import { CONTACT_STORE, MemoryContactStore } from '../../core/contacts/contact-store';
import { ContactsService } from '../../core/contacts/contacts.service';
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

function fakeDeviceKeys() {
  return {
    status: signal<DeviceIdentityStatus>('none'),
    refresh: vi.fn().mockResolvedValue(undefined),
    setUp: vi.fn().mockResolvedValue(undefined),
    backup: vi.fn().mockResolvedValue({ fileName: 'cipheroom-identity-abc.key', contents: '{}' }),
    discardPendingBackup: vi.fn(),
    restore: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup({ name = '', room }: { name?: string; room?: string } = {}) {
  localStorage.setItem(DISPLAY_NAME_KEY, name);
  const hostKeys = fakeHostKeys();
  const deviceKeys = fakeDeviceKeys();
  TestBed.configureTestingModule({
    imports: [Home],
    providers: [
      provideRouter([]),
      provideNzIcons(APP_ICONS),
      { provide: HostKeysService, useValue: hostKeys },
      { provide: DeviceKeysService, useValue: deviceKeys },
      { provide: CONTACT_STORE, useValue: new MemoryContactStore() },
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
  return { fixture, el, navigate, type, button, hostKeys, deviceKeys, modal };
}

describe('Home', () => {
  afterEach(() =>
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()),
  );

  // A browser that can do encrypted calls (jsdom has WebCrypto Ed25519/X25519 but no encoded transforms).
  beforeEach(() => vi.stubGlobal('RTCRtpScriptTransform', class {}));
  afterEach(() => vi.unstubAllGlobals());

  it('offers the source of the running version (AGPL-3.0 §13)', async () => {
    const { el } = await setup({ name: 'Alex' });
    const link = el.querySelector<HTMLAnchorElement>('.license a')!;
    expect(el.querySelector('.license')!.textContent).toContain('AGPL-3.0');
    expect(link.getAttribute('href')).toBe('/source');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

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

  it('opens the meeting after the backup is skipped too', async () => {
    const { fixture, button, hostKeys, navigate } = await setup({ name: 'Alex' });
    button('.new-meeting').click();
    await fixture.whenStable();
    fixture.debugElement.query((d) => d.name === 'app-backup-dialog').triggerEventHandler('done');

    expect(hostKeys.discardPendingBackup).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/r', ROOM]);
  });

  it('asks before forgetting a meeting, with Cancel focused', async () => {
    const { el, fixture, hostKeys, modal } = await setup({ name: 'Alex' });
    hostKeys.meetings.set([{ roomId: ROOM, createdAt: 1 }]);
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.meeting .forget')!.click();

    expect(modal.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        nzTitle: 'Forget this meeting?',
        nzAutofocus: 'cancel',
        nzCentered: true,
      }),
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

  describe('identity and contacts', () => {
    it('sets up an identity and offers its one-time backup, then stays on the home page', async () => {
      const { fixture, el, deviceKeys, navigate } = await setup({ name: 'Alex' });
      el.querySelector<HTMLButtonElement>('app-identity-card .set-up')!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(deviceKeys.setUp).toHaveBeenCalled();
      const dialog = fixture.debugElement.query((d) => d.name === 'app-backup-dialog');
      expect(dialog.componentInstance.open()).toBe(true);
      expect(dialog.componentInstance.kind()).toBe('identity');

      dialog.triggerEventHandler('save', 'correct horse battery staple');
      await fixture.whenStable();
      expect(deviceKeys.backup).toHaveBeenCalledWith('correct horse battery staple');
      dialog.triggerEventHandler('done');
      fixture.detectChanges();
      expect(deviceKeys.discardPendingBackup).toHaveBeenCalled();
      expect(dialog.componentInstance.open()).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('imports an identity backup as an identity, a host key backup as a meeting', async () => {
      const { fixture, hostKeys, deviceKeys } = await setup({ name: 'Alex' });
      const dialog = fixture.debugElement.query((d) => d.name === 'app-import-dialog');
      const device = JSON.stringify({ kind: 'cipheroom-device-key' });
      dialog.triggerEventHandler('unlock', { contents: device, passphrase: 'p' });
      await fixture.whenStable();
      expect(deviceKeys.restore).toHaveBeenCalledWith(device, 'p');
      expect(hostKeys.import).not.toHaveBeenCalled();

      const host = JSON.stringify({ kind: 'cipheroom-host-key' });
      dialog.triggerEventHandler('unlock', { contents: host, passphrase: 'p' });
      await fixture.whenStable();
      expect(hostKeys.import).toHaveBeenCalledWith(host, 'p');
    });

    it('lists people met before, once there are any', async () => {
      const { fixture, el } = await setup({ name: 'Alex' });
      expect(el.querySelector('app-contacts-list')).toBeNull();
      await TestBed.inject(ContactsService).remember('bob-key', 'Bob', 'call-1');
      fixture.detectChanges();
      expect(el.querySelector('app-contacts-list .name')!.textContent!.trim()).toBe('Bob');
    });
  });
});
