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

test('profile and product uploads accept phone-sized images up to 10 MB', async () => {
  const database = createDatabase(':memory:');
  try {
    const user = database.createUser({
      name: 'Image Upload User',
      email: 'image-upload@example.com',
      passwordHash: 'unused-test-hash',
      role: 'customer',
    });
    const app = createApp(database);
    const authorization = `Bearer ${tokenFor(user)}`;
    const phoneImage = `data:image/jpeg;base64,${Buffer.alloc(6 * 1024 * 1024).toString('base64')}`;

    const profile = await request(app)
      .patch('/api/account/profile')
      .set('Authorization', authorization)
      .send({ profileImage: phoneImage });
    assert.equal(profile.status, 200);

    const product = await request(app)
      .post('/api/catalog/products')
      .send({
        name: 'Phone Photo Product',
        category: 'Skincare',
        description: '',
        price: 100,
        imageUrl: phoneImage,
      });
    assert.equal(product.status, 201);

    const oversizedImage = `data:image/jpeg;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`;
    const oversized = await request(app)
      .patch('/api/account/profile')
      .set('Authorization', authorization)
      .send({ profileImage: oversizedImage });
    assert.equal(oversized.status, 413);
  } finally {
    database.db.close();
  }
});
