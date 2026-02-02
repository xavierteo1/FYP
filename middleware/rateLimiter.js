/**
 * Rate Limiting Middleware
 * Prevents API abuse with 5 requests per minute per user
 */

const requestCounts = new Map(); // Store: userId -> { count, resetTime }

const RATE_LIMIT = 5; // requests
const WINDOW_MS = 60 * 1000; // 1 minute in milliseconds

function rateLimiter(req, res, next) {
  // Skip rate limiting for non-authenticated users (they can't use AI anyway)
  if (!req.session || !req.session.user) {
    return next();
  }

  const userId = req.session.user.user_id;
  const now = Date.now();

  // Get or initialize user's request data
  let userRequests = requestCounts.get(userId);

  if (!userRequests || now > userRequests.resetTime) {
    // Reset if window expired
    userRequests = { count: 0, resetTime: now + WINDOW_MS };
    requestCounts.set(userId, userRequests);
  }

  // Check if user exceeded limit
  if (userRequests.count >= RATE_LIMIT) {
    const resetIn = Math.ceil((userRequests.resetTime - now) / 1000);
    return res.status(429).json({
      success: false,
      error: `Too many requests. Please wait ${resetIn} seconds before trying again.`,
      retryAfter: resetIn
    });
  }

  // Increment counter
  userRequests.count++;

  // Add helpful headers
  res.set('X-RateLimit-Limit', RATE_LIMIT);
  res.set('X-RateLimit-Remaining', RATE_LIMIT - userRequests.count);
  res.set('X-RateLimit-Reset', new Date(userRequests.resetTime).toISOString());

  next();
}

module.exports = rateLimiter;
