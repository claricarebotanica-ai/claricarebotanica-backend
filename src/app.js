const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

const { createDatabase } = require('./db');
const { employeeAgreementFields, employeeAgreementTemplate } = require('./employee-agreement-template');

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_URL_LENGTH = 2048;

const parseSizeOptions = (value) => {
  if (!value) return [];
  return Array.isArray(value) ? value : JSON.parse(value);
};

const productForApi = (product) => ({
  ...product,
  price: Number(product.price),
  sizeOptions: parseSizeOptions(product.size_options),
  howToUse: product.how_to_use || '',
});

const referrerAgreementContent = (name, email, position) => `CLARICARE BOTANICA LTD
REFERRAL PARTNER AGREEMENT

This Referral Partner Agreement is between ClariCare Botanica Ltd ("ClariCare") and ${name} (${email}, "Referrer"). It takes effect when the Referrer electronically signs it.

1. Referral role
The Referrer may introduce customers to ClariCare products using a referral code or link issued by ClariCare. ${position ? `The invitation role is: ${position}.` : ''} The Referrer is an independent referral partner, not an employee, agent, franchisee, or legal representative of ClariCare. The Referrer cannot make promises, accept orders, or incur obligations on ClariCare's behalf.

2. Commission and attribution
ClariCare will credit a 5% commission on the eligible product subtotal of a qualifying order attributed by ClariCare's referral system to the Referrer's code or link within 7 days of the customer's referral interaction. The eligible product subtotal is the amount actually received for products after discounts, excluding delivery charges and amounts cancelled or refunded. A commission is not earned on the Referrer's own purchases, duplicate or fraudulent orders, unpaid orders, or orders later cancelled or refunded. ClariCare's recorded order and attribution data will be used to verify eligibility.

3. Payment
Approved commissions will be reviewed and paid monthly after the order payment has been confirmed and relevant cancellation, refund, and return checks are complete. The Referrer must provide accurate payment details through the channel ClariCare specifies. No commission is due on an order that does not satisfy the eligibility rules above. This agreement does not promise a minimum number of referrals or earnings.

4. Responsible promotion
The Referrer must describe products honestly, use only current product information, comply with applicable advertising and consumer-protection laws, and make clear when a recommendation is a referral. The Referrer must not make unapproved medical or therapeutic claims, mislead customers, spam, impersonate ClariCare, or use customer personal information except with lawful permission.

5. Brand, confidentiality, and customer information
ClariCare retains its ownership of its name, marks, content, and products. ClariCare grants the Referrer a limited, revocable permission to use approved referral materials only to promote the program. The Referrer must protect non-public business information and handle customer information lawfully and securely.

6. Term and ending the relationship
This agreement continues until either party ends it by written notice. ClariCare may suspend or end participation immediately for suspected fraud, unlawful or misleading promotion, misuse of personal information, or a material breach. Ending the relationship does not remove commission eligibility for qualifying orders already completed before termination, subject to the eligibility and payment checks in this agreement.

7. General
This agreement is governed by the laws of Kenya. Any change to the commission rate, attribution period, or other terms must be communicated by ClariCare; changes will not reduce a commission already earned on a qualifying order. If a provision cannot be enforced, the remaining provisions continue to apply.

By signing electronically, the Referrer confirms that they have read and understood this agreement, agree to its terms, and intend their drawn signature and typed name to serve as their electronic signature.
`;

const validateElectronicSignature = ({ signatureName, signatureData, consent }) => {
  const name = typeof signatureName === 'string' ? signatureName.trim() : '';
  if (name.length < 2 || name.length > 160) return { error: 'Enter your full name to sign the agreement.' };
  if (consent !== true) return { error: 'Confirm that you have read and agree to the agreement before signing.' };
  if (typeof signatureData !== 'string' || signatureData.length > 200000) return { error: 'Draw your signature before signing. The signature image must be under 150 KB.' };
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(signatureData);
  if (!match) return { error: 'The signature must be a valid PNG drawing.' };
  const image = Buffer.from(match[1], 'base64');
  if (image.length < 8 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { error: 'The signature image is not a valid PNG.' };
  }
  return { name, data: signatureData };
};

const validateAgreementFields = (fields) => {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { error: 'Complete the required employee agreement fields.' };
  const normalized = {};
  for (const field of employeeAgreementFields) {
    const value = typeof fields[field.name] === 'string' ? fields[field.name].trim() : '';
    if (!value || value.length > (field.maxLength || 10)) return { error: `${field.label} is required and must be valid.` };
    if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)) {
      return { error: `${field.label} must be a valid date.` };
    }
    normalized[field.name] = value;
  }
  return { fields: normalized };
};

const renderEmployeeAgreement = (fields, signatureName) => employeeAgreementTemplate
  .replaceAll('{{effectiveDate}}', fields.effectiveDate)
  .replaceAll('{{teamMemberName}}', signatureName)
  .replaceAll('{{position}}', fields.position)
  .replaceAll('{{startDate}}', fields.startDate)
  .replaceAll('{{signedDate}}', new Date().toISOString().slice(0, 10));

const agreementForApi = (agreement) => ({
  ...agreement,
  fillableFields: JSON.parse(agreement.fillable_fields || '[]'),
});

