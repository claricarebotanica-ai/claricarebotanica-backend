const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const signatureData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WioAAAAASUVORK5CYII=';

const tokenFor = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role },
  process.env.JWT_SECRET || 'claricare-dev-secret'
);

const createUser = (database, role, email) => {
  const user = database.createUser({ name: 'Taylor Example', email, passwordHash: 'not-used-in-this-test', role });
  if (role === 'employee' || role === 'referrer') {
    database.db.prepare('UPDATE users SET invitation_accepted_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
  }
  return user;
};

test('admins assign agreements that employees can sign once with drawn signature and consent', async () => {
  const database = createDatabase(':memory:');
  try {
    const admin = createUser(database, 'admin', 'agreements-admin@example.com');
    const employee = createUser(database, 'employee', 'agreements-employee@example.com');
    const app = createApp(database);

    const unauthenticatedCreate = await request(app)
      .post('/api/agreements')
      .send({ employeeId: employee.id, type: 'employment', content: 'Agreement text' });
    assert.equal(unauthenticatedCreate.status, 401);

    const created = await request(app)
      .post('/api/agreements')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ employeeId: employee.id, type: 'employment', title: 'Employee Agreement', content: 'Employee agreement text.' });
    assert.equal(created.status, 201);
    assert.equal(created.body.agreement.status, 'pending_signature');

    const employeeToken = tokenFor(employee);
    const mine = await request(app)
      .get('/api/agreements/mine')
      .set('Authorization', `Bearer ${employeeToken}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.agreements.length, 1);

    const missingConsent = await request(app)
      .post(`/api/agreements/${created.body.agreement.id}/sign`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ signatureName: 'Taylor Example', signatureData });
    assert.equal(missingConsent.status, 400);

    const signed = await request(app)
      .post(`/api/agreements/${created.body.agreement.id}/sign`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ signatureName: 'Taylor Example', signatureData, consent: true });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.agreement.status, 'signed');
    assert.equal(signed.body.agreement.signed_by, 'Taylor Example');
    assert.ok(signed.body.agreement.signed_at);
    assert.equal(signed.body.agreement.signature_data, signatureData);

    const duplicate = await request(app)
      .post(`/api/agreements/${created.body.agreement.id}/sign`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ signatureName: 'Taylor Example', signatureData, consent: true });
    assert.equal(duplicate.status, 409);

    const customer = createUser(database, 'customer', 'agreement-viewer@example.com');
    const hidden = await request(app)
      .get(`/api/agreements/${created.body.agreement.id}`)
      .set('Authorization', `Bearer ${tokenFor(customer)}`);
    assert.equal(hidden.status, 404);
  } finally {
    database.db.close();
  }
});

test('referrer invitation requires signing the assigned agreement before account activation', async () => {
  const database = createDatabase(':memory:');
  try {
    const referrer = database.createUser({
      name: 'Jordan Referrer',
      email: 'jordan-referrer@example.com',
      passwordHash: 'temporary-hash',
      role: 'referrer',
    });
    const invitationToken = 'referrer-invitation-token';
    const tokenHash = crypto.createHash('sha256').update(invitationToken).digest('hex');
    database.db.prepare(`
      UPDATE users SET invitation_token_hash=?,invitation_expires_at=? WHERE id=?
    `).run(tokenHash, new Date(Date.now() + 60 * 60 * 1000).toISOString(), referrer.id);
    const agreement = database.createAgreement({
      employeeId: referrer.id,
      type: 'referrer',
      title: 'Referral Partner Agreement',
      content: 'Five percent on qualifying product subtotal with seven-day attribution.',
      status: 'pending_signature',
    });
    const app = createApp(database);

    const invitation = await request(app)
      .get('/api/auth/invitation')
      .query({ token: invitationToken });
    assert.equal(invitation.status, 200);
    assert.equal(invitation.body.invitation.role, 'referrer');
    assert.equal(invitation.body.agreement.id, agreement.id);

    const unsigned = await request(app)
      .post('/api/auth/accept-invitation')
      .send({ token: invitationToken, password: 'LongSecurePass123!' });
    assert.equal(unsigned.status, 400);
    assert.equal(database.db.prepare('SELECT invitation_accepted_at FROM users WHERE id=?').get(referrer.id).invitation_accepted_at, null);

    const accepted = await request(app)
      .post('/api/auth/accept-invitation')
      .send({
        token: invitationToken,
        password: 'LongSecurePass123!',
        signatureName: 'Jordan Referrer',
        signatureData,
        agreementConsent: true,
      });
    assert.equal(accepted.status, 200, accepted.body.error);
    assert.equal(accepted.body.user.role, 'referrer');
    assert.ok(accepted.body.token);
    const savedAgreement = database.getAgreement(agreement.id);
    assert.equal(savedAgreement.status, 'signed');
    assert.equal(savedAgreement.signed_by, 'Jordan Referrer');
    assert.equal(savedAgreement.signature_data, signatureData);
    assert.ok(savedAgreement.signed_at);
  } finally {
    database.db.close();
  }
});

test('employee template requires employee fields and stores a personalized signed agreement without CEO or witness signature blocks', async () => {
  const database = createDatabase(':memory:');
  try {
    const admin = createUser(database, 'admin', 'template-admin@example.com');
    const employee = createUser(database, 'employee', 'template-employee@example.com');
    const app = createApp(database);
    const created = await request(app)
      .post('/api/agreements')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({
        employeeId: employee.id,
        type: 'employment',
        templateKey: 'employee-team-participation',
      });

    assert.equal(created.status, 201);
    const agreement = created.body.agreement;
    assert.equal(agreement.type, 'employee-team-participation');
    assert.deepEqual(agreement.fillableFields.map(({ name }) => name), ['effectiveDate', 'position', 'startDate']);
    assert.match(agreement.content, /For ClariCare Botanica Ltd/);
    assert.doesNotMatch(agreement.content, /Founder\/CEO\n\nName:/);
    assert.doesNotMatch(agreement.content, /##?\s*Witness/i);
    assert.match(agreement.content, /Team Member.*\{\{teamMemberName\}\}/);

    const employeeToken = tokenFor(employee);
    const missingFields = await request(app)
      .post(`/api/agreements/${agreement.id}/sign`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ signatureName: 'Taylor Example', signatureData, consent: true });
    assert.equal(missingFields.status, 400);

    const signed = await request(app)
      .post(`/api/agreements/${agreement.id}/sign`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        signatureName: 'Taylor Example',
        signatureData,
        consent: true,
        fields: {
          effectiveDate: '2026-11-01',
          position: 'Product Operations Associate',
          startDate: '2026-11-01',
        },
      });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.agreement.status, 'signed');
    assert.deepEqual(signed.body.agreement.fillableFields, []);
    assert.match(signed.body.agreement.content, /Effective Date:\*\* 2026-11-01/);
    assert.match(signed.body.agreement.content, /\*\*Team Member:\*\* Taylor Example/);
    assert.match(signed.body.agreement.content, /\*\*Position\/Role:\*\* Product Operations Associate/);
    assert.match(signed.body.agreement.content, /\*\*Start Date:\*\* 2026-11-01/);
    assert.match(signed.body.agreement.content, /### TEAM MEMBER ELECTRONIC SIGNATURE/);
    assert.doesNotMatch(signed.body.agreement.content, /### WITNESS|### FOUNDER\/CEO SIGNATURE/i);
    assert.equal(signed.body.agreement.signed_by, 'Taylor Example');
    assert.equal(signed.body.agreement.signature_data, signatureData);
  } finally {
    database.db.close();
  }
});
