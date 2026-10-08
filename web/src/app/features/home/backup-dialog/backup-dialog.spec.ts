import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../../core/ui/icons';
import { BackupDialog } from './backup-dialog';

async function setup() {
  TestBed.configureTestingModule({
    imports: [BackupDialog],
    providers: [provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(BackupDialog);
  fixture.componentRef.setInput('open', true);
  fixture.detectChanges();
  // nz-modal renders into a CDK overlay attached to document.body.
  const modal = () => document.body.querySelector<HTMLElement>('.ant-modal')!;
  const button = (cls: string) => modal().querySelector<HTMLButtonElement>(`.${cls}`);
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const type = async (id: string, value: string) => {
    const input = modal().querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const escape = async () => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }),
    );
    await settle();
  };
  // The dialog's content attaches after the first round of change detection: interact only once it has.
  await settle();
  return { fixture, modal, button, type, settle, escape };
}

describe('BackupDialog', () => {
  afterEach(() =>
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()),
  );

  it('is centered', async () => {
    const { modal } = await setup();
    expect(modal().closest('.ant-modal-wrap')!.classList).toContain('ant-modal-centered');
  });

  it('only saves a long enough passphrase typed twice', async () => {
    const { fixture, modal, button, type } = await setup();
    const saved = vi.fn();
    fixture.componentInstance.save.subscribe(saved);

    await type('passphrase', 'short');
    expect(fixture.componentInstance['passphrase']()).toBe('short');
    expect(modal().textContent).toContain('At least 12 characters');
    expect(button('save')!.disabled).toBe(true);

    await type('passphrase', 'correct horse battery staple');
    await type('confirmation', 'correct horse battery stable');
    expect(modal().textContent).toContain("The passphrases don't match.");
    expect(button('save')!.disabled).toBe(true);

    await type('confirmation', 'correct horse battery staple');
    expect(button('save')!.disabled).toBe(false);
    button('save')!.click();
    expect(saved).toHaveBeenCalledWith('correct horse battery staple');
  });

  it('asks before skipping inside the same dialog, and forgets the passphrase when skipped', async () => {
    const { fixture, modal, button, type, settle } = await setup();
    const done = vi.fn();
    fixture.componentInstance.done.subscribe(done);
    await type('passphrase', 'correct horse battery staple');

    button('skip')!.click();
    await settle();
    expect(document.body.querySelectorAll('.ant-modal')).toHaveLength(1); // nothing stacked
    expect(modal().textContent).toContain('Skip the backup?');

    button('go-back')!.click();
    await settle();
    expect(modal().querySelector<HTMLInputElement>('#passphrase')!.value).toBe(
      'correct horse battery staple',
    );

    button('skip')!.click();
    await settle();
    button('skip-anyway')!.click();
    await settle();
    expect(done).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['passphrase']()).toBe('');
  });

  it('Esc goes one step back and never closes the dialog by accident', async () => {
    const { fixture, modal, escape } = await setup();
    const done = vi.fn();
    fixture.componentInstance.done.subscribe(done);

    await escape();
    expect(modal().textContent).toContain('Skip the backup?');
    await escape();
    expect(modal().textContent).toContain('Back up your host key');
    expect(done).not.toHaveBeenCalled();

    fixture.componentRef.setInput('busy', true);
    await escape();
    expect(modal().textContent).toContain('Back up your host key');
  });

  it('confirms once saved', async () => {
    const { fixture, modal, button, settle } = await setup();
    fixture.componentRef.setInput('saved', true);
    await settle();
    expect(modal().textContent).toContain('Backup saved');
    expect(button('continue')).not.toBeNull();
  });
});
