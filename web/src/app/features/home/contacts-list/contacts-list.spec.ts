import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { Contact } from '../../../core/contacts/contacts';
import { APP_ICONS } from '../../../core/ui/icons';
import { ContactsList } from './contacts-list';

const contact = (overrides: Partial<Contact>): Contact => ({
  devicePub: 'k',
  name: 'x',
  firstSeen: 1,
  lastSeen: 1,
  calls: 1,
  lastCall: 'c',
  verified: false,
  ...overrides,
});

function render(contacts: Contact[], persistent = true) {
  TestBed.configureTestingModule({
    imports: [ContactsList],
    providers: [provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(ContactsList);
  fixture.componentRef.setInput('contacts', contacts);
  fixture.componentRef.setInput('persistent', persistent);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ContactsList', () => {
  const people = [
    contact({ devicePub: 'carol', name: 'Carol', lastSeen: 300, calls: 3 }),
    contact({
      devicePub: 'bob',
      name: 'Robert',
      previousName: 'Bob',
      verified: true,
      lastSeen: 100,
    }),
    contact({ devicePub: 'dan', name: '<b>Dan</b>', lastSeen: 200 }),
  ];

  it('lists verified people first, then the most recently met, as text', () => {
    const { el } = render(people);
    const names = [...el.querySelectorAll('.name')].map((n) => n.textContent!.trim());
    expect(names).toEqual(['Robert', 'Carol', '<b>Dan</b>']);
    expect(el.querySelector('.name b')).toBeNull();
    const meta = [...el.querySelectorAll('.meta')].map((m) =>
      m.textContent!.replace(/\s+/g, ' ').trim(),
    );
    expect(meta[0]).toMatch(/^previously Bob · 1 call · last /);
    expect(meta[1]).toMatch(/^3 calls · last /);
  });

  it('takes a verification back, forgets one person, or everyone', () => {
    const { el, fixture } = render(people);
    const events: unknown[] = [];
    fixture.componentInstance.unverify.subscribe((k) => events.push(['unverify', k]));
    fixture.componentInstance.forget.subscribe((k) => events.push(['forget', k]));
    fixture.componentInstance.forgetAll.subscribe(() => events.push(['forgetAll']));

    expect(el.querySelectorAll('.unverify')).toHaveLength(1);
    el.querySelector<HTMLButtonElement>('.unverify')!.click();
    el.querySelectorAll<HTMLButtonElement>('.forget')[1].click();
    el.querySelector<HTMLButtonElement>('.forget-all')!.click();
    expect(events).toEqual([['unverify', 'bob'], ['forget', 'carol'], ['forgetAll']]);
  });

  it('says when contacts can’t be kept', () => {
    expect(render(people, false).el.textContent).toContain('gone when you close it');
  });
});
