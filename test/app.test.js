const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const buildApp = () => {
  const db = createDatabase(':memory:');
  return createApp(db);
};

test('GET /api/health returns service status', async () => {
  const app = buildApp();
  const response = await request(app).get('/api/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('register and login flow works for applicants', async () => {
  const app = buildApp();

  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Nadia M.',
      email: 'nadia@example.com',
      password: 'StrongPass123!',
      role: 'applicant'
    });

  assert.equal(registerRes.status, 201);
  assert.equal(registerRes.body.user.role, 'applicant');

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({
      email: 'nadia@example.com',
      password: 'StrongPass123!'
    });

  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.body.token);
  assert.equal(loginRes.body.user.email, 'nadia@example.com');
});

test('positions, agreements and review workflow are available', async () => {
  const app = buildApp();

  const seedRes = await request(app)
    .post('/api/company/departments')
    .send({ name: 'Product Lab', description: 'Research and product design' });

  assert.equal(seedRes.status, 201);

  const positionRes = await request(app)
    .post('/api/recruitment/positions')
    .send({
      title: 'Formulation Researcher',
      departmentId: seedRes.body.department.id,
      description: 'Develop skincare formulations',
      requirements: 'Cosmetic science knowledge'
    });

  assert.equal(positionRes.status, 201);

  const employee = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Team Member',
      email: 'member@example.com',
      password: 'StrongPass123!',
      role: 'employee'
    });

  assert.equal(employee.status, 201);

  const agreementRes = await request(app)
    .post('/api/agreements')
    .send({
      employeeId: employee.body.user.id,
      type: 'employment',
      title: 'Employment Agreement',
      content: 'Employee agrees to company policies and professional standards.'
    });

  assert.equal(agreementRes.status, 201);
  assert.equal(agreementRes.body.agreement.type, 'employment');

  const reviewRes = await request(app)
    .post('/api/catalog/products')
    .send({
      name: 'ClariCare Glow Serum',
      category: 'Skincare',
      description: 'Hydrating facial serum'
    });

  assert.equal(reviewRes.status, 201);

  const customerReview = await request(app)
    .post(`/api/catalog/products/${reviewRes.body.product.id}/reviews`)
    .send({
      rating: 5,
      comment: 'Excellent product and easy to use'
    });

  assert.equal(customerReview.status, 201);
  assert.equal(customerReview.body.review.rating, 5);
});

test('customer messages, sales accounting and referral logic work', async () => {
  const app = buildApp();

  const customer = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Customer One',
      email: 'customerone@example.com',
      password: 'StrongPass123!',
      role: 'customer'
    });

  assert.equal(customer.status, 201);

  const messageRes = await request(app)
    .post('/api/customers/messages')
    .send({
      customerId: customer.body.user.id,
      customerName: 'Customer One',
      phone: '+254700000001',
      channel: 'message',
      message: 'I want to know if this serum is suitable for sensitive skin.'
    });

  assert.equal(messageRes.status, 201);
  assert.equal(messageRes.body.message.channel, 'message');

  const productRes = await request(app)
    .post('/api/catalog/products')
    .send({
      name: 'ClariCare Repair Cream',
      category: 'Skincare',
      description: 'Nourishing cream for sensitive skin'
    });

  const ingredientRes = await request(app)
    .post('/api/accounting/ingredients/purchases')
    .send({
      name: 'Aloe Vera Extract',
      unit: 'litre',
      quantity: 10,
      unitCost: 150,
      supplier: 'Green Labs Ltd'
    });

  assert.equal(ingredientRes.status, 201);
  assert.equal(ingredientRes.body.purchase.totalCost, 1500);

  const saleRes = await request(app)
    .post('/api/accounting/sales')
    .send({
      customerId: customer.body.user.id,
      customerName: 'Customer One',
      items: [{
        productId: productRes.body.product.id,
        quantity: 2,
        unitPrice: 2000,
        costPrice: 1200
      }],
      paymentMethod: 'cash'
    });

  assert.equal(saleRes.status, 201);
  assert.equal(saleRes.body.sale.totalAmount, 4000);

  const summaryRes = await request(app).get('/api/accounting/summary');
  assert.equal(summaryRes.status, 200);
  assert.ok(summaryRes.body.summary.totalRevenue >= 4000);

  const referralRes = await request(app)
    .post('/api/referrals')
    .send({
      referrerId: customer.body.user.id,
      customerId: customer.body.user.id,
      customerName: 'Customer One',
      saleAmount: 4000,
      referredAt: new Date().toISOString(),
      note: 'Direct referral'
    });

  assert.equal(referralRes.status, 201);
  assert.equal(referralRes.body.referral.commissionRate, 5);
  assert.ok(referralRes.body.referral.commissionAmount > 0);
});

