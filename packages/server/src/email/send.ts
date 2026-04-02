/**
 * Email sending service — thin wrapper around nodemailer.
 * Used for magic link delivery and future email-as-a-channel.
 */
import { type Transporter, createTransport } from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  secure: boolean;
}

function buildTransport(config: SmtpConfig): Transporter {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password,
    },
  });
}

/** Verify SMTP credentials by attempting a connection handshake. */
export async function verifySmtp(config: SmtpConfig): Promise<void> {
  const transport = buildTransport(config);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

/** Send a plain-text email. */
export async function sendEmail(
  config: SmtpConfig,
  opts: { to: string; subject: string; text: string; html?: string },
): Promise<void> {
  const transport = buildTransport(config);
  try {
    await transport.sendMail({
      from: config.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
  } finally {
    transport.close();
  }
}

/** Send a magic link verification code via email. */
export async function sendVerificationCode(
  config: SmtpConfig,
  opts: { to: string; code: string; botName?: string },
): Promise<void> {
  const name = opts.botName ?? "Sketch";
  await sendEmail(config, {
    to: opts.to,
    subject: `${opts.code} is your ${name} verification code`,
    text: `Your verification code is: ${opts.code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
    html: `
			<div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
				<h2 style="margin: 0 0 8px; font-size: 18px;">Verification code</h2>
				<p style="margin: 0 0 24px; color: #666; font-size: 14px;">Enter this code to verify your email address.</p>
				<div style="background: #f4f4f5; border-radius: 8px; padding: 16px; text-align: center; margin-bottom: 24px;">
					<span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; font-family: monospace;">${opts.code}</span>
				</div>
				<p style="margin: 0; color: #999; font-size: 12px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
			</div>
		`,
  });
}
