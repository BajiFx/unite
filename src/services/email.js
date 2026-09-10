// ================================================================
//  email.js - Complete Email Service with Business Support
//  Location: src/services/email.js
// ================================================================

const nodemailer = require('nodemailer');

// ---- Email Queue ----
class EmailQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.maxRetries = 3;
  }

  async add(email) {
    this.queue.push(email);
    if (!this.processing) {
      return this.process();
    }
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const email = this.queue.shift();
      let retries = 0;
      let sent = false;

      while (!sent && retries < this.maxRetries) {
        try {
          await this.sendEmail(email);
          sent = true;
          console.log(`📧 Email sent successfully to ${email.to}`);
        } catch (err) {
          retries++;
          console.error(`❌ Email attempt ${retries} failed for ${email.to}:`, err.message);
          if (retries < this.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 2000 * retries));
          }
        }
      }

      if (!sent) {
        console.error(`❌ All ${this.maxRetries} attempts failed for ${email.to}`);
        try {
          const fs = require('fs');
          const path = require('path');
          const logDir = path.join(process.cwd(), 'logs');
          if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
          fs.appendFileSync(
            path.join(logDir, 'email-failures.log'),
            `${new Date().toISOString()} - Failed to send to ${email.to}: ${email.subject}\n`
          );
        } catch (logErr) {
          console.error('Failed to log email failure:', logErr);
        }
      }
    }

    this.processing = false;
  }

  async sendEmail({ to, subject, html, text }) {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        const info = await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to,
          subject,
          html,
          text,
        });
        return info;
      } catch (err) {
        console.error('❌ Primary email error:', err.message);
        console.log('🔄 Trying fallback email provider...');
        return this.sendFallback({ to, subject, html, text });
      }
    }

    return this.sendFallback({ to, subject, html, text });
  }

  async sendFallback({ to, subject, html, text }) {
    if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_API_KEY !== 'your_sendgrid_api_key_here') {
      try {
        const transporter = nodemailer.createTransport({
          host: 'smtp.sendgrid.net',
          port: 587,
          secure: false,
          auth: {
            user: 'apikey',
            pass: process.env.SENDGRID_API_KEY,
          },
        });

        const info = await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@yourdomain.com',
          to,
          subject,
          html,
          text,
        });
        console.log(`📧 Email sent via SendGrid to ${to}`);
        return info;
      } catch (err) {
        console.error('❌ SendGrid error:', err.message);
        throw err;
      }
    }

    console.warn('⚠️ No email provider configured. Email not sent.');
    console.warn(`📧 Would have sent to ${to}: ${subject}`);
    return { messageId: 'disabled', accepted: [] };
  }
}

const emailQueue = new EmailQueue();

// ---- Send email with queue ----
async function sendEmail({ to, subject, html, text }) {
  if (!to) {
    console.error('❌ No recipient email provided');
    return { messageId: 'error', accepted: [] };
  }

  const cleanEmail = to.trim().toLowerCase();
  return emailQueue.add({ to: cleanEmail, subject, html, text });
}

