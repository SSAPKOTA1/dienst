import argon2 from 'argon2';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { isWeakPin } from '@dienst/rules';
import { AppError } from './errors';

export const PASSWORD_MIN = 10;

export const hashSecret = (plain: string): Promise<string> => argon2.hash(plain, { type: argon2.argon2id });
export const verifySecret = async (hash: string, plain: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
};

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** One-time activation code: 10 chars, uppercase letters and digits without 0, O, 1, I (SPEC 4.14). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomActivationCode = (): string =>
  Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export function generatePin(length = 6): string {
  for (;;) {
    let pin = '';
    for (let i = 0; i < length; i++) pin += String(randomInt(10));
    if (!isWeakPin(pin)) return pin;
  }
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN) {
    throw new AppError('VALIDATION', `Password must be at least ${PASSWORD_MIN} characters`, {
      field: 'password',
    });
  }
}

// Encryption at rest and keyed hashes live in lib/keys.ts (one derived key per purpose).
