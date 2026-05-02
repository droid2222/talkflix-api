import { Resend } from "resend";

export async function sendWithResend({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required when MAIL_PROVIDER=resend");
  }

  // You must configure a sender domain in Resend and use it here.
  // Example: "Talkflix <no-reply@send.talkflix.cc>"
  if (!from) {
    throw new Error("MAIL_FROM is required when MAIL_PROVIDER=resend");
  }

  const resend = new Resend(apiKey);

  await resend.emails.send({
    from,
    to,
    subject,
    html: html || undefined,
    text: text || undefined,
  });
}
