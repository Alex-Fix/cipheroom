import { PREVIEW_LENGTH, chatPreview } from './chat-preview';

describe('chatPreview', () => {
  it('keeps short one-line messages as they are', () => {
    expect(chatPreview('hi 👋')).toBe('hi 👋');
  });

  it('shortens long messages by characters', () => {
    const preview = chatPreview('😀'.repeat(PREVIEW_LENGTH + 10));
    expect([...preview]).toHaveLength(PREVIEW_LENGTH + 1);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('shows only the first line', () => {
    expect(chatPreview('first\nsecond')).toBe('first…');
  });
});
