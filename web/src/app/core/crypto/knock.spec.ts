import { fromBase64Url, toBase64Url, utf8 } from './encoding';
import { createIdentity, verifyIdentity } from './identity';
import { openKnock, sealKnock } from './knock';

const ROOM = 'efddmex6ms7upv5eyuy3bo5oqm';

async function person() {
  const identity = await createIdentity(ROOM);
  return { identity, verified: (await verifyIdentity(identity.bundle, ROOM))! };
}

describe('knocks', () => {
  it('carry the guest’s name to that admitter only, unreadable on the way', async () => {
    const [guest, host, other] = await Promise.all([person(), person(), person()]);
    const blob = await sealKnock(ROOM, 'Gina', guest.identity, host.verified);

    expect(new TextDecoder().decode(fromBase64Url(blob))).not.toContain('Gina');
    expect(await openKnock(ROOM, blob, host.identity, guest.verified)).toBe('Gina');
    expect(await openKnock(ROOM, blob, other.identity, guest.verified)).toBeUndefined();
  });

  it('are rejected when attributed to someone else, replayed into another room or tampered with', async () => {
    const [guest, host, mallory] = await Promise.all([person(), person(), person()]);
    const blob = await sealKnock(ROOM, 'Gina', guest.identity, host.verified);
    const wire = JSON.parse(new TextDecoder().decode(fromBase64Url(blob)));
    wire.ct = toBase64Url(fromBase64Url(wire.ct).map((b, i) => (i === 0 ? b ^ 1 : b)));
    const tampered = toBase64Url(utf8(JSON.stringify(wire)));

    expect(await openKnock(ROOM, blob, host.identity, mallory.verified)).toBeUndefined();
    expect(
      await openKnock('aaaaaaaaaaaaaaaaaaaaaaaaaa', blob, host.identity, guest.verified),
    ).toBeUndefined();
    expect(await openKnock(ROOM, tampered, host.identity, guest.verified)).toBeUndefined();
    expect(await openKnock(ROOM, 'not a knock', host.identity, guest.verified)).toBeUndefined();
  });

  it('are the same size whatever the name', async () => {
    const [guest, host] = await Promise.all([person(), person()]);
    const short = await sealKnock(ROOM, 'A', guest.identity, host.verified);
    const long = await sealKnock(
      ROOM,
      'Alexandra Konstantinopolska-Wiśniewska',
      guest.identity,
      host.verified,
    );
    expect(short.length).toBe(long.length);
    expect(short.length).toBeLessThanOrEqual(2048);
  });
});
