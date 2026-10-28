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

test('employees can publish product measurements and customers keep selected prices through checkout', async () => {
  const database = createDatabase(':memory:');
  try {
    const employee = database.createUser({
      name: 'Catalog Employee',
      email: 'catalog@example.com',
      passwordHash: 'not-used-in-this-test',
      role: 'employee',
    });
    database.db.prepare('UPDATE users SET invitation_accepted_at=CURRENT_TIMESTAMP WHERE id=?').run(employee.id);
    const customer = database.createUser({
      name: 'Shopper',
      email: 'shopper-options@example.com',
      passwordHash: 'not-used-in-this-test',
      role: 'customer',
    });
    const app = createApp(database);

    const productResponse = await request(app)
      .post('/api/catalog/products')
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        name: 'Bond Maintenance Shampoo',
        category: 'Shampoo',
        brand: 'ClariCare',
        price: 5500,
        sizeOptions: [{ label: '250 ml', price: 5500 }, { label: '100 g', price: 3200 }],
        description: 'Gentle everyday cleansing.',
        howToUse: 'Massage into wet hair and rinse.',
        ingredients: 'Aqua, conditioning agents',
        benefits: 'For dry and damaged hair',
      });

    assert.equal(productResponse.status, 201);
    assert.deepEqual(productResponse.body.product.sizeOptions, [
      { label: '250 ml', price: 5500 },
      { label: '100 g', price: 3200 },
    ]);
    assert.equal(productResponse.body.product.brand, 'ClariCare');

    const productId = productResponse.body.product.id;
    const publicProduct = await request(app).get(`/api/catalog/products/${productId}`);
    assert.equal(publicProduct.status, 200);
    assert.equal(publicProduct.body.product.howToUse, 'Massage into wet hair and rinse.');
    assert.equal(publicProduct.body.product.ingredients, 'Aqua, conditioning agents');
    assert.equal(publicProduct.body.product.benefits, 'For dry and damaged hair');

    const customerToken = tokenFor(customer);
    const addLarge = await request(app)
      .post('/api/cart/add')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId, quantity: 1, variantLabel: '250 ml', price: 1 });
    const addSmall = await request(app)
      .post('/api/cart/add')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId, quantity: 2, variantLabel: '100 g', price: 1 });

    assert.equal(addLarge.status, 201);
    assert.equal(addSmall.status, 201);
    const cartResponse = await request(app)
      .get('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`);
    assert.equal(cartResponse.body.cart.items.length, 2);
    assert.deepEqual(
      cartResponse.body.cart.items.map((item) => [item.variant_label, item.quantity, item.unit_price]).sort(([a], [b]) => a.localeCompare(b)),
      [['100 g', 2, 3200], ['250 ml', 1, 5500]],
    );
    assert.equal(cartResponse.body.total, 11900);

    const checkout = await request(app)
      .post('/api/cart/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ paymentMethod: 'mpesa' });
    assert.equal(checkout.status, 201);
    assert.equal(checkout.body.sale.totalAmount, 11900);
    const saleItems = database.db.prepare('SELECT product_name, unit_price, quantity FROM sale_items WHERE sale_id=? ORDER BY product_name').all(checkout.body.sale.id);
    assert.deepEqual(saleItems, [
      { product_name: 'Bond Maintenance Shampoo (100 g)', unit_price: 3200, quantity: 2 },
      { product_name: 'Bond Maintenance Shampoo (250 ml)', unit_price: 5500, quantity: 1 },
    ]);
  } finally {
    database.db.close();
  }
});

test('product creation rejects duplicate or invalid measurement options', async () => {
  const database = createDatabase(':memory:');
  try {
    const employee = database.createUser({
      name: 'Catalog Employee',
      email: 'catalog-validation@example.com',
      passwordHash: 'not-used-in-this-test',
      role: 'employee',
    });
    database.db.prepare('UPDATE users SET invitation_accepted_at=CURRENT_TIMESTAMP WHERE id=?').run(employee.id);

    const response = await request(createApp(database))
      .post('/api/catalog/products')
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        name: 'Invalid Product',
        category: 'Care',
        price: 100,
        sizeOptions: [{ label: '250 ml', price: 100 }, { label: '250 ML', price: 200 }],
      });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /unique/i);
  } finally {
    database.db.close();
  }
});
