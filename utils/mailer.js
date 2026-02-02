const nodemailer = require('nodemailer');
require('dotenv').config();

// Gmail SMTP transporter
const transporter = nodemailer.createTransport({
  service: 'gmail', // simplified for Gmail
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

// Send OTP email function
exports.sendOTPEmail = (to, otp) => {
  const mailOptions1 = {
    from: `"Wardrobe Plug" <${process.env.MAIL_USER}>`,
    to: to,
    subject: 'Your Wardrobe Plug One-Time Password (OTP)',
    html: `
      <p>Hi,</p>
      <p>Your OTP for verifying your Wardrobe Plug account is:</p>
      <p style="font-size: 22px; font-weight: bold; letter-spacing: 3px;">
          ${otp}
      </p>
      <p>This OTP will expire in 10 minutes.</p>
      <p>If you did not request this, simply ignore this email.</p>
      <br>
      <p>Best regards,<br>Clothes Swap Team</p>
    `
  };

return transporter.sendMail(mailOptions1);
};


exports.sendAccountTerminationEmail = (to, username, reason) => {
  const mailOptions = {
    from: `"Wardrobe Plug" <${process.env.MAIL_USER}>`,
    to: to,
    subject: 'Your Clothes Swap account has been terminated',
    html: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Arial, sans-serif; line-height:1.5;">
        <h2>Account Termination Notice</h2>

        <p>Hi ${username || 'there'},</p>

        <p>
          This email is to inform you that your Clothes Swap account has been permanently terminated
          and you no longer have access to the platform.
        </p>

        <p>
          <strong>Reason:</strong><br>
          ${reason}
        </p>

        <p>
          If you believe this action was taken in error, you may contact our support team
          to submit an appeal.
        </p>

        <br>
        <p>— Clothes Swap Team</p>
      </div>
    `
  };


  return transporter.sendMail(mailOptions);
};

exports.sendSahmApplicationStatusEmail = (to, { username, status, adminComment }, cb) => {
  try {
    const statusPretty = String(status || '').replace(/_/g, ' ').toUpperCase();
    const safeName = username || 'there';
    const commentLine = adminComment && adminComment.trim()
      ? adminComment.trim()
      : 'No additional comments from admin.';

    const subject = `SAHM Application Update: ${statusPretty}`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.5; color:#111;">
        <h2 style="margin:0 0 12px;">Your SAHM application has been updated</h2>
        <p style="margin:0 0 10px;">Hi ${safeName},</p>

        <p style="margin:0 0 10px;">
          Your SAHM application status is now:
          <b style="color:#e60000;">${statusPretty}</b>
        </p>

        <p style="margin:0 0 6px;"><b>Admin comment:</b></p>
        <div style="background:#f3f4f7; padding:12px; border-radius:10px;">
          ${commentLine}
        </div>

        <p style="margin:14px 0 0; font-size:12px; color:#6b7280;">
          Please do not reply to this email.
        </p>
      </div>
    `;

    const mailOptions = {
      from: process.env.MAIL_FROM || process.env.MAIL_USER,
      to,
      subject,
      html
    };

    // transporter must exist in your file already
    transporter.sendMail(mailOptions, cb);
  } catch (e) {
    console.error('sendSahmApplicationStatusEmail error:', e);
    cb(e);
  }
};

// utils/mailer.js

exports.sendPayPalReceiptEmail = (to, {
  username,
  amount,
  currency = 'SGD',
  matchId,
  chatId,
  orderId,
  captureId,
  payerLabel // optional e.g. "You paid all" / "Split evenly"
}) => {
  const safeName = username || 'there';

  const amtNum = Number(amount);
  const amountText = Number.isFinite(amtNum) ? amtNum.toFixed(2) : String(amount || '0.00');

  const subject = `Payment Receipt (PayPal) - ${currency} ${amountText}`;

  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Arial, sans-serif; line-height:1.5; color:#111;">
      <h2 style="margin:0 0 12px;">Payment Receipt</h2>

      <p style="margin:0 0 10px;">Hi ${safeName},</p>

      <p style="margin:0 0 10px;">
        We’ve received your payment via <b>PayPal</b>.
      </p>

      <div style="background:#f3f4f7; padding:12px; border-radius:10px;">
        <p style="margin:0 0 6px;"><b>Amount:</b> ${currency} ${amountText}</p>
        ${payerLabel ? `<p style="margin:0 0 6px;"><b>Split:</b> ${payerLabel}</p>` : ''}
        ${matchId ? `<p style="margin:0 0 6px;"><b>Match ID:</b> ${matchId}</p>` : ''}
        ${chatId ? `<p style="margin:0 0 6px;"><b>Chat ID:</b> ${chatId}</p>` : ''}
        ${orderId ? `<p style="margin:0 0 6px;"><b>PayPal Order ID:</b> ${orderId}</p>` : ''}
        ${captureId ? `<p style="margin:0;"><b>PayPal Capture ID:</b> ${captureId}</p>` : ''}
      </div>

      <p style="margin:14px 0 0; font-size:12px; color:#6b7280;">
        This is an automated receipt. Please keep it for your records.
      </p>
    </div>
  `;

  const mailOptions = {
    from: `"Wardrobe Plug" <${process.env.MAIL_USER}>`,
    to,
    subject,
    html
  };

  return transporter.sendMail(mailOptions);
};

// ============================================
// SAHM Payout: Admin decision email (approved / rejected / failed)
// ============================================
exports.sendSahmPayoutDecisionEmail = (to, {
  username,
  payoutId,
  status,           // 'approved' | 'rejected' | 'failed' | 'processing'
  amount,
  currency = 'SGD',
  receiverEmail,
  reason,           // reject reason or failure reason
  paypalBatchId,
  paypalBatchStatus
}) => {
  const safeName = username || 'there';
  const st = String(status || '').toLowerCase();
  const amtNum = Number(amount);
  const amountText = Number.isFinite(amtNum) ? amtNum.toFixed(2) : String(amount || '0.00');

  const title =
    st === 'approved' ? 'Payout Request Approved' :
    st === 'rejected' ? 'Payout Request Rejected' :
    st === 'failed' ? 'Payout Processing Failed' :
    st === 'processing' ? 'Payout Processing' :
    'Payout Request Update';

  const subject =
    st === 'approved' ? `Payout Approved (#${payoutId})` :
    st === 'rejected' ? `Payout Rejected (#${payoutId})` :
    st === 'failed' ? `Payout Failed (#${payoutId})` :
    st === 'processing' ? `Payout Processing (#${payoutId})` :
    `Payout Update (#${payoutId})`;

  const bodyLine =
    st === 'approved'
      ? 'Your payout request has been approved by the admin and has been submitted to PayPal.'
      : st === 'processing'
        ? 'Your payout request is approved and is currently being processed by PayPal.'
        : st === 'rejected'
          ? 'Your payout request has been reviewed and rejected by the admin.'
          : st === 'failed'
            ? 'Your payout request was approved, but the PayPal payout attempt failed.'
            : 'Your payout request has been updated.';

  const reasonBlock = reason
    ? `<p style="margin:10px 0 0;"><b>Note:</b> ${String(reason)}</p>`
    : '';

  const paypalBlock = (paypalBatchId || paypalBatchStatus)
    ? `
      <div style="background:#f3f4f7; padding:12px; border-radius:10px; margin-top:12px;">
        <div style="font-weight:700; margin-bottom:6px;">PayPal Details</div>
        ${paypalBatchId ? `<div><b>Batch ID:</b> ${paypalBatchId}</div>` : ''}
      </div>
    `
    : '';

  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Arial, sans-serif; line-height:1.5; color:#111;">
      <h2 style="margin:0 0 12px;">${title}</h2>
      <p style="margin:0 0 10px;">Hi ${safeName},</p>

      <p style="margin:0 0 10px;">${bodyLine}</p>

      <div style="background:#f3f4f7; padding:12px; border-radius:10px;">
        <p style="margin:0 0 6px;"><b>Payout ID:</b> #${payoutId}</p>
        <p style="margin:0 0 6px;"><b>Amount:</b> ${currency} ${amountText}</p>
        ${receiverEmail ? `<p style="margin:0;"><b>Receiver:</b> ${receiverEmail}</p>` : ''}
      </div>

      ${reasonBlock}
      ${paypalBlock}

      <p style="margin:14px 0 0; font-size:12px; color:#6b7280;">
        This is an automated email. Please do not reply.
      </p>
    </div>
  `;

  const mailOptions = {
    from: `"Wardrobe Plug" <${process.env.MAIL_USER}>`,
    to,
    subject,
    html
  };

  return transporter.sendMail(mailOptions);
};


// ============================================
// SAHM Payout: Credited / Paid email
// ============================================
exports.sendSahmPayoutCreditedEmail = (to, {
  username,
  payoutId,
  amount,
  currency = 'SGD',
  receiverEmail,
  paypalBatchId,
  paypalBatchStatus
}) => {
  const safeName = username || 'there';
  const amtNum = Number(amount);
  const amountText = Number.isFinite(amtNum) ? amtNum.toFixed(2) : String(amount || '0.00');

  const subject = `Payout Credited (#${payoutId}) - ${currency} ${amountText}`;

  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Arial, sans-serif; line-height:1.5; color:#111;">
      <h2 style="margin:0 0 12px;">Payout Credited</h2>

      <p style="margin:0 0 10px;">Hi ${safeName},</p>

      <p style="margin:0 0 10px;">
        Your payout has been successfully sent via <b>PayPal</b> and credited to your PayPal account.
      </p>

      <div style="background:#f3f4f7; padding:12px; border-radius:10px;">
        <p style="margin:0 0 6px;"><b>Payout ID:</b> #${payoutId}</p>
        <p style="margin:0 0 6px;"><b>Amount:</b> ${currency} ${amountText}</p>
        ${receiverEmail ? `<p style="margin:0 0 6px;"><b>Receiver:</b> ${receiverEmail}</p>` : ''}
        ${paypalBatchId ? `<p style="margin:0 0 6px;"><b>PayPal Batch ID:</b> ${paypalBatchId}</p>` : ''}
      </div>

      <p style="margin:14px 0 0; font-size:12px; color:#6b7280;">
        This is an automated email. Please keep it for your records.
      </p>
    </div>
  `;

  const mailOptions = {
    from: `"Wardrobe Plug" <${process.env.MAIL_USER}>`,
    to,
    subject,
    html
  };

  return transporter.sendMail(mailOptions);
};

// Payment OTP (Secure Pay Verification)
exports.sendPaymentOTPEmail = (to, { username, otp, amount, currency = 'SGD', matchId }) => {
  const safeName = username || 'there';
  const amtNum = Number(amount);
  const amountText = Number.isFinite(amtNum) ? amtNum.toFixed(2) : String(amount || '0.00');

  const mailOptions = {
    from: `"Wardrobe Plug" <${process.env.MAIL_USER}>`,
    to,
    subject: `Secure Pay Verification Code - ${currency} ${amountText}`,
    html: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Arial, sans-serif; line-height:1.5; color:#111;">
        <h2 style="margin:0 0 12px;">Secure Pay Verification</h2>
        <p style="margin:0 0 10px;">Hi ${safeName},</p>
        <p style="margin:0 0 10px;">
          We received a request to proceed with a PayPal payment for your swap.
          Please enter the code below in the app to continue.
        </p>
        <div style="background:#f3f4f7; padding:12px; border-radius:10px; display:inline-block;">
          <div style="font-size:22px; font-weight:800; letter-spacing:4px;">${otp}</div>
        </div>
        <p style="margin:12px 0 0;"><b>Amount:</b> ${currency} ${amountText}</p>
        ${matchId ? `<p style="margin:0;"><b>Match ID:</b> ${matchId}</p>` : ''}
        <p style="margin:12px 0 0; font-size:12px; color:#6b7280;">
          This code expires in 10 minutes. If you did not request this, please change your password immediately.
        </p>
      </div>
    `
  };

  return transporter.sendMail(mailOptions);
};
