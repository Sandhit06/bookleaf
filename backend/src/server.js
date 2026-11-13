require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { authenticateToken, requireRole, JWT_SECRET } = require('./middleware/auth');
const { analyzeTicketWithAI, deterministicTriageAndDraft } = require('./services/aiService');

const app = express();
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false }));
app.use(express.json({ limit: '2mb' }));

// Load seed data from bookleaf_sample_data.json
const seedPath = path.join(__dirname, 'db', 'bookleaf_sample_data.json');
const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'db');
fs.mkdirSync(dataDir, { recursive: true });
const ticketStorePath = path.join(dataDir, 'tickets.json');
let tickets = [];
try {
  tickets = JSON.parse(fs.readFileSync(ticketStorePath, 'utf-8'));
  if (!Array.isArray(tickets)) throw new Error('Ticket store must be an array.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function persistTickets() {
  const tempPath = `${ticketStorePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(tickets, null, 2));
  fs.renameSync(tempPath, ticketStorePath);
}

const sseClients = new Map();

function broadcastSse(event, payload, authorId) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [res, user] of sseClients) {
    if (user.role !== 'admin' && user.sub !== authorId) continue;
    if (!res.write(data)) sseClients.delete(res);
  }
}

// 1. POST /api/v1/auth/login
app.post('/api/v1/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || typeof email !== 'string' || !password) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Valid email and password are required.' });
  }
  const normalized = email.trim().toLowerCase();
  const expectedPassword = process.env.DEMO_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'bookleaf123');
  if (!expectedPassword || password !== expectedPassword) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
  }
  if (normalized === 'admin@bookleaf.in' || normalized === 'ops@bookleaf.in') {
    const token = jwt.sign({ sub: 'ADMIN01', role: 'admin', name: 'Aditi Verma', email: normalized }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, user: { id: 'ADMIN01', role: 'admin', name: 'Aditi Verma', email: normalized } });
  }
  const author = seedData.authors.find((a) => a.email.toLowerCase() === normalized);
  if (!author) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
  }
  const token = jwt.sign({ sub: author.author_id, role: 'author', name: author.name, email: author.email }, JWT_SECRET, { expiresIn: '12h' });
  return res.json({ token, user: { id: author.author_id, role: 'author', name: author.name, email: author.email, city: author.city } });
});

// 2. GET /api/v1/authors/me/books (RBAC: Author only sees their own books)
app.get('/api/v1/authors/me/books', authenticateToken, requireRole('author'), (req, res) => {
  const author = seedData.authors.find((a) => a.author_id === req.user.sub);
  if (!author) {
    return res.status(404).json({ error: 'AUTHOR_NOT_FOUND', message: 'Author record not found.' });
  }
  return res.json({
    author_id: author.author_id, name: author.name, email: author.email,
    phone: author.phone, city: author.city, joined_date: author.joined_date, books: author.books
  });
});

app.get('/api/v1/authors', authenticateToken, requireRole('admin'), (_req, res) => {
  return res.json({ authors: seedData.authors });
});

// 3. GET /api/v1/tickets (RBAC: Author sees own tickets without internal_notes; Admin sees all)
app.get('/api/v1/tickets', authenticateToken, (req, res) => {
  const { status, category, priority, from, to } = req.query;
  const statuses = ['Open', 'In Progress', 'Resolved', 'Closed'];
  const priorities = ['Critical', 'High', 'Medium', 'Low'];
  if ((status && status !== 'UNRESOLVED' && !statuses.includes(status)) ||
      (priority && !priorities.includes(priority)) ||
      (from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) {
    return res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Ticket filter is invalid.' });
  }
  const matchesFilters = (ticket) =>
    (!status || (status === 'UNRESOLVED' ? ['Open', 'In Progress'].includes(ticket.status) : ticket.status === status)) &&
    (!category || ticket.category === category) && (!priority || ticket.priority === priority) &&
    (!from || new Date(ticket.created_at) >= new Date(`${from}T00:00:00.000Z`)) &&
    (!to || new Date(ticket.created_at) <= new Date(`${to}T23:59:59.999Z`));
  if (req.user.role === 'author') {
    const own = tickets
      .filter((t) => t.author_id === req.user.sub && matchesFilters(t))
      .map(({ internal_notes, ...publicFields }) => publicFields);
    return res.json({ tickets: own });
  }
  return res.json({ tickets: tickets.filter(matchesFilters) });
});

// 4. POST /api/v1/tickets (Creates ticket + runs AI classification, priority scoring & draft generation)
app.post('/api/v1/tickets', authenticateToken, asyncHandler(async (req, res) => {
  if (req.user.role !== 'author') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only authors can submit support tickets.' });
  }
  const { book_id, subject, description, attachments } = req.body || {};
  if (typeof subject !== 'string' || subject.trim().length < 4 || subject.trim().length > 160 ||
      typeof description !== 'string' || description.trim().length < 10 || description.trim().length > 10000) {
    return res.status(422).json({
      error: 'VALIDATION_ERROR',
      message: 'Subject (min 4 chars) and detailed description (min 10 chars) are required.'
    });
  }
  const author = seedData.authors.find((a) => a.author_id === req.user.sub);
  if (!author) return res.status(404).json({ error: 'AUTHOR_NOT_FOUND', message: 'Author record not found.' });
  const book = book_id && book_id !== 'GENERAL' ? author.books.find((b) => b.book_id === book_id) : null;
  if (book_id && book_id !== 'GENERAL' && !book) {
    return res.status(403).json({
      error: 'BOOK_OWNERSHIP_VIOLATION',
      message: 'Authors may only submit tickets for books belonging to their account.'
    });
  }

  const aiResult = await analyzeTicketWithAI({ subject, description, author, book });
  const newTicket = {
    id: `TKT-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    author_id: author.author_id,
    book_id: book ? book.book_id : 'GENERAL',
    subject: subject.trim(),
    description: description.trim(),
    status: 'Open',
    category: aiResult.category,
    priority: aiResult.priority,
    ai_confidence: aiResult.confidence,
    ai_reasoning: aiResult.reasoning,
    ai_draft_response: aiResult.draftResponse,
    ai_degraded: aiResult.aiDegraded,
    prompt_tokens_used: aiResult.promptTokensUsed,
    prompt_tokens_estimated: aiResult.promptTokensEstimated,
    assigned_to: 'Unassigned',
    attachments: Array.isArray(attachments) ? attachments.slice(0, 5).filter((item) => typeof item === 'string').map((item) => item.slice(0, 500)) : [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: [
      {
        id: `MSG-${Date.now()}`,
        sender_role: 'author',
        sender_name: author.name,
        body: description.trim(),
        created_at: new Date().toISOString()
      }
    ],
    internal_notes: []
  };
  tickets.unshift(newTicket);
  persistTickets();
  broadcastSse('ticket_created', { id: newTicket.id, author_id: newTicket.author_id }, newTicket.author_id);
  return res.status(201).json({ ticket: newTicket });
}));

