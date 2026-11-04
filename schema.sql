CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT NOT NULL DEFAULT '#3b82f6', sort INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'card' CHECK (type IN ('card','account','id','login')),
  name_ar TEXT NOT NULL, name_en TEXT, name_fr TEXT,
  image_url TEXT, price NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock_mode TEXT NOT NULL DEFAULT 'codes' CHECK (stock_mode IN ('codes','manual')),
  in_stock BOOLEAN NOT NULL DEFAULT TRUE,
  fast BOOLEAN NOT NULL DEFAULT TRUE, featured BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE, sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS product_codes (
  id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code TEXT NOT NULL, sold_at TIMESTAMPTZ, order_id INT, UNIQUE (product_id, code));
CREATE INDEX IF NOT EXISTS idx_codes_free ON product_codes (product_id) WHERE sold_at IS NULL;
CREATE TABLE IF NOT EXISTS banners (
  id SERIAL PRIMARY KEY, image_url TEXT NOT NULL, link TEXT, sort INT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE);
-- Stage 2 tables (accounts, wallet, orders) are created now so the database is complete from day one
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, pin_hash TEXT,
  account_type TEXT NOT NULL DEFAULT 'عميل', discount NUMERIC(5,2) NOT NULL DEFAULT 0,
  points INT NOT NULL DEFAULT 0, balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  last_spin TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('in','out')), amount NUMERIC(14,2) NOT NULL,
  details TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY, public_id TEXT UNIQUE NOT NULL, user_id INT REFERENCES users(id),
  product_id INT REFERENCES products(id), quantity INT NOT NULL DEFAULT 1,
  total NUMERIC(12,2) NOT NULL DEFAULT 0, method TEXT, status TEXT NOT NULL DEFAULT 'pending',
  target TEXT, delivered_codes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS otp_codes (
  id SERIAL PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, purpose TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN NOT NULL DEFAULT FALSE);
