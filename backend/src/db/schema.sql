-- BookLeaf Author Support & Communication Portal — PostgreSQL / SQLite Schema

CREATE TABLE authors (
  author_id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(40),
  city VARCHAR(80),
  joined_date DATE NOT NULL
);

CREATE TABLE books (
  book_id VARCHAR(32) PRIMARY KEY,
  author_id VARCHAR(32) NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  isbn VARCHAR(64) NOT NULL,
  genre VARCHAR(100),
  publication_date DATE,
  status VARCHAR(100) NOT NULL,
  mrp NUMERIC(10, 2),
  author_royalty_per_copy NUMERIC(10, 2),
  total_copies_sold INTEGER NOT NULL DEFAULT 0,
  total_royalty_earned NUMERIC(12, 2) NOT NULL DEFAULT 0,
  royalty_paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
  royalty_pending NUMERIC(12, 2) NOT NULL DEFAULT 0,
  last_royalty_payout_date DATE,
  print_partner VARCHAR(80),
  available_on JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE tickets (
  id VARCHAR(32) PRIMARY KEY,
  author_id VARCHAR(32) NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
  book_id VARCHAR(32), -- Nullable for 'GENERAL' account-level queries
  subject VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In Progress', 'Resolved', 'Closed')),
  category VARCHAR(80) NOT NULL,
  priority VARCHAR(24) NOT NULL CHECK (priority IN ('Critical', 'High', 'Medium', 'Low')),
  ai_confidence NUMERIC(4, 3),
  ai_reasoning TEXT,
  ai_draft_response TEXT,
  ai_degraded BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_tokens_used INTEGER NOT NULL DEFAULT 0,
  assigned_to VARCHAR(120) DEFAULT 'Unassigned',
  attachments JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tickets_queue ON tickets (status, priority, created_at ASC);
CREATE INDEX idx_tickets_author ON tickets (author_id, updated_at DESC);

CREATE TABLE ticket_messages (
  id VARCHAR(48) PRIMARY KEY,
  ticket_id VARCHAR(32) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_role VARCHAR(24) NOT NULL CHECK (sender_role IN ('author', 'admin')),
  sender_name VARCHAR(120) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ticket_internal_notes (
  id VARCHAR(48) PRIMARY KEY,
  ticket_id VARCHAR(32) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_name VARCHAR(120) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
