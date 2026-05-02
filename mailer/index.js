export async function sendEmail({ to, subject, html, text }) {
  const provider = process.env.MAIL_PROVIDER || "ethereal"; // "ethereal" | "resend"

  if (provider === "resend") {
    const { sendWithResend } = await import("./resend.js");
    return sendWithResend({ to, subject, html, text });
  }

  // default: ethereal (dev/testing)
  const { sendWithEthereal } = await import("./ethereal.js");
  return sendWithEthereal({ to, subject, html, text });
}
