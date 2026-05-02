import nodemailer from "nodemailer";

export async function sendWithEthereal({ to, subject, html, text }) {
  const testAccount = await nodemailer.createTestAccount();

  const transporter = nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });

  const info = await transporter.sendMail({
    from: "Talkflix <no-reply@talkflix.local>",
    to,
    subject,
    text,
    html,
  });

  // Dev convenience: prints preview URL in backend console
  const previewUrl = nodemailer.getTestMessageUrl(info);
  console.log("Ethereal preview:", previewUrl);
}