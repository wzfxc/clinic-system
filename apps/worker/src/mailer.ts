import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingMail {
  /** Deterministic per outbox row, so a repeated delivery carries the same Message-ID. */
  messageId: string;
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Refuse to send unless the connection upgrades to TLS. Off only for the local mailpit catcher. */
  requireTls?: boolean;
  from?: string;
}

const DEFAULT_FROM = 'Clinic <no-reply@clinic.local>';

/** SMTP delivery; in compose this talks to mailpit, which catches everything locally. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly options: SmtpOptions) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: false,
      requireTLS: options.requireTls === true,
      ignoreTLS: options.requireTls !== true,
      connectionTimeout: options.timeoutMs,
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    await this.transport.sendMail({
      messageId: mail.messageId,
      from: this.options.from ?? DEFAULT_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
  }

  close(): void {
    this.transport.close();
  }
}

/** Records every call (a repeated Message-ID is recorded again); optional failure injection. */
export class RecordingMailer implements Mailer {
  readonly sent: OutgoingMail[] = [];
  /** When set, `send` rejects with it instead of recording. */
  failWith: Error | null = null;

  send(mail: OutgoingMail): Promise<void> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.sent.push(mail);
    return Promise.resolve();
  }

  countOf(messageId: string): number {
    return this.sent.filter((m) => m.messageId === messageId).length;
  }
}
