import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';

/**
 * Outbound mail transport, backed by Ethereal (https://ethereal.email) — a
 * fake SMTP service built for exactly this: nothing "sent" through it is
 * ever delivered to a real inbox, but every message is captured and given a
 * shareable preview URL. That's enough for local dev/staging and for this
 * project's current stage (there's no real transactional-email provider
 * wired up yet); swap this file's transport for a real one (SES, Postmark,
 * etc.) before this is anywhere near production traffic.
 *
 * The transporter is created lazily, on first send, and cached — minting an
 * Ethereal test account (`nodemailer.createTestAccount()`) is a network
 * call, so it shouldn't slow down app startup for a process that might
 * never send an email at all.
 */
let transporterPromise: Promise<Transporter> | undefined;

async function getTransporter(): Promise<Transporter> {
  if (!transporterPromise) {
    transporterPromise = (async () => {
      if (env.ETHEREAL_SMTP_USER && env.ETHEREAL_SMTP_PASS) {
        // A pinned account, set explicitly — reused across restarts instead
        // of minting a fresh throwaway one every time the process starts.
        return nodemailer.createTransport({
          host: 'smtp.ethereal.email',
          port: 587,
          secure: false,
          auth: { user: env.ETHEREAL_SMTP_USER, pass: env.ETHEREAL_SMTP_PASS },
        });
      }
      const testAccount = await nodemailer.createTestAccount();
      // eslint-disable-next-line no-console
      console.log(
        `mail.service: minted a fresh Ethereal test account (${testAccount.user}) — ` +
          'set ETHEREAL_SMTP_USER/ETHEREAL_SMTP_PASS to reuse one instead of a new ' +
          'throwaway account on every restart.',
      );
      return nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: { user: testAccount.user, pass: testAccount.pass },
      });
    })();
  }
  return transporterPromise;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends one email through the Ethereal transport. Since Ethereal never
 * delivers anywhere real, the returned/logged preview URL IS how a human
 * actually sees the message — there's no inbox to check.
 *
 * Failures are logged, not thrown: every caller of this (signup's
 * verification email, a password-reset request) has already done the real
 * work — creating the token — before this is called, and email delivery
 * being unavailable should never turn into a failed signup/reset-request
 * for the user making it. The token still exists and is still valid; only
 * the notification about it failed.
 */
export async function sendMail(input: SendMailInput): Promise<string | undefined> {
  try {
    const transporter = await getTransporter();
    const info = await transporter.sendMail({
      from: env.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    const previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
    if (previewUrl) {
      // eslint-disable-next-line no-console
      console.log(`mail.service: sent "${input.subject}" to ${input.to} — preview: ${previewUrl}`);
    }
    return previewUrl;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`mail.service: failed to send "${input.subject}" to ${input.to}`, err);
    return undefined;
  }
}

/** Emails a single-use email-verification link (see verification.service.ts). */
export async function sendVerificationEmail(to: string, rawToken: string): Promise<void> {
  const url = new URL(env.EMAIL_VERIFICATION_URL);
  url.searchParams.set('token', rawToken);
  await sendMail({
    to,
    subject: 'Verify your email address',
    text:
      `Verify your email address by visiting this link:\n\n${url.toString()}\n\n` +
      "This link expires in 24 hours. If you didn't create an account, you can ignore this email.",
    html:
      `<p>Verify your email address by clicking the link below:</p>` +
      `<p><a href="${url.toString()}">${url.toString()}</a></p>` +
      `<p>This link expires in 24 hours. If you didn't create an account, you can ignore this email.</p>`,
  });
}

/** Emails a single-use password-reset link (see verification.service.ts). */
export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
  const url = new URL(env.PASSWORD_RESET_URL);
  url.searchParams.set('token', rawToken);
  await sendMail({
    to,
    subject: 'Reset your password',
    text:
      `Reset your password by visiting this link:\n\n${url.toString()}\n\n` +
      "This link expires in 1 hour and can only be used once. If you didn't request " +
      "this, you can safely ignore this email — your password won't change.",
    html:
      `<p>Reset your password by clicking the link below:</p>` +
      `<p><a href="${url.toString()}">${url.toString()}</a></p>` +
      `<p>This link expires in 1 hour and can only be used once. If you didn't request ` +
      `this, you can safely ignore this email — your password won't change.</p>`,
  });
}
