export async function sendEmail({ to, subject, html, text }) {
  const provider = String(process.env.MAIL_PROVIDER || "resend")
    .trim()
    .toLowerCase();
  const isProduction =
    String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";

  if (provider === "resend") {
    const { sendWithResend } = await import("./resend.js");
    return sendWithResend({ to, subject, html, text });
  }

  if (provider === "ethereal") {
    if (isProduction) {
      throw new Error("MAIL_PROVIDER=ethereal is not allowed in production");
    }
    const { sendWithEthereal } = await import("./ethereal.js");
    return sendWithEthereal({ to, subject, html, text });
  }

  throw new Error(`Unsupported MAIL_PROVIDER: ${provider}`);
}
