import { CallPlatform } from '../signaling/signaling.types';

/**
 * Coarse browser bucket for call-quality reports — deliberately not the user agent (that would identify devices).
 * iPadOS reports itself as macOS; touch points give it away.
 */
export function callPlatform(userAgent: string, maxTouchPoints: number): CallPlatform {
  const ua = userAgent.toLowerCase();
  const ios = /iphone|ipad|ipod/.test(ua) || (ua.includes('macintosh') && maxTouchPoints > 1);
  if (ios) return /crios|fxios|edgios/.test(ua) ? 'other' : 'ios-safari';
  if (ua.includes('android'))
    return ua.includes('chrome') && !/edga|samsungbrowser|opr/.test(ua)
      ? 'android-chrome'
      : 'other';
  if (ua.includes('firefox')) return 'desktop-firefox';
  if (/edg\/|opr\/|samsungbrowser/.test(ua)) return 'other';
  if (ua.includes('chrome')) return 'desktop-chrome';
  if (ua.includes('safari')) return 'desktop-safari';
  return 'other';
}
