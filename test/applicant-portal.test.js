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

const completeAnswers = {
  country: 'Kenya',
  city: 'Nairobi',
  profileUrl: 'https://example.com/profile',
  workArrangement: 'full-time',
  education: 'Diploma in business administration',
  experienceYears: '1–2 years',
  previousExperience: 'Customer service experience.',
  skills: 'Communication, organization, teamwork.',
  achievement: 'Coordinated a successful community event.',
  motivation: 'I want to contribute to thoughtful care.',
  contribution: 'I can bring reliable customer support.',
  problemSolving: 'I investigated an issue and coordinated a solution.',
  teamwork: 'I worked with a team to deliver a project.',
  responsibility: 'I communicate limitations and prioritize transparently.',
  commitment: 'I follow through and learn as the company grows.',
  foundationalCommitment: 'I am suited to an early-stage team.',
  equityCommitment: 'I understand this is conditional and subject to a separate agreement.',
};

test('applicants submit applications, track progress, receive notifications, and cannot access other applications', async () => {
  const database = createDatabase(':memory:');
  const previousTransport = nodemailer.createTransport;
  const previousSmtpUser = process.env.SMTP_USER;
  const previousSmtpPassword = process.env.SMTP_APP_PASSWORD;
  const sentEmails = [];
  try {
    const admin = database.createUser({
      name: 'Recruitment Admin',
      email: 'recruit-admin@example.com',
      passwordHash: 'unused-test-hash',
      role: 'admin',
    });
    nodemailer.createTransport = () => ({
      sendMail: async (message) => { sentEmails.push(message); return { messageId: 'test-message' }; },
    });
    process.env.SMTP_USER = 'test@example.com';
    process.env.SMTP_APP_PASSWORD = 'test-password';
    const app = createApp(database);

    const department = database.db.prepare("SELECT id FROM departments WHERE name='Customer Experience'").get();
    const position = database.createPosition({
      title: 'Customer Care Associate',
      departmentId: department.id,
      description: 'Supports ClariCare customers.',
      requirements: 'Clear communication.',
      isHiring: true,
    });

    const registered = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Candidate Example', email: 'candidate@example.com', password: 'SecurePass123!', role: 'applicant' });
    assert.equal(registered.status, 201);
    const applicantToken = registered.body.token;

    const submitted = await request(app)
      .post('/api/recruitment/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        positionId: position.id,
        applicantPhone: '+254700000001',
        applicationType: 'foundational',
        cvUrl: 'https://example.com/candidate-cv',
        answers: completeAnswers,
      });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.application.application_type, 'foundational');
    assert.equal(submitted.body.application.answers.motivation, completeAnswers.motivation);
    assert.equal(submitted.body.notification.sent, true);
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].text, /not guaranteed ownership/i);

    const ownDashboard = await request(app)
      .get('/api/dashboard/applicant')
      .set('Authorization', `Bearer ${applicantToken}`);
    assert.equal(ownDashboard.status, 200);
    assert.equal(ownDashboard.body.applications.length, 1);
    assert.equal(ownDashboard.body.applications[0].history[0].status, 'submitted');

    const forbiddenRecruitmentList = await request(app)
      .get('/api/recruitment/applications')
      .set('Authorization', `Bearer ${applicantToken}`);
    assert.equal(forbiddenRecruitmentList.status, 403);

    const statusUpdate = await request(app)
      .patch(`/api/recruitment/applications/${submitted.body.application.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ status: 'interview', note: 'We would like to schedule an interview.' });
    assert.equal(statusUpdate.status, 200);
    assert.equal(statusUpdate.body.application.status, 'interview');
    assert.equal(statusUpdate.body.notification.sent, true);
    assert.equal(sentEmails.length, 2);
    assert.match(sentEmails[1].text, /schedule an interview/i);

    const updatedDashboard = await request(app)
      .get('/api/dashboard/applicant')
      .set('Authorization', `Bearer ${applicantToken}`);
    assert.equal(updatedDashboard.body.applications[0].status, 'interview');
    assert.equal(updatedDashboard.body.applications[0].history.length, 2);

    const disabledTrack = await request(app)
      .patch('/api/recruitment/settings')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ foundationalTeamEnabled: false });
    assert.equal(disabledTrack.status, 200);
    assert.equal(disabledTrack.body.foundationalTeamEnabled, false);
    const blockedFoundational = await request(app)
      .post('/api/recruitment/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        positionId: position.id,
        applicantPhone: '+254700000001',
        applicationType: 'foundational',
        answers: completeAnswers,
      });
    assert.equal(blockedFoundational.status, 409);
  } finally {
    nodemailer.createTransport = previousTransport;
    if (previousSmtpUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = previousSmtpUser;
    if (previousSmtpPassword === undefined) delete process.env.SMTP_APP_PASSWORD;
    else process.env.SMTP_APP_PASSWORD = previousSmtpPassword;
    database.db.close();
  }
});
