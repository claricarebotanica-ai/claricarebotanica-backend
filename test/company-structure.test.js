const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const nodemailer = require('nodemailer');

const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const tokenFor = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role },
  process.env.JWT_SECRET || 'claricare-dev-secret'
);

test('admins manage departments and positions, and employee invitations preserve the selected assignment', async () => {
  const database = createDatabase(':memory:');
  const previousTransport = nodemailer.createTransport;
  const previousSmtpUser = process.env.SMTP_USER;
  const previousSmtpPassword = process.env.SMTP_APP_PASSWORD;
  const previousResendApiKey = process.env.RESEND_API_KEY;
  const previousResendFrom = process.env.RESEND_FROM;
  const previousFetch = global.fetch;
  try {
    const admin = database.createUser({
      name: 'Structure Admin',
      email: 'structure-admin@example.com',
      passwordHash: 'unused-test-hash',
      role: 'admin',
    });
    nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: 'test-message' }) });
    process.env.SMTP_USER = 'test@example.com';
    process.env.SMTP_APP_PASSWORD = 'test-password';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.RESEND_FROM = 'ClariCare <invitations@claricarebotanica.com>';
    let resendRequest;
    global.fetch = async (url, options) => {
      resendRequest = { url, options };
      return { ok: true, status: 200, json: async () => ({ id: 'test-resend-message' }) };
    };
    const app = createApp(database);
    const authorization = `Bearer ${tokenFor(admin)}`;

    const structure = await request(app)
      .get('/api/company/structure')
      .set('Authorization', authorization);
    assert.equal(structure.status, 200);
    assert.ok(structure.body.departments.some((item) => item.name === 'Product Development & Formulation'));
    assert.ok(structure.body.positions.some((item) => item.title === 'Cosmetic Formulator' && !item.isHiring));

    const department = await request(app)
      .post('/api/company/departments')
      .set('Authorization', authorization)
      .send({ name: 'Customer Success', description: 'Customer service and follow-up.' });
    assert.equal(department.status, 201);

    const internalPosition = await request(app)
      .post('/api/recruitment/positions')
      .set('Authorization', authorization)
      .send({
        title: 'Customer Care Specialist',
        departmentId: department.body.department.id,
        description: 'Supports assigned customers.',
        isHiring: false,
      });
    assert.equal(internalPosition.status, 201);
    assert.equal(internalPosition.body.position.is_hiring, 0);

    const publicPosition = await request(app)
      .post('/api/recruitment/positions')
      .set('Authorization', authorization)
      .send({
        title: 'Customer Care Associate',
        departmentId: department.body.department.id,
        description: 'Public vacancy.',
        isHiring: true,
      });
    assert.equal(publicPosition.status, 201);
    const vacancies = await request(app).get('/api/recruitment/positions');
    assert.equal(vacancies.status, 200);
    assert.deepEqual(vacancies.body.positions.map((item) => item.title), ['Customer Care Associate']);

    const mismatchedInvitation = await request(app)
      .post('/api/admin/users')
      .set('Authorization', authorization)
      .send({
        name: 'Misassigned Employee',
        email: 'mismatch@example.com',
        role: 'employee',
        departmentId: department.body.department.id,
        positionId: publicPosition.body.position.id,
      });
    assert.equal(mismatchedInvitation.status, 400);

    const invitation = await request(app)
      .post('/api/admin/users')
      .set('Authorization', authorization)
      .send({
        name: 'Assigned Employee',
        email: 'assigned@example.com',
        role: 'employee',
        departmentId: department.body.department.id,
        positionId: internalPosition.body.position.id,
      });
    assert.equal(invitation.status, 201);
    assert.equal(invitation.body.user.departmentId, department.body.department.id);
    assert.equal(invitation.body.user.positionId, internalPosition.body.position.id);
    assert.equal(invitation.body.user.departmentName, 'Customer Success');
    assert.equal(invitation.body.user.position, 'Customer Care Specialist');
    assert.equal(resendRequest.url, 'https://api.resend.com/emails');
    assert.equal(resendRequest.options.headers.Authorization, 'Bearer test-resend-key');
    assert.equal(JSON.parse(resendRequest.options.body).from, 'ClariCare <invitations@claricarebotanica.com>');
    assert.equal(JSON.parse(resendRequest.options.body).to, 'assigned@example.com');

    const rawUser = database.db.prepare('SELECT * FROM users WHERE id=?').get(invitation.body.user.id);
    const token = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    database.db.prepare('UPDATE users SET invitation_token_hash=? WHERE id=?').run(tokenHash, rawUser.id);
    const invitationDetails = await request(app).get('/api/auth/invitation').query({ token });
    assert.equal(invitationDetails.status, 200);
    assert.equal(invitationDetails.body.invitation.departmentName, 'Customer Success');
    assert.equal(invitationDetails.body.invitation.position, 'Customer Care Specialist');
  } finally {
    nodemailer.createTransport = previousTransport;
    global.fetch = previousFetch;
    if (previousSmtpUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = previousSmtpUser;
    if (previousSmtpPassword === undefined) delete process.env.SMTP_APP_PASSWORD;
    else process.env.SMTP_APP_PASSWORD = previousSmtpPassword;
    if (previousResendApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendApiKey;
    if (previousResendFrom === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = previousResendFrom;
    database.db.close();
  }
});
