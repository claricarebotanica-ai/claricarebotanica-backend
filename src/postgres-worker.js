const { parentPort, workerData } = require('node:worker_threads');
const { Client, types } = require('pg');

types.setTypeParser(20, Number);
types.setTypeParser(1700, Number);

const header = new Int32Array(workerData.sharedBuffer, 0, 2);
const body = new Uint8Array(workerData.sharedBuffer, 8);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const client = new Client({
  connectionString: workerData.connectionString,
  connectionTimeoutMillis: 25000,
  statement_timeout: 25000,
  ...(process.env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
  ...(process.env.DATABASE_SSL === 'false' ? { ssl: false } : {}),
});
let stopping = false;
let transactionDepth = 0;

const send = (payload) => {
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > body.length) {
    throw new Error('PostgreSQL response exceeds the database bridge size limit.');
  }
  body.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, 2);
  Atomics.notify(header, 0);
};

const execute = async ({ sql, values = [] }) => {
  const queryResult = await client.query(sql, values);
  const result = Array.isArray(queryResult) ? queryResult[queryResult.length - 1] : queryResult;
  return {
    rows: result.rows || [],
    rowCount: result.rowCount || 0,
  };
};

const handle = async (request) => {
  switch (request.type) {
    case 'query':
      return execute(request);
    case 'begin':
      if (transactionDepth++ === 0) await client.query('BEGIN');
      else await client.query(`SAVEPOINT claricare_${transactionDepth}`);
      return { rows: [], rowCount: 0 };
    case 'commit':
      if (transactionDepth <= 0) throw new Error('Cannot commit without a transaction.');
      if (--transactionDepth === 0) await client.query('COMMIT');
      else await client.query(`RELEASE SAVEPOINT claricare_${transactionDepth + 1}`);
      return { rows: [], rowCount: 0 };
    case 'rollback':
      if (transactionDepth > 0) {
        if (--transactionDepth === 0) await client.query('ROLLBACK');
        else {
          await client.query(`ROLLBACK TO SAVEPOINT claricare_${transactionDepth + 1}`);
          await client.query(`RELEASE SAVEPOINT claricare_${transactionDepth + 1}`);
        }
      }
      return { rows: [], rowCount: 0 };
    case 'close':
      stopping = true;
      await client.end();
      return { rows: [], rowCount: 0 };
    default:
      throw new Error(`Unknown PostgreSQL database operation: ${request.type}`);
  }
};

const main = async () => {
  try {
    await client.connect();
    send({ ready: true });
  } catch (error) {
    send({ ready: false, error: { message: error.message, code: error.code } });
    return;
  }

  while (!stopping) {
    Atomics.wait(header, 0, 0);
    if (Atomics.load(header, 0) !== 1) continue;

    const length = Atomics.load(header, 1);
    let response;
    try {
      const request = JSON.parse(decoder.decode(body.subarray(0, length)));
      response = { result: await handle(request) };
    } catch (error) {
      response = { error: { message: error.message, code: error.code, detail: error.detail } };
    }

    try {
      send(response);
    } catch (error) {
      send({ error: { message: error.message } });
    }
  }
};

main().catch((error) => {
  parentPort.postMessage({ error: { message: error.message, code: error.code } });
});
