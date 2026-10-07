import { TestBed } from '@angular/core/testing';
import { AudioPlayback } from './audio-playback';

function element(play: () => Promise<void>) {
  return { play: vi.fn(play) } as unknown as HTMLMediaElement & { play: ReturnType<typeof vi.fn> };
}

const blockedByBrowser = () =>
  Promise.reject(Object.assign(new Error('autoplay'), { name: 'NotAllowedError' }));

describe('AudioPlayback', () => {
  it('remembers elements the browser refused to play and replays them on resume', async () => {
    const playback = TestBed.inject(AudioPlayback);
    const audio = element(blockedByBrowser);

    playback.play(audio);
    await Promise.resolve();
    await Promise.resolve();
    expect(playback.blocked()).toBe(true);

    audio.play.mockResolvedValue(undefined);
    await playback.resume();

    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(playback.blocked()).toBe(false);
  });

  it('ignores other playback errors and forgotten elements', async () => {
    const playback = TestBed.inject(AudioPlayback);
    playback.play(element(() => Promise.reject(new Error('aborted'))));
    await Promise.resolve();
    await Promise.resolve();
    expect(playback.blocked()).toBe(false);

    const audio = element(blockedByBrowser);
    playback.play(audio);
    await Promise.resolve();
    await Promise.resolve();
    playback.forget(audio);
    expect(playback.blocked()).toBe(false);
  });
});
