const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../data/.env/.env') });

const { createDatabase } = require('./db');
const { createApp } = require('./app');

const db = createDatabase();
const app = createApp(db);
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`ClariCare backend running on http://localhost:${port}`);
});
