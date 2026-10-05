import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { Config } from '../config';

/**
 * One key per purpose, derived (HKDF-SHA256) from two master secrets, so that a token for one job can
 * never be accepted for another and a leak of one derived key does not expose the others.
 *
 *  - signing:  `JWT_SECRET`  -> access (sessions), kiosk (tablet references and confirmations), sso (login flow)
 *  - data:     `DATA_KEY`    -> totp, documents, import-credentials, sso-client-secret, badge (HMAC)
 *
 * Rotation: put the old value into `JWT_SECRET_PREVIOUS` / `DATA_KEY_PREVIOUS` (comma separated). Tokens
 * signed with a previous secret are still accepted until they expire; data written with a previous key
 * (or with the legacy raw `TOTP_ENC_KEY`) is still readable and `pnpm security:rekey` re-encrypts it.
 */
export type SignPurpose = 'access' | 'kiosk' | 'sso';
export type DataPurpose = 'totp' | 'documents' | 'import-credentials' | 'sso-client-secret' | 'badge';

const derive = (master: string | Buffer, label: string): Buffer =>
  Buffer.from(hkdfSync('sha256', master, 'dienst-v1', label, 32));

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export class Keys {
  private readonly jwt: string[];
  private readonly data: string[];
  private readonly legacy: Buffer | null;

  constructor(
    cfg: Pick<
      Config,
      'JWT_SECRET' | 'JWT_SECRET_PREVIOUS' | 'DATA_KEY' | 'DATA_KEY_PREVIOUS' | 'TOTP_ENC_KEY'
    >,
  ) {
    this.jwt = [cfg.JWT_SECRET, ...list(cfg.JWT_SECRET_PREVIOUS)];
    this.data = [cfg.DATA_KEY, ...list(cfg.DATA_KEY_PREVIOUS)];
    this.legacy = cfg.TOTP_ENC_KEY ? Buffer.from(cfg.TOTP_ENC_KEY, 'hex') : null;
  }

  /** Key that signs new tokens of this purpose. */
  signing(purpose: SignPurpose): Uint8Array {
    return derive(this.jwt[0], `jwt/${purpose}`);
  }
  /** Keys that may have signed a token of this purpose (current first). */
  verifying(purpose: SignPurpose): Uint8Array[] {
    return this.jwt.map((s) => derive(s, `jwt/${purpose}`));
  }

  private dataKey(master: string, purpose: DataPurpose): Buffer {
    return derive(Buffer.from(master, 'hex'), `data/${purpose}`);
  }
  /** Current key first, then previous ones, then the raw legacy key that older data was written with. */
  private readKeys(purpose: DataPurpose): Buffer[] {
    return [...this.data.map((m) => this.dataKey(m, purpose)), ...(this.legacy ? [this.legacy] : [])];
  }

  /** AES-256-GCM, layout iv(12) | tag(16) | ciphertext. */
  seal(purpose: DataPurpose, plain: Buffer | string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.dataKey(this.data[0], purpose), iv);
    const enc = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]);
  }

  /** Opens data written with the current, a previous or the legacy key; `current` tells whether a rekey is due. */
  openWithInfo(purpose: DataPurpose, buf: Buffer): { plain: Buffer; current: boolean } {
    const keys = this.readKeys(purpose);
    for (let i = 0; i < keys.length; i++) {
      try {
        const d = createDecipheriv('aes-256-gcm', keys[i], buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(12, 28));
        return { plain: Buffer.concat([d.update(buf.subarray(28)), d.final()]), current: i === 0 };
      } catch {
        /* authentication failed with this key: try the next one */
      }
    }
    throw new Error('Cannot decrypt: no configured key matches');
  }
  open(purpose: DataPurpose, buf: Buffer): Buffer {
    return this.openWithInfo(purpose, buf).plain;
  }
  openText(purpose: DataPurpose, buf: Buffer): string {
    return this.open(purpose, buf).toString('utf8');
  }

  /** Keyed hash of a badge id: [current, ...older]. Older ones exist so badges survive a key change. */
  badgeHashes(badge: string): string[] {
    const msg = `badge:${badge.trim()}`;
    return [
      ...this.data.map((m) => createHmac('sha256', this.dataKey(m, 'badge')).update(msg).digest('hex')),
      ...(this.legacy ? [createHmac('sha256', this.legacy).update(msg).digest('hex')] : []),
    ];
  }
}
