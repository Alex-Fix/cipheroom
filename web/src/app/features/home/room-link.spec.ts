import { parseRoomLink, shortRoomId } from './room-link';

const ID = 'efddmex6ms7upv5eyuy3bo5oqm';

describe('parseRoomLink', () => {
  it.each([
    ID,
    `  ${ID}  `,
    ID.toUpperCase(),
    `https://cipheroom.example/r/${ID}`,
    `https://cipheroom.example/r/${ID}?x=1`,
    `/r/${ID}`,
  ])('finds the meeting in %s', (text) => expect(parseRoomLink(text)).toBe(ID));

  it.each([
    '',
    'a1b2-c3d4-e5f6',
    `${ID}x`,
    'https://cipheroom.example/r/short',
    'https://evil.example/',
  ])('rejects %s', (text) => expect(parseRoomLink(text)).toBeUndefined());

  it('shortens ids for lists', () => expect(shortRoomId(ID)).toBe('efdd-mex6'));
});
