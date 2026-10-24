import { randomBytes } from 'node:crypto';

/** UUID v7 (RFC 9562): 48-bit millisecond timestamp, then random bits (constitution 5.1). */
export function uuidv7(now: Date, random: Uint8Array = randomBytes(10)): string {
  const hex = now.getTime().toString(16).padStart(12, '0');
  const bytes = Buffer.from(random);
  const rand = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const variant = ((bytes[2] ?? 0) & 0x3f) | 0x80;
  const parts = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${rand.slice(0, 3)}`,
    variant.toString(16).padStart(2, '0') + rand.slice(6, 8),
    rand.slice(8, 20),
  ];
  return parts.join('-');
}

export type IdGenerator = () => string;
