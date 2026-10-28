const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const tokenFor = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role },
  process.env.JWT_SECRET || 'claricare-dev-secret'
);

const createEmployee = (database, departmentId, email) => {
  const employee = database.createUser({
    name: email.split('@')[0],
    email,
    passwordHash: 'unused-test-hash',
    role: 'employee',
    departmentId,
  });
  database.db.prepare('UPDATE users SET invitation_accepted_at=CURRENT_TIMESTAMP WHERE id=?').run(employee.id);
  return employee;
};

test('department members share discussions while admins can access every department', async () => {
  const database = createDatabase(':memory:');
  try {
    const firstDepartment = database.createDepartment({ name: 'Operations', description: '' });
    const secondDepartment = database.createDepartment({ name: 'Finance', description: '' });
    const admin = database.createUser({
      name: 'Admin',
      email: 'discussion-admin@example.com',
      passwordHash: 'unused-test-hash',
      role: 'admin',
    });
    const sender = createEmployee(database, firstDepartment.id, 'sender@example.com');
    const colleague = createEmployee(database, firstDepartment.id, 'colleague@example.com');
    const otherDepartmentEmployee = createEmployee(database, secondDepartment.id, 'finance@example.com');
    const app = createApp(database);

    const senderAuth = `Bearer ${tokenFor(sender)}`;
    const colleagueAuth = `Bearer ${tokenFor(colleague)}`;
    const otherDepartmentAuth = `Bearer ${tokenFor(otherDepartmentEmployee)}`;
    const adminAuth = `Bearer ${tokenFor(admin)}`;

    const departmentList = await request(app)
      .get('/api/company/discussions')
      .set('Authorization', senderAuth);
    assert.equal(departmentList.status, 200);
    assert.deepEqual(departmentList.body.departments, [{ id: firstDepartment.id, name: firstDepartment.name }]);

    const posted = await request(app)
      .post(`/api/company/departments/${firstDepartment.id}/messages`)
      .set('Authorization', senderAuth)
      .send({ message: 'We should review the weekly plan.' });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.message.sender_id, sender.id);
    assert.equal(posted.body.message.sender_name, sender.name);

    const colleagueView = await request(app)
      .get(`/api/company/departments/${firstDepartment.id}/messages`)
      .set('Authorization', colleagueAuth);
    assert.equal(colleagueView.status, 200);
    assert.equal(colleagueView.body.messages.length, 1);
    assert.equal(colleagueView.body.messages[0].message, 'We should review the weekly plan.');

    const blockedRead = await request(app)
      .get(`/api/company/departments/${firstDepartment.id}/messages`)
      .set('Authorization', otherDepartmentAuth);
    assert.equal(blockedRead.status, 404);

    const blockedPost = await request(app)
      .post(`/api/company/departments/${firstDepartment.id}/messages`)
      .set('Authorization', otherDepartmentAuth)
      .send({ message: 'This must not be visible to another department.' });
    assert.equal(blockedPost.status, 404);

    const adminDepartments = await request(app)
      .get('/api/company/discussions')
      .set('Authorization', adminAuth);
    assert.equal(adminDepartments.status, 200);
    assert.ok(adminDepartments.body.departments.some(({ id }) => id === firstDepartment.id));
    assert.ok(adminDepartments.body.departments.some(({ id }) => id === secondDepartment.id));

    const adminMessages = await request(app)
      .get(`/api/company/departments/${firstDepartment.id}/messages`)
      .set('Authorization', adminAuth);
    assert.equal(adminMessages.status, 200);
    assert.equal(adminMessages.body.messages.length, 1);

    const invalidMessage = await request(app)
      .post(`/api/company/departments/${firstDepartment.id}/messages`)
      .set('Authorization', colleagueAuth)
      .send({ message: '   ' });
    assert.equal(invalidMessage.status, 400);
  } finally {
    database.db.close();
  }
});