test('dashboard access is restricted by role', async () => {
  const app = buildApp();

  const admin = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Admin User',
      email: 'admin@example.com',
      password: 'StrongPass123!',
      role: 'admin'
    });

  const employee = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Employee User',
      email: 'employee@example.com',
      password: 'StrongPass123!',
      role: 'employee'
    });

  const customer = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Customer User',
      email: 'customer@example.com',
      password: 'StrongPass123!',
      role: 'customer'
    });

  const adminRes = await request(app)
    .get('/api/dashboard/admin')
    .set('Authorization', `Bearer ${admin.body.token}`);

  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.body.dashboard, 'admin');

  const employeeRes = await request(app)
    .get('/api/dashboard/admin')
    .set('Authorization', `Bearer ${employee.body.token}`);

  assert.equal(employeeRes.status, 403);

  const customerDash = await request(app)
    .get('/api/dashboard/customer')
    .set('Authorization', `Bearer ${customer.body.token}`);

  assert.equal(customerDash.status, 200);
  assert.equal(customerDash.body.dashboard, 'customer');

  const referrer = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Referrer User',
      email: 'referrer@example.com',
      password: 'StrongPass123!',
      role: 'referrer'
    });

  const referrerDash = await request(app)
    .get('/api/dashboard/referrer')
    .set('Authorization', `Bearer ${referrer.body.token}`);

  assert.equal(referrerDash.status, 200);
  assert.equal(referrerDash.body.dashboard, 'referrer');
});

test('product storefront supports price, cart and checkout', async () => {
  const app = buildApp();

  const customer = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Shopper User',
      email: 'shopper@example.com',
      password: 'StrongPass123!',
      role: 'customer'
    });

  const productRes = await request(app)
    .post('/api/catalog/products')
    .send({
      name: 'Glow Serum',
      category: 'Skincare',
      description: 'Hydrating serum for all skin types',
      price: 1800
    });

  assert.equal(productRes.status, 201);
  assert.equal(productRes.body.product.price, 1800);

  const catalogRes = await request(app).get('/api/catalog/products');
  assert.equal(catalogRes.status, 200);
  assert.ok(catalogRes.body.products.some((product) => product.price === 1800));

  const addToCartRes = await request(app)
    .post('/api/cart/add')
    .send({
      customerId: customer.body.user.id,
      productId: productRes.body.product.id,
      quantity: 2
    });

  assert.equal(addToCartRes.status, 201);
  assert.equal(addToCartRes.body.item.quantity, 2);

  const cartRes = await request(app)
    .get(`/api/cart/${customer.body.user.id}`);

  assert.equal(cartRes.status, 200);
  assert.equal(cartRes.body.cart.items.length, 1);

  const checkoutRes = await request(app)
    .post('/api/cart/checkout')
    .send({
      customerId: customer.body.user.id,
      paymentMethod: 'mpesa'
    });

  assert.equal(checkoutRes.status, 201);
  assert.equal(checkoutRes.body.sale.totalAmount, 3600);
});
