import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../../core/ui/icons';
import { ImportDialog } from './import-dialog';

function setup() {
  TestBed.configureTestingModule({
    imports: [ImportDialog],
    providers: [provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(ImportDialog);
  fixture.componentRef.setInput('open', true);
  fixture.detectChanges();
  const modal = () => document.body.querySelector<HTMLElement>('.ant-modal')!;
  return { fixture, modal };
}

describe('ImportDialog', () => {
  afterEach(() =>
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()),
  );

  it('unlocks a picked file with the passphrase', async () => {
    const { fixture, modal } = setup();
    const unlocked = vi.fn();
    fixture.componentInstance.unlock.subscribe(unlocked);

    const file = modal().querySelector<HTMLInputElement>('#backup-file')!;
    Object.defineProperty(file, 'files', { value: [new File(['{"v":1}'], 'backup.key')] });
    file.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    const passphrase = modal().querySelector<HTMLInputElement>('#backup-passphrase')!;
    passphrase.value = 'correct horse battery staple';
    passphrase.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    modal().querySelector<HTMLButtonElement>('.unlock')!.click();
    expect(unlocked).toHaveBeenCalledWith({
      contents: '{"v":1}',
      passphrase: 'correct horse battery staple',
    });
  });

  it('refuses files far too big to be a backup, and shows errors from the container', async () => {
    const { fixture, modal } = setup();
    const file = modal().querySelector<HTMLInputElement>('#backup-file')!;
    Object.defineProperty(file, 'files', { value: [new File(['x'.repeat(20_000)], 'big.key')] });
    file.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(modal().textContent).toContain("This isn't a Cipheroom host key backup.");

    fixture.componentRef.setInput('error', 'Wrong passphrase, or the file was changed.');
    fixture.detectChanges();
    expect(modal().querySelector('.unlock')!.hasAttribute('disabled')).toBe(true);
  });
});