// 5. PATCH /api/v1/tickets/:id/triage (Admin Override for Category, Priority, Status & Assignee)
app.patch('/api/v1/tickets/:id/triage', authenticateToken, requireRole('admin'), (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ticket not found.' });

  const { status, category, priority, assigned_to } = req.body || {};
  const statuses = ['Open', 'In Progress', 'Resolved', 'Closed'];
  const categories = ['Royalty & Payments', 'ISBN & Metadata Issues', 'Printing & Quality', 'Distribution & Availability', 'Book Status & Production Updates', 'General Inquiry'];
  const priorities = ['Critical', 'High', 'Medium', 'Low'];
  if ((status !== undefined && !statuses.includes(status)) || (category !== undefined && !categories.includes(category)) ||
      (priority !== undefined && !priorities.includes(priority)) ||
      (assigned_to !== undefined && (typeof assigned_to !== 'string' || assigned_to.length > 120))) {
    return res.status(422).json({ error: 'VALIDATION_ERROR', message: 'One or more triage fields are invalid.' });
  }
  if (status) ticket.status = status;
  if (category) ticket.category = category;
  if (priority) ticket.priority = priority;
  if (assigned_to) ticket.assigned_to = assigned_to;
  ticket.updated_at = new Date().toISOString();
  persistTickets();

  broadcastSse('ticket_updated', { id: ticket.id, status: ticket.status }, ticket.author_id);
  return res.json({ ticket });
});

app.post('/api/v1/tickets/:id/draft', authenticateToken, requireRole('admin'), asyncHandler(async (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ticket not found.' });
  const author = seedData.authors.find((a) => a.author_id === ticket.author_id);
  const book = author?.books.find((b) => b.book_id === ticket.book_id) || null;
  const context = { subject: ticket.subject, description: ticket.description, author, book };
  const result = req.body?.fallback_only === true
    ? deterministicTriageAndDraft(context)
    : await analyzeTicketWithAI(context);
  if (req.body?.fallback_only === true) result.aiDegraded = true;
  ticket.ai_draft_response = result.draftResponse;
  ticket.ai_degraded = result.aiDegraded;
  ticket.prompt_tokens_used = result.promptTokensUsed;
  ticket.prompt_tokens_estimated = result.promptTokensEstimated;
  ticket.updated_at = new Date().toISOString();
  persistTickets();
  return res.json({ ticket });
}));

// 6. POST /api/v1/tickets/:id/responses (Admin or Author Reply / Admin Internal Note)
app.post('/api/v1/tickets/:id/responses', authenticateToken, (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ticket not found.' });
  if (req.user.role === 'author' && ticket.author_id !== req.user.sub) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot access another author ticket.' });
  }
  const { body, is_internal_note, next_status } = req.body || {};
  if (typeof body !== 'string' || !body.trim() || body.trim().length > 10000) {
    return res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Message body cannot be empty.' });
  }

  if (is_internal_note) {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Only admins can add internal notes.' });
    }
    ticket.internal_notes.push({
      id: `NOTE-${Date.now()}`,
      author_name: req.user.name,
      body: body.trim(),
      created_at: new Date().toISOString()
    });
  } else {
    if (next_status && (req.user.role !== 'admin' || !['Open', 'In Progress', 'Resolved', 'Closed'].includes(next_status))) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', message: 'The requested status is invalid.' });
    }
    ticket.messages.push({
      id: `MSG-${Date.now()}`,
      sender_role: req.user.role,
      sender_name: req.user.name,
      body: body.trim(),
      created_at: new Date().toISOString()
    });
    if (next_status && req.user.role === 'admin') {
      ticket.status = next_status;
    }
  }
  ticket.updated_at = new Date().toISOString();
  persistTickets();
  broadcastSse('ticket_message', { id: ticket.id, status: ticket.status }, ticket.author_id);
  return res.status(201).json({ ticket });
});

// 7. GET /api/v1/events (Real-Time Server-Sent Events Stream)
app.get('/api/v1/events', authenticateToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.set(res, req.user);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  heartbeat.unref();
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));

app.use((err, _req, res, _next) => {
  console.error('[API]', err.message);
  res.status(err.status || 500).json({ error: 'INTERNAL_ERROR', message: 'The request could not be completed.' });
});

app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`BookLeaf Portal API & Frontend running on http://localhost:${PORT}`);
  });
}

module.exports = app;
