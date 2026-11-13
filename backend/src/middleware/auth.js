const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'bookleaf-dev-secret-do-not-use-in-prod');
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production.');
}

/**
 * Verifies Bearer JWT token on all protected REST API endpoints.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing Bearer authentication token.'
    });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { sub: author_id | 'ADMIN', role: 'author' | 'admin', email, name }
    next();
  } catch (err) {
    return res.status(403).json({
      error: 'FORBIDDEN_INVALID_TOKEN',
      message: 'Invalid or expired authentication token.'
    });
  }
}

/**
 * Role-based access control guard.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'INSUFFICIENT_PERMISSIONS',
        message: `Access restricted to roles: ${allowedRoles.join(', ')}`
      });
    }
    next();
  };
}

module.exports = { authenticateToken, requireRole, JWT_SECRET };
