-- ============================================================================
-- Surekha BMS Pro — Double-Entry Ledger — Neon PostgreSQL Schema
-- Phase 2 implementation. Purely additive: does not alter any existing table.
-- Safe to run on your existing database — uses IF NOT EXISTS everywhere.
-- ============================================================================

-- Chart of Accounts
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id              TEXT PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  normal_balance  TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  is_control_account BOOLEAN DEFAULT FALSE,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Journal Entries (the voucher/header)
CREATE TABLE IF NOT EXISTS journal_entries (
  id              TEXT PRIMARY KEY,
  date            DATE NOT NULL,
  voucher_number  TEXT NOT NULL,
  ref_type        TEXT NOT NULL,   -- pos-sale, credit-sale, due-settlement, supplier-invoice,
                                    -- supplier-payment, manual-accounting, payroll,
                                    -- migrated-historical, opening-balance, manual-journal
  ref_id          TEXT,
  reference       TEXT,
  description     TEXT,
  is_auto_generated BOOLEAN DEFAULT TRUE,
  is_void         BOOLEAN DEFAULT FALSE,
  void_reason     TEXT,
  voided_at       TIMESTAMPTZ,
  voided_by       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  created_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_ref ON journal_entries(ref_type, ref_id);

-- Journal Lines (the Dr/Cr detail rows — always sum(debit) = sum(credit) per journal_entry_id)
CREATE TABLE IF NOT EXISTS journal_lines (
  id                TEXT PRIMARY KEY,
  journal_entry_id  TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code      TEXT NOT NULL REFERENCES chart_of_accounts(code),
  debit             NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit            NUMERIC(14,2) NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0))  -- a line is either a debit or a credit, never both
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_code);

-- Voucher numbering counters (kept server-side too, so two devices syncing never collide)
CREATE TABLE IF NOT EXISTS voucher_counters (
  kind        TEXT PRIMARY KEY,  -- Sales, Purchase, Payment, Receipt, Journal
  next_number INTEGER NOT NULL DEFAULT 1
);
INSERT INTO voucher_counters (kind, next_number) VALUES
  ('Sales',1), ('Purchase',1), ('Payment',1), ('Receipt',1), ('Journal',1)
ON CONFLICT (kind) DO NOTHING;

-- Account/QR/payment-method mapping settings (mirrors db.settings.acctMappings client-side)
CREATE TABLE IF NOT EXISTS acct_mappings (
  key         TEXT PRIMARY KEY,   -- e.g. 'paymentMethod:Cash', 'qrCode:<id>', 'expenseCategory:Salary'
  account_code TEXT NOT NULL REFERENCES chart_of_accounts(code),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- Seed the default Chart of Accounts (matches DEFAULT_CHART_OF_ACCOUNTS in the app)
-- ============================================================================
INSERT INTO chart_of_accounts (id, code, name, type, normal_balance, is_control_account) VALUES
  (gen_random_uuid()::text,'1010','Cash in Hand','asset','debit',false),
  (gen_random_uuid()::text,'1020','Bank Account','asset','debit',false),
  (gen_random_uuid()::text,'1021','eSewa Wallet','asset','debit',false),
  (gen_random_uuid()::text,'1022','Khalti Wallet','asset','debit',false),
  (gen_random_uuid()::text,'1030','Accounts Receivable (Customer Dues)','asset','debit',true),
  (gen_random_uuid()::text,'1040','Inventory – Raw Materials','asset','debit',false),
  (gen_random_uuid()::text,'1041','Inventory – Finished Goods','asset','debit',false),
  (gen_random_uuid()::text,'1042','Inventory – Trading/Retail Goods','asset','debit',false),
  (gen_random_uuid()::text,'1050','VAT Receivable (Input VAT)','asset','debit',false),
  (gen_random_uuid()::text,'1060','Advance to Suppliers','asset','debit',false),
  (gen_random_uuid()::text,'1070','Prepaid Expenses','asset','debit',false),
  (gen_random_uuid()::text,'1110','Machinery & Equipment','asset','debit',false),
  (gen_random_uuid()::text,'1111','Accumulated Depreciation – Machinery','asset','credit',false),
  (gen_random_uuid()::text,'1120','Vehicles','asset','debit',false),
  (gen_random_uuid()::text,'1121','Accumulated Depreciation – Vehicles','asset','credit',false),
  (gen_random_uuid()::text,'1130','Furniture & Fixtures','asset','debit',false),
  (gen_random_uuid()::text,'1131','Accumulated Depreciation – Furniture','asset','credit',false),
  (gen_random_uuid()::text,'1140','Computers & Office Equipment','asset','debit',false),
  (gen_random_uuid()::text,'1141','Accumulated Depreciation – Computers','asset','credit',false),
  (gen_random_uuid()::text,'2010','Accounts Payable (Supplier Dues)','liability','credit',true),
  (gen_random_uuid()::text,'2020','VAT Payable (Output VAT)','liability','credit',false),
  (gen_random_uuid()::text,'2030','Salary Payable','liability','credit',false),
  (gen_random_uuid()::text,'2040','Advance from Customers','liability','credit',false),
  (gen_random_uuid()::text,'2050','Short-Term Loans','liability','credit',false),
  (gen_random_uuid()::text,'2060','TDS Payable','liability','credit',false),
  (gen_random_uuid()::text,'2110','Long-Term Loans','liability','credit',false),
  (gen_random_uuid()::text,'3010','Owner''s Capital','equity','credit',false),
  (gen_random_uuid()::text,'3020','Owner''s Drawings','equity','debit',false),
  (gen_random_uuid()::text,'3030','Retained Earnings','equity','credit',false),
  (gen_random_uuid()::text,'4010','Sales Revenue – Retail','income','credit',false),
  (gen_random_uuid()::text,'4020','Sales Revenue – Wholesale','income','credit',false),
  (gen_random_uuid()::text,'4090','Other Income','income','credit',false),
  (gen_random_uuid()::text,'5010','Purchases / Cost of Goods Sold','expense','debit',false),
  (gen_random_uuid()::text,'5020','Salary & Wages','expense','debit',false),
  (gen_random_uuid()::text,'5030','Rent','expense','debit',false),
  (gen_random_uuid()::text,'5040','Utilities','expense','debit',false),
  (gen_random_uuid()::text,'5050','Supplies','expense','debit',false),
  (gen_random_uuid()::text,'5060','Tax & Government Fees','expense','debit',false),
  (gen_random_uuid()::text,'5070','Maintenance','expense','debit',false),
  (gen_random_uuid()::text,'5080','Travel','expense','debit',false),
  (gen_random_uuid()::text,'5090','Depreciation Expense','expense','debit',false),
  (gen_random_uuid()::text,'5100','Other Expense','expense','debit',false)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- Notes for your Node/Express backend (no code written yet — for when we wire sync):
-- 1. journal_entries + journal_lines should sync the same way db.journalEntries
--    does client-side today — same last-write-wins, timestamp+version pattern
--    already used for the rest of your data.
-- 2. Never DELETE a journal_entries row from the app — only ever set is_void = true.
--    This is what makes the ledger audit-proof.
-- 3. voucher_counters should be incremented with a single atomic UPDATE ... RETURNING
--    (not read-then-write) once this moves server-side, to avoid two devices grabbing
--    the same voucher number if they're both online at once. Client-side today, the
--    counter lives in db.settings.voucherCounters and follows your existing sync rules.
-- ============================================================================
