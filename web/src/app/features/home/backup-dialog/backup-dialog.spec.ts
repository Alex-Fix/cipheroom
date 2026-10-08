import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../../core/ui/icons';
import { BackupDialog } from './backup-dialog';

function setup() {
  TestBed.configureTestingModule({
    imports: [BackupDialog],
    providers: [provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(BackupDialog);
  fixture.componentRef.setInput('open', true);
  fixture.detectChanges();
  // nz-modal renders into a CDK overlay attached to document.body.
  const modal = () => document.body.querySelector<HTMLElement>('.ant-modal')!;
  const type = async (id: string, value: string) => {
    const input = modal().querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, modal, type };
}

describe('BackupDialog', () => {
  afterEach(() =>
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()),
  );

  it('only saves a long enough passphrase typed twice', async () => {
    const { fixture, modal, type } = setup();
    const saved = vi.fn();
    fixture.componentInstance.save.subscribe(saved);
    const save = () => modal().querySelector<HTMLButtonElement>('.save')!;

    await type('passphrase', 'short');
    expect(modal().textContent).toContain('At least 12 characters');
    expect(save().disabled).toBe(true);

    await type('passphrase', 'correct horse battery staple');
    await type('confirmation', 'correct horse battery stable');
    expect(modal().textContent).toContain("The passphrases don't match.");
    expect(save().disabled).toBe(true);

    await type('confirmation', 'correct horse battery staple');
    expect(save().disabled).toBe(false);
    save().click();
    expect(saved).toHaveBeenCalledWith('correct horse battery staple');
  });

  it('says it’s the only chance, and confirms once saved', () => {
    const { fixture, modal } = setup();
    expect(modal().textContent).toContain('You can only make it now.');
    fixture.componentRef.setInput('saved', true);
    fixture.detectChanges();
    expect(modal().textContent).toContain('Backup saved.');
    expect(modal().querySelector('.continue')).not.toBeNull();
  });
});
