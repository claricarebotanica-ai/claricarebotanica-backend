const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

function createDatabase(filePath = process.env.DATABASE_PATH || './data/claricare.db') {
  const normalizedPath = filePath === ':memory:' ? ':memory:' : path.resolve(filePath);

  if (normalizedPath !== ':memory:') {
    const directory = path.dirname(normalizedPath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  const db = new Database(normalizedPath);

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'applicant',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id, created_at);

    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      department_id TEXT NOT NULL,
      description TEXT,
      requirements TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      is_hiring INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id)
    );

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      application_number TEXT,
      applicant_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      cv_url TEXT,
      cover_letter TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      application_type TEXT NOT NULL DEFAULT 'regular',
      applicant_phone TEXT NOT NULL DEFAULT '',
      answers_json TEXT NOT NULL DEFAULT '{}',
      hr_recommendation TEXT,
      ceo_decision TEXT,
      ceo_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (applicant_id) REFERENCES users(id),
      FOREIGN KEY (position_id) REFERENCES positions(id)
    );

    CREATE TABLE IF NOT EXISTS application_status_history (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      changed_by TEXT,
      is_private INTEGER NOT NULL DEFAULT 0,
      event_type TEXT NOT NULL DEFAULT 'status',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS application_documents (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      document_type TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      storage_path TEXT NOT NULL UNIQUE,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS application_interviews (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL UNIQUE,
      invitation_token_hash TEXT,
      token_expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'not_invited',
      consent_at TEXT,
      camera_test_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS application_interview_questions (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL,
      question_number INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      prep_seconds INTEGER NOT NULL DEFAULT 30,
      answer_seconds INTEGER NOT NULL DEFAULT 180,
      critical INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id),
      UNIQUE(department_id,question_number)
    );

    CREATE TABLE IF NOT EXISTS application_interview_events (
      id TEXT PRIMARY KEY,
      interview_id TEXT NOT NULL,
      question_number INTEGER,
      event_type TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (interview_id) REFERENCES application_interviews(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS application_hr_notes (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS department_messages (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS department_messages_history_idx ON department_messages(department_id, created_at, id);

    CREATE TABLE IF NOT EXISTS recruitment_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agreements (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      signature_url TEXT,
      signature_data TEXT,
      fillable_fields TEXT NOT NULL DEFAULT '[]',
      signed_by TEXT,
      signed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL DEFAULT 0,
      image_url TEXT,
      size_options TEXT NOT NULL DEFAULT '[]',
      brand TEXT,
      how_to_use TEXT,
      ingredients TEXT,
      benefits TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_reviews (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS carts (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      id TEXT PRIMARY KEY,
      cart_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      variant_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cart_id) REFERENCES carts(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS customer_messages (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      customer_name TEXT NOT NULL,
      phone TEXT,
      channel TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ingredient_purchases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit_cost REAL NOT NULL,
      total_cost REAL NOT NULL,
      supplier TEXT,
      purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      customer_name TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      total_amount REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      cost_price REAL NOT NULL,
      subtotal REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_id TEXT,
      customer_id TEXT,
      customer_name TEXT NOT NULL,
      sale_id TEXT,
      sale_amount REAL NOT NULL DEFAULT 0,
      commission_rate REAL NOT NULL DEFAULT 5,
      commission_amount REAL NOT NULL DEFAULT 0,
      referred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      window_minutes INTEGER NOT NULL DEFAULT 30,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (referrer_id) REFERENCES users(id),
      FOREIGN KEY (customer_id) REFERENCES users(id),
      FOREIGN KEY (sale_id) REFERENCES sales(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_materials (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL DEFAULT 'ingredient',
      unit TEXT NOT NULL, reorder_level REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS material_movements (
      id TEXT PRIMARY KEY, material_id TEXT NOT NULL, movement_type TEXT NOT NULL,
      quantity REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, reference TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(material_id) REFERENCES inventory_materials(id)
    );
    CREATE TABLE IF NOT EXISTS product_formulas (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, version INTEGER NOT NULL,
      expected_yield REAL NOT NULL, labour_cost REAL NOT NULL DEFAULT 0,
      overhead_cost REAL NOT NULL DEFAULT 0, equipment_depreciation REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id), UNIQUE(product_id, version)
    );
    CREATE TABLE IF NOT EXISTS formula_items (
      id TEXT PRIMARY KEY, formula_id TEXT NOT NULL, material_id TEXT NOT NULL, quantity REAL NOT NULL,
      FOREIGN KEY(formula_id) REFERENCES product_formulas(id), FOREIGN KEY(material_id) REFERENCES inventory_materials(id)
    );
    CREATE TABLE IF NOT EXISTS production_batches (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, formula_id TEXT NOT NULL,
      produced_quantity REAL NOT NULL, saleable_quantity REAL NOT NULL, total_cost REAL NOT NULL,
      unit_cost REAL NOT NULL, notes TEXT, produced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id), FOREIGN KEY(formula_id) REFERENCES product_formulas(id)
    );
    CREATE TABLE IF NOT EXISTS equipment_assets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, purchase_price REAL NOT NULL CHECK(purchase_price > 0),
      purchase_date TEXT NOT NULL, useful_life_months INTEGER NOT NULL CHECK(useful_life_months > 0),
      residual_value REAL NOT NULL DEFAULT 0 CHECK(residual_value >= 0),
      depreciation_method TEXT NOT NULL DEFAULT 'straight_line' CHECK(depreciation_method = 'straight_line'),
      category TEXT, notes TEXT, allocation_basis TEXT NOT NULL DEFAULT 'per_unit' CHECK(allocation_basis IN ('per_unit','per_batch')),
      allocation_quantity REAL NOT NULL DEFAULT 1 CHECK(allocation_quantity > 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS equipment_assets_active_name_idx ON equipment_assets(is_active,name);
    CREATE TABLE IF NOT EXISTS finished_stock_movements (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, movement_type TEXT NOT NULL, quantity REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0, reference TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS inventory_expenses (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL,
      paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS contact_conversations (
      id TEXT PRIMARY KEY, customer_id TEXT, name TEXT NOT NULL, email TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT 'Contact request', status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS contact_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_type TEXT NOT NULL CHECK(sender_type IN ('visitor','admin')),
      message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES contact_conversations(id)
    );
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, staff_id TEXT, status TEXT NOT NULL DEFAULT 'waiting'
        CHECK(status IN ('waiting','active','ended')), requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      accepted_at TEXT, ended_at TEXT, FOREIGN KEY(customer_id) REFERENCES users(id), FOREIGN KEY(staff_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS calls_status_requested_idx ON calls(status, requested_at);
    CREATE TABLE IF NOT EXISTS call_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      signal_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(call_id) REFERENCES calls(id), FOREIGN KEY(sender_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS company_updates (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1,
      created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS content_posts (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('blog','news','video')),
      excerpt TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      cover_image_url TEXT, video_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
      author_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT,
      FOREIGN KEY(author_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS content_posts_public_idx ON content_posts(status,type,published_at);
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1,
      subscribed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, unsubscribed_at TEXT
    );
  `);

  // Add stock and cost to the existing storefront product records without breaking older databases.
  const productColumns = db.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
  if (!productColumns.includes('price')) db.exec('ALTER TABLE products ADD COLUMN price REAL NOT NULL DEFAULT 0');
  if (!productColumns.includes('inventory_enabled')) db.exec('ALTER TABLE products ADD COLUMN inventory_enabled INTEGER NOT NULL DEFAULT 0');
  if (!productColumns.includes('image_url')) db.exec('ALTER TABLE products ADD COLUMN image_url TEXT');
  if (!productColumns.includes('size_options')) db.exec("ALTER TABLE products ADD COLUMN size_options TEXT NOT NULL DEFAULT '[]'");
  if (!productColumns.includes('brand')) db.exec('ALTER TABLE products ADD COLUMN brand TEXT');
  if (!productColumns.includes('how_to_use')) db.exec('ALTER TABLE products ADD COLUMN how_to_use TEXT');
  if (!productColumns.includes('ingredients')) db.exec('ALTER TABLE products ADD COLUMN ingredients TEXT');
  if (!productColumns.includes('benefits')) db.exec('ALTER TABLE products ADD COLUMN benefits TEXT');
  const materialMovementColumns = db.prepare('PRAGMA table_info(material_movements)').all().map((column) => column.name);
  if (!materialMovementColumns.includes('receipt_url')) db.exec('ALTER TABLE material_movements ADD COLUMN receipt_url TEXT');
  const cartItemColumns = db.prepare('PRAGMA table_info(cart_items)').all().map((column) => column.name);
  if (!cartItemColumns.includes('variant_label')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE cart_items_new (
          id TEXT PRIMARY KEY,
          cart_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          unit_price REAL NOT NULL DEFAULT 0,
          variant_label TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (cart_id) REFERENCES carts(id),
          FOREIGN KEY (product_id) REFERENCES products(id)
        );
        INSERT INTO cart_items_new (id, cart_id, product_id, quantity, unit_price, created_at)
        SELECT id, cart_id, product_id, quantity, unit_price, created_at FROM cart_items;
        DROP TABLE cart_items;
        ALTER TABLE cart_items_new RENAME TO cart_items;
      `);
    })();
  }
  db.exec('CREATE INDEX IF NOT EXISTS cart_items_cart_product_idx ON cart_items(cart_id, product_id, variant_label)');
  const messageColumns = db.prepare('PRAGMA table_info(customer_messages)').all().map((column) => column.name);
  if (!messageColumns.includes('email')) db.exec("ALTER TABLE customer_messages ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  const conversationColumns = db.prepare('PRAGMA table_info(contact_conversations)').all().map((column) => column.name);
  if (!conversationColumns.includes('deleted_at')) db.exec('ALTER TABLE contact_conversations ADD COLUMN deleted_at TEXT');
  const contactMessageColumns = db.prepare('PRAGMA table_info(contact_messages)').all().map((column) => column.name);
  if (!contactMessageColumns.includes('deleted_at')) db.exec('ALTER TABLE contact_messages ADD COLUMN deleted_at TEXT');
  const callColumns = db.prepare('PRAGMA table_info(calls)').all().map((column) => column.name);
  if (!callColumns.includes('media_type')) db.exec("ALTER TABLE calls ADD COLUMN media_type TEXT NOT NULL DEFAULT 'audio'");
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  const applicationColumns = db.prepare('PRAGMA table_info(applications)').all().map((column) => column.name);
  if (!applicationColumns.includes('application_type')) db.exec("ALTER TABLE applications ADD COLUMN application_type TEXT NOT NULL DEFAULT 'regular'");
  if (!applicationColumns.includes('applicant_phone')) db.exec("ALTER TABLE applications ADD COLUMN applicant_phone TEXT NOT NULL DEFAULT ''");
  if (!applicationColumns.includes('answers_json')) db.exec("ALTER TABLE applications ADD COLUMN answers_json TEXT NOT NULL DEFAULT '{}'");
  if (!applicationColumns.includes('application_number')) db.exec('ALTER TABLE applications ADD COLUMN application_number TEXT');
  if (!applicationColumns.includes('hr_recommendation')) db.exec('ALTER TABLE applications ADD COLUMN hr_recommendation TEXT');
  if (!applicationColumns.includes('ceo_decision')) db.exec('ALTER TABLE applications ADD COLUMN ceo_decision TEXT');
  if (!applicationColumns.includes('ceo_note')) db.exec("ALTER TABLE applications ADD COLUMN ceo_note TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE applications SET application_number='APP-' || strftime('%Y','now') || '-' || upper(substr(id,1,8)) WHERE application_number IS NULL").run();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS applications_reference_idx ON applications(application_number)');
  const applicationHistoryColumns = db.prepare('PRAGMA table_info(application_status_history)').all().map((column) => column.name);
  if (!applicationHistoryColumns.includes('is_private')) db.exec('ALTER TABLE application_status_history ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
  if (!applicationHistoryColumns.includes('event_type')) db.exec("ALTER TABLE application_status_history ADD COLUMN event_type TEXT NOT NULL DEFAULT 'status'");
  db.prepare("INSERT OR IGNORE INTO recruitment_settings (key,value) VALUES ('foundational_team_enabled','true')").run();
  db.prepare("INSERT OR IGNORE INTO recruitment_settings (key,value) VALUES ('max_foundational_positions','0')").run();
  db.exec('CREATE INDEX IF NOT EXISTS applications_applicant_created_idx ON applications(applicant_id,created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS application_status_history_app_idx ON application_status_history(application_id,created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS application_documents_app_idx ON application_documents(application_id,created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS application_interview_events_interview_idx ON application_interview_events(interview_id,created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS application_hr_notes_app_idx ON application_hr_notes(application_id,created_at)');
  const agreementColumns = db.prepare('PRAGMA table_info(agreements)').all().map((column) => column.name);
  if (!agreementColumns.includes('signature_data')) db.exec('ALTER TABLE agreements ADD COLUMN signature_data TEXT');
  if (!agreementColumns.includes('fillable_fields')) db.exec("ALTER TABLE agreements ADD COLUMN fillable_fields TEXT NOT NULL DEFAULT '[]'");
  db.exec("UPDATE agreements SET status='pending_signature' WHERE status='draft'");
  db.exec('CREATE INDEX IF NOT EXISTS agreements_user_status_idx ON agreements(employee_id,status,created_at)');
  if (!userColumns.includes('deleted_at')) db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
  for (const table of ['positions', 'company_updates', 'content_posts']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    if (!columns.includes('deleted_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
  }
  if (!userColumns.includes('profile_image')) db.exec('ALTER TABLE users ADD COLUMN profile_image TEXT');
  if (!userColumns.includes('position')) db.exec('ALTER TABLE users ADD COLUMN position TEXT');
  if (!userColumns.includes('department_id')) db.exec('ALTER TABLE users ADD COLUMN department_id TEXT');
  if (!userColumns.includes('position_id')) db.exec('ALTER TABLE users ADD COLUMN position_id TEXT');
  if (!userColumns.includes('invitation_token_hash')) db.exec('ALTER TABLE users ADD COLUMN invitation_token_hash TEXT');
  if (!userColumns.includes('invitation_expires_at')) db.exec('ALTER TABLE users ADD COLUMN invitation_expires_at TEXT');
  if (!userColumns.includes('invitation_accepted_at')) db.exec('ALTER TABLE users ADD COLUMN invitation_accepted_at TEXT');
  db.exec("UPDATE users SET invitation_accepted_at=COALESCE(created_at,CURRENT_TIMESTAMP) WHERE role='employee' AND invitation_accepted_at IS NULL AND invitation_token_hash IS NULL");
  const positionColumns = db.prepare('PRAGMA table_info(positions)').all().map((column) => column.name);
  if (!positionColumns.includes('is_hiring')) db.exec('ALTER TABLE positions ADD COLUMN is_hiring INTEGER NOT NULL DEFAULT 1');
  const defaultDepartments = [
    { name: 'Leadership & Operations', description: 'Company direction, cross-team coordination, operating priorities, budgets, and key partnerships.' },
    { name: 'Product Development & Formulation', description: 'Product briefs, formulation development, product information, and product launches.' },
    { name: 'Quality & Regulatory', description: 'Product and supplier documentation, quality checks, labeling and claims review, and compliance coordination.' },
    { name: 'Production & Packaging', description: 'Production planning, approved procedures, batch records, packaging, and finished-product preparation.' },
    { name: 'Supply Chain & Inventory', description: 'Supplier coordination, purchasing, inventory movement, expiry monitoring, and replenishment.' },
    { name: 'E-commerce & IT', description: 'Online store operations, company systems, user access, technical support, backups, and integrations.' },
    { name: 'Marketing & Sales', description: 'Brand communications, approved educational content, campaigns, customer acquisition, and commercial partnerships.' },
    { name: 'Customer Experience', description: 'Customer enquiries, order support, feedback, complaints, and customer-care service quality.' },
    { name: 'Education & Formulation Services', description: 'Cosmetic education, learning resources, formulation consultations, and client project coordination.' },
    { name: 'Finance & Administration', description: 'Bookkeeping, reconciliations, approved financial processes, records, scheduling, and office coordination.' },
    { name: 'People & Recruitment', description: 'Recruitment, onboarding, employee records, training coordination, and people operations.' },
    { name: 'Fulfilment & Delivery', description: 'Order picking, packing checks, dispatch coordination, and delivery follow-up.' },
  ];
  const defaultPositions = [
    ['Leadership & Operations', 'Founder / Managing Director', 'Sets company direction, approves budgets and major decisions, and leads key partnerships.'],
    ['Leadership & Operations', 'Operations Manager', 'Coordinates cross-functional priorities, follows up on work, and escalates operational issues.'],
    ['Product Development & Formulation', 'Product Development Lead', 'Maintains product briefs and roadmap, coordinates product changes, and manages launches.'],
    ['Product Development & Formulation', 'Cosmetic Formulator', 'Develops and improves cosmetic formulas, records ingredients and processes, and supports formulation projects.'],
    ['Product Development & Formulation', 'Product Coordinator', 'Maintains complete and accurate product descriptions, sizes, images, and catalog details.'],
    ['Quality & Regulatory', 'Quality & Regulatory Lead', 'Maintains quality and supplier documentation, coordinates compliance checks, and reviews labels and product claims.'],
    ['Quality & Regulatory', 'Quality Control Technician', 'Records incoming-material and finished-product checks, reports deviations, and maintains batch quality records.'],
    ['Production & Packaging', 'Production Supervisor', 'Schedules production, assigns work, and reviews production and batch records.'],
    ['Production & Packaging', 'Production Technician', 'Follows approved production procedures and records batch activities accurately.'],
    ['Production & Packaging', 'Packaging Technician', 'Fills, labels, packages, and records finished products using approved instructions.'],
    ['Supply Chain & Inventory', 'Procurement Officer', 'Requests supplier quotes, places approved orders, and tracks supplier deliveries.'],
    ['Supply Chain & Inventory', 'Inventory / Stores Coordinator', 'Records stock movements, monitors quantities and expiry dates, and raises replenishment needs.'],
    ['E-commerce & IT', 'IT / Systems Administrator', 'Manages accounts, access, backups, security controls, and internal technical support.'],
    ['E-commerce & IT', 'E-commerce Coordinator', 'Maintains approved online catalog content, prices, and e-commerce order workflows.'],
    ['E-commerce & IT', 'Web Developer / IT Support', 'Maintains the website and integrations and troubleshoots technical issues.'],
    ['Marketing & Sales', 'Marketing Lead', 'Plans campaigns, coordinates brand communications, and tracks marketing results.'],
    ['Marketing & Sales', 'Content Creator', 'Prepares product and educational content using claims approved through the quality process.'],
    ['Marketing & Sales', 'Sales / Partnerships Executive', 'Handles wholesale enquiries, business development, and approved commercial partnerships.'],
    ['Customer Experience', 'Customer Care Lead', 'Assigns customer enquiries, monitors response quality, and escalates complaints or safety concerns.'],
    ['Customer Experience', 'Customer Care Agent', 'Responds to assigned customer questions, order issues, and feedback.'],
    ['Education & Formulation Services', 'Education / Training Lead', 'Plans workshops, learning resources, and cosmetic education activities.'],
    ['Education & Formulation Services', 'Formulation Services Consultant', 'Coordinates client briefs, consultations, and formulation-project follow-ups.'],
    ['Finance & Administration', 'Finance Officer / Accountant', 'Records transactions, prepares reconciliations and reports, and performs authorized finance tasks.'],
    ['Finance & Administration', 'Administrator', 'Supports records, scheduling, office coordination, and routine administration.'],
    ['People & Recruitment', 'HR / Recruitment Coordinator', 'Coordinates vacancies, applications, onboarding, employee records, and training administration.'],
    ['Fulfilment & Delivery', 'Fulfilment Coordinator', 'Prepares orders, verifies items and delivery details, and tracks dispatch status.'],
  ];
  const seedCompanyStructure = db.transaction(() => {
    const departmentIds = new Map();
    for (const department of defaultDepartments) {
      let existing = db.prepare('SELECT id FROM departments WHERE name=? COLLATE NOCASE').get(department.name);
      if (!existing) {
        const id = uuidv4();
        db.prepare('INSERT INTO departments (id,name,description) VALUES (?,?,?)').run(id, department.name, department.description);
        existing = { id };
      }
      departmentIds.set(department.name, existing.id);
    }
    for (const [departmentName, title, description] of defaultPositions) {
      const departmentId = departmentIds.get(departmentName);
      const existing = db.prepare('SELECT id FROM positions WHERE department_id=? AND title=? COLLATE NOCASE').get(departmentId, title);
      if (!existing) {
        db.prepare(`INSERT INTO positions (id,title,department_id,description,requirements,status,is_hiring)
          VALUES (?,?,?,?,'','open',0)`).run(uuidv4(), title, departmentId, description);
      }
    }
  });
  seedCompanyStructure();
  const defaultInterviewQuestions = {
    'Marketing & Sales': [
      'Explain how you would help ClariCare attract its first 100 customers. Which marketing channels would you prioritize and why?',
      'ClariCare gives you a small marketing budget and asks you to generate measurable sales within 30 days. What would you do in the first week, how would you use the budget, and how would you measure results?',
    ],
    'Customer Experience': [
      'A customer is extremely unhappy with a product and is demanding a refund. How would you handle the situation?',
      'A customer reports a possible product reaction after use. What steps would you take to support the customer and escalate the concern?',
    ],
    'Product Development & Formulation': [
      'If asked to develop a new product, explain how you would move from an idea to a tested and usable product.',
      'A product receives negative feedback during testing. What information would you collect and how would you decide whether to change it?',
    ],
    'Finance & Administration': [
      'If ClariCare has limited funds and several departments request money, how would you help management decide where funds should go?',
      'ClariCare needs ingredients for production, but available cash is limited. How would you evaluate the purchase and advise the CEO?',
    ],
    'People & Recruitment': [
      'How would you handle a serious disagreement between two employees that is affecting their work?',
      'How would you make recruitment and onboarding fair, organized, and useful for a small early-stage company?',
    ],
    'Production & Packaging': [
      'If you discovered a problem with a product during production, what would you do before allowing it to reach customers?',
      'How would you investigate a repeated production variation and prevent affected batches from being released?',
    ],
    'E-commerce & IT': [
      'If an important company system stopped working during business hours, how would you diagnose and resolve the problem?',
      'How would you protect customer and company information while maintaining a reliable online store?',
    ],
  };
  const seedInterviewQuestions = db.transaction(() => {
    for (const [departmentName, prompts] of Object.entries(defaultInterviewQuestions)) {
      const department = db.prepare('SELECT id FROM departments WHERE name=? COLLATE NOCASE').get(departmentName);
      if (!department) continue;
      prompts.forEach((prompt, index) => {
        db.prepare(`
          INSERT OR IGNORE INTO application_interview_questions
            (id,department_id,question_number,prompt,prep_seconds,answer_seconds,critical,active)
          VALUES (?,?,?,?,30,180,1,1)
        `).run(uuidv4(), department.id, index + 1, prompt);
      });
    }
    const genericDepartments = db.prepare(`
      SELECT d.id,d.name FROM departments d
      WHERE NOT EXISTS (SELECT 1 FROM application_interview_questions q WHERE q.department_id=d.id)
    `).all();
    for (const department of genericDepartments) {
      [
        `Describe a role-specific challenge you expect in ${department.name} and how you would approach it.`,
        `ClariCare has limited resources and an urgent priority in ${department.name}. Explain how you would make a sound decision and measure the result.`,
      ].forEach((prompt, index) => {
        db.prepare(`
          INSERT INTO application_interview_questions
            (id,department_id,question_number,prompt,prep_seconds,answer_seconds,critical,active)
          VALUES (?,?,?,?,30,180,1,1)
        `).run(uuidv4(), department.id, index + 1, prompt);
      });
    }
  });
  seedInterviewQuestions();
  const productionBatchColumns = db.prepare('PRAGMA table_info(production_batches)').all().map((column) => column.name);
  if (!productionBatchColumns.includes('raw_material_cost')) db.exec('ALTER TABLE production_batches ADD COLUMN raw_material_cost REAL NOT NULL DEFAULT 0');
  if (!productionBatchColumns.includes('packaging_material_cost')) db.exec('ALTER TABLE production_batches ADD COLUMN packaging_material_cost REAL NOT NULL DEFAULT 0');
  if (!productionBatchColumns.includes('other_material_cost')) db.exec('ALTER TABLE production_batches ADD COLUMN other_material_cost REAL NOT NULL DEFAULT 0');
  if (!productionBatchColumns.includes('material_cost')) db.exec('ALTER TABLE production_batches ADD COLUMN material_cost REAL NOT NULL DEFAULT 0');
  if (!productionBatchColumns.includes('labour_cost')) db.exec('ALTER TABLE production_batches ADD COLUMN labour_cost REAL NOT NULL DEFAULT 0');
  if (!productionBatchColumns.includes('overhead_cost')) db.exec('ALTER TABLE production_batches ADD COLUMN overhead_cost REAL NOT NULL DEFAULT 0');
  if (!productionBatchColumns.includes('equipment_depreciation')) db.exec('ALTER TABLE production_batches ADD COLUMN equipment_depreciation REAL NOT NULL DEFAULT 0');
  if (!productionBatchColumns.includes('equipment_depreciation_details')) db.exec("ALTER TABLE production_batches ADD COLUMN equipment_depreciation_details TEXT NOT NULL DEFAULT '[]'");

  const getFormulaById = (id) => {
    const formula = db.prepare('SELECT * FROM product_formulas WHERE id=?').get(id);
    if (!formula) return null;
    formula.legacyManualEquipmentDepreciation = Number(formula.equipment_depreciation || 0);
    formula.equipment_depreciation = 0;
    formula.items = db.prepare('SELECT fi.material_id AS materialId, m.name, m.unit, m.category, fi.quantity FROM formula_items fi JOIN inventory_materials m ON m.id=fi.material_id WHERE fi.formula_id=?').all(id);
    return formula;
  };
  const getMaterialStock = (id) => db.prepare("SELECT COALESCE(SUM(CASE WHEN movement_type IN ('purchase','adjustment_in') THEN quantity ELSE -quantity END),0) AS quantity FROM material_movements WHERE material_id=?").get(id).quantity;
  const insertMaterialMovement = ({ materialId, type, quantity, unitCost = 0, reference, receiptUrl }) => {
    const movement = { id: uuidv4(), material_id: materialId, movement_type: type, quantity, unit_cost: unitCost, reference: reference || null, receipt_url: receiptUrl || null };
    db.prepare('INSERT INTO material_movements (id,material_id,movement_type,quantity,unit_cost,reference,receipt_url) VALUES (@id,@material_id,@movement_type,@quantity,@unit_cost,@reference,@receipt_url)').run(movement);
    return movement;
  };
  const getContactConversationById = (id, { includeDeleted = false } = {}) => {
    const conversation = db.prepare(`SELECT * FROM contact_conversations WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).get(id);
    if (!conversation) return null;
    conversation.messages = db.prepare(`SELECT * FROM contact_messages WHERE conversation_id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY created_at,id`).all(id);
    return conversation;
  };
  const roundCurrency = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const equipmentDepreciationState = (asset, asOfDate = new Date()) => {
    const date = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
    const purchaseDate = new Date(`${asset.purchase_date}T00:00:00.000Z`);
    const validDates = Number.isFinite(date.getTime()) && Number.isFinite(purchaseDate.getTime());
    const monthIndex = validDates
      ? (date.getUTCFullYear() - purchaseDate.getUTCFullYear()) * 12 + (date.getUTCMonth() - purchaseDate.getUTCMonth())
      : -1;
    const usefulLifeMonths = Number(asset.useful_life_months);
    const depreciableBase = Math.max(0, Number(asset.purchase_price) - Number(asset.residual_value));
    const scheduledMonthlyDepreciation = usefulLifeMonths > 0 ? depreciableBase / usefulLifeMonths : 0;
    const depreciationStatus = asset.is_active === 0
      ? 'archived'
      : monthIndex < 0
        ? 'not_yet_in_service'
        : monthIndex >= usefulLifeMonths
          ? 'fully_depreciated'
          : 'active';
    const monthlyDepreciation = depreciationStatus === 'active' ? scheduledMonthlyDepreciation : 0;
    const allocationQuantity = Number(asset.allocation_quantity);
    return {
      assetId: asset.id,
      name: asset.name,
      category: asset.category || null,
      notes: asset.notes || null,
      purchasePrice: Number(asset.purchase_price),
      purchaseDate: asset.purchase_date,
      usefulLifeMonths,
      usefulLifeYears: usefulLifeMonths / 12,
      residualValue: Number(asset.residual_value),
      depreciationMethod: asset.depreciation_method,
      allocationBasis: asset.allocation_basis,
      allocationQuantity,
      allocationUnit: asset.allocation_basis === 'per_unit' ? 'unit' : 'batch',
      isActive: Boolean(asset.is_active),
      depreciationStatus,
      depreciableBase: roundCurrency(depreciableBase),
      monthlyDepreciation: roundCurrency(monthlyDepreciation),
      annualDepreciation: roundCurrency(monthlyDepreciation * 12),
      allocationRate: allocationQuantity > 0 ? roundCurrency(monthlyDepreciation / allocationQuantity) : 0,
    };
  };
  const calculateEquipmentDepreciation = (batchQuantity, asOfDate = new Date()) => {
    const quantity = Number(batchQuantity);
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Batch quantity must be a non-negative number');
    const assets = db.prepare('SELECT * FROM equipment_assets WHERE is_active=1 ORDER BY name').all();
    const details = assets.map((asset) => {
      const state = equipmentDepreciationState(asset, asOfDate);
      const allocatedAmount = state.depreciationStatus !== 'active'
        ? 0
        : state.allocationRate * (asset.allocation_basis === 'per_unit' ? quantity : (quantity > 0 ? 1 : 0));
      return { ...state, allocatedDepreciation: roundCurrency(allocatedAmount) };
    });
    return { total: roundCurrency(details.reduce((sum, asset) => sum + asset.allocatedDepreciation, 0)), assets: details };
  };
  const getEquipmentOverview = () => {
    const assets = db.prepare('SELECT * FROM equipment_assets ORDER BY is_active DESC,name').all()
      .map((asset) => equipmentDepreciationState(asset));
    const activeAssets = assets.filter((asset) => asset.isActive);
    const monthlyDepreciation = roundCurrency(activeAssets.reduce((sum, asset) => sum + asset.monthlyDepreciation, 0));
    return {
      assets,
      activeAssetCount: activeAssets.length,
      currentlyDepreciatingAssetCount: activeAssets.filter((asset) => asset.depreciationStatus === 'active').length,
      monthlyDepreciation,
      annualDepreciation: roundCurrency(monthlyDepreciation * 12),
    };
  };

  return {
    db,
    generateId: uuidv4,
    ensureUser: (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email),
    createUser: ({ name, email, passwordHash, role, departmentId = null, positionId = null, position = null, invitationTokenHash = null, invitationExpiresAt = null, invitationAcceptedAt = null }) => {
      const resolvedAcceptedAt = invitationAcceptedAt ?? (['customer', 'applicant', 'admin'].includes(role) ? new Date().toISOString() : null);
      const user = {
        id: uuidv4(),
        name,
        email,
        password_hash: passwordHash,
        role,
        department_id: departmentId,
        position_id: positionId,
        position,
        invitation_token_hash: invitationTokenHash,
        invitation_expires_at: invitationExpiresAt,
        invitation_accepted_at: resolvedAcceptedAt,
      };
      db.prepare(`
        INSERT INTO users (id, name, email, password_hash, role, department_id, position_id, position, invitation_token_hash, invitation_expires_at, invitation_accepted_at)
        VALUES (@id, @name, @email, @password_hash, @role, @department_id, @position_id, @position, @invitation_token_hash, @invitation_expires_at, @invitation_accepted_at)
      `).run(user);
      return user;
    },
    createDepartment: ({ name, description }) => {
      const department = { id: uuidv4(), name, description };
      db.prepare(`
        INSERT INTO departments (id, name, description)
        VALUES (@id, @name, @description)
      `).run(department);
      return db.prepare('SELECT * FROM departments WHERE id = ?').get(department.id);
    },
    createPosition: ({ title, departmentId, description, requirements, isHiring = true }) => {
      const position = { id: uuidv4(), title, department_id: departmentId, description, requirements, is_hiring: isHiring ? 1 : 0 };
      db.prepare(`
        INSERT INTO positions (id, title, department_id, description, requirements, is_hiring)
        VALUES (@id, @title, @department_id, @description, @requirements, @is_hiring)
      `).run(position);
      return db.prepare('SELECT * FROM positions WHERE id = ?').get(position.id);
    },
    createProduct: ({ name, category, description, price = 0, imageUrl = null, sizeOptions = [], brand = '', howToUse = '', ingredients = '', benefits = '' }) => {
      const product = {
        id: uuidv4(), name, category, description, price: Number(price), image_url: imageUrl,
        size_options: JSON.stringify(sizeOptions), brand, how_to_use: howToUse, ingredients, benefits,
      };
      db.prepare(`
        INSERT INTO products (id, name, category, description, price, image_url, size_options, brand, how_to_use, ingredients, benefits)
        VALUES (@id, @name, @category, @description, @price, @image_url, @size_options, @brand, @how_to_use, @ingredients, @benefits)
      `).run(product);
      return db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
    },
    createReview: ({ productId, rating, comment }) => {
      const review = { id: uuidv4(), product_id: productId, rating, comment };
      db.prepare(`
        INSERT INTO product_reviews (id, product_id, rating, comment)
        VALUES (@id, @product_id, @rating, @comment)
      `).run(review);
      return db.prepare('SELECT * FROM product_reviews WHERE id = ?').get(review.id);
    },
    createAgreement: ({ employeeId, type, title, content, status = 'draft', fillableFields = [] }) => {
      const agreement = { id: uuidv4(), employee_id: employeeId, type, title, content, status, fillable_fields: JSON.stringify(fillableFields) };
      db.prepare(`
        INSERT INTO agreements (id, employee_id, type, title, content, status, fillable_fields)
        VALUES (@id, @employee_id, @type, @title, @content, @status, @fillable_fields)
      `).run(agreement);
      return db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreement.id);
    },
    createMessage: ({ customerId, customerName, phone, channel, message }) => {
      const record = { id: uuidv4(), customer_id: customerId || null, customer_name: customerName, phone: phone || '', channel, message };
      db.prepare(`
        INSERT INTO customer_messages (id, customer_id, customer_name, phone, channel, message)
        VALUES (@id, @customer_id, @customer_name, @phone, @channel, @message)
      `).run(record);
      return db.prepare('SELECT * FROM customer_messages WHERE id = ?').get(record.id);
    },
    createIngredientPurchase: ({ name, unit, quantity, unitCost, supplier }) => {
      const totalCost = Number(quantity) * Number(unitCost);
      const purchase = { id: uuidv4(), name, unit, quantity: Number(quantity), unit_cost: Number(unitCost), total_cost: totalCost, supplier: supplier || '' };
      db.prepare(`
        INSERT INTO ingredient_purchases (id, name, unit, quantity, unit_cost, total_cost, supplier)
        VALUES (@id, @name, @unit, @quantity, @unit_cost, @total_cost, @supplier)
      `).run(purchase);
      return db.prepare('SELECT * FROM ingredient_purchases WHERE id = ?').get(purchase.id);
    },
    getProductById: (productId) => db.prepare('SELECT * FROM products WHERE id = ?').get(productId),
    getOrCreateCart: ({ customerId }) => {
      const cart = db.prepare('SELECT * FROM carts WHERE customer_id = ?').get(customerId);
      if (cart) return cart;

      const newCart = { id: uuidv4(), customer_id: customerId };
      db.prepare(`
        INSERT INTO carts (id, customer_id)
        VALUES (@id, @customer_id)
      `).run(newCart);
      return db.prepare('SELECT * FROM carts WHERE id = ?').get(newCart.id);
    },
    addToCart: ({ customerId, productId, quantity, variantLabel = '', unitPrice }) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) return null;

      const cart = db.prepare('SELECT * FROM carts WHERE customer_id = ?').get(customerId) || (() => {
        const newCart = { id: uuidv4(), customer_id: customerId };
        db.prepare('INSERT INTO carts (id, customer_id) VALUES (@id, @customer_id)').run(newCart);
        return db.prepare('SELECT * FROM carts WHERE id = ?').get(newCart.id);
      })();

      const normalizedVariant = String(variantLabel || '');
      const existing = db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ? AND variant_label = ?').get(cart.id, productId, normalizedVariant);
      const nextQuantity = Number(quantity) || 1;
      const selectedPrice = Number(unitPrice === undefined ? product.price : unitPrice);

      if (existing) {
        db.prepare(`
          UPDATE cart_items
          SET quantity = quantity + @quantity,
              unit_price = @unit_price
          WHERE cart_id = @cart_id AND product_id = @product_id AND variant_label = @variant_label
        `).run({
          quantity: nextQuantity,
          unit_price: selectedPrice,
          cart_id: cart.id,
          product_id: productId,
          variant_label: normalizedVariant,
        });
      } else {
        const item = {
          id: uuidv4(),
          cart_id: cart.id,
          product_id: productId,
          quantity: nextQuantity,
          unit_price: selectedPrice,
          variant_label: normalizedVariant,
        };

        db.prepare(`
          INSERT INTO cart_items (id, cart_id, product_id, quantity, unit_price, variant_label)
          VALUES (@id, @cart_id, @product_id, @quantity, @unit_price, @variant_label)
        `).run(item);
      }

      return db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ? AND variant_label = ?').get(cart.id, productId, normalizedVariant);
    },
    getCartByCustomerId: (customerId) => {
      const cart = db.prepare('SELECT * FROM carts WHERE customer_id = ?').get(customerId);
      if (!cart) {
        return { cart: null, items: [] };
      }

      const items = db.prepare(`
        SELECT ci.*, p.name AS product_name, p.category, p.description, p.image_url, p.price AS product_price,
          p.size_options, p.brand, p.how_to_use, p.ingredients, p.benefits
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = ?
      `).all(cart.id);

      return { cart, items };
    },
    removeCartItem: ({ customerId, itemId }) => {
      const byId = db.prepare('DELETE FROM cart_items WHERE id=? AND cart_id IN (SELECT id FROM carts WHERE customer_id=?)').run(itemId, customerId);
      if (byId.changes) return byId.changes;
      return db.prepare('DELETE FROM cart_items WHERE product_id=? AND cart_id IN (SELECT id FROM carts WHERE customer_id=?)').run(itemId, customerId).changes;
    },
    createSale: ({ customerId, customerName, paymentMethod, items }) => {
      const totalAmount = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0);
      const totalCost = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.costPrice), 0);
      const sale = {
        id: uuidv4(),
        customer_id: customerId || null,
        customer_name: customerName,
        payment_method: paymentMethod,
        total_amount: totalAmount,
        total_cost: totalCost,
      };

      db.prepare(`
        INSERT INTO sales (id, customer_id, customer_name, payment_method, total_amount, total_cost)
        VALUES (@id, @customer_id, @customer_name, @payment_method, @total_amount, @total_cost)
      `).run(sale);

      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
        if (!product) continue;

        const subtotal = Number(item.quantity) * Number(item.unitPrice);
        const record = {
          id: uuidv4(),
          sale_id: sale.id,
          product_id: item.productId,
          product_name: item.variantLabel ? `${product.name} (${item.variantLabel})` : product.name,
          quantity: Number(item.quantity),
          unit_price: Number(item.unitPrice),
          cost_price: Number(item.costPrice),
          subtotal,
        };

        db.prepare(`
          INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, unit_price, cost_price, subtotal)
          VALUES (@id, @sale_id, @product_id, @product_name, @quantity, @unit_price, @cost_price, @subtotal)
        `).run(record);
      }

      return db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
    },
    checkoutCartByCustomer: ({ customerId, paymentMethod }) => {
      const cartRecord = db.prepare('SELECT * FROM carts WHERE customer_id = ?').get(customerId);
      if (!cartRecord) return null;

      const items = db.prepare(`
        SELECT ci.*, p.name AS product_name, p.price AS product_price
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = ?
      `).all(cartRecord.id);

      if (!items.length) return null;

      const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(customerId);
      const normalizedItems = items.map((item) => ({
        productId: item.product_id,
        variantLabel: item.variant_label,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unit_price),
        costPrice: Number(item.unit_price),
      }));

      const totalAmount = normalizedItems.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0);
      const totalCost = normalizedItems.reduce((sum, item) => sum + Number(item.quantity) * Number(item.costPrice), 0);
      const sale = {
        id: uuidv4(),
        customer_id: customerId || null,
        customer_name: customer ? customer.name : 'Guest Customer',
        payment_method: paymentMethod,
        total_amount: totalAmount,
        total_cost: totalCost,
      };

      db.prepare(`
        INSERT INTO sales (id, customer_id, customer_name, payment_method, total_amount, total_cost)
        VALUES (@id, @customer_id, @customer_name, @payment_method, @total_amount, @total_cost)
      `).run(sale);

      for (const item of normalizedItems) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
        if (!product) continue;

        const subtotal = Number(item.quantity) * Number(item.unitPrice);
        const record = {
          id: uuidv4(),
          sale_id: sale.id,
          product_id: item.productId,
          product_name: item.variantLabel ? `${product.name} (${item.variantLabel})` : product.name,
          quantity: Number(item.quantity),
          unit_price: Number(item.unitPrice),
          cost_price: Number(item.costPrice),
          subtotal,
        };

        db.prepare(`
          INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, unit_price, cost_price, subtotal)
          VALUES (@id, @sale_id, @product_id, @product_name, @quantity, @unit_price, @cost_price, @subtotal)
        `).run(record);
      }

      const persistedSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);

      db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartRecord.id);
      return persistedSale;
    },
    createReferral: ({ referrerId, customerId, customerName, saleAmount, referredAt, note }) => {
      const commissionRate = 5;
      const commissionAmount = Number(saleAmount) * (commissionRate / 100);
      const record = {
        id: uuidv4(),
        referrer_id: referrerId || null,
        customer_id: customerId || null,
        customer_name: customerName,
        sale_amount: Number(saleAmount),
        commission_rate: commissionRate,
        commission_amount: commissionAmount,
        referred_at: referredAt || new Date().toISOString(),
        window_minutes: 30,
        note: note || '',
        status: 'approved',
      };

      db.prepare(`
        INSERT INTO referrals (id, referrer_id, customer_id, customer_name, sale_amount, commission_rate, commission_amount, referred_at, window_minutes, note, status)
        VALUES (@id, @referrer_id, @customer_id, @customer_name, @sale_amount, @commission_rate, @commission_amount, @referred_at, @window_minutes, @note, @status)
      `).run(record);

      return db.prepare('SELECT * FROM referrals WHERE id = ?').get(record.id);
    },
    getAgreement: (id) => db.prepare('SELECT * FROM agreements WHERE id = ?').get(id),
    getProductSummary: (productId) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      const reviews = db.prepare('SELECT * FROM product_reviews WHERE product_id = ? ORDER BY created_at DESC').all(productId);
      const average = reviews.length ? reviews.reduce((sum, item) => sum + item.rating, 0) / reviews.length : 0;

      return {
        product,
        reviews,
        averageRating: Number(average.toFixed(2)),
        totalReviews: reviews.length,
      };
    },
    getAccountingSummary: () => {
      const sales = db.prepare('SELECT * FROM sales ORDER BY created_at DESC').all();
      const purchases = db.prepare('SELECT * FROM ingredient_purchases ORDER BY purchased_at DESC').all();
      const totalRevenue = sales.reduce((sum, sale) => sum + Number(sale.total_amount), 0);
      const totalCost = sales.reduce((sum, sale) => sum + Number(sale.total_cost), 0) + purchases.reduce((sum, item) => sum + Number(item.total_cost), 0);
      const totalProfit = totalRevenue - totalCost;
      const totalOrders = sales.length;
      const avgOrderValue = totalOrders ? totalRevenue / totalOrders : 0;
      const equipmentOverview = getEquipmentOverview();

      const trend = sales.map((sale) => ({
        date: new Date(sale.created_at).toISOString().slice(0, 10),
        revenue: Number(sale.total_amount),
      }));

      return {
        totalRevenue,
        totalCost,
        totalProfit,
        totalOrders,
        avgOrderValue: Number(avgOrderValue.toFixed(2)),
        ingredientSpend: purchases.reduce((sum, item) => sum + Number(item.total_cost), 0),
        salesTrend: trend,
        equipment: {
          activeAssetCount: equipmentOverview.activeAssetCount,
          currentlyDepreciatingAssetCount: equipmentOverview.currentlyDepreciatingAssetCount,
          monthlyDepreciation: equipmentOverview.monthlyDepreciation,
          annualDepreciation: equipmentOverview.annualDepreciation,
        },
      };
    },
    createMaterial: ({ name, category = 'ingredient', unit, reorderLevel = 0 }) => {
      const material = { id: uuidv4(), name, category, unit, reorder_level: reorderLevel };
      db.prepare('INSERT INTO inventory_materials (id,name,category,unit,reorder_level) VALUES (@id,@name,@category,@unit,@reorder_level)').run(material);
      return db.prepare('SELECT * FROM inventory_materials WHERE id=?').get(material.id);
    },
    listEquipmentAssets: ({ includeArchived = false } = {}) => {
      const assets = db.prepare(`SELECT * FROM equipment_assets ${includeArchived ? '' : 'WHERE is_active=1'} ORDER BY is_active DESC,name`).all();
      return assets.map((asset) => equipmentDepreciationState(asset));
    },
    getEquipmentAsset: (id) => db.prepare('SELECT * FROM equipment_assets WHERE id=?').get(id),
    createEquipmentAsset: ({ name, purchasePrice, purchaseDate, usefulLifeMonths, residualValue = 0, depreciationMethod = 'straight_line', category = null, notes = null, allocationBasis = 'per_unit', allocationQuantity }) => {
      const asset = {
        id: uuidv4(), name, purchase_price: purchasePrice, purchase_date: purchaseDate,
        useful_life_months: usefulLifeMonths, residual_value: residualValue,
        depreciation_method: depreciationMethod, category, notes,
        allocation_basis: allocationBasis, allocation_quantity: allocationQuantity,
      };
      db.prepare(`
        INSERT INTO equipment_assets (id,name,purchase_price,purchase_date,useful_life_months,residual_value,depreciation_method,category,notes,allocation_basis,allocation_quantity)
        VALUES (@id,@name,@purchase_price,@purchase_date,@useful_life_months,@residual_value,@depreciation_method,@category,@notes,@allocation_basis,@allocation_quantity)
      `).run(asset);
      return db.prepare('SELECT * FROM equipment_assets WHERE id=?').get(asset.id);
    },
    updateEquipmentAsset: (id, { name, purchasePrice, purchaseDate, usefulLifeMonths, residualValue, depreciationMethod, category, notes, allocationBasis, allocationQuantity }) => {
      db.prepare(`
        UPDATE equipment_assets SET name=?,purchase_price=?,purchase_date=?,useful_life_months=?,residual_value=?,depreciation_method=?,category=?,notes=?,allocation_basis=?,allocation_quantity=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(name, purchasePrice, purchaseDate, usefulLifeMonths, residualValue, depreciationMethod, category, notes, allocationBasis, allocationQuantity, id);
      return db.prepare('SELECT * FROM equipment_assets WHERE id=?').get(id);
    },
    archiveEquipmentAsset: (id) => db.prepare('UPDATE equipment_assets SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND is_active=1').run(id).changes,
    equipmentOverview: getEquipmentOverview,
    calculateEquipmentDepreciation,
    materialStock: getMaterialStock,
    recordMaterialMovement: insertMaterialMovement,
    createFormula: ({ productId, expectedYield, items, labourCost = 0, overheadCost = 0 }) => {
      const version = (db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM product_formulas WHERE product_id=?').get(productId)).version;
      const formula = { id: uuidv4(), product_id: productId, version, expected_yield: expectedYield, labour_cost: labourCost, overhead_cost: overheadCost, equipment_depreciation: 0 };
      const create = db.transaction(() => {
        db.prepare('INSERT INTO product_formulas (id,product_id,version,expected_yield,labour_cost,overhead_cost,equipment_depreciation) VALUES (@id,@product_id,@version,@expected_yield,@labour_cost,@overhead_cost,@equipment_depreciation)').run(formula);
        for (const item of items) db.prepare('INSERT INTO formula_items (id,formula_id,material_id,quantity) VALUES (?,?,?,?)').run(uuidv4(), formula.id, item.materialId, item.quantity);
      });
      create();
      return getFormulaById(formula.id);
    },
    getFormula: getFormulaById,
    getLatestFormula: (productId) => { const f = db.prepare('SELECT id FROM product_formulas WHERE product_id=? ORDER BY version DESC LIMIT 1').get(productId); return f ? getFormulaById(f.id) : null; },
    produceBatch: ({ productId, formulaId, producedQuantity, saleableQuantity, notes }) => {
      const formula = getFormulaById(formulaId);
      if (!formula || formula.product_id !== productId) throw new Error('Formula not found for product');
      const multiplier = producedQuantity / formula.expected_yield;
      const stock = formula.items.map((item) => {
        const material = db.prepare('SELECT * FROM inventory_materials WHERE id=?').get(item.materialId);
        const needed = item.quantity * multiplier;
        const available = getMaterialStock(item.materialId);
        if (available + 1e-9 < needed) throw new Error(`Insufficient ${material.name} stock`);
        const avg = db.prepare("SELECT COALESCE(SUM(CASE WHEN movement_type IN ('purchase','adjustment_in') THEN quantity*unit_cost ELSE 0 END),0) AS value, COALESCE(SUM(CASE WHEN movement_type IN ('purchase','adjustment_in') THEN quantity ELSE -quantity END),0) AS quantity FROM material_movements WHERE material_id=?").get(item.materialId);
        return { materialId: item.materialId, category: material.category, quantity: needed, unitCost: avg.quantity > 0 ? avg.value / avg.quantity : 0 };
      });
      const wastageMultiplier = 1 + Number(formula.wastage_rate || 0);
      const rawMaterialCost = stock.filter((item) => item.category === 'ingredient').reduce((sum, item) => sum + item.quantity * item.unitCost, 0) * wastageMultiplier;
      const packagingMaterialCost = stock.filter((item) => item.category === 'packaging').reduce((sum, item) => sum + item.quantity * item.unitCost, 0) * wastageMultiplier;
      const otherMaterialCost = stock.filter((item) => !['ingredient', 'packaging'].includes(item.category)).reduce((sum, item) => sum + item.quantity * item.unitCost, 0) * wastageMultiplier;
      const materialCost = rawMaterialCost + packagingMaterialCost + otherMaterialCost;
      const scale = producedQuantity / formula.expected_yield;
      const labourCost = Number(formula.labour_cost) * scale;
      const overheadCost = Number(formula.overhead_cost) * scale;
      const equipmentAllocation = calculateEquipmentDepreciation(producedQuantity);
      const totalCost = roundCurrency(materialCost + labourCost + overheadCost + equipmentAllocation.total);
      const batch = {
        id: uuidv4(), product_id: productId, formula_id: formulaId,
        produced_quantity: producedQuantity, saleable_quantity: saleableQuantity,
        raw_material_cost: roundCurrency(rawMaterialCost), packaging_material_cost: roundCurrency(packagingMaterialCost),
        other_material_cost: roundCurrency(otherMaterialCost),
        material_cost: roundCurrency(materialCost), labour_cost: roundCurrency(labourCost),
        overhead_cost: roundCurrency(overheadCost), equipment_depreciation: equipmentAllocation.total,
        equipment_depreciation_details: JSON.stringify(equipmentAllocation.assets),
        total_cost: totalCost, unit_cost: roundCurrency(totalCost / saleableQuantity), notes: notes || null,
      };
      const save = db.transaction(() => {
        for (const used of stock) insertMaterialMovement({ materialId: used.materialId, type: 'production_use', quantity: used.quantity, unitCost: used.unitCost, reference: batch.id });
        db.prepare(`
          INSERT INTO production_batches (id,product_id,formula_id,produced_quantity,saleable_quantity,raw_material_cost,packaging_material_cost,other_material_cost,material_cost,labour_cost,overhead_cost,equipment_depreciation,equipment_depreciation_details,total_cost,unit_cost,notes)
          VALUES (@id,@product_id,@formula_id,@produced_quantity,@saleable_quantity,@raw_material_cost,@packaging_material_cost,@other_material_cost,@material_cost,@labour_cost,@overhead_cost,@equipment_depreciation,@equipment_depreciation_details,@total_cost,@unit_cost,@notes)
        `).run(batch);
        db.prepare("INSERT INTO finished_stock_movements (id,product_id,movement_type,quantity,unit_cost,reference) VALUES (?,?,?,?,?,?)").run(uuidv4(), productId, 'production', saleableQuantity, batch.unit_cost, batch.id);
        db.prepare('UPDATE products SET inventory_enabled=1 WHERE id=?').run(productId);
      });
      save();
      return {
        ...batch,
        equipment_depreciation_details: equipmentAllocation.assets,
        cost_breakdown: {
          rawMaterialCost: batch.raw_material_cost,
          packagingMaterialCost: batch.packaging_material_cost,
          otherMaterialCost: batch.other_material_cost,
          materialCost: batch.material_cost,
          labourCost: batch.labour_cost,
          overheadCost: batch.overhead_cost,
          equipmentDepreciation: batch.equipment_depreciation,
          totalCost: batch.total_cost,
          producedQuantity: batch.produced_quantity,
          costPerUnit: batch.unit_cost,
        },
      };
    },
    finishedStock: (productId) => db.prepare("SELECT COALESCE(SUM(CASE WHEN movement_type IN ('production','adjustment_in','return') THEN quantity ELSE -quantity END),0) AS quantity FROM finished_stock_movements WHERE product_id=?").get(productId).quantity,
    listInventory: () => db.prepare(`SELECT m.*, COALESCE(SUM(CASE WHEN mm.movement_type IN ('purchase','adjustment_in') THEN mm.quantity ELSE -mm.quantity END),0) AS stock FROM inventory_materials m LEFT JOIN material_movements mm ON mm.material_id=m.id GROUP BY m.id ORDER BY m.name`).all(),
    inventorySummary: () => ({ materials: db.prepare("SELECT m.*, COALESCE(SUM(CASE WHEN mm.movement_type IN ('purchase','adjustment_in') THEN mm.quantity ELSE -mm.quantity END),0) AS stock FROM inventory_materials m LEFT JOIN material_movements mm ON mm.material_id=m.id GROUP BY m.id ORDER BY m.name").all(), products: db.prepare("SELECT p.id,p.name,COALESCE(SUM(CASE WHEN f.movement_type IN ('production','adjustment_in','return') THEN f.quantity ELSE -f.quantity END),0) AS stock FROM products p LEFT JOIN finished_stock_movements f ON f.product_id=p.id WHERE p.inventory_enabled=1 GROUP BY p.id ORDER BY p.name").all(), equipment: getEquipmentOverview() }),
    recordExpense: ({ category, description, amount }) => { const item = { id: uuidv4(), category, description, amount }; db.prepare('INSERT INTO inventory_expenses (id,category,description,amount) VALUES (@id,@category,@description,@amount)').run(item); return item; },
    createContactConversation: ({ customerId, name, email, subject, message }) => {
      const conversation = { id: uuidv4(), customer_id: customerId || null, name, email, subject: subject || 'Contact request' };
      const insert = db.transaction(() => {
        db.prepare('INSERT INTO contact_conversations (id,customer_id,name,email,subject) VALUES (@id,@customer_id,@name,@email,@subject)').run(conversation);
        db.prepare("INSERT INTO contact_messages (id,conversation_id,sender_type,message) VALUES (?,?, 'visitor', ?)").run(uuidv4(), conversation.id, message);
      });
      insert();
      return getContactConversationById(conversation.id);
    },
    getContactConversation: getContactConversationById,
    getCustomerContactConversation: (id, customerId) => {
      const conversation = db.prepare('SELECT * FROM contact_conversations WHERE id=? AND customer_id=? AND deleted_at IS NULL').get(id, customerId);
      if (!conversation) return null;
      conversation.messages = db.prepare('SELECT * FROM contact_messages WHERE conversation_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(id);
      return conversation;
    },
    listCustomerContactConversations: (customerId) => db.prepare(`SELECT c.*,
      (SELECT message FROM contact_messages WHERE conversation_id=c.id AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) AS last_message
      FROM contact_conversations c WHERE c.customer_id=? AND c.deleted_at IS NULL ORDER BY c.updated_at DESC`).all(customerId),
    listContactConversations: ({ includeDeleted = false } = {}) => db.prepare(`SELECT c.*,
      (SELECT message FROM contact_messages WHERE conversation_id=c.id AND (? OR deleted_at IS NULL) ORDER BY created_at DESC,id DESC LIMIT 1) AS last_message
      FROM contact_conversations c WHERE (? OR c.deleted_at IS NULL) ORDER BY c.updated_at DESC`).all(includeDeleted ? 1 : 0, includeDeleted ? 1 : 0),
    addCustomerContactMessage: ({ conversationId, message }) => {
      const result = db.transaction(() => {
        const reply = { id: uuidv4(), conversation_id: conversationId, message };
        db.prepare("INSERT INTO contact_messages (id,conversation_id,sender_type,message) VALUES (@id,@conversation_id,'visitor',@message)").run(reply);
        db.prepare("UPDATE contact_conversations SET updated_at=CURRENT_TIMESTAMP,status='open' WHERE id=? AND deleted_at IS NULL").run(conversationId);
        return reply;
      })();
      return result;
    },
    addContactReply: ({ conversationId, message }) => {
      const result = db.transaction(() => {
        const reply = { id: uuidv4(), conversation_id: conversationId, message };
        db.prepare("INSERT INTO contact_messages (id,conversation_id,sender_type,message) VALUES (@id,@conversation_id,'admin',@message)").run(reply);
        db.prepare("UPDATE contact_conversations SET updated_at=CURRENT_TIMESTAMP,status='open' WHERE id=?").run(conversationId);
        return reply;
      })();
      return result;
    },
    setContactConversationStatus: (id, status) => db.prepare('UPDATE contact_conversations SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL').run(status, id).changes,
    deleteContactConversation: (id) => db.transaction(() => {
      const exists = db.prepare('SELECT id FROM contact_conversations WHERE id=? AND deleted_at IS NULL').get(id);
      if (!exists) return false;
      db.prepare('UPDATE contact_conversations SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
      db.prepare('UPDATE contact_messages SET deleted_at=CURRENT_TIMESTAMP WHERE conversation_id=? AND deleted_at IS NULL').run(id);
      return true;
    })(),
    restoreContactConversation: (id) => db.transaction(() => {
      const exists = db.prepare('SELECT id FROM contact_conversations WHERE id=? AND deleted_at IS NOT NULL').get(id);
      if (!exists) return false;
      db.prepare('UPDATE contact_conversations SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
      db.prepare('UPDATE contact_messages SET deleted_at=NULL WHERE conversation_id=?').run(id);
      return true;
    })(),
    deleteContactMessage: (id) => db.prepare('UPDATE contact_messages SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL').run(id).changes,
    restoreContactMessage: (id) => db.prepare(`UPDATE contact_messages SET deleted_at=NULL WHERE id=? AND EXISTS (SELECT 1 FROM contact_conversations WHERE id=contact_messages.conversation_id AND deleted_at IS NULL)`).run(id).changes,
  };
}

module.exports = { createDatabase };
