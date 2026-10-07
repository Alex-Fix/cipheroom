import { callPlatform } from './platform';

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  android:
    'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
};

describe('callPlatform', () => {
  it.each([
    [UA.iphone, 5, 'ios-safari'],
    [UA.ipad, 5, 'ios-safari'],
    [UA.macSafari, 0, 'desktop-safari'],
    [UA.macChrome, 0, 'desktop-chrome'],
    [UA.windowsEdge, 0, 'other'],
    [UA.firefox, 0, 'desktop-firefox'],
    [UA.android, 5, 'android-chrome'],
    [UA.iosChrome, 5, 'other'],
    ['', 0, 'other'],
  ])('buckets %s', (ua, touch, expected) => {
    expect(callPlatform(ua, touch)).toBe(expected);
  });
});
