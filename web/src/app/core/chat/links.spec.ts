import { linkify } from './links';

describe('linkify', () => {
  it('leaves plain text alone', () => {
    expect(linkify('no links here')).toEqual([{ text: 'no links here' }]);
    expect(linkify('')).toEqual([]);
  });

  it('turns http(s) URLs into links and keeps the text around them', () => {
    expect(linkify('see https://example.org/a?b=1#c, ok')).toEqual([
      { text: 'see ' },
      { text: 'https://example.org/a?b=1#c', href: 'https://example.org/a?b=1#c' },
      { text: ', ok' },
    ]);
    expect(linkify('http://a.test and https://b.test.')).toEqual([
      { text: 'http://a.test', href: 'http://a.test/' },
      { text: ' and ' },
      { text: 'https://b.test', href: 'https://b.test/' },
      { text: '.' },
    ]);
  });

  it('keeps a closing parenthesis that is part of the URL', () => {
    expect(linkify('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { text: '(' },
      {
        text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
        href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      },
      { text: ')' },
    ]);
  });

  it('never links other schemes', () => {
    for (const text of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://x.test',
      'www.example.org',
    ]) {
      expect(linkify(text)).toEqual([{ text }]);
    }
  });

  it('stops at angle brackets and quotes', () => {
    expect(linkify('<https://x.test/">')).toEqual([
      { text: '<' },
      { text: 'https://x.test/', href: 'https://x.test/' },
      { text: '">' },
    ]);
  });
});
