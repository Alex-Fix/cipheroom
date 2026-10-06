/** Random room id in the form `xxxx-xxxx-xxxx` (48 random bits, lowercase hex). */
export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`;
}
