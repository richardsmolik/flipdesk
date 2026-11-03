/**
 * Outgoing email (password resets). Optional: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
 * Works with Gmail (app password), Resend, Postmark, SendGrid, Amazon SES... any SMTP service.
 */
import nodemailer from "nodemailer";
import { reportHealth } from "../health.js";

export const mailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);

export interface Attachment { filename: string; content: Buffer; contentType: string }
let sent: { to: string; subject: string; text: string; attachments?: Attachment[] }[] = [];
/** Tests read what would have been sent. */
export const outbox = () => sent;
export const clearOutbox = () => void (sent = []);

export async function sendMail(to: string, subject: string, text: string, attachments?: Attachment[]) {
  if (process.env.SMTP_HOST === "test") {
    sent.push({ to, subject, text, ...(attachments ? { attachments } : {}) });
    return true;
  }
  if (!mailConfigured()) return false;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  try {
    await t.sendMail({ from: process.env.SMTP_FROM, to, subject, text, attachments });
    reportHealth("mail", true);
  } catch (e) {
    reportHealth("mail", false, (e as Error).message);
    throw e;
  }
  return true;
}
