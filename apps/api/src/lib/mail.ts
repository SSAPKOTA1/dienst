import nodemailer, { type Transporter } from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export class Mailer {
  readonly outbox: Mail[] = [];
  private transport: Transporter;
  constructor(
    private opts: { mode: 'smtp' | 'json'; host: string; port: number; from: string },
    private log: FastifyBaseLogger,
  ) {
    this.transport =
      opts.mode === 'json'
        ? nodemailer.createTransport({ jsonTransport: true })
        : nodemailer.createTransport({ host: opts.host, port: opts.port, secure: false, ignoreTLS: true });
  }
  async send(mail: Mail): Promise<void> {
    if (this.opts.mode === 'json') this.outbox.push(mail);
    try {
      await this.transport.sendMail({ from: this.opts.from, ...mail });
    } catch (e) {
      // never log the body: it may contain a one-time link
      this.log.warn({ err: (e as Error).message }, 'mail delivery failed');
    }
  }
}

export const invitationMail = (to: string, name: string, link: string): Mail => ({
  to,
  subject: 'Einladung zum Dienstplan',
  text: `Hallo ${name},\n\ndu wurdest zum Dienstplan eingeladen. Lege hier dein Passwort fest (24 Stunden gültig):\n${link}\n\nWenn du die Einladung nicht erwartet hast, ignoriere diese E-Mail.`,
});

export const resetMail = (to: string, link: string): Mail => ({
  to,
  subject: 'Passwort zurücksetzen',
  text: `Hallo,\n\nüber diesen Link kannst du dein Passwort neu festlegen (1 Stunde gültig):\n${link}\n\nWenn du das nicht angefordert hast, ignoriere diese E-Mail.`,
});