// ---- Order Confirmation Email - WITH BUSINESS NAME ----
function orderConfirmationEmail(order, customerName, businessName = null) {
  const ref = order.order_ref || `#${order.id}`;
  const shopName = businessName || process.env.SHOP_NAME || 'Our Shop';

  let itemsHtml = '';
  let itemsText = '';

  (order.items || []).forEach((item, index) => {
    const priceNum = parseFloat(String(item.price).replace(/[^0-9.]/g,'')) || 0;
    const subtotal = priceNum * item.quantity;
    const uniqueId = item.unique_id || '—';
    const variantName = item.variant_name || 'Default';

    itemsHtml += `<tr>
      <td style="padding:8px;border:1px solid #e2e8f0;">${item.product_name}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;">${variantName}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;">${item.quantity}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;">Ksh ${priceNum.toFixed(2)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-weight:bold;">Ksh ${subtotal.toFixed(2)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-family:monospace;font-size:0.75rem;">${uniqueId}</td>
    </tr>`;

    itemsText += `${index+1}. ${item.product_name} (${variantName}) x${item.quantity} – Ksh ${subtotal.toFixed(2)} (ID: ${uniqueId})\n`;
  });

  const total = Number(order.total).toFixed(2);

  return {
    subject: `Order ${ref} Confirmed! ✅`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #1e293b; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #0f172a; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #ffffff; padding: 20px; border: 1px solid #e2e8f0; border-radius: 0 0 8px 8px; }
          .order-details { margin: 20px 0; }
          table { width: 100%; border-collapse: collapse; margin: 10px 0; }
          th { background: #f1f5f9; padding: 10px; text-align: left; border: 1px solid #e2e8f0; }
          td { padding: 8px; border: 1px solid #e2e8f0; }
          .total-row { font-weight: bold; font-size: 1.1rem; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 0.85rem; }
          .button { display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Order Confirmed!</h1>
            <p>Order #${ref}</p>
            <p style="font-size:0.8rem;opacity:0.8;">${shopName}</p>
          </div>
          <div class="content">
            <p>Dear ${customerName},</p>
            <p>Your order has been confirmed. Here are the details:</p>

            <div class="order-details">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Variant</th>
                    <th style="text-align:center;">Qty</th>
                    <th style="text-align:right;">Unit Price</th>
                    <th style="text-align:right;">Subtotal</th>
                    <th style="text-align:center;">ID</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan="4" style="text-align:right;font-weight:bold;padding:10px;">Total</td>
                    <td style="text-align:right;font-weight:bold;padding:10px;color:#2563eb;">Ksh ${total}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            ${order.delivery_address ? `
            <div style="background:#f8fafc;padding:12px;border-radius:6px;margin:10px 0;">
              <strong>📍 Delivery Location:</strong>
              <p style="margin:4px 0;">${order.delivery_address}</p>
              ${order.recipient_name ? `<p style="margin:2px 0;">👤 Recipient: ${order.recipient_name} (${order.recipient_phone || 'N/A'})</p>` : ''}
              ${order.delivery_instructions ? `<p style="margin:2px 0;">📝 Instructions: ${order.delivery_instructions}</p>` : ''}
            </div>
            ` : ''}

            <p style="margin-top:20px;">We will notify you when your order ships.</p>
            <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/order-tracking.html?id=${order.id}" class="button">Track Your Order</a>

            <p style="margin-top:20px;">Thank you for shopping with us! 🙏</p>
          </div>
          <div class="footer">
            <p>${shopName} • ${new Date().getFullYear()}</p>
            <p>Need help? Contact us via chat on our website.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Order ${ref} Confirmed!
${'='.repeat(40)}

Dear ${customerName},

Your order has been confirmed. Here are the details:

${itemsText}
${'='.repeat(40)}
Total: Ksh ${total}

${order.delivery_address ? `Delivery Location: ${order.delivery_address}` : ''}

We will notify you when your order ships.

Track your order: ${process.env.CLIENT_URL || 'http://localhost:3000'}/order-tracking.html?id=${order.id}

Thank you for shopping with us!

- ${shopName}
    `.trim()
  };
}

// ---- Status Update Email - WITH BUSINESS NAME ----
function statusUpdateEmail(order, newStatus, customerName, businessName = null) {
  const ref = order.order_ref || `#${order.id}`;
  const shopName = businessName || process.env.SHOP_NAME || 'Our Shop';
  const tracking = order.tracking_number ? `Tracking: ${order.tracking_number}` : '';

  const statusMessages = {
    'pending': 'Your order is being reviewed.',
    'confirmed': 'Your order has been confirmed and is being prepared.',
    'shipped': 'Your order is on the way! 🚚',
    'delivered': 'Your order has been delivered and is ready for pickup.',
    'received': 'You have confirmed receipt. Thank you!',
    'cancelled': 'Your order has been cancelled.',
    'completed': 'Your order is complete. Thank you for shopping!'
  };

  const message = statusMessages[newStatus] || `Your order status has been updated to ${newStatus}.`;

  return {
    subject: `Order ${ref} Updated to ${newStatus.toUpperCase()}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #1e293b; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #0f172a; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #ffffff; padding: 20px; border: 1px solid #e2e8f0; border-radius: 0 0 8px 8px; }
          .status-box { background: #f1f5f9; padding: 15px; border-radius: 8px; margin: 10px 0; text-align: center; }
          .status { font-size: 1.2rem; font-weight: bold; color: #2563eb; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 0.85rem; }
          .button { display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📦 Order ${ref}</h1>
            <p>Status Update</p>
            <p style="font-size:0.8rem;opacity:0.8;">${shopName}</p>
          </div>
          <div class="content">
            <p>Dear ${customerName},</p>

            <div class="status-box">
              <div>Your order is now:</div>
              <div class="status">${newStatus.toUpperCase()}</div>
              <div style="margin-top:8px;font-size:0.9rem;color:#475569;">${message}</div>
            </div>

            ${tracking ? `<p><strong>📮 Tracking Number:</strong> ${tracking}</p>` : ''}

            <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/order-tracking.html?id=${order.id}" class="button">View Order Details</a>

            <p style="margin-top:20px;">Thank you for shopping with us! 🙏</p>
          </div>
          <div class="footer">
            <p>${shopName} • ${new Date().getFullYear()}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Order ${ref} Updated to ${newStatus.toUpperCase()}
${'='.repeat(40)}

Dear ${customerName},

Your order status has been updated to: ${newStatus.toUpperCase()}

${message}
${tracking ? `\nTracking Number: ${tracking}` : ''}

View your order: ${process.env.CLIENT_URL || 'http://localhost:3000'}/order-tracking.html?id=${order.id}

Thank you for shopping with us!

- ${shopName}
    `.trim()
  };
}

// ---- Received Email - WITH BUSINESS NAME ----
function receivedEmail(order, customerName, businessName = null) {
  const ref = order.order_ref || `#${order.id}`;
  const shopName = businessName || process.env.SHOP_NAME || 'Our Shop';

  return {
    subject: `Order ${ref} Received Confirmation`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #1e293b; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #0f172a; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #ffffff; padding: 20px; border: 1px solid #e2e8f0; border-radius: 0 0 8px 8px; }
          .thank-you { text-align: center; font-size: 1.2rem; color: #22c55e; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 0.85rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Order ${ref} Received</h1>
            <p style="font-size:0.8rem;opacity:0.8;">${shopName}</p>
          </div>
          <div class="content">
            <p>Dear ${customerName},</p>

            <div class="thank-you">
              🎉 You have confirmed receipt of your order!
            </div>

            <p>Thank you for your trust and for shopping with us. We hope you enjoy your products!</p>

            <p>If you have any questions or need assistance, please don't hesitate to contact us.</p>

            <p style="margin-top:20px;">We value your business and look forward to serving you again.</p>
          </div>
          <div class="footer">
            <p>${shopName} • ${new Date().getFullYear()}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Order ${ref} Received Confirmation
${'='.repeat(40)}

Dear ${customerName},

✅ You have confirmed receipt of your order!

Thank you for your trust and for shopping with us. We hope you enjoy your products!

We value your business and look forward to serving you again.

- ${shopName}
    `.trim()
  };
}

// ---- Forgot Password Email ----
function forgotPasswordEmail(email, resetLink) {
  return {
    subject: '🔑 Reset Your Password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #1e293b; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #0f172a; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #ffffff; padding: 20px; border: 1px solid #e2e8f0; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 10px 0; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 0.85rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔑 Password Reset</h1>
          </div>
          <div class="content">
            <p>We received a request to reset your password for <strong>${email}</strong>.</p>

            <p>Click the button below to set a new password. This link expires in 1 hour.</p>

            <div style="text-align:center;">
              <a href="${resetLink}" class="button">Reset Password</a>
            </div>

            <p style="margin-top:20px;">If you didn't request this, please ignore this email.</p>

            <p>For security, this link can only be used once.</p>
          </div>
          <div class="footer">
            <p>${process.env.SHOP_NAME || 'Our Shop'} • ${new Date().getFullYear()}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Password Reset Request
${'='.repeat(40)}

We received a request to reset your password for ${email}.

Click the link below to set a new password. This link expires in 1 hour:

${resetLink}

If you didn't request this, please ignore this email.

For security, this link can only be used once.
    `.trim()
  };
}

module.exports = {
  sendEmail,
  orderConfirmationEmail,
  statusUpdateEmail,
  receivedEmail,
  forgotPasswordEmail
};