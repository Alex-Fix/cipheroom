import { newRoomId } from './room-id';

describe('newRoomId', () => {
  it('generates room ids matching the room pattern', () => {
    expect(newRoomId()).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });
});