function createApp(database = createDatabase()) {
  const app = express();

  const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,https://claricarebotanica.com')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  const allowedOriginSet = new Set([...allowedOrigins, 'https://claricarebotanica.com', 'https://www.claricarebotanica.com', 'https://calicarebotanica.netlify.app']);
  for (const origin of allowedOrigins) {
    try {
      const alias = new URL(origin);
      if (alias.hostname === 'localhost') alias.hostname = '127.0.0.1';
      else if (alias.hostname === '127.0.0.1') alias.hostname = 'localhost';
      allowedOriginSet.add(alias.origin);
    } catch (_) { /* Ignore malformed configured origins; CORS will reject them. */ }
  }
  app.use(cors({
    origin: (origin, callback) => callback(null, !origin || allowedOriginSet.has(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Setup-Key', 'X-Document-Type', 'X-File-Type', 'X-File-Name'],
  }));
  const standardJsonParser = express.json({ limit: '2mb' });
  const imageJsonParser = express.json({ limit: '15mb' });
  app.use((req, res, next) => {
    const isImageUpload = (req.method === 'PATCH' && req.path === '/api/account/profile')
      || (req.method === 'POST' && req.path === '/api/catalog/products');
    return (isImageUpload ? imageJsonParser : standardJsonParser)(req, res, next);
  });

  const signToken = (user) => {
    return jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'claricare-dev-secret',
      { expiresIn: '7d' }
    );
  };

  const sanitizeUser = (user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.created_at,
    profileImage: user.profile_image || null,
    deletedAt: user.deleted_at || null,
    position: user.position || null,
    departmentId: user.department_id || null,
    positionId: user.position_id || null,
    departmentName: user.department_id
      ? database.db.prepare('SELECT name FROM departments WHERE id=?').get(user.department_id)?.name || null
      : null,
    invitationPending: ['referrer', 'employee'].includes(user.role) && !user.invitation_accepted_at && !user.deleted_at,
  });

  const contentSlug = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 160);
  const validContentUrl = (value) => {
    if (value === null || value === undefined || value === '') return true;
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch (_) { return false; }
  };
  const escapeApplicantEmailHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const renderApplicantEmailHtml = (subject, text) => {
    const paragraphs = String(text || '').trim().split(/\n{2,}/).filter(Boolean).map((paragraph) =>
      `<p style="margin:0 0 16px;color:#47564a;font-size:15px;line-height:1.75;white-space:normal">${escapeApplicantEmailHtml(paragraph).replace(/\n/g, '<br>')}</p>`
    ).join('');
    return `<!doctype html><html><body style="margin:0;padding:32px 14px;background:#f2f5ef;font-family:Arial,Helvetica,sans-serif;color:#304636">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e2e9df;border-radius:14px;overflow:hidden">
        <tr><td style="padding:24px 32px;background:#304636;color:#ffffff"><div style="font-family:Georgia,serif;font-size:22px;letter-spacing:1px">CLARICARE</div><div style="margin-top:4px;color:#dce7d8;font-size:10px;letter-spacing:2px">BOTANICA LTD</div></td></tr>
        <tr><td style="padding:32px"><h1 style="margin:0 0 24px;color:#304636;font-family:Georgia,serif;font-size:25px;font-weight:500;line-height:1.3">${escapeApplicantEmailHtml(subject)}</h1>${paragraphs}</td></tr>
        <tr><td style="padding:18px 32px;border-top:1px solid #e8eee5;background:#fafbf9;color:#788477;font-size:11px;line-height:1.6">ClariCare Botanica Ltd<br>Clarity in Skincare. Care Beyond the Surface.<br><a href="mailto:claricarebotanica@gmail.com" style="color:#456849;text-decoration:none">claricarebotanica@gmail.com</a></td></tr>
      </table>
    </body></html>`;
  };
  const sendApplicantNotification = async (to, subject, text) => {
    const { SMTP_USER, SMTP_APP_PASSWORD, SMTP_FROM } = process.env;
    if (!SMTP_USER || !SMTP_APP_PASSWORD || !nodemailer) {
      return { sent: false, reason: 'Email is not configured on the backend.' };
    }
    try {
      const smtpPort = Number(process.env.SMTP_PORT || 465);
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: smtpPort,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE.toLowerCase() === 'true' : smtpPort === 465,
        auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD.replace(/\s/g, '') },
      });
      await transporter.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, html: renderApplicantEmailHtml(subject, text) });
      return { sent: true };
    } catch (error) {
      console.error('Applicant notification email failed:', error.message);
      return { sent: false, reason: 'The application was saved, but its email notification could not be sent.' };
    }
  };
  const recruitmentSetting = (key) => database.db.prepare('SELECT value FROM recruitment_settings WHERE key=?').get(key)?.value;
  const foundationalTeamStats = () => {
    const enabled = recruitmentSetting('foundational_team_enabled') === 'true';
    const maximum = Math.max(0, Number(recruitmentSetting('max_foundational_positions') || 0));
    const current = database.db.prepare("SELECT COUNT(*) AS count FROM applications WHERE application_type='foundational' AND status='accepted'").get().count;
    return {
      foundationalTeamEnabled: enabled,
      maxFoundationalPositions: maximum,
      foundationalTeamMembers: current,
      foundationalPositionsAvailable: maximum === 0 ? null : Math.max(0, maximum - current),
      foundationalTeamAvailable: enabled && (maximum === 0 || current < maximum),
    };
  };
  const addApplicationTimelineEvent = (applicationId, status, note, { changedBy = null, isPrivate = false, eventType = 'status' } = {}) => {
    database.db.prepare(`
      INSERT INTO application_status_history (id,application_id,status,note,changed_by,is_private,event_type)
      VALUES (?,?,?,?,?,?,?)
    `).run(database.generateId(), applicationId, status, note, changedBy, isPrivate ? 1 : 0, eventType);
  };
  const supabaseStorageConfig = () => {
    const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_RECRUITMENT_BUCKET || 'recruitment-private';
    if (!url || !key) return null;
    return { url, key, bucket };
  };
  const encodeStoragePath = (value) => value.split('/').map(encodeURIComponent).join('/');
  const uploadPrivateRecruitmentFile = async ({ path, mimeType, buffer }) => {
    const config = supabaseStorageConfig();
    if (!config) throw new Error('Private recruitment storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the backend.');
    const response = await fetch(`${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodeStoragePath(path)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
        'Content-Type': mimeType,
        'x-upsert': 'false',
      },
      body: buffer,
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Private recruitment upload failed (${response.status}): ${message.slice(0, 500)}`);
    }
  };
  const deletePrivateRecruitmentFile = async (path) => {
    const config = supabaseStorageConfig();
    if (!config) return;
    const response = await fetch(`${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodeStoragePath(path)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${config.key}`, apikey: config.key },
    });
    if (!response.ok) throw new Error(`Private recruitment cleanup failed (${response.status}).`);
  };
  const signPrivateRecruitmentUrl = async (path) => {
    const config = supabaseStorageConfig();
    if (!config) throw new Error('Private recruitment storage is not configured.');
    const response = await fetch(`${config.url}/storage/v1/object/sign/${encodeURIComponent(config.bucket)}/${encodeStoragePath(path)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.key}`, apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 600 }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Private document access could not be created (${response.status}): ${message.slice(0, 500)}`);
    }
    const data = await response.json();
    return `${config.url}/storage/v1${data.signedURL}`;
  };
  const parseApplicationAnswers = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
  };
  const validateApplicationAnswers = (answers, applicationType) => {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { error: 'Application answers must be an object.' };
    const limits = {
      country: 120, city: 120, profileUrl: 500, workArrangement: 40, education: 2000,
      experienceYears: 40, previousExperience: 5000, skills: 2000, achievement: 5000,
      motivation: 5000, contribution: 5000, problemSolving: 5000, teamwork: 5000,
      responsibility: 5000, commitment: 5000, foundationalCommitment: 5000, equityCommitment: 5000,
    };
    const result = {};
    for (const [key, maxLength] of Object.entries(limits)) {
      const answer = answers[key] === undefined ? '' : answers[key];
      if (typeof answer !== 'string' || answer.length > maxLength) return { error: `${key} must be text of at most ${maxLength} characters.` };
      result[key] = answer.trim();
    }
    const required = ['country', 'city', 'workArrangement', 'education', 'experienceYears', 'previousExperience', 'skills', 'achievement', 'motivation', 'contribution', 'problemSolving', 'teamwork', 'responsibility', 'commitment'];
    if (required.some((key) => !result[key])) return { error: 'Complete all required application questions before submitting.' };
    if (result.profileUrl && !validContentUrl(result.profileUrl)) return { error: 'profileUrl must be a valid http or https URL.' };
    if (!['full-time', 'part-time', 'contract', 'other'].includes(result.workArrangement)) return { error: 'Choose a valid work arrangement.' };
    if (!['No previous experience', 'Less than 1 year', '1–2 years', '3–5 years', '6–10 years', 'More than 10 years'].includes(result.experienceYears)) {
      return { error: 'Choose a valid experience range.' };
    }
    if (applicationType === 'foundational' && (!result.foundationalCommitment || !result.equityCommitment)) {
      return { error: 'Complete both foundational-team questions for this application type.' };
    }
    return { answers: result };
  };
  const validateContent = (data, { partial = false } = {}) => {
    const title = data.title === undefined && partial ? undefined : String(data.title || '').trim();
    const type = data.type === undefined && partial ? undefined : data.type;
    const body = data.body === undefined && partial ? undefined : String(data.body || '').trim();
    const excerpt = data.excerpt === undefined && partial ? undefined : String(data.excerpt || '').trim();
    const slug = data.slug === undefined && partial ? undefined : contentSlug(data.slug || title);
    if (title !== undefined && (!title || title.length > 240)) return { error: 'title is required and must be at most 240 characters' };
    if (type !== undefined && !['blog', 'news', 'video'].includes(type)) return { error: 'type must be blog, news or video' };
    if (slug !== undefined && !slug) return { error: 'A valid slug could not be generated' };
    if (body !== undefined && body.length > 100000) return { error: 'body must be at most 100,000 characters' };
    if (excerpt !== undefined && excerpt.length > 1000) return { error: 'excerpt must be at most 1,000 characters' };
    for (const key of ['coverImageUrl', 'videoUrl']) if (data[key] !== undefined && !validContentUrl(data[key])) return { error: `${key} must be a valid http or https URL` };
    if (!partial && type !== 'video' && !body) return { error: 'body is required for blog and news posts' };
    if (!partial && type === 'video' && !data.videoUrl) return { error: 'videoUrl is required for video posts' };
    return { values: { title, type, body, excerpt, slug } };
  };
  const emailNewsSubscribers = async (post) => {
    const subscribers = database.db.prepare('SELECT email FROM newsletter_subscribers WHERE active=1 ORDER BY email').all();
    const { SMTP_USER, SMTP_APP_PASSWORD, SMTP_FROM } = process.env;
    if (!subscribers.length) return { emailSent: false, subscriberCount: 0, emailReason: 'No active subscribers' };
    if (!SMTP_USER || !SMTP_APP_PASSWORD || !nodemailer) return { emailSent: false, subscriberCount: subscribers.length, emailReason: 'Email is not configured' };
    try {
      const smtpPort = Number(process.env.SMTP_PORT || 465);
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com', port: smtpPort,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE.toLowerCase() === 'true' : smtpPort === 465,
        auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD.replace(/\s/g, '') },
      });
      const frontendUrl = (process.env.FRONTEND_URL || 'https://claricarebotanica.com').replace(/\/+$/, '');
      const url = `${frontendUrl}/#updates`;
      const excerpt = post.excerpt || String(post.body || '').replace(/<[^>]*>/g, '').slice(0, 500);
      await transporter.sendMail({
        from: SMTP_FROM || SMTP_USER,
        to: SMTP_FROM || SMTP_USER,
        bcc: subscribers.map((subscriber) => subscriber.email),
        subject: `ClariCare news: ${post.title}`,
        text: `${post.title}\n\n${excerpt}\n\nRead the latest from ClariCare: ${url}\n\nYou received this because you subscribed to ClariCare updates.`,
      });
      return { emailSent: true, subscriberCount: subscribers.length };
    } catch (error) {
      console.error('News subscriber email failed:', error.message);
      return { emailSent: false, subscriberCount: subscribers.length, emailReason: 'News was published, but subscriber email could not be sent' };
    }
  };
  const normalizeEquipmentAsset = (data, current = null) => {
    const name = data.name === undefined ? current?.name : data.name;
    const purchasePrice = Number(data.purchasePrice === undefined ? current?.purchase_price : data.purchasePrice);
    const purchaseDate = data.purchaseDate === undefined ? current?.purchase_date : data.purchaseDate;
    const usefulLifeMonths = data.usefulLifeMonths !== undefined
      ? Number(data.usefulLifeMonths)
      : data.usefulLifeYears !== undefined
        ? Number(data.usefulLifeYears) * 12
        : Number(current?.useful_life_months);
    const residualValue = Number(data.residualValue === undefined ? (current?.residual_value ?? 0) : data.residualValue);
    const depreciationMethod = data.depreciationMethod === undefined ? (current?.depreciation_method || 'straight_line') : data.depreciationMethod;
    const categoryValue = data.category === undefined ? current?.category : data.category;
    const notesValue = data.notes === undefined ? current?.notes : data.notes;
    const allocationBasis = data.allocationBasis === undefined ? (current?.allocation_basis || 'per_unit') : data.allocationBasis;
    const allocationQuantity = Number(data.allocationQuantity === undefined ? current?.allocation_quantity : data.allocationQuantity);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 160) return { error: 'name must be between 1 and 160 characters' };
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) return { error: 'purchasePrice must be a positive number in KES' };
    if (typeof purchaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) || !Number.isFinite(Date.parse(`${purchaseDate}T00:00:00.000Z`)) || new Date(`${purchaseDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== purchaseDate) return { error: 'purchaseDate must use YYYY-MM-DD format' };
    if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths < 1) return { error: 'provide a positive usefulLifeMonths or usefulLifeYears value' };
    if (!Number.isFinite(residualValue) || residualValue < 0 || residualValue > purchasePrice) return { error: 'residualValue must be between zero and purchasePrice' };
    if (depreciationMethod !== 'straight_line') return { error: 'depreciationMethod must be straight_line' };
    if (!['per_unit', 'per_batch'].includes(allocationBasis)) return { error: 'allocationBasis must be per_unit or per_batch' };
    if (!Number.isFinite(allocationQuantity) || allocationQuantity <= 0) return { error: 'allocationQuantity must be positive; use expected units or batches per month for the selected basis' };
    if (categoryValue !== null && categoryValue !== undefined && (typeof categoryValue !== 'string' || categoryValue.trim().length > 120)) return { error: 'category must be at most 120 characters' };
    if (notesValue !== null && notesValue !== undefined && (typeof notesValue !== 'string' || notesValue.length > 1000)) return { error: 'notes must be at most 1,000 characters' };
    return { values: {
      name: name.trim(), purchasePrice, purchaseDate, usefulLifeMonths, residualValue,
      depreciationMethod, category: typeof categoryValue === 'string' && categoryValue.trim() ? categoryValue.trim() : null,
      notes: typeof notesValue === 'string' && notesValue.trim() ? notesValue.trim() : null,
      allocationBasis, allocationQuantity,
    } };
  };

  const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'claricare-dev-secret');
      const user = database.db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      if (user.deleted_at) return res.status(401).json({ error: 'This account has been deleted. Contact an administrator.' });
      if (['referrer', 'employee'].includes(user.role) && !user.invitation_accepted_at) return res.status(401).json({ error: 'Accept your invitation before signing in.' });

      req.user = user;
      return next();
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  const requireRole = (...allowedRoles) => (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied for this role' });
    }

    return next();
  };

  app.get('/', (req, res) => {
    res.json({
      status: 'success',
      message: 'ClariCare backend is running successfully',
      service: 'claricare-backend',
      endpoints: '/api/health'
    });
  });

  app.get('/api', (req, res) => {
    return res.json({ status: 'ok', service: 'claricare-backend', endpoints: '/api/health' });
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'claricare-backend' });
  });

  app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, role = 'customer' } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    const allowedRoles = ['customer', 'applicant', 'employee', 'admin', 'referrer'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Role must be one of: customer, applicant, employee, admin, or referrer.' });
    }

    const existing = database.ensureUser(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = database.createUser({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      passwordHash,
      role,
      invitationAcceptedAt: ['employee', 'referrer'].includes(role) ? new Date().toISOString() : undefined,
    });

    return res.status(201).json({
      message: 'User registered successfully',
      user: sanitizeUser(user),
      token: signToken(user),
    });
  });

  // One-time owner setup: enabled only when ADMIN_SETUP_KEY is configured and no admin exists.
  app.post('/api/auth/bootstrap-admin', async (req, res) => {
    const setupKey = process.env.ADMIN_SETUP_KEY;
    const adminCount = database.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'").get().count;
    if (!setupKey || adminCount) return res.status(404).json({ error: 'Admin bootstrap is unavailable' });
    if (req.get('x-admin-setup-key') !== setupKey) return res.status(401).json({ error: 'Invalid setup key' });
    const { name, email, password } = req.body || {};
    if (!name || !email || !password || String(password).length < 12) return res.status(400).json({ error: 'name, email and a password of at least 12 characters are required' });
    if (database.ensureUser(String(email).toLowerCase().trim())) return res.status(409).json({ error: 'User already exists' });
    const user = database.createUser({ name: String(name).trim(), email: String(email).toLowerCase().trim(), passwordHash: await bcrypt.hash(password, 12), role: 'admin' });
    return res.status(201).json({ user: sanitizeUser(user), token: signToken(user) });
  });

  app.get('/api/auth/invitation', (req, res) => {
    const token = req.query.token;
    if (typeof token !== 'string' || !token.trim()) return res.status(400).json({ error: 'A valid invitation token is required.' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const invitedUser = database.db.prepare("SELECT * FROM users WHERE invitation_token_hash=? AND role IN ('referrer','employee') AND deleted_at IS NULL").get(tokenHash);
    if (!invitedUser || invitedUser.invitation_accepted_at || !invitedUser.invitation_expires_at || Date.parse(invitedUser.invitation_expires_at) <= Date.now()) {
      return res.status(400).json({ error: 'This invitation is invalid or has expired.' });
    }
    const agreement = invitedUser.role === 'referrer'
      ? database.db.prepare("SELECT id,title,type,content,status FROM agreements WHERE employee_id=? AND type='referrer' AND status='pending_signature' ORDER BY created_at DESC LIMIT 1").get(invitedUser.id)
      : null;
    if (invitedUser.role === 'referrer' && !agreement) return res.status(409).json({ error: 'The referral agreement is unavailable. Ask the administrator to resend your invitation.' });
    return res.json({
      invitation: {
        name: invitedUser.name,
        role: invitedUser.role,
        position: invitedUser.position || null,
        departmentName: invitedUser.department_id
          ? database.db.prepare('SELECT name FROM departments WHERE id=?').get(invitedUser.department_id)?.name || null
          : null,
      },
      agreement: agreement || null,
    });
  });

  app.post('/api/auth/accept-invitation', async (req, res) => {
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || !token.trim() || typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({ error: 'A valid invitation token and a password of at least 12 characters are required.' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const invitedUser = database.db.prepare("SELECT * FROM users WHERE invitation_token_hash=? AND role IN ('referrer','employee') AND deleted_at IS NULL").get(tokenHash);
    if (!invitedUser || invitedUser.invitation_accepted_at || !invitedUser.invitation_expires_at || Date.parse(invitedUser.invitation_expires_at) <= Date.now()) {
      return res.status(400).json({ error: 'This invitation is invalid or has expired.' });
    }
    let signature = null;
    let agreement = null;
    if (invitedUser.role === 'referrer') {
      signature = validateElectronicSignature({
        ...(req.body || {}),
        consent: req.body?.agreementConsent,
      });
      if (signature.error) return res.status(400).json({ error: signature.error });
      agreement = database.db.prepare("SELECT id FROM agreements WHERE employee_id=? AND type='referrer' AND status='pending_signature' ORDER BY created_at DESC LIMIT 1").get(invitedUser.id);
      if (!agreement) return res.status(409).json({ error: 'The referral agreement is unavailable. Ask the administrator to resend your invitation.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const acceptInvitation = database.db.transaction(() => {
      if (agreement) {
        const signed = database.db.prepare(`
          UPDATE agreements SET status='signed',signed_by=?,signature_data=?,signed_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='pending_signature'
        `).run(signature.name, signature.data, agreement.id);
        if (!signed.changes) return false;
      }
      const accepted = database.db.prepare(`
        UPDATE users
        SET password_hash=?, invitation_token_hash=NULL, invitation_expires_at=NULL, invitation_accepted_at=CURRENT_TIMESTAMP
        WHERE id=? AND invitation_token_hash=? AND invitation_accepted_at IS NULL AND deleted_at IS NULL
      `).run(passwordHash, invitedUser.id, tokenHash);
      return accepted.changes > 0;
    });
    if (!acceptInvitation()) return res.status(400).json({ error: 'This invitation is invalid, expired, or already accepted.' });
    const user = database.db.prepare('SELECT * FROM users WHERE id=?').get(invitedUser.id);
    return res.json({ message: 'Invitation accepted. You can now sign in.', user: sanitizeUser(user), token: signToken(user) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const configuredAdminEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
    const configuredAdminPassword = process.env.ADMIN_PASSWORD || '';

    // Let the configured owner sign in before an admin row exists in SQLite.
    // The database stores only a bcrypt hash, never the environment password.
    if (configuredAdminEmail && configuredAdminPassword && normalizedEmail === configuredAdminEmail) {
      if (String(password) !== configuredAdminPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const passwordHash = await bcrypt.hash(configuredAdminPassword, 12);
      let user = database.ensureUser(configuredAdminEmail);
      if (user) {
        if (user.deleted_at) return res.status(401).json({ error: 'Invalid credentials' });
        database.db.prepare('UPDATE users SET name = ?, password_hash = ?, role = ? WHERE id = ?')
          .run(process.env.ADMIN_NAME || user.name, passwordHash, 'admin', user.id);
        user = database.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      } else {
        const created = database.createUser({
          name: process.env.ADMIN_NAME || 'Admin',
          email: configuredAdminEmail,
          passwordHash,
          role: 'admin',
        });
        user = database.db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
      }
      return res.json({ message: 'Login successful', token: signToken(user), user: sanitizeUser(user) });
    }

    const user = database.ensureUser(normalizedEmail);
    if (!user || user.deleted_at || (['referrer', 'employee'].includes(user.role) && !user.invitation_accepted_at)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    return res.json({
      message: 'Login successful',
      token: signToken(user),
      user: sanitizeUser(user),
    });
  });

  app.post('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
    const { name, email, password, role, position, departmentId, positionId } = req.body || {};
    if (typeof name !== 'string' || typeof email !== 'string' || !['admin', 'employee', 'referrer'].includes(role)) {
      return res.status(400).json({ error: 'name, email and an authorized role are required' });
    }
    const normalizedEmail = String(email).toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) return res.status(400).json({ error: 'A valid email address is required' });
    const normalizedName = String(name).trim();
    if (!normalizedName || normalizedName.length > 160) return res.status(400).json({ error: 'name must be between 1 and 160 characters' });

    if (role === 'referrer' || role === 'employee') {
      const normalizedPosition = typeof position === 'string' ? position.trim() : '';
      if (role === 'referrer' && (!normalizedPosition || normalizedPosition.length > 160)) return res.status(400).json({ error: 'A position of 1 to 160 characters is required for a referrer invitation' });
      let assignedPosition = null;
      let assignedDepartment = null;
      if (role === 'employee') {
        if (typeof departmentId !== 'string' || !departmentId || typeof positionId !== 'string' || !positionId) {
          return res.status(400).json({ error: 'departmentId and positionId are required for an employee invitation' });
        }
        assignedPosition = database.db.prepare("SELECT id,title,department_id FROM positions WHERE id=? AND status='open' AND is_hiring=0").get(positionId);
        if (!assignedPosition || assignedPosition.department_id !== departmentId) {
          return res.status(400).json({ error: 'Choose an active employee position belonging to the selected department.' });
        }
        assignedDepartment = database.db.prepare('SELECT id,name FROM departments WHERE id=?').get(departmentId);
      }
      const { SMTP_USER, SMTP_APP_PASSWORD, SMTP_FROM } = process.env;
      if (!SMTP_USER || !SMTP_APP_PASSWORD || !nodemailer) {
        return res.status(503).json({ error: 'Email is not configured, so the invitation could not be sent.' });
      }

      const existing = database.ensureUser(normalizedEmail);
      if (existing && (existing.role !== role || existing.deleted_at || existing.invitation_accepted_at)) {
        return res.status(409).json({ error: 'An active account already uses this email address.' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      let userId;
      if (existing) {
        userId = existing.id;
        database.db.prepare(`
          UPDATE users SET name=?,position=?,department_id=?,position_id=?,invitation_token_hash=?,invitation_expires_at=?,invitation_accepted_at=NULL
          WHERE id=? AND role=? AND deleted_at IS NULL
        `).run(
          normalizedName,
          role === 'referrer' ? normalizedPosition : assignedPosition.title,
          assignedDepartment?.id || null,
          assignedPosition?.id || null,
          tokenHash,
          expiresAt,
          userId,
          role
        );
      } else {
        userId = database.generateId();
        const temporaryPasswordHash = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 12);
        database.db.prepare(`
          INSERT INTO users (id,name,email,password_hash,role,position,department_id,position_id,invitation_token_hash,invitation_expires_at)
          VALUES (@id,@name,@email,@password_hash,@role,@position,@department_id,@position_id,@invitation_token_hash,@invitation_expires_at)
        `).run({
          id: userId,
          name: normalizedName,
          email: normalizedEmail,
          password_hash: temporaryPasswordHash,
          role,
          position: role === 'referrer' ? normalizedPosition : assignedPosition.title,
          department_id: assignedDepartment?.id || null,
          position_id: assignedPosition?.id || null,
          invitation_token_hash: tokenHash,
          invitation_expires_at: expiresAt,
        });
      }

      if (role === 'referrer') {
        const content = referrerAgreementContent(normalizedName, normalizedEmail, normalizedPosition);
        const pendingAgreement = database.db.prepare(`
          SELECT id FROM agreements
          WHERE employee_id=? AND type='referrer' AND status='pending_signature'
          ORDER BY created_at DESC LIMIT 1
        `).get(userId);
        if (pendingAgreement) {
          database.db.prepare('UPDATE agreements SET title=?,content=?,signature_data=NULL,signed_by=NULL,signed_at=NULL WHERE id=?')
            .run('Referral Partner Agreement', content, pendingAgreement.id);
        } else {
          database.createAgreement({
            employeeId: userId,
            type: 'referrer',
            title: 'Referral Partner Agreement',
            content,
            status: 'pending_signature',
          });
        }
      }

      const roleName = role === 'referrer' ? 'referrer' : 'employee';
      const article = role === 'referrer' ? 'a' : 'an';
      try {
        const smtpPort = Number(process.env.SMTP_PORT || 465);
        const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
        const smtpSecure = process.env.SMTP_SECURE
          ? process.env.SMTP_SECURE.toLowerCase() === 'true'
          : smtpPort === 465;
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD.replace(/\s/g, '') },
        });
        const frontendUrl = (process.env.FRONTEND_URL || 'https://claricarebotanica.com').replace(/\/+$/, '');
        const invitationUrl = `${frontendUrl}/accept-invitation?token=${encodeURIComponent(token)}`;
        await transporter.sendMail({
          from: SMTP_FROM || SMTP_USER,
          to: normalizedEmail,
          subject: `You are invited to join ClariCare as ${article} ${roleName}`,
          text: `Hello ${normalizedName},\n\nAn administrator has invited you to join ClariCare as ${article} ${roleName}.${role === 'referrer' ? `\nPosition: ${normalizedPosition}` : `\nDepartment: ${assignedDepartment.name}\nPosition: ${assignedPosition.title}`}\n\nAccept your invitation and choose a password here:\n${invitationUrl}\n\nThis invitation expires in 7 days.`,
        });
      } catch (error) {
        console.error(`${roleName} invitation email failed:`, error.message);
        return res.status(502).json({ error: 'The invitation could not be emailed. You can retry the invitation from the admin panel.' });
      }

      const invitedUser = database.db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      return res.status(existing ? 200 : 201).json({ message: `${roleName[0].toUpperCase()}${roleName.slice(1)} invitation sent.`, user: sanitizeUser(invitedUser) });
    }

    if (typeof password !== 'string' || password.length < 12) return res.status(400).json({ error: 'Staff passwords must be at least 12 characters long' });
    if (database.ensureUser(normalizedEmail)) return res.status(409).json({ error: 'User already exists' });
    const user = database.createUser({ name: normalizedName, email: normalizedEmail, passwordHash: await bcrypt.hash(password, 12), role });
    return res.status(201).json({ user: sanitizeUser(user) });
  });

  app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
    const includeDeleted = req.query.includeDeleted === 'true';
    const users = database.db.prepare(`SELECT * FROM users ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY deleted_at IS NOT NULL, created_at DESC`).all();
    const counts = database.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS activeCount,
        COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS deletedCount
      FROM users
    `).get();
    return res.json({ users: users.map(sanitizeUser), activeCount: counts.activeCount, deletedCount: counts.deletedCount });
  });

  app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot move your own account to the bin.' });
    const user = database.db.prepare('SELECT id,role,deleted_at FROM users WHERE id=?').get(req.params.id);
    if (!user || user.deleted_at) return res.status(404).json({ error: 'Active user not found.' });
    if (user.role === 'admin') {
      const admins = database.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND deleted_at IS NULL").get().count;
      if (admins <= 1) return res.status(400).json({ error: 'The last active administrator cannot be deleted.' });
    }
    database.db.prepare('UPDATE users SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL').run(req.params.id);
    return res.json({ message: 'User moved to bin.' });
  });

  app.post('/api/admin/users/:id/restore', requireAuth, requireRole('admin'), (req, res) => {
    const result = database.db.prepare('UPDATE users SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Deleted user not found.' });
    return res.json({ message: 'User restored.' });
  });

  app.get('/api/admin/bin', requireAuth, requireRole('admin'), (req, res) => {
    const items = [
      ...database.db.prepare("SELECT id,title AS name,'position' AS type,deleted_at FROM positions WHERE deleted_at IS NOT NULL").all(),
      ...database.db.prepare("SELECT id,title AS name,'update' AS type,deleted_at FROM company_updates WHERE deleted_at IS NOT NULL").all(),
      ...database.db.prepare("SELECT id,title AS name,'content' AS type,deleted_at FROM content_posts WHERE deleted_at IS NOT NULL").all(),
      ...database.db.prepare("SELECT id,name,'user' AS type,deleted_at FROM users WHERE deleted_at IS NOT NULL").all(),
    ].sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
    return res.json({ items });
  });

  app.post('/api/admin/bin/:type/:id/restore', requireAuth, requireRole('admin'), (req, res) => {
    const tables = { position: 'positions', update: 'company_updates', content: 'content_posts' };
    const table = tables[req.params.type];
    if (!table) return res.status(400).json({ error: 'Unsupported Bin item type. Restore users with /api/admin/users/:id/restore.' });
    const result = database.db.prepare(`UPDATE ${table} SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL`).run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Deleted item not found.' });
    return res.json({ message: 'Item restored.' });
  });

  app.delete('/api/admin/positions/:id', requireAuth, requireRole('admin'), (req, res) => {
    const result = database.db.prepare('UPDATE positions SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Active position not found.' });
    return res.json({ message: 'Position moved to Bin.' });
  });
  app.patch('/api/account/profile', requireAuth, (req, res) => {
    const image = req.body?.profileImage;
    const match = typeof image === 'string' ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
    if (!match) {
      return res.status(400).json({ error: 'Choose a PNG, JPEG, or WebP profile image.' });
    }
    if (Buffer.from(match[2], 'base64').byteLength > MAX_INLINE_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Profile image must be 10 MB or smaller.' });
    }
    database.db.prepare('UPDATE users SET profile_image=? WHERE id=?').run(image, req.user.id);
    const user = database.db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    return res.json({ user: sanitizeUser(user) });
  });

  app.get('/api/company/structure', requireAuth, requireRole('admin'), (req, res) => {
    const departments = database.db.prepare('SELECT id,name,description,created_at FROM departments ORDER BY name COLLATE NOCASE').all();
    const positions = database.db.prepare(`
      SELECT p.id,p.title,p.department_id,p.description,p.requirements,p.status,p.is_hiring,d.name AS department_name,p.created_at
      FROM positions p JOIN departments d ON d.id=p.department_id
      ORDER BY d.name COLLATE NOCASE,p.title COLLATE NOCASE
    `).all().map((item) => ({ ...item, isHiring: Boolean(item.is_hiring) }));
    return res.json({ departments, positions });
  });

  const accessibleDepartment = (req, res, departmentId) => {
    const department = database.db.prepare('SELECT id,name FROM departments WHERE id=?').get(departmentId);
    if (!department) {
      res.status(404).json({ error: 'Department not found.' });
      return null;
    }
    if (req.user.role !== 'admin' && (req.user.role !== 'employee' || req.user.department_id !== department.id)) {
      res.status(404).json({ error: 'Department discussion not found.' });
      return null;
    }
    return department;
  };

  app.get('/api/company/discussions', requireAuth, requireRole('employee'), (req, res) => {
    const departments = req.user.role === 'admin'
      ? database.db.prepare('SELECT id,name FROM departments ORDER BY name COLLATE NOCASE').all()
      : database.db.prepare('SELECT id,name FROM departments WHERE id=?').all(req.user.department_id);
    return res.json({ departments });
  });

  app.get('/api/company/departments/:departmentId/messages', requireAuth, requireRole('employee'), (req, res) => {
    const department = accessibleDepartment(req, res, req.params.departmentId);
    if (!department) return;
    const limitValue = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 200) {
      return res.status(400).json({ error: 'limit must be an integer from 1 to 200.' });
    }
    const messages = database.db.prepare(`
      SELECT m.id,m.department_id,m.sender_id,u.name AS sender_name,u.role AS sender_role,m.message,m.created_at
      FROM department_messages m
      JOIN users u ON u.id=m.sender_id
      WHERE m.department_id=?
      ORDER BY m.created_at DESC,m.id DESC
      LIMIT ?
    `).all(department.id, limitValue).reverse();
    return res.json({ department, messages });
  });

  app.post('/api/company/departments/:departmentId/messages', requireAuth, requireRole('employee'), (req, res) => {
    const department = accessibleDepartment(req, res, req.params.departmentId);
    if (!department) return;
    const message = req.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.trim().length > 10000) {
      return res.status(400).json({ error: 'A message of 1 to 10,000 characters is required.' });
    }
    const record = {
      id: database.generateId(),
      department_id: department.id,
      sender_id: req.user.id,
      message: message.trim(),
    };
    database.db.prepare(`
      INSERT INTO department_messages (id,department_id,sender_id,message)
      VALUES (@id,@department_id,@sender_id,@message)
    `).run(record);
    const saved = database.db.prepare(`
      SELECT m.id,m.department_id,m.sender_id,u.name AS sender_name,u.role AS sender_role,m.message,m.created_at
      FROM department_messages m JOIN users u ON u.id=m.sender_id
      WHERE m.id=?
    `).get(record.id);
    return res.status(201).json({ message: saved });
  });

  app.post('/api/company/departments', (req, res) => {
    const { name, description } = req.body || {};

    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: 'Department name must be between 1 and 120 characters.' });
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 1000)) return res.status(400).json({ error: 'description must be at most 1,000 characters.' });

    if (database.db.prepare('SELECT id FROM departments WHERE name=? COLLATE NOCASE').get(name.trim())) {
      return res.status(409).json({ error: 'Department already exists' });
    }
    try {
      const department = database.createDepartment({ name: name.trim(), description: String(description || '').trim() });
      return res.status(201).json({ message: 'Department created successfully', department });
    } catch (error) {
      if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      return res.status(409).json({ error: 'Department already exists' });
    }
  });

  app.post('/api/recruitment/positions', (req, res) => {
    const { title, departmentId, description, requirements, isHiring = true } = req.body || {};

    if (typeof title !== 'string' || !title.trim() || title.trim().length > 160 || typeof departmentId !== 'string' || !departmentId) {
      return res.status(400).json({ error: 'A position title of 1 to 160 characters and departmentId are required.' });
    }
    if (typeof isHiring !== 'boolean') return res.status(400).json({ error: 'isHiring must be true or false.' });
    if (description !== undefined && (typeof description !== 'string' || description.length > 2000)) return res.status(400).json({ error: 'description must be at most 2,000 characters.' });
    if (requirements !== undefined && (typeof requirements !== 'string' || requirements.length > 2000)) return res.status(400).json({ error: 'requirements must be at most 2,000 characters.' });

    const department = database.db.prepare('SELECT * FROM departments WHERE id = ?').get(departmentId);
    if (!department) {
      return res.status(404).json({ error: 'Department not found' });
    }
    if (database.db.prepare('SELECT id FROM positions WHERE department_id=? AND title=? COLLATE NOCASE').get(departmentId, title.trim())) {
      return res.status(409).json({ error: 'A position with this title already exists in the selected department.' });
    }

    const position = database.createPosition({ title: title.trim(), departmentId, description: String(description || '').trim(), requirements: String(requirements || '').trim(), isHiring });
    return res.status(201).json({ message: 'Position created successfully', position });
  });

  app.get('/api/recruitment/settings', (req, res) => {
    return res.json(foundationalTeamStats());
  });

  app.patch('/api/recruitment/settings', requireAuth, requireRole('admin'), (req, res) => {
    const { foundationalTeamEnabled, maxFoundationalPositions } = req.body || {};
    if (foundationalTeamEnabled === undefined && maxFoundationalPositions === undefined) return res.status(400).json({ error: 'Provide recruitment settings to update.' });
    if (foundationalTeamEnabled !== undefined && typeof foundationalTeamEnabled !== 'boolean') return res.status(400).json({ error: 'foundationalTeamEnabled must be true or false.' });
    if (maxFoundationalPositions !== undefined && (!Number.isInteger(maxFoundationalPositions) || maxFoundationalPositions < 0 || maxFoundationalPositions > 10000)) {
      return res.status(400).json({ error: 'maxFoundationalPositions must be an integer from 0 to 10,000; zero means no fixed cap.' });
    }
    const update = database.db.transaction(() => {
      if (foundationalTeamEnabled !== undefined) {
        database.db.prepare(`
          INSERT INTO recruitment_settings (key,value,updated_at)
          VALUES ('foundational_team_enabled',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP
        `).run(String(foundationalTeamEnabled));
      }
      if (maxFoundationalPositions !== undefined) {
        database.db.prepare(`
          INSERT INTO recruitment_settings (key,value,updated_at)
          VALUES ('max_foundational_positions',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP
        `).run(String(maxFoundationalPositions));
      }
    });
    update();
    return res.json(foundationalTeamStats());
  });

  app.get('/api/recruitment/positions', (req, res) => {
    const positions = database.db.prepare("SELECT p.id,p.title,p.department_id,d.name AS department_name,p.description,p.requirements,p.created_at FROM positions p JOIN departments d ON d.id=p.department_id WHERE p.status='open' AND p.is_hiring=1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC").all();
    return res.json({
      positions,
      ...foundationalTeamStats(),
    });
  });

  app.post('/api/recruitment/applications', requireAuth, requireRole('applicant'), (req, res) => {
    const { positionId, applicantPhone, applicationType = 'regular', cvUrl, coverLetter, answers } = req.body || {};
    if (typeof positionId !== 'string' || !positionId) return res.status(400).json({ error: 'positionId is required.' });
    if (typeof applicantPhone !== 'string' || applicantPhone.trim().length < 5 || applicantPhone.trim().length > 40) return res.status(400).json({ error: 'A valid phone number is required.' });
    if (!['regular', 'foundational'].includes(applicationType)) return res.status(400).json({ error: 'applicationType must be regular or foundational.' });
    const foundationalStats = foundationalTeamStats();
    if (applicationType === 'foundational' && !foundationalStats.foundationalTeamAvailable) {
      return res.status(409).json({ error: 'Foundational Team applications are currently closed. Please apply as a Regular Employee.' });
    }
    if (cvUrl !== undefined && (typeof cvUrl !== 'string' || cvUrl.length > 500 || !validContentUrl(cvUrl))) return res.status(400).json({ error: 'cvUrl must be a valid http or https URL.' });
    if (coverLetter !== undefined && (typeof coverLetter !== 'string' || coverLetter.length > 5000)) return res.status(400).json({ error: 'coverLetter must be at most 5,000 characters.' });
    const validatedAnswers = validateApplicationAnswers(answers, applicationType);
    if (validatedAnswers.error) return res.status(400).json({ error: validatedAnswers.error });
    const position = database.db.prepare("SELECT p.id,p.title,d.name AS department_name FROM positions p JOIN departments d ON d.id=p.department_id WHERE p.id=? AND p.status='open' AND p.is_hiring=1").get(positionId);
    if (!position) return res.status(404).json({ error: 'Open position not found' });
    const existing = database.db.prepare('SELECT id,status FROM applications WHERE applicant_id=? AND position_id=?').get(req.user.id, positionId);
    if (existing && existing.status !== 'draft') return res.status(409).json({ error: 'You have already applied for this position' });

    const applicationId = existing?.id || database.generateId();
    const application = {
      id: applicationId,
      application_number: existing?.application_number || `APP-${new Date().getFullYear()}-${applicationId.slice(0, 8).toUpperCase()}`,
      applicant_id: req.user.id,
      position_id: positionId,
      cv_url: cvUrl?.trim() || null,
      cover_letter: coverLetter?.trim() || null,
      status: 'submitted',
      application_type: applicationType,
      applicant_phone: applicantPhone.trim(),
      answers_json: JSON.stringify(validatedAnswers.answers),
    };
    const persist = database.db.transaction(() => {
      if (existing) {
        database.db.prepare(`
          UPDATE applications SET applicant_phone=?,application_type=?,answers_json=?,cv_url=?,cover_letter=?,status='submitted'
          WHERE id=? AND applicant_id=? AND status='draft'
        `).run(applicantPhone.trim(), applicationType, JSON.stringify(validatedAnswers.answers), cvUrl?.trim() || null, coverLetter?.trim() || null, existing.id, req.user.id);
      } else {
        database.db.prepare(`
          INSERT INTO applications (id,application_number,applicant_id,position_id,cv_url,cover_letter,status,application_type,applicant_phone,answers_json)
          VALUES (@id,@application_number,@applicant_id,@position_id,@cv_url,@cover_letter,@status,@application_type,@applicant_phone,@answers_json)
        `).run(application);
      }
      addApplicationTimelineEvent(application.id, 'submitted', 'Application submitted.', { changedBy: req.user.id });
    });
    persist();
    const notificationPromise = sendApplicantNotification(
      req.user.email,
      'ClariCare received your application',
      `Hello ${req.user.name},\n\nWe have received your application ${application.application_number} for ${position.title} in ${position.department_name} as a ${applicationType === 'foundational' ? 'Foundational Team Member' : 'Regular Employee'}.\n\nYou can sign in to your ClariCare applicant portal to follow its progress. We will email you when its status changes.\n\n${applicationType === 'foundational' ? 'The foundational-team opportunity is not guaranteed ownership. Any equity opportunity would be subject to a separate written agreement and its terms.' : ''}\n\nClariCare Botanica Ltd`
    );
    return notificationPromise.then((notification) => {
      addApplicationTimelineEvent(application.id, 'submitted', notification.sent ? 'Application confirmation email sent.' : `Application confirmation email not sent: ${notification.reason}`, { eventType: 'email' });
      const saved = database.db.prepare('SELECT * FROM applications WHERE id=?').get(application.id);
      return res.status(201).json({
        message: 'Application submitted successfully.',
        application: {
          ...saved,
          application_type: saved.application_type,
          answers: parseApplicationAnswers(JSON.parse(saved.answers_json || '{}')),
        },
        notification,
      });
    });
  });

  app.post('/api/recruitment/applications/:id/documents', requireAuth, requireRole('applicant'), express.raw({ type: 'application/octet-stream', limit: '105mb' }), async (req, res) => {
    const application = database.db.prepare('SELECT * FROM applications WHERE id=? AND applicant_id=?').get(req.params.id, req.user.id);
    if (!application || !['draft', 'interview_in_progress'].includes(application.status)) return res.status(404).json({ error: 'Application is unavailable for document upload.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'File data is required.' });
    const documentType = req.get('x-document-type') || '';
    const mimeType = req.get('x-file-type') || '';
    const rawName = req.get('x-file-name') || 'upload';
    let originalName;
    try { originalName = decodeURIComponent(rawName).replace(/[\\/]/g, '_').replace(/[^\w .()-]/g, '_').slice(0, 180); }
    catch (_) { return res.status(400).json({ error: 'File name is invalid.' }); }
    if (!originalName || originalName === '.' || originalName === '..') return res.status(400).json({ error: 'File name is invalid.' });
    const ext = originalName.split('.').pop().toLowerCase();
    const documents = ['cv', 'certificate', 'portfolio', 'reference', 'other'];
    const documentMimes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'];
    const isInterviewAnswer = /^interview-answer-[12]$/.test(documentType);
    const interviewMimes = ['video/webm', 'video/mp4', 'video/quicktime'];
    if (isInterviewAnswer ? !interviewMimes.includes(mimeType) : !documents.includes(documentType) || !documentMimes.includes(mimeType)) {
      return res.status(400).json({ error: 'Only PDF, DOC, DOCX, JPG and PNG documents or MP4/WebM interview answers are accepted.' });
    }
    const isAllowedExtension = isInterviewAnswer
      ? ['webm', 'mp4', 'mov'].includes(ext)
      : ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'].includes(ext);
    if (!isAllowedExtension) return res.status(400).json({ error: 'The file extension does not match an accepted format.' });
    const maxBytes = isInterviewAnswer ? 100 * 1024 * 1024 : 15 * 1024 * 1024;
    if (req.body.length > maxBytes) return res.status(413).json({ error: `File exceeds the ${isInterviewAnswer ? '100 MB' : '15 MB'} limit.` });
    if (isInterviewAnswer) {
      const interview = database.db.prepare("SELECT id,status,consent_at FROM application_interviews WHERE application_id=?").get(application.id);
      if (!interview || interview.status !== 'in_progress' || !interview.consent_at) return res.status(409).json({ error: 'The consented interview must be in progress before video answers are uploaded.' });
    }
    const documentId = database.generateId();
    const storagePath = `applications/${application.id}/${documentId}-${originalName}`;
    try {
      await uploadPrivateRecruitmentFile({ path: storagePath, mimeType, buffer: req.body });
      const document = {
        id: documentId, application_id: application.id, document_type: documentType,
        original_name: originalName, mime_type: mimeType, byte_size: req.body.length,
        storage_path: storagePath, uploaded_by: req.user.id,
      };
      database.db.prepare(`
        INSERT INTO application_documents (id,application_id,document_type,original_name,mime_type,byte_size,storage_path,uploaded_by)
        VALUES (@id,@application_id,@document_type,@original_name,@mime_type,@byte_size,@storage_path,@uploaded_by)
      `).run(document);
      addApplicationTimelineEvent(application.id, application.status, `${isInterviewAnswer ? 'Interview answer' : documentType} uploaded.`, { changedBy: req.user.id, eventType: 'document' });
      if (isInterviewAnswer) {
        const answered = database.db.prepare("SELECT COUNT(DISTINCT document_type) AS count FROM application_documents WHERE application_id=? AND document_type IN ('interview-answer-1','interview-answer-2')").get(application.id).count;
        if (answered === 2) {
          const interview = database.db.prepare("UPDATE application_interviews SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE application_id=? AND status='in_progress'").run(application.id);
          if (interview.changes) {
            database.db.prepare("UPDATE applications SET status='interview_completed' WHERE id=?").run(application.id);
            addApplicationTimelineEvent(application.id, 'interview_completed', 'Online interview completed.', { changedBy: req.user.id, eventType: 'interview' });
          }
        }
      }
      return res.status(201).json({
        document: { id: document.id, type: document.document_type, name: document.original_name, size: document.byte_size, created_at: database.db.prepare('SELECT created_at FROM application_documents WHERE id=?').get(document.id).created_at },
      });
    } catch (error) {
      console.error('Recruitment file upload failed:', error.message);
      return res.status(502).json({ error: error.message || 'The file could not be securely uploaded.' });
    }
  });

  app.post('/api/recruitment/applications/:id/submit', requireAuth, requireRole('applicant'), async (req, res) => {
    const application = database.db.prepare(`
      SELECT a.*,p.title AS position_title,d.name AS department_name
      FROM applications a JOIN positions p ON p.id=a.position_id JOIN departments d ON d.id=p.department_id
      WHERE a.id=? AND a.applicant_id=?
    `).get(req.params.id, req.user.id);
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (application.status !== 'draft') return res.status(409).json({ error: 'This application has already been submitted.' });
    const cv = database.db.prepare("SELECT id FROM application_documents WHERE application_id=? AND document_type='cv'").get(application.id);
    if (!cv) return res.status(400).json({ error: 'Upload your CV or résumé before submitting the application.' });
    const updated = database.db.transaction(() => {
      database.db.prepare("UPDATE applications SET status='submitted' WHERE id=? AND status='draft'").run(application.id);
      addApplicationTimelineEvent(application.id, 'submitted', 'Application submitted.', { changedBy: req.user.id });
    });
    updated();
    const notificationPromise = sendApplicantNotification(
      req.user.email,
      'ClariCare received your application',
      `Hello ${req.user.name},\n\nWe have received your application ${application.application_number} for ${application.position_title} in ${application.department_name} as a ${application.application_type === 'foundational' ? 'Foundational Team Member' : 'Regular Employee'}.\n\nYou can sign in to your ClariCare applicant portal to follow its progress. We will email you when its status changes.\n\n${application.application_type === 'foundational' ? 'The foundational-team opportunity is not guaranteed ownership. Any equity opportunity would be subject to a separate written agreement and its terms.' : ''}\n\nClariCare Botanica Ltd`
    );
    return notificationPromise.then((notification) => {
      addApplicationTimelineEvent(application.id, 'submitted', notification.sent ? 'Application confirmation email sent.' : `Application confirmation email not sent: ${notification.reason}`, { eventType: 'email' });
      const submittedApplication = database.db.prepare('SELECT * FROM applications WHERE id=?').get(application.id);
      return res.json({
        message: 'Application submitted successfully.',
        application: {
          ...submittedApplication,
          application_number: application.application_number,
        },
        notification,
      });
    });
  });

  app.get('/api/dashboard/applicant', requireAuth, requireRole('applicant'), (req, res) => {
    const applications = database.db.prepare('SELECT a.*,p.title AS position_title,d.name AS department_name FROM applications a JOIN positions p ON p.id=a.position_id JOIN departments d ON d.id=p.department_id WHERE a.applicant_id=? ORDER BY a.created_at DESC').all(req.user.id)
      .map((application) => ({
        ...application,
        answers: parseApplicationAnswers(JSON.parse(application.answers_json || '{}')),
        history: database.db.prepare(`
          SELECT status,note,event_type,created_at
          FROM application_status_history
          WHERE application_id=? AND is_private=0 AND event_type IN ('status','interview','attention_flag')
          ORDER BY created_at,id
        `).all(application.id),
        documents: database.db.prepare('SELECT id,document_type,original_name,mime_type,byte_size,created_at FROM application_documents WHERE application_id=? ORDER BY created_at,id').all(application.id),
        interview: database.db.prepare('SELECT id,status,consent_at,started_at,completed_at FROM application_interviews WHERE application_id=?').get(application.id) || null,
      }));
    return res.json({ dashboard: 'applicant', user: sanitizeUser(req.user), applications });
  });

  app.get('/api/recruitment/applications', requireAuth, requireRole('admin'), (req, res) => {
    const applications = database.db.prepare(`
      SELECT a.*,u.name AS applicant_name,u.email AS applicant_email,p.title AS position_title,d.name AS department_name
      FROM applications a JOIN users u ON u.id=a.applicant_id
      JOIN positions p ON p.id=a.position_id JOIN departments d ON d.id=p.department_id
      ORDER BY a.created_at DESC
    `).all().map((application) => ({
      ...application,
      answers: parseApplicationAnswers(JSON.parse(application.answers_json || '{}')),
      documents: database.db.prepare('SELECT id,document_type,original_name,mime_type,byte_size,created_at FROM application_documents WHERE application_id=? ORDER BY created_at,id').all(application.id),
      history: database.db.prepare(`
        SELECT status,note,event_type,created_at,is_private
        FROM application_status_history
        WHERE application_id=? AND (is_private=0 OR event_type IN ('hr_review','ceo_review'))
        ORDER BY created_at,id
      `).all(application.id),
      hrNotes: database.db.prepare('SELECT n.id,n.note,n.created_at,u.name AS author_name FROM application_hr_notes n JOIN users u ON u.id=n.author_id WHERE n.application_id=? ORDER BY n.created_at DESC').all(application.id),
      interview: database.db.prepare('SELECT id,status,consent_at,started_at,completed_at FROM application_interviews WHERE application_id=?').get(application.id) || null,
      attentionEvents: database.db.prepare('SELECT e.question_number,e.event_type,e.duration_ms,e.details,e.created_at FROM application_interview_events e JOIN application_interviews i ON i.id=e.interview_id WHERE i.application_id=? ORDER BY e.created_at,e.id').all(application.id),
    }));
    return res.json({ applications });
  });

  app.patch('/api/recruitment/applications/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const { status, note = '', hrRecommendation, ceoDecision, ceoNote } = req.body || {};
    const allowedStatuses = ['submitted', 'under_review', 'reviewing', 'shortlisted', 'interview', 'interview_in_progress', 'interview_completed', 'hr_review', 'ceo_review', 'accepted', 'rejected', 'withdrawn'];
    if (status !== undefined && !allowedStatuses.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}.` });
    if (status === undefined && hrRecommendation === undefined && ceoDecision === undefined && ceoNote === undefined) return res.status(400).json({ error: 'Provide a status, HR recommendation, or CEO review update.' });
    if (hrRecommendation !== undefined && !['reject', 'continue_review', 'recommend', 'request_ceo_review'].includes(hrRecommendation)) return res.status(400).json({ error: 'hrRecommendation must be reject, continue_review, recommend, or request_ceo_review.' });
    if (ceoDecision !== undefined && !['approve', 'reject', 'request_more_information'].includes(ceoDecision)) return res.status(400).json({ error: 'ceoDecision must be approve, reject, or request_more_information.' });
    if (ceoNote !== undefined && (typeof ceoNote !== 'string' || ceoNote.trim().length > 5000)) return res.status(400).json({ error: 'ceoNote must be text of at most 5,000 characters.' });
    if (typeof note !== 'string' || note.length > 2000) return res.status(400).json({ error: 'note must be text of at most 2,000 characters.' });
    const current = database.db.prepare(`
      SELECT a.*,u.name AS applicant_name,u.email AS applicant_email,p.title AS position_title
      FROM applications a JOIN users u ON u.id=a.applicant_id JOIN positions p ON p.id=a.position_id
      WHERE a.id=?
    `).get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Application not found.' });
    if (status !== undefined && current.status === status && hrRecommendation === undefined && ceoDecision === undefined && ceoNote === undefined) return res.status(409).json({ error: 'The application already has this status.' });
    const updateApplication = database.db.transaction(() => {
      if (status !== undefined) {
        database.db.prepare('UPDATE applications SET status=? WHERE id=?').run(status, current.id);
        addApplicationTimelineEvent(current.id, status, note.trim() || `Application status changed to ${status.replaceAll('_', ' ')}.`, { changedBy: req.user.id });
      }
      if (hrRecommendation !== undefined) {
        database.db.prepare('UPDATE applications SET hr_recommendation=? WHERE id=?').run(hrRecommendation, current.id);
        addApplicationTimelineEvent(current.id, current.status, `HR recommendation recorded: ${hrRecommendation.replaceAll('_', ' ')}.`, { changedBy: req.user.id, isPrivate: true, eventType: 'hr_review' });
      }
      if (ceoDecision !== undefined || ceoNote !== undefined) {
        database.db.prepare('UPDATE applications SET ceo_decision=COALESCE(?,ceo_decision),ceo_note=COALESCE(?,ceo_note) WHERE id=?')
          .run(ceoDecision || null, ceoNote === undefined ? null : ceoNote.trim(), current.id);
        addApplicationTimelineEvent(current.id, current.status, `CEO review updated${ceoDecision ? `: ${ceoDecision.replaceAll('_', ' ')}` : ''}.`, { changedBy: req.user.id, isPrivate: true, eventType: 'ceo_review' });
      }
    });
    updateApplication();
    if (status === undefined) return res.json({ application: database.db.prepare('SELECT * FROM applications WHERE id=?').get(current.id) });
    let subject = 'Your ClariCare application status has changed';
    let emailText = `Hello ${current.applicant_name},\n\nThe status of your application for ${current.position_title} has changed to: ${status.replaceAll('_', ' ')}.${note.trim() ? `\n\nMessage from ClariCare:\n${note.trim()}` : ''}\n\nSign in to your ClariCare applicant portal to view your application progress.\n\nClariCare Botanica Ltd`;
    if (status === 'accepted') {
      subject = 'An update on your ClariCare application';
      emailText = current.application_type === 'foundational'
        ? `Hello ${current.applicant_name},\n\nCongratulations. We are pleased to inform you that your application has been accepted for consideration as a Foundational Team Member.\n\nYour Foundational Team participation and any potential equity interest will be governed by a separate written agreement. Any potential 8% equity interest is conditional, earned over the agreed period, and is not an immediate grant of ownership. Further instructions will be provided separately.\n\nClariCare Botanica Ltd`
        : `Hello ${current.applicant_name},\n\nCongratulations. We are pleased to inform you that your application has been successful. Our team will contact you with the next steps regarding employment and onboarding.\n\nClariCare Botanica Ltd`;
    } else if (status === 'rejected') {
      subject = 'An update on your ClariCare application';
      emailText = `Hello ${current.applicant_name},\n\nThank you for taking the time to apply and participate in our recruitment process. After reviewing your application, we have decided not to proceed with your application at this stage. We appreciate your interest in joining ClariCare and wish you the very best in your future opportunities.\n\nClariCare Botanica Ltd`;
    }
    const notification = await sendApplicantNotification(
      current.applicant_email,
      subject,
      emailText
    );
    addApplicationTimelineEvent(current.id, status, notification.sent ? `${subject} email sent.` : `${subject} email not sent: ${notification.reason}`, { eventType: 'email' });
    const application = database.db.prepare('SELECT * FROM applications WHERE id=?').get(current.id);
    return res.json({ application, notification });
  });

  app.get('/api/recruitment/questions', requireAuth, requireRole('admin'), (req, res) => {
    const questions = database.db.prepare(`
      SELECT q.*,d.name AS department_name FROM application_interview_questions q
      JOIN departments d ON d.id=q.department_id
      ORDER BY d.name COLLATE NOCASE,q.question_number
    `).all().map((question) => ({
      ...question,
      critical: Boolean(question.critical),
      active: Boolean(question.active),
    }));
    return res.json({ questions });
  });

  app.post('/api/recruitment/questions', requireAuth, requireRole('admin'), (req, res) => {
    const { departmentId, questionNumber, prompt, prepSeconds = 30, answerSeconds = 180, critical = true } = req.body || {};
    const department = database.db.prepare('SELECT id FROM departments WHERE id=?').get(departmentId);
    if (!department) return res.status(404).json({ error: 'Department not found.' });
    if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > 20) return res.status(400).json({ error: 'questionNumber must be an integer from 1 to 20.' });
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 2000) return res.status(400).json({ error: 'prompt must be between 1 and 2,000 characters.' });
    if (!Number.isInteger(prepSeconds) || prepSeconds < 0 || prepSeconds > 600 || !Number.isInteger(answerSeconds) || answerSeconds < 30 || answerSeconds > 1800) {
      return res.status(400).json({ error: 'Preparation must be 0–600 seconds and answer time 30–1,800 seconds.' });
    }
    if (typeof critical !== 'boolean') return res.status(400).json({ error: 'critical must be true or false.' });
    const question = {
      id: database.generateId(), department_id: departmentId, question_number: questionNumber,
      prompt: prompt.trim(), prep_seconds: prepSeconds, answer_seconds: answerSeconds,
      critical: critical ? 1 : 0, active: 1,
    };
    try {
      database.db.prepare(`
        INSERT INTO application_interview_questions
          (id,department_id,question_number,prompt,prep_seconds,answer_seconds,critical,active)
        VALUES (@id,@department_id,@question_number,@prompt,@prep_seconds,@answer_seconds,@critical,@active)
      `).run(question);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That question number is already used in the department.' });
      throw error;
    }
    return res.status(201).json({ question });
  });

  app.patch('/api/recruitment/questions/:id', requireAuth, requireRole('admin'), (req, res) => {
    const current = database.db.prepare('SELECT * FROM application_interview_questions WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Interview question not found.' });
    const { departmentId = current.department_id, questionNumber = current.question_number, prompt = current.prompt,
      prepSeconds = current.prep_seconds, answerSeconds = current.answer_seconds, critical = Boolean(current.critical), active = Boolean(current.active) } = req.body || {};
    if (!database.db.prepare('SELECT id FROM departments WHERE id=?').get(departmentId)) return res.status(404).json({ error: 'Department not found.' });
    if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > 20) return res.status(400).json({ error: 'questionNumber must be an integer from 1 to 20.' });
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 2000) return res.status(400).json({ error: 'prompt must be between 1 and 2,000 characters.' });
    if (!Number.isInteger(prepSeconds) || prepSeconds < 0 || prepSeconds > 600 || !Number.isInteger(answerSeconds) || answerSeconds < 30 || answerSeconds > 1800) return res.status(400).json({ error: 'Preparation must be 0–600 seconds and answer time 30–1,800 seconds.' });
    if (typeof critical !== 'boolean' || typeof active !== 'boolean') return res.status(400).json({ error: 'critical and active must be true or false.' });
    try {
      database.db.prepare(`
        UPDATE application_interview_questions
        SET department_id=?,question_number=?,prompt=?,prep_seconds=?,answer_seconds=?,critical=?,active=?
        WHERE id=?
      `).run(departmentId, questionNumber, prompt.trim(), prepSeconds, answerSeconds, critical ? 1 : 0, active ? 1 : 0, current.id);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That question number is already used in the department.' });
      throw error;
    }
    return res.json({ question: database.db.prepare('SELECT * FROM application_interview_questions WHERE id=?').get(current.id) });
  });

  app.post('/api/recruitment/applications/:id/interview-invite', requireAuth, requireRole('admin'), async (req, res) => {
    const application = database.db.prepare(`
      SELECT a.*,u.name AS applicant_name,u.email AS applicant_email,p.title AS position_title,d.id AS department_id,d.name AS department_name
      FROM applications a JOIN users u ON u.id=a.applicant_id
      JOIN positions p ON p.id=a.position_id JOIN departments d ON d.id=p.department_id WHERE a.id=?
    `).get(req.params.id);
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (application.status !== 'shortlisted') return res.status(409).json({ error: 'Only shortlisted applicants can be invited to interview.' });
    const questions = database.db.prepare('SELECT id FROM application_interview_questions WHERE department_id=? AND critical=1 AND active=1 ORDER BY question_number LIMIT 2').all(application.department_id);
    if (questions.length < 2) return res.status(409).json({ error: 'At least two active critical interview questions are required for this department.' });
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const interviewId = database.generateId();
    database.db.prepare(`
      INSERT INTO application_interviews (id,application_id,invitation_token_hash,token_expires_at,status)
      VALUES (?,?,?,?,'invited')
      ON CONFLICT(application_id) DO UPDATE SET invitation_token_hash=excluded.invitation_token_hash,
        token_expires_at=excluded.token_expires_at,status='invited',consent_at=NULL,camera_test_json='{}',started_at=NULL,completed_at=NULL
    `).run(interviewId, application.id, tokenHash, expiresAt);
    database.db.prepare("UPDATE applications SET status='interview_invited' WHERE id=?").run(application.id);
    addApplicationTimelineEvent(application.id, 'interview_invited', 'Online interview invitation sent.', { changedBy: req.user.id, eventType: 'interview' });
    const frontendUrl = (process.env.FRONTEND_URL || 'https://claricarebotanica.com').replace(/\/+$/, '');
    const interviewUrl = `${frontendUrl}/applicant?applicationId=${encodeURIComponent(application.id)}&interviewToken=${encodeURIComponent(token)}`;
    const notification = await sendApplicantNotification(
      application.applicant_email,
      'You have been invited to complete a ClariCare online interview',
      `Hello ${application.applicant_name},\n\nYou have been invited to complete the online interview for ${application.position_title}. Sign in to your applicant portal and open this secure invitation link:\n${interviewUrl}\n\nThe link expires in 7 days. Before recording, you will review the consent information and test your camera and microphone. The two recorded answers are final after submission. Camera attention or technical events are review flags only and will not automatically reject your application.\n\nClariCare Botanica Ltd`
    );
    addApplicationTimelineEvent(application.id, 'interview_invited', notification.sent ? 'Interview invitation email sent.' : `Interview invitation email not sent: ${notification.reason}`, { eventType: 'email' });
    return res.json({ interviewId, notification });
  });

  app.get('/api/recruitment/applications/:id/interview', requireAuth, requireRole('applicant'), (req, res) => {
    const application = database.db.prepare('SELECT id,applicant_id,status FROM applications WHERE id=? AND applicant_id=?').get(req.params.id, req.user.id);
    if (!application) return res.status(404).json({ error: 'Interview not found.' });
    const token = req.query.token;
    if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'A valid interview invitation token is required.' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const interview = database.db.prepare('SELECT * FROM application_interviews WHERE application_id=?').get(application.id);
    if (!interview || interview.invitation_token_hash !== tokenHash || !interview.token_expires_at || Date.parse(interview.token_expires_at) <= Date.now()) {
      return res.status(403).json({ error: 'This interview link is invalid or has expired.' });
    }
    const questions = database.db.prepare(`
      SELECT q.question_number,q.prompt,q.prep_seconds,q.answer_seconds
      FROM application_interview_questions q
      JOIN positions p ON p.department_id=q.department_id
      JOIN applications a ON a.position_id=p.id
      WHERE a.id=? AND q.active=1 AND q.critical=1
      ORDER BY q.question_number LIMIT 2
    `).all(application.id);
    if (questions.length < 2) return res.status(409).json({ error: 'The interview question set is unavailable. Contact ClariCare recruitment.' });
    const answers = database.db.prepare("SELECT document_type FROM application_documents WHERE application_id=? AND document_type IN ('interview-answer-1','interview-answer-2')").all(application.id).map((item) => item.document_type);
    return res.json({
      interview: {
        id: interview.id,
        status: interview.status,
        consentAt: interview.consent_at,
        startedAt: interview.started_at,
        completedAt: interview.completed_at,
        cameraTest: JSON.parse(interview.camera_test_json || '{}'),
      },
      questions,
      submittedAnswers: answers,
    });
  });

  app.post('/api/recruitment/applications/:id/interview/start', requireAuth, requireRole('applicant'), (req, res) => {
    const { token, consent, cameraReady, microphoneReady } = req.body || {};
    if (consent !== true) return res.status(400).json({ error: 'You must consent to the interview recording before starting.' });
    if (cameraReady !== true || microphoneReady !== true) return res.status(400).json({ error: 'Test and enable both camera and microphone before starting.' });
    const tokenHash = typeof token === 'string' ? crypto.createHash('sha256').update(token).digest('hex') : '';
    const interview = database.db.prepare(`
      SELECT i.*,a.applicant_id FROM application_interviews i JOIN applications a ON a.id=i.application_id
      WHERE i.application_id=? AND a.applicant_id=?
    `).get(req.params.id, req.user.id);
    if (!interview || interview.invitation_token_hash !== tokenHash || Date.parse(interview.token_expires_at || '') <= Date.now()) return res.status(403).json({ error: 'This interview link is invalid or has expired.' });
    if (!['invited', 'in_progress'].includes(interview.status)) return res.status(409).json({ error: 'This interview is no longer available.' });
    const cameraTest = { cameraReady: true, microphoneReady: true, testedAt: new Date().toISOString() };
    database.db.prepare(`
      UPDATE application_interviews SET status='in_progress',consent_at=COALESCE(consent_at,CURRENT_TIMESTAMP),
        camera_test_json=?,started_at=COALESCE(started_at,CURRENT_TIMESTAMP) WHERE id=?
    `).run(JSON.stringify(cameraTest), interview.id);
    database.db.prepare("UPDATE applications SET status='interview_in_progress' WHERE id=?").run(req.params.id);
    addApplicationTimelineEvent(req.params.id, 'interview_in_progress', 'Applicant consented and started the online interview.', { changedBy: req.user.id, eventType: 'interview' });
    return res.json({ message: 'Interview started.', cameraTest });
  });

  app.post('/api/recruitment/applications/:id/interview/events', requireAuth, requireRole('applicant'), (req, res) => {
    const { token, questionNumber, eventType, durationMs = 0, details = '' } = req.body || {};
    const allowedEvents = ['tab_hidden', 'camera_disconnected', 'microphone_disconnected', 'face_not_visible', 'face_multiple_visible', 'recording_interrupted'];
    if (!allowedEvents.includes(eventType)) return res.status(400).json({ error: 'Unsupported interview event.' });
    if (questionNumber !== null && questionNumber !== undefined && ![1, 2].includes(questionNumber)) return res.status(400).json({ error: 'questionNumber must be 1 or 2.' });
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 1800000) return res.status(400).json({ error: 'durationMs is outside the allowed range.' });
    if (typeof details !== 'string' || details.length > 300) return res.status(400).json({ error: 'details must be at most 300 characters.' });
    const tokenHash = typeof token === 'string' ? crypto.createHash('sha256').update(token).digest('hex') : '';
    const interview = database.db.prepare(`
      SELECT i.* FROM application_interviews i JOIN applications a ON a.id=i.application_id
      WHERE i.application_id=? AND a.applicant_id=?
    `).get(req.params.id, req.user.id);
    if (!interview || interview.invitation_token_hash !== tokenHash || interview.status !== 'in_progress') return res.status(403).json({ error: 'Interview is not active.' });
    const count = database.db.prepare('SELECT COUNT(*) AS count FROM application_interview_events WHERE interview_id=?').get(interview.id).count;
    if (count >= 100) return res.status(429).json({ error: 'The interview event limit has been reached.' });
    database.db.prepare(`
      INSERT INTO application_interview_events (id,interview_id,question_number,event_type,duration_ms,details)
      VALUES (?,?,?,?,?,?)
    `).run(database.generateId(), interview.id, questionNumber || null, eventType, durationMs, details.trim());
    addApplicationTimelineEvent(req.params.id, 'interview_in_progress', `Interview review flag recorded: ${eventType.replaceAll('_', ' ')}.`, { changedBy: req.user.id, isPrivate: true, eventType: 'attention_flag' });
    return res.status(201).json({ recorded: true, reviewFlag: true });
  });

  app.post('/api/recruitment/applications/:id/hr-notes', requireAuth, requireRole('admin'), (req, res) => {
    const note = req.body?.note;
    if (typeof note !== 'string' || !note.trim() || note.trim().length > 5000) return res.status(400).json({ error: 'A private HR note of 1 to 5,000 characters is required.' });
    const exists = database.db.prepare('SELECT id,status FROM applications WHERE id=?').get(req.params.id);
    if (!exists) return res.status(404).json({ error: 'Application not found.' });
    const id = database.generateId();
    database.db.prepare('INSERT INTO application_hr_notes (id,application_id,author_id,note) VALUES (?,?,?,?)').run(id, exists.id, req.user.id, note.trim());
    addApplicationTimelineEvent(exists.id, exists.status, 'Private HR note added.', { changedBy: req.user.id, isPrivate: true, eventType: 'private_note' });
    return res.status(201).json({ note: database.db.prepare('SELECT id,note,created_at FROM application_hr_notes WHERE id=?').get(id) });
  });

  app.get('/api/recruitment/applications/:id/documents', requireAuth, (req, res) => {
    const application = database.db.prepare('SELECT id,applicant_id FROM applications WHERE id=?').get(req.params.id);
    if (!application || (req.user.role !== 'admin' && (req.user.role !== 'applicant' || req.user.id !== application.applicant_id))) {
      return res.status(404).json({ error: 'Application not found.' });
    }
    const documents = database.db.prepare('SELECT id,document_type,original_name,mime_type,byte_size,created_at FROM application_documents WHERE application_id=? ORDER BY created_at,id').all(application.id);
    return res.json({ documents });
  });

  app.get('/api/recruitment/applications/:id/documents/:documentId/url', requireAuth, async (req, res) => {
    const document = database.db.prepare(`
      SELECT d.*,a.applicant_id FROM application_documents d JOIN applications a ON a.id=d.application_id
      WHERE d.id=? AND a.id=?
    `).get(req.params.documentId, req.params.id);
    if (!document || (req.user.role !== 'admin' && (req.user.role !== 'applicant' || req.user.id !== document.applicant_id))) {
      return res.status(404).json({ error: 'Document not found.' });
    }
    try {
      return res.json({ url: await signPrivateRecruitmentUrl(document.storage_path), expiresInSeconds: 600 });
    } catch (error) {
      return res.status(503).json({ error: error.message });
    }
  });

  app.post('/api/catalog/products', (req, res) => {
    const { name, category, description = '', price, brand = '', howToUse = '', ingredients = '', benefits = '' } = req.body || {};
    const imageUrl = req.body?.imageUrl ?? req.body?.image ?? null;
    const rawSizeOptions = req.body?.sizeOptions ?? [];

    if (typeof name !== 'string' || !name.trim() || typeof category !== 'string' || !category.trim()) {
      return res.status(400).json({ error: 'Product name and category are required' });
    }
    const normalizedPrice = Number(price ?? 0);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice < 0) {
      return res.status(400).json({ error: 'Product price must be zero or a positive number' });
    }
    if (!Array.isArray(rawSizeOptions) || rawSizeOptions.length > 30) {
      return res.status(400).json({ error: 'sizeOptions must be a list of at most 30 size and price options' });
    }
    const sizeOptions = [];
    const seenLabels = new Set();
    for (const option of rawSizeOptions) {
      const label = typeof option?.label === 'string' ? option.label.trim() : '';
      const optionPrice = Number(option?.price);
      if (!label || label.length > 80 || !Number.isFinite(optionPrice) || optionPrice <= 0) {
        return res.status(400).json({ error: 'Each size option needs a label (up to 80 characters) and a positive price' });
      }
      const normalizedLabel = label.toLocaleLowerCase();
      if (seenLabels.has(normalizedLabel)) {
        return res.status(400).json({ error: 'Size option labels must be unique' });
      }
      seenLabels.add(normalizedLabel);
      sizeOptions.push({ label, price: optionPrice });
    }
    for (const [field, value] of Object.entries({ description, brand, howToUse, ingredients, benefits })) {
      if (typeof value !== 'string' || value.length > 10000) {
        return res.status(400).json({ error: `${field} must be text no longer than 10,000 characters` });
      }
    }
    if (typeof imageUrl === 'string' && imageUrl) {
      const inlineImage = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageUrl);
      let remoteImage = false;
      try { remoteImage = ['http:', 'https:'].includes(new URL(imageUrl).protocol); } catch (_) { /* Not a URL. */ }
      if (!inlineImage && !remoteImage) return res.status(400).json({ error: 'Product image must be a PNG, JPEG or WebP image or a valid HTTP(S) image URL.' });
      if (inlineImage && Buffer.from(inlineImage[2], 'base64').byteLength > MAX_INLINE_IMAGE_BYTES) {
        return res.status(413).json({ error: 'Product image must be 10 MB or smaller.' });
      }
      if (!inlineImage && imageUrl.length > MAX_IMAGE_URL_LENGTH) {
        return res.status(413).json({ error: 'Product image URL must be 2,048 characters or shorter.' });
      }
    } else if (imageUrl !== null && imageUrl !== '') {
      return res.status(400).json({ error: 'imageUrl must be a valid image URL or encoded image.' });
    }

    const product = database.createProduct({
      name: name.trim(),
      category: category.trim(),
      description: description.trim(),
      price: sizeOptions.length ? sizeOptions[0].price : normalizedPrice,
      imageUrl: imageUrl || null,
      sizeOptions,
      brand: brand.trim(),
      howToUse: howToUse.trim(),
      ingredients: ingredients.trim(),
      benefits: benefits.trim(),
    });
    return res.status(201).json({ message: 'Product created successfully', product: productForApi(product) });
  });

  app.get('/api/catalog/products/:productId', (req, res) => {
    const product = database.getProductById(req.params.productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const summary = database.getProductSummary(product.id);
    return res.json({
      product: productForApi(product),
      reviews: summary.reviews,
      averageRating: summary.averageRating,
      totalReviews: summary.totalReviews,
    });
  });

  const guardAdminWhenPresent = (req, res, next) => {
    const adminExists = database.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND deleted_at IS NULL").get().count > 0;
    if (!adminExists) return next();
    return requireAuth(req, res, () => requireRole('admin')(req, res, next));
  };

  app.post('/api/agreements', guardAdminWhenPresent, (req, res) => {
    const { employeeId, type, title, content, templateKey } = req.body || {};
    if (!employeeId || typeof type !== 'string' || !type.trim() || type.length > 80) {
      return res.status(400).json({ error: 'A user ID and agreement type are required' });
    }

    const user = database.db.prepare("SELECT * FROM users WHERE id=? AND role IN ('employee','referrer') AND deleted_at IS NULL").get(employeeId);
    if (!user) return res.status(404).json({ error: 'Active employee or referrer not found' });
    if (title !== undefined && (typeof title !== 'string' || title.trim().length > 200)) return res.status(400).json({ error: 'title must be at most 200 characters' });
    if (templateKey && (templateKey !== 'employee-team-participation' || user.role !== 'employee')) {
      return res.status(400).json({ error: 'This agreement template is available only for employee agreements.' });
    }
    const agreementContent = templateKey === 'employee-team-participation' ? employeeAgreementTemplate : content;
    if (typeof agreementContent !== 'string' || !agreementContent.trim() || agreementContent.length > 50000) {
      return res.status(400).json({ error: 'Agreement content of up to 50,000 characters is required' });
    }

    const agreement = database.createAgreement({
      employeeId,
      type: templateKey === 'employee-team-participation' ? 'employee-team-participation' : type.trim(),
      title: templateKey === 'employee-team-participation'
        ? 'Team Participation, Conditional Equity and Contribution Agreement'
        : title?.trim() || `${type.trim()} Agreement`,
      content: agreementContent.trim(),
      status: 'pending_signature',
      fillableFields: templateKey === 'employee-team-participation' ? employeeAgreementFields : [],
    });
    return res.status(201).json({ message: 'Agreement created and assigned for signature.', agreement: agreementForApi(agreement) });
  });

  app.get('/api/agreements/mine', requireAuth, (req, res) => {
    if (!['employee', 'referrer'].includes(req.user.role)) return res.status(403).json({ error: 'Only employees and referrers have assigned agreements.' });
    const agreements = database.db.prepare('SELECT * FROM agreements WHERE employee_id=? ORDER BY created_at DESC').all(req.user.id);
    return res.json({ agreements: agreements.map(agreementForApi) });
  });

  app.get('/api/agreements/:id', requireAuth, (req, res) => {
    const agreement = database.getAgreement(req.params.id);
    if (!agreement || (req.user.role !== 'admin' && agreement.employee_id !== req.user.id)) return res.status(404).json({ error: 'Agreement not found' });
    return res.json({ agreement: agreementForApi(agreement) });
  });

  app.post('/api/agreements/:id/sign', requireAuth, requireRole('employee', 'referrer'), (req, res) => {
    const agreement = database.getAgreement(req.params.id);
    if (!agreement || agreement.employee_id !== req.user.id) return res.status(404).json({ error: 'Agreement not found' });
    if (agreement.status !== 'pending_signature') return res.status(409).json({ error: 'This agreement is not awaiting your signature.' });
    const signature = validateElectronicSignature(req.body || {});
    if (signature.error) return res.status(400).json({ error: signature.error });
    const fillableFields = JSON.parse(agreement.fillable_fields || '[]');
    let filledContent = agreement.content;
    if (fillableFields.length) {
      if (agreement.type !== 'employee-team-participation' || req.user.role !== 'employee') {
        return res.status(409).json({ error: 'This agreement has unsupported fillable fields. Contact an administrator.' });
      }
      const validatedFields = validateAgreementFields(req.body?.fields);
      if (validatedFields.error) return res.status(400).json({ error: validatedFields.error });
      filledContent = renderEmployeeAgreement(validatedFields.fields, signature.name);
    }
    const result = database.db.prepare(`
      UPDATE agreements SET status='signed',signed_by=?,signature_data=?,signed_at=CURRENT_TIMESTAMP,content=?,fillable_fields='[]'
      WHERE id=? AND employee_id=? AND status='pending_signature'
    `).run(signature.name, signature.data, filledContent, agreement.id, req.user.id);
    if (!result.changes) return res.status(409).json({ error: 'This agreement has already been signed or is no longer awaiting signature.' });
    return res.json({ message: 'Agreement signed successfully.', agreement: agreementForApi(database.getAgreement(agreement.id)) });
  });

  app.get('/api/catalog/products', (req, res) => {
    const products = database.db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
    const enriched = products.map((product) => ({
      ...productForApi(product),
      ...database.getProductSummary(product.id),
    }));

    return res.json({ products: enriched });
  });

  app.get('/api/updates', (req, res) => {
    const updates = database.db.prepare('SELECT id,title,body,created_at,updated_at FROM company_updates WHERE published=1 AND deleted_at IS NULL ORDER BY created_at DESC').all();
    return res.json({ updates });
  });

  app.post('/api/admin/updates', requireAuth, requireRole('admin'), (req, res) => {
    const { title, body, published = true } = req.body || {};
    if (!title || !body || String(title).length > 200 || String(body).length > 20000 || typeof published !== 'boolean') return res.status(400).json({ error: 'title, body and boolean published are required' });
    const update = { id: database.generateId(), title: String(title).trim(), body: String(body).trim(), published: published ? 1 : 0, created_by: req.user.id };
    database.db.prepare('INSERT INTO company_updates (id,title,body,published,created_by) VALUES (@id,@title,@body,@published,@created_by)').run(update);
    return res.status(201).json({ update });
  });

  app.patch('/api/admin/updates/:id', requireAuth, requireRole('admin'), (req, res) => {
    const existing = database.db.prepare('SELECT * FROM company_updates WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Update not found' });
    const title = req.body.title === undefined ? existing.title : String(req.body.title).trim();
    const body = req.body.body === undefined ? existing.body : String(req.body.body).trim();
    const published = req.body.published === undefined ? existing.published : req.body.published === true ? 1 : req.body.published === false ? 0 : null;
    if (!title || !body || title.length > 200 || body.length > 20000 || published === null) return res.status(400).json({ error: 'title and body are required and published must be boolean' });
    database.db.prepare('UPDATE company_updates SET title=?,body=?,published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title, body, published, req.params.id);
    return res.json({ update: database.db.prepare('SELECT * FROM company_updates WHERE id=?').get(req.params.id) });
  });

  app.delete('/api/admin/updates/:id', requireAuth, requireRole('admin'), (req, res) => {
    const result = database.db.prepare('UPDATE company_updates SET deleted_at=CURRENT_TIMESTAMP,published=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Update not found' });
    return res.json({ message: 'Update moved to Bin' });
  });

  app.get('/api/content', (req, res) => {
    const { type } = req.query;
    if (type && !['blog', 'news', 'video'].includes(type)) return res.status(400).json({ error: 'type must be blog, news or video' });
    const posts = type
      ? database.db.prepare("SELECT id,title,slug,type,excerpt,cover_image_url,video_url,published_at FROM content_posts WHERE status='published' AND deleted_at IS NULL AND type=? ORDER BY published_at DESC").all(type)
      : database.db.prepare("SELECT id,title,slug,type,excerpt,cover_image_url,video_url,published_at FROM content_posts WHERE status='published' AND deleted_at IS NULL ORDER BY published_at DESC").all();
    return res.json({ posts });
  });

  app.post('/api/updates/subscribe', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address' });
    if (req.body?.consent !== true) return res.status(400).json({ error: 'Please confirm you want to receive ClariCare news by email' });
    const existing = database.db.prepare('SELECT id FROM newsletter_subscribers WHERE email=?').get(email);
    if (existing) {
      database.db.prepare('UPDATE newsletter_subscribers SET active=1,unsubscribed_at=NULL WHERE id=?').run(existing.id);
      return res.json({ message: 'Subscription confirmed' });
    }
    database.db.prepare('INSERT INTO newsletter_subscribers (id,email) VALUES (?,?)').run(database.generateId(), email);
    return res.status(201).json({ message: 'Subscription confirmed' });
  });

  app.get('/api/content/:slug', (req, res) => {
    const post = database.db.prepare("SELECT id,title,slug,type,excerpt,body,cover_image_url,video_url,published_at FROM content_posts WHERE slug=? AND status='published' AND deleted_at IS NULL").get(req.params.slug);
    if (!post) return res.status(404).json({ error: 'Published content not found' });
    return res.json({ post });
  });

  app.get('/api/admin/content', requireAuth, requireRole('employee'), (req, res) => {
    const { status } = req.query;
    if (status && !['draft', 'published', 'archived'].includes(status)) return res.status(400).json({ error: 'status must be draft, published or archived' });
    const posts = status
      ? database.db.prepare('SELECT * FROM content_posts WHERE status=? ORDER BY updated_at DESC').all(status)
      : database.db.prepare('SELECT * FROM content_posts ORDER BY updated_at DESC').all();
    return res.json({ posts });
  });

  app.get('/api/admin/content/:id', requireAuth, requireRole('employee'), (req, res) => {
    const post = database.db.prepare('SELECT * FROM content_posts WHERE id=?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Content not found' });
    return res.json({ post });
  });

  app.post('/api/admin/content', requireAuth, requireRole('employee'), async (req, res) => {
    const validated = validateContent(req.body || {});
    if (validated.error) return res.status(400).json({ error: validated.error });
    const { title, slug, type, excerpt, body } = validated.values;
    const { status = 'draft', coverImageUrl, videoUrl } = req.body;
    if (!['draft', 'published'].includes(status)) return res.status(400).json({ error: 'status must be draft or published when creating content' });
    const record = {
      id: database.generateId(), title, slug, type, excerpt: excerpt || '', body: body || '',
      cover_image_url: coverImageUrl || null, video_url: videoUrl || null, status,
      author_id: req.user.id,
      published_at: status === 'published' ? new Date().toISOString() : null,
    };
    try {
      database.db.prepare('INSERT INTO content_posts (id,title,slug,type,excerpt,body,cover_image_url,video_url,status,author_id,published_at) VALUES (@id,@title,@slug,@type,@excerpt,@body,@cover_image_url,@video_url,@status,@author_id,@published_at)').run(record);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That slug is already in use' });
      throw error;
    }
    const post = database.db.prepare('SELECT * FROM content_posts WHERE id=?').get(record.id);
    const notification = status === 'published' && type === 'news' ? await emailNewsSubscribers(post) : null;
    return res.status(201).json({ post, ...(notification || {}) });
  });

  app.patch('/api/admin/content/:id', requireAuth, requireRole('employee'), (req, res) => {
    const existing = database.db.prepare('SELECT * FROM content_posts WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Content not found' });
    if (existing.status === 'archived') return res.status(409).json({ error: 'Archived content cannot be edited' });
    const data = req.body || {};
    const merged = {
      title: data.title ?? existing.title, slug: data.slug ?? existing.slug, type: data.type ?? existing.type,
      excerpt: data.excerpt ?? existing.excerpt, body: data.body ?? existing.body,
      coverImageUrl: Object.hasOwn(data, 'coverImageUrl') ? data.coverImageUrl : existing.cover_image_url,
      videoUrl: Object.hasOwn(data, 'videoUrl') ? data.videoUrl : existing.video_url,
    };
    const validated = validateContent(merged);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const { title, slug, type, excerpt, body } = validated.values;
    try {
      database.db.prepare('UPDATE content_posts SET title=?,slug=?,type=?,excerpt=?,body=?,cover_image_url=?,video_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(title, slug, type, excerpt || '', body || '', merged.coverImageUrl || null, merged.videoUrl || null, existing.id);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That slug is already in use' });
      throw error;
    }
    return res.json({ post: database.db.prepare('SELECT * FROM content_posts WHERE id=?').get(existing.id) });
  });

  app.post('/api/admin/content/:id/publish', requireAuth, requireRole('employee'), async (req, res) => {
    const post = database.db.prepare('SELECT * FROM content_posts WHERE id=?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Content not found' });
    if (post.status === 'archived') return res.status(409).json({ error: 'Archived content cannot be published' });
    const validated = validateContent({ ...post, coverImageUrl: post.cover_image_url, videoUrl: post.video_url });
    if (validated.error) return res.status(400).json({ error: validated.error });
    const wasPublished = post.status === 'published';
    database.db.prepare("UPDATE content_posts SET status='published',published_at=CASE WHEN published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(post.id);
    const publishedPost = database.db.prepare('SELECT * FROM content_posts WHERE id=?').get(post.id);
    const notification = !wasPublished && post.type === 'news' ? await emailNewsSubscribers(publishedPost) : null;
    return res.json({ post: publishedPost, ...(notification || {}) });
  });

  app.post('/api/admin/content/:id/unpublish', requireAuth, requireRole('employee'), (req, res) => {
    const result = database.db.prepare("UPDATE content_posts SET status='draft',published_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='published'").run(req.params.id);
    if (!result.changes) {
      const exists = database.db.prepare('SELECT id FROM content_posts WHERE id=?').get(req.params.id);
      return res.status(exists ? 409 : 404).json({ error: exists ? 'Only published content can be unpublished' : 'Content not found' });
    }
    return res.json({ post: database.db.prepare('SELECT * FROM content_posts WHERE id=?').get(req.params.id) });
  });

  app.post('/api/admin/content/:id/archive', requireAuth, requireRole('employee'), (req, res) => {
    const result = database.db.prepare("UPDATE content_posts SET status='archived',published_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'archived'").run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Content not found or already archived' });
    return res.json({ post: database.db.prepare('SELECT * FROM content_posts WHERE id=?').get(req.params.id) });
  });

  app.delete('/api/admin/content/:id', requireAuth, requireRole('admin'), (req, res) => {
    const result = database.db.prepare('UPDATE content_posts SET deleted_at=CURRENT_TIMESTAMP,published_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Content not found' });
    return res.json({ message: 'Content permanently deleted' });
  });

  app.post('/api/cart/add', (req, res) => {
    const { customerId: bodyCustomerId, productId, quantity = 1, variantLabel = '' } = req.body || {};
    const customerId = bodyCustomerId || req.user?.id;

    if (!customerId || !productId) {
      return res.status(400).json({ error: 'customerId and productId are required' });
    }

    const user = database.db.prepare('SELECT * FROM users WHERE id = ?').get(customerId);
    if (!user) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const product = database.getProductById(productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const normalizedQuantity = Number(quantity);
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      return res.status(400).json({ error: 'Quantity must be a positive number' });
    }

    const sizeOptions = parseSizeOptions(product.size_options);
    const selectedLabel = typeof variantLabel === 'string' ? variantLabel.trim() : '';
    const selectedOption = sizeOptions.find((option) => option.label === selectedLabel);
    if (sizeOptions.length && !selectedOption) {
      return res.status(400).json({ error: 'Choose a valid size or measurement for this product' });
    }
    if (!sizeOptions.length && selectedLabel) {
      return res.status(400).json({ error: 'This product does not have size options' });
    }
    const item = database.addToCart({
      customerId,
      productId,
      quantity: normalizedQuantity,
      variantLabel: selectedLabel,
      unitPrice: selectedOption ? selectedOption.price : Number(product.price),
    });
    const cart = database.getCartByCustomerId(customerId);
    const total = cart.items.reduce((sum, entry) => sum + Number(entry.quantity) * Number(entry.unit_price), 0);

    return res.status(201).json({
      message: 'Item added to cart successfully',
      product: productForApi(product),
      item: { ...item, unitPrice: Number(item.unit_price), quantity: Number(item.quantity), variantLabel: item.variant_label },
      cart: {
        ...cart.cart,
        items: cart.items.map((entry) => ({
          ...entry,
          unitPrice: Number(entry.unit_price),
          quantity: Number(entry.quantity),
          productPrice: Number(entry.product_price),
          subtotal: Number(entry.quantity) * Number(entry.unit_price),
        }))
      },
      total,
    });
  });

  app.get('/api/cart/:customerId', (req, res) => {
    const customerId = req.params.customerId;
    const cart = database.getCartByCustomerId(customerId);

    if (!cart.cart) {
      return res.json({ cart: { customerId, items: [] }, total: 0 });
    }

    const total = cart.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0);

    return res.json({
      cart: {
        ...cart.cart,
        customerId: cart.cart.customer_id,
        items: cart.items.map((entry) => ({
          ...entry,
          unitPrice: Number(entry.unit_price),
          quantity: Number(entry.quantity),
          productPrice: Number(entry.product_price),
          variantLabel: entry.variant_label,
          subtotal: Number(entry.quantity) * Number(entry.unit_price)
        }))
      },
      total,
    });
  });

  app.get('/api/cart', (req, res) => {
    const customerId = req.query.customerId || req.user?.id;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    const cart = database.getCartByCustomerId(customerId);
    const total = cart.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0);
    return res.json({ cart: { customerId, items: cart.items }, total });
  });

  app.delete('/api/cart/items/:productId', (req, res) => {
    const customerId = req.body?.customerId || req.user?.id;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    const removed = database.removeCartItem({ customerId, itemId: req.params.productId });
    if (!removed) return res.status(404).json({ error: 'Product is not in your cart' });
    const cart = database.getCartByCustomerId(customerId);
    const total = cart.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0);
    return res.json({ cart: { customerId, items: cart.items }, total });
  });

  app.post('/api/cart/checkout', (req, res) => {
    const { customerId, paymentMethod } = req.body || {};

    if (!customerId || !paymentMethod) {
      return res.status(400).json({ error: 'customerId and paymentMethod are required' });
    }

    const user = database.db.prepare('SELECT * FROM users WHERE id = ?').get(customerId);
    if (!user) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const sale = database.checkoutCartByCustomer({ customerId, paymentMethod });
    if (!sale) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    return res.status(201).json({
      message: 'Checkout successful',
      sale: {
        ...sale,
        totalAmount: Number(sale.total_amount),
        totalCost: Number(sale.total_cost),
      }
    });
  });

  app.post('/api/catalog/products/:productId/reviews', (req, res) => {
    const { productId } = req.params;
    const { rating, comment } = req.body || {};

    if (!productId) {
      return res.status(400).json({ error: 'Product id is required' });
    }

    const product = database.db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const normalizedRating = Number(rating);
    if (!Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
      return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
    }

    const review = database.createReview({
      productId,
      rating: normalizedRating,
      comment: comment || '',
    });

    const summary = database.getProductSummary(productId);
    return res.status(201).json({ message: 'Review created successfully', review, summary });
  });

  app.post('/api/customers/messages', (req, res) => {
    const { customerId, customerName, phone = '', channel, message } = req.body || {};
    if (!['message', 'callback'].includes(channel) || !message || String(message).length > 10000) {
      return res.status(400).json({ error: 'A supported channel and message (up to 10,000 characters) are required' });
    }

    const record = database.createMessage({
      customerId: customerId || null,
      customerName: customerName || 'Customer',
      phone,
      email: req.body?.email || '',
      channel,
      message,
    });

    return res.status(201).json({ message: 'Customer message recorded successfully', message: record });
  });

  // Public contact form: saves a conversation only; it never emails on initial submission.
  app.post('/api/contact', (req, res) => {
    const { name, email, subject, message } = req.body || {};
    if (!name || !email || !message || !/^\S+@\S+\.\S+$/.test(String(email))) return res.status(400).json({ error: 'A valid name, email and message are required' });
    if (String(name).length > 160 || String(email).length > 254 || String(message).length > 10000) return res.status(400).json({ error: 'Contact details exceed the allowed length' });
    const conversation = database.createContactConversation({ name: String(name).trim(), email: String(email).trim().toLowerCase(), subject: String(subject || 'Contact request').trim().slice(0, 200), message: String(message).trim() });
    return res.status(201).json({ message: 'Your message was received', conversationId: conversation.id, status: conversation.status });
  });

  app.post('/api/customer/contact/conversations', requireAuth, requireRole('customer'), (req, res) => {
    const { subject = 'Customer support', message } = req.body || {};
    if (!message || !String(message).trim() || String(message).length > 10000) return res.status(400).json({ error: 'A first message (up to 10,000 characters) is required' });
    const conversation = database.createContactConversation({
      customerId: req.user.id,
      name: req.user.name,
      email: req.user.email,
      subject: String(subject).trim().slice(0, 200),
      message: String(message).trim(),
    });
    return res.status(201).json({ conversation });
  });

  app.get('/api/customer/contact/conversations', requireAuth, requireRole('customer'), (req, res) => {
    return res.json({ conversations: database.listCustomerContactConversations(req.user.id) });
  });

  app.get('/api/customer/contact/conversations/:id', requireAuth, requireRole('customer'), (req, res) => {
    const conversation = database.getCustomerContactConversation(req.params.id, req.user.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    return res.json({ conversation });
  });

  app.post('/api/customer/contact/conversations/:id/messages', requireAuth, requireRole('customer'), (req, res) => {
    const conversation = database.getCustomerContactConversation(req.params.id, req.user.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const { message } = req.body || {};
    if (!message || !String(message).trim() || String(message).length > 10000) return res.status(400).json({ error: 'A message (up to 10,000 characters) is required' });
    const saved = database.addCustomerContactMessage({ conversationId: conversation.id, message: String(message).trim() });
    return res.status(201).json({ message: saved });
  });

  app.get('/api/admin/contact/conversations', requireAuth, requireRole('employee'), (req, res) => {
    return res.json({ conversations: database.listContactConversations({ includeDeleted: req.user.role === 'admin' }) });
  });

  app.get('/api/admin/contact/conversations/:id', requireAuth, requireRole('employee'), (req, res) => {
    const conversation = database.getContactConversation(req.params.id, { includeDeleted: req.user.role === 'admin' });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    return res.json({ conversation });
  });

  app.post('/api/admin/contact/conversations/:id/replies', requireAuth, requireRole('employee'), async (req, res) => {
    const { message } = req.body || {};
    if (!message || !String(message).trim() || String(message).length > 10000) return res.status(400).json({ error: 'A reply message (up to 10,000 characters) is required' });
    const replyText = String(message);
    const conversation = database.getContactConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const reply = database.addContactReply({ conversationId: conversation.id, message: replyText });
    const { SMTP_USER, SMTP_APP_PASSWORD, SMTP_FROM } = process.env;
    if (!SMTP_USER || !SMTP_APP_PASSWORD || !nodemailer) return res.status(201).json({ message: 'Reply saved to the live conversation', reply, emailSent: false });
    try {
      const smtpPort = Number(process.env.SMTP_PORT || 465);
      const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
      const smtpSecure = process.env.SMTP_SECURE
        ? process.env.SMTP_SECURE.toLowerCase() === 'true'
        : smtpPort === 465;
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: smtpPort, secure: smtpSecure,
        auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD.replace(/\s/g, '') },
      });
      await transporter.sendMail({
        from: SMTP_FROM || SMTP_USER,
        to: conversation.email,
        replyTo: SMTP_FROM || SMTP_USER,
        subject: `Re: ${conversation.subject}`,
        text: replyText,
      });
      return res.status(201).json({ message: 'Reply saved and sent by email', reply, emailSent: true });
    } catch (error) {
      console.error('Contact reply email failed:', error.message);
      return res.status(201).json({ message: 'Reply saved to the live conversation', reply, emailSent: false });
    }
  });

  app.patch('/api/admin/contact/conversations/:id', requireAuth, requireRole('employee'), (req, res) => {
    const { status } = req.body || {};
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be open or closed' });
    if (!database.setContactConversationStatus(req.params.id, status)) return res.status(404).json({ error: 'Conversation not found' });
    return res.json({ conversation: database.getContactConversation(req.params.id) });
  });

  app.delete('/api/admin/contact/conversations/:id', requireAuth, requireRole('admin'), (req, res) => {
    if (!database.deleteContactConversation(req.params.id)) return res.status(404).json({ error: 'Conversation not found or already deleted' });
    return res.json({ message: 'Conversation and its messages moved to trash' });
  });

  app.post('/api/admin/contact/conversations/:id/restore', requireAuth, requireRole('admin'), (req, res) => {
    if (!database.restoreContactConversation(req.params.id)) return res.status(404).json({ error: 'Deleted conversation not found' });
    return res.json({ conversation: database.getContactConversation(req.params.id, { includeDeleted: true }) });
  });

  app.delete('/api/admin/contact/conversations/:id/permanent', requireAuth, requireRole('admin'), (req, res) => {
    const conversation = database.db.prepare('SELECT id FROM contact_conversations WHERE id=? AND deleted_at IS NOT NULL').get(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Deleted conversation not found. Only items in the Bin can be permanently deleted.' });
    const permanentlyDelete = database.db.transaction((id) => {
      database.db.prepare('DELETE FROM contact_messages WHERE conversation_id=?').run(id);
      database.db.prepare('DELETE FROM contact_conversations WHERE id=? AND deleted_at IS NOT NULL').run(id);
    });
    permanentlyDelete(conversation.id);
    return res.json({ message: 'Conversation and its messages permanently deleted' });
  });

  app.delete('/api/admin/contact/messages/:id', requireAuth, requireRole('admin'), (req, res) => {
    if (!database.deleteContactMessage(req.params.id)) return res.status(404).json({ error: 'Message not found or already deleted' });
    return res.json({ message: 'Message moved to trash' });
  });

  app.post('/api/admin/contact/messages/:id/restore', requireAuth, requireRole('admin'), (req, res) => {
    if (!database.restoreContactMessage(req.params.id)) return res.status(404).json({ error: 'Message not found or its conversation is deleted' });
    return res.json({ message: 'Message restored' });
  });

  app.delete('/api/admin/contact/messages/:id/permanent', requireAuth, requireRole('admin'), (req, res) => {
    const result = database.db.prepare('DELETE FROM contact_messages WHERE id=? AND deleted_at IS NOT NULL').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Deleted message not found. Only items in the Bin can be permanently deleted.' });
    return res.json({ message: 'Message permanently deleted' });
  });

  // WebRTC call coordination: clients exchange SDP/ICE through these authenticated polling endpoints.
  app.post('/api/calls', requireAuth, requireRole('customer'), (req, res) => {
    const existing = database.db.prepare("SELECT id,status FROM calls WHERE customer_id=? AND status IN ('waiting','active')").get(req.user.id);
    if (existing) return res.status(409).json({ error: 'You already have a call in progress', call: existing });
    const mediaType = req.body?.mediaType || 'audio';
    if (!['audio', 'video'].includes(mediaType)) return res.status(400).json({ error: 'mediaType must be audio or video' });
    const call = { id: database.generateId(), customer_id: req.user.id, media_type: mediaType };
    database.db.prepare('INSERT INTO calls (id,customer_id,media_type) VALUES (@id,@customer_id,@media_type)').run(call);
    return res.status(201).json({ call: { id: call.id, status: 'waiting', mediaType } });
  });

  app.get('/api/calls/waiting', requireAuth, requireRole('employee'), (req, res) => {
    const calls = database.db.prepare("SELECT c.id,c.customer_id,c.media_type AS mediaType,u.name AS customer_name,c.requested_at FROM calls c JOIN users u ON u.id=c.customer_id WHERE c.status='waiting' ORDER BY c.requested_at").all();
    return res.json({ calls });
  });

  // Live waiting-call feed for the employee UI. The browser should play its
  // ringtone when a call ID first appears, then stop when it disappears.
  // Use fetch() with the existing Bearer token (EventSource cannot set headers).
  app.get('/api/calls/events', requireAuth, requireRole('employee'), (req, res) => {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const sendWaitingCalls = () => {
      if (res.destroyed || res.writableEnded) return;
      const calls = database.db.prepare("SELECT c.id,c.customer_id,c.media_type AS mediaType,u.name AS customer_name,c.requested_at FROM calls c JOIN users u ON u.id=c.customer_id WHERE c.status='waiting' ORDER BY c.requested_at").all();
      res.write(`event: waiting-calls\ndata: ${JSON.stringify({ calls })}\n\n`);
    };

    sendWaitingCalls();
    const poll = setInterval(sendWaitingCalls, 2000);
    res.on('close', () => clearInterval(poll));
  });

  app.get('/api/admin/calls', requireAuth, requireRole('admin'), (req, res) => {
    const calls = database.db.prepare('SELECT c.id,c.customer_id,c.staff_id,c.media_type AS mediaType,c.status,c.requested_at,c.accepted_at,c.ended_at,u.name AS customer_name,s.name AS staff_name FROM calls c JOIN users u ON u.id=c.customer_id LEFT JOIN users s ON s.id=c.staff_id ORDER BY c.requested_at DESC LIMIT 200').all();
    return res.json({ calls });
  });

  app.get('/api/calls/:id', requireAuth, (req, res) => {
    const call = database.db.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (req.user.role !== 'admin' && call.customer_id !== req.user.id && call.staff_id !== req.user.id) return res.status(403).json({ error: 'Only call participants can view this call' });
    return res.json({ call: { ...call, mediaType: call.media_type } });
  });

  app.post('/api/calls/:id/accept', requireAuth, requireRole('employee'), (req, res) => {
    const result = database.db.prepare("UPDATE calls SET status='active',staff_id=?,accepted_at=CURRENT_TIMESTAMP WHERE id=? AND status='waiting'").run(req.user.id, req.params.id);
    if (!result.changes) {
      const call = database.db.prepare('SELECT id,status,staff_id FROM calls WHERE id=?').get(req.params.id);
      return res.status(call ? 409 : 404).json({ error: call ? 'Call is no longer waiting' : 'Call not found' });
    }
    return res.json({ call: database.db.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id) });
  });

  app.post('/api/calls/:id/end', requireAuth, (req, res) => {
    const call = database.db.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (req.user.role !== 'admin' && call.customer_id !== req.user.id && call.staff_id !== req.user.id) return res.status(403).json({ error: 'Only call participants can end this call' });
    if (call.status === 'ended') return res.json({ call });
    database.db.prepare("UPDATE calls SET status='ended',ended_at=CURRENT_TIMESTAMP WHERE id=?").run(call.id);
    return res.json({ call: database.db.prepare('SELECT * FROM calls WHERE id=?').get(call.id) });
  });

  const getCallForUser = (callId, user) => {
    const call = database.db.prepare('SELECT * FROM calls WHERE id=?').get(callId);
    if (!call) return { error: 'Call not found', status: 404 };
    if (call.customer_id !== user.id && call.staff_id !== user.id && user.role !== 'admin') return { error: 'Only call participants can access signaling', status: 403 };
    return { call };
  };

  app.post('/api/calls/:id/signals', requireAuth, (req, res) => {
    const access = getCallForUser(req.params.id, req.user);
    if (access.error) return res.status(access.status).json({ error: access.error });
    if (access.call.status !== 'active') return res.status(409).json({ error: 'Signaling is available only for an active call' });
    const { type, payload } = req.body || {};
    if (!['offer', 'answer', 'ice-candidate', 'renegotiate'].includes(type) || payload === undefined || Buffer.byteLength(JSON.stringify(payload)) > 64000) return res.status(400).json({ error: 'Valid signal type and payload up to 64 KB are required' });
    const info = database.db.prepare('INSERT INTO call_signals (call_id,sender_id,signal_type,payload) VALUES (?,?,?,?)').run(req.params.id, req.user.id, type, JSON.stringify(payload));
    return res.status(201).json({ signalId: Number(info.lastInsertRowid) });
  });

  app.get('/api/calls/:id/signals', requireAuth, (req, res) => {
    const access = getCallForUser(req.params.id, req.user);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const afterId = Math.max(0, Number(req.query.afterId) || 0);
    const signals = database.db.prepare('SELECT id,sender_id,signal_type,payload,created_at FROM call_signals WHERE call_id=? AND id>? AND sender_id<>? ORDER BY id LIMIT 100').all(req.params.id, afterId, req.user.id)
      .map((signal) => ({ ...signal, payload: JSON.parse(signal.payload) }));
    return res.json({ call: { id: access.call.id, status: access.call.status }, signals });
  });

  app.post('/api/accounting/ingredients/purchases', (req, res) => {
    const { name, unit, quantity, unitCost, supplier } = req.body || {};

    if (!name || !unit || !quantity || !unitCost) {
      return res.status(400).json({ error: 'name, unit, quantity and unitCost are required' });
    }

    const purchase = database.createIngredientPurchase({
      name,
      unit,
      quantity,
      unitCost,
      supplier,
    });

    return res.status(201).json({
      message: 'Ingredient purchase recorded successfully',
      purchase: {
        ...purchase,
        totalCost: Number(purchase.total_cost),
      },
    });
  });

  app.post('/api/accounting/sales', (req, res) => {
    const { customerId, customerName, paymentMethod, items } = req.body || {};

    if (!customerName || !Array.isArray(items) || !items.length || !paymentMethod) {
      return res.status(400).json({ error: 'customerName, paymentMethod and items are required' });
    }

    for (const item of items) {
      const quantity = Number(item.quantity); const unitPrice = Number(item.unitPrice); const costPrice = Number(item.costPrice);
      const product = database.getProductById(item.productId);
      if (!product || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(costPrice) || costPrice < 0) {
        return res.status(400).json({ error: 'Each item needs an existing product, positive quantity, and non-negative unitPrice and costPrice' });
      }
      if (product.inventory_enabled && database.finishedStock(product.id) < quantity) return res.status(409).json({ error: `Insufficient finished stock for ${product.name}` });
    }

    const sale = database.createSale({
      customerId,
      customerName,
      paymentMethod,
      items,
    });

    for (const item of items) {
      const product = database.getProductById(item.productId);
      if (product.inventory_enabled) database.db.prepare("INSERT INTO finished_stock_movements (id,product_id,movement_type,quantity,unit_cost,reference) VALUES (?,?,?,?,?,?)")
        .run(database.generateId(), product.id, 'sale', Number(item.quantity), Number(item.costPrice), sale.id);
    }

    return res.status(201).json({
      message: 'Sale recorded successfully',
      sale: {
        ...sale,
        totalAmount: Number(sale.total_amount),
        totalCost: Number(sale.total_cost),
      },
    });
  });

  app.get('/api/accounting/summary', (req, res) => {
    const summary = database.getAccountingSummary();
    return res.json({ summary });
  });

  // Private inventory, production and costing API. All figures are recorded in KES.
  app.post('/api/accounting/materials', requireAuth, requireRole('admin'), (req, res) => {
    const { name, unit, category = 'ingredient', reorderLevel = 0 } = req.body || {};
    if (!name || !unit || !['ingredient', 'packaging', 'other'].includes(category) || !Number.isFinite(Number(reorderLevel)) || Number(reorderLevel) < 0) {
      return res.status(400).json({ error: 'name and unit are required; category and reorderLevel must be valid' });
    }
    try {
      const material = database.createMaterial({ name: name.trim(), unit, category, reorderLevel: Number(reorderLevel) });
      return res.status(201).json({ material });
    } catch (error) {
      return res.status(409).json({ error: 'A material with that name already exists' });
    }
  });

  app.get('/api/accounting/inventory', requireAuth, requireRole('admin'), (req, res) => {
    return res.json({ currency: 'KES', ...database.inventorySummary() });
  });

  app.get('/api/accounting/equipment', requireAuth, requireRole('admin'), (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    const overview = database.equipmentOverview();
    return res.json({
      currency: 'KES',
      assets: database.listEquipmentAssets({ includeArchived }),
      activeAssetCount: overview.activeAssetCount,
      currentlyDepreciatingAssetCount: overview.currentlyDepreciatingAssetCount,
      monthlyDepreciation: overview.monthlyDepreciation,
      annualDepreciation: overview.annualDepreciation,
    });
  });

  app.post('/api/accounting/equipment', requireAuth, requireRole('admin'), (req, res) => {
    const normalized = normalizeEquipmentAsset(req.body || {});
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    try {
      const saved = database.createEquipmentAsset(normalized.values);
      const asset = database.listEquipmentAssets({ includeArchived: true }).find((item) => item.assetId === saved.id);
      return res.status(201).json({ asset, equipment: database.equipmentOverview() });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.patch('/api/accounting/equipment/:id', requireAuth, requireRole('admin'), (req, res) => {
    const current = database.getEquipmentAsset(req.params.id);
    if (!current) return res.status(404).json({ error: 'Equipment asset not found' });
    const normalized = normalizeEquipmentAsset(req.body || {}, current);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const saved = database.updateEquipmentAsset(req.params.id, normalized.values);
    const asset = database.listEquipmentAssets({ includeArchived: true }).find((item) => item.assetId === saved.id);
    return res.json({ asset, equipment: database.equipmentOverview() });
  });

  app.delete('/api/accounting/equipment/:id', requireAuth, requireRole('admin'), (req, res) => {
    const asset = database.getEquipmentAsset(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Equipment asset not found' });
    if (!asset.is_active) return res.status(409).json({ error: 'Equipment asset is already archived' });
    database.archiveEquipmentAsset(req.params.id);
    return res.json({ message: 'Equipment asset archived; it will no longer be depreciated.', equipment: database.equipmentOverview() });
  });

  app.get('/api/accounting/material-purchases', requireAuth, requireRole('admin'), (req, res) => {
    const purchases = database.db.prepare(`
      SELECT mm.id,mm.material_id AS materialId,m.name AS materialName,m.unit,mm.quantity,
        mm.unit_cost AS unitCost,mm.quantity*mm.unit_cost AS totalCost,mm.reference,
        mm.receipt_url AS receiptUrl,mm.created_at AS createdAt
      FROM material_movements mm JOIN inventory_materials m ON m.id=mm.material_id
      WHERE mm.movement_type='purchase'
      ORDER BY datetime(mm.created_at) DESC,mm.rowid DESC LIMIT 500
    `).all();
    return res.json({ currency: 'KES', purchases });
  });
  app.post('/api/accounting/materials/:materialId/purchases', requireAuth, requireRole('admin'), (req, res) => {
    const { quantity, totalCost, supplier, reference, receiptUrl } = req.body || {};
    const qty = Number(quantity); const cost = Number(totalCost);
    const material = database.db.prepare('SELECT * FROM inventory_materials WHERE id=?').get(req.params.materialId);
    if (!material) return res.status(404).json({ error: 'Material not found' });
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'Positive quantity and non-negative totalCost are required (KES)' });
    const normalizedReceiptUrl = typeof receiptUrl === 'string' ? receiptUrl.trim() : '';
    if (normalizedReceiptUrl.length > 2048 || (normalizedReceiptUrl && !validContentUrl(normalizedReceiptUrl))) return res.status(400).json({ error: 'Receipt link must be a valid HTTP or HTTPS URL no longer than 2048 characters.' });
    const movement = database.recordMaterialMovement({ materialId: material.id, type: 'purchase', quantity: qty, unitCost: cost / qty, reference: supplier ? `${supplier}${reference ? `: ${reference}` : ''}` : reference, receiptUrl: normalizedReceiptUrl || null });
    return res.status(201).json({ purchase: { ...movement, totalCost: cost, supplier: supplier || null, receiptUrl: movement.receipt_url }, stock: Number(database.materialStock(material.id)) });
  });

  app.post('/api/accounting/products/:productId/formulas', requireAuth, requireRole('admin'), (req, res) => {
    const { items, expectedYield, labourCost = 0, overheadCost = 0 } = req.body || {};
    const product = database.getProductById(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const nums = [expectedYield, labourCost, overheadCost].map(Number);
    if (!Array.isArray(items) || !items.length || !Number.isFinite(nums[0]) || nums[0] <= 0 || nums.slice(1).some((x) => !Number.isFinite(x) || x < 0) || items.some((x) => !x.materialId || !Number.isFinite(Number(x.quantity)) || Number(x.quantity) <= 0)) {
      return res.status(400).json({ error: 'A positive expectedYield and formula items are required; costs and item quantities must be non-negative and positive respectively' });
    }
    for (const item of items) if (!database.db.prepare('SELECT id FROM inventory_materials WHERE id=?').get(item.materialId)) return res.status(400).json({ error: `Unknown material ${item.materialId}` });
    const formula = database.createFormula({ productId: product.id, expectedYield: nums[0], labourCost: nums[1], overheadCost: nums[2], items: items.map((i) => ({ materialId: i.materialId, quantity: Number(i.quantity) })) });
    const equipmentAllocation = database.calculateEquipmentDepreciation(nums[0]);
    return res.status(201).json({ formula, equipmentDepreciation: equipmentAllocation.total, equipmentDepreciationDetails: equipmentAllocation.assets });
  });

  app.get('/api/accounting/products/:productId/costing', requireAuth, requireRole('admin'), (req, res) => {
    const product = database.getProductById(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const formula = database.getLatestFormula(product.id);
    if (!formula) return res.status(404).json({ error: 'No formula is configured for this product' });
    const ingredients = formula.items.map((item) => {
      const recent = database.db.prepare("SELECT unit_cost FROM material_movements WHERE material_id=? AND movement_type IN ('purchase','adjustment_in') ORDER BY created_at DESC LIMIT 1").get(item.materialId);
      return { ...item, unitCost: recent ? Number(recent.unit_cost) : 0, extendedCost: item.quantity * (recent ? Number(recent.unit_cost) : 0) };
    });
    const rawMaterialCost = ingredients.filter((item) => item.category === 'ingredient').reduce((sum, item) => sum + item.extendedCost, 0);
    const packagingMaterialCost = ingredients.filter((item) => item.category === 'packaging').reduce((sum, item) => sum + item.extendedCost, 0);
    const otherMaterialCost = ingredients.filter((item) => !['ingredient', 'packaging'].includes(item.category)).reduce((sum, item) => sum + item.extendedCost, 0);
    const materialCost = ingredients.reduce((sum, item) => sum + item.extendedCost, 0);
    const labourCost = Number(formula.labour_cost);
    const overheadCost = Number(formula.overhead_cost);
    const equipmentAllocation = database.calculateEquipmentDepreciation(Number(formula.expected_yield));
    const equipmentDepreciation = equipmentAllocation.total;
    const batchCost = materialCost + labourCost + overheadCost + equipmentDepreciation;
    const unitCost = batchCost / Number(formula.expected_yield);
    const costBreakdown = {
      rawMaterialCost,
      packagingMaterialCost,
      otherMaterialCost,
      materialCost,
      labourCost,
      overheadCost,
      equipmentDepreciation,
      totalBatchCost: batchCost,
      quantity: Number(formula.expected_yield),
      costPerUnit: unitCost,
    };
    return res.json({ currency: 'KES', product, formula, ingredients, equipmentDepreciation, equipmentDepreciationDetails: equipmentAllocation.assets, costBreakdown, batchCost, unitCost, breakEvenPrice: unitCost, pricing: { markup50: unitCost * 1.5, margin30: unitCost / 0.7, margin40: unitCost / 0.6 }, finishedStock: Number(database.finishedStock(product.id)) });
  });

  app.get('/api/accounting/production', requireAuth, requireRole('admin'), (req, res) => {
    const requestedLimit = Number(req.query.limit || 50);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return res.status(400).json({ error: 'limit must be a positive integer' });
    const limit = Math.min(requestedLimit, 200);
    const batches = database.db.prepare(`
      SELECT b.*, p.name AS product_name
      FROM production_batches b JOIN products p ON p.id=b.product_id
      ORDER BY b.produced_at DESC LIMIT ?
    `).all(limit).map((batch) => ({
      ...batch,
      equipment_depreciation_details: JSON.parse(batch.equipment_depreciation_details || '[]'),
      costBreakdown: {
        rawMaterialCost: Number(batch.raw_material_cost),
        packagingMaterialCost: Number(batch.packaging_material_cost),
        otherMaterialCost: Number(batch.other_material_cost),
        materialCost: Number(batch.material_cost),
        labourCost: Number(batch.labour_cost),
        overheadCost: Number(batch.overhead_cost),
        equipmentDepreciation: Number(batch.equipment_depreciation),
        totalCost: Number(batch.total_cost),
        producedQuantity: Number(batch.produced_quantity),
        costPerUnit: Number(batch.unit_cost),
      },
    }));
    return res.json({ currency: 'KES', batches });
  });

  app.post('/api/accounting/production', requireAuth, requireRole('admin'), (req, res) => {
    const { productId, formulaId, producedQuantity, saleableQuantity, notes } = req.body || {};
    const made = Number(producedQuantity); const saleable = Number(saleableQuantity);
    if (!productId || !formulaId || !Number.isFinite(made) || made <= 0 || !Number.isFinite(saleable) || saleable <= 0 || saleable > made) return res.status(400).json({ error: 'productId, formulaId, positive producedQuantity and saleableQuantity not exceeding producedQuantity are required' });
    try {
      const batch = database.produceBatch({ productId, formulaId, producedQuantity: made, saleableQuantity: saleable, notes });
      return res.status(201).json({ currency: 'KES', batch, finishedStock: Number(database.finishedStock(productId)) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/accounting/expenses', requireAuth, requireRole('admin'), (req, res) => {
    const { category, description, amount } = req.body || {};
    if (!category || !description || !Number.isFinite(Number(amount)) || Number(amount) < 0) return res.status(400).json({ error: 'category, description and non-negative amount (KES) are required' });
    return res.status(201).json({ currency: 'KES', expense: database.recordExpense({ category, description, amount: Number(amount) }) });
  });

  app.post('/api/referrals', (req, res) => {
    const { referrerId, customerId, customerName, saleAmount, referredAt, note } = req.body || {};

    if (!customerName || !saleAmount) {
      return res.status(400).json({ error: 'customerName and saleAmount are required' });
    }

    const referral = database.createReferral({
      referrerId,
      customerId,
      customerName,
      saleAmount,
      referredAt,
      note,
    });

    return res.status(201).json({
      message: 'Referral recorded successfully',
      referral: {
        ...referral,
        commissionRate: Number(referral.commission_rate),
        commissionAmount: Number(referral.commission_amount),
      },
    });
  });

  app.get('/api/dashboard/admin', requireAuth, requireRole('admin'), (req, res) => {
    const totalUsers = database.db.prepare('SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL').get().count;
    const totalProducts = database.db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
    const totalSales = database.db.prepare('SELECT COUNT(*) AS count FROM sales').get().count;
    const totalMessages = database.db.prepare('SELECT COUNT(*) AS count FROM customer_messages').get().count;
    const totalReferrals = database.db.prepare('SELECT COUNT(*) AS count FROM referrals').get().count;
    const summary = database.getAccountingSummary();

    return res.json({
      dashboard: 'admin',
      user: sanitizeUser(req.user),
      stats: {
        totalUsers,
        totalProducts,
        totalSales,
        totalMessages,
        totalReferrals,
        summary,
      },
      access: 'full-control',
    });
  });

  app.get('/api/dashboard/employee', requireAuth, requireRole('employee'), (req, res) => {
    const products = database.db.prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT 10').all();
    const assignment = database.db.prepare(`
      SELECT d.name AS department_name,p.title AS position_title,p.description AS position_description
      FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN positions p ON p.id=u.position_id
      WHERE u.id=?
    `).get(req.user.id);
    const messages = database.db.prepare('SELECT * FROM customer_messages ORDER BY created_at DESC LIMIT 10').all();

    return res.json({
      dashboard: 'employee',
      user: {
        ...sanitizeUser(req.user),
        departmentName: assignment.department_name || null,
        position: assignment.position_title || req.user.position || null,
        positionDescription: assignment.position_description || null,
      },
      products,
      recentMessages: messages,
      access: 'team-view',
    });
  });

  app.get('/api/dashboard/customer', requireAuth, requireRole('customer'), (req, res) => {
    const products = database.db.prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT 10').all();
    const reviews = database.db.prepare('SELECT * FROM product_reviews ORDER BY created_at DESC LIMIT 10').all();
    const messages = database.db.prepare('SELECT * FROM customer_messages WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10')
      .all(req.user.id);

    return res.json({
      dashboard: 'customer',
      user: sanitizeUser(req.user),
      products,
      recentReviews: reviews,
      myMessages: messages,
      access: 'customer-view',
    });
  });

  app.get('/api/dashboard/referrer', requireAuth, requireRole('referrer'), (req, res) => {
    const referrals = database.db.prepare('SELECT * FROM referrals WHERE referrer_id = ? ORDER BY referred_at DESC').all(req.user.id);
    const summary = referrals.reduce((acc, referral) => {
      acc.totalCommission += Number(referral.commission_amount);
      acc.totalSales += Number(referral.sale_amount);
      acc.totalReferrals += 1;
      return acc;
    }, { totalCommission: 0, totalSales: 0, totalReferrals: 0 });

    return res.json({
      dashboard: 'referrer',
      user: sanitizeUser(req.user),
      referrals,
      summary,
      access: 'referrer-view',
    });
  });

  return app;
}

module.exports = { createApp };
