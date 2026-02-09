const db = require('../db');
const bcrypt = require('bcryptjs');
const {
  sendOTPEmail,
  sendAccountTerminationEmail,
  sendSahmPayoutDecisionEmail,
  sendSahmPayoutCreditedEmail
} = require('../utils/mailer');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
require('dotenv').config();

const adminMailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

function sendAdminConfigurableEmail(to, subject, html) {
  const mailOptions = {
    from: `"Wardrobe Plug" <${process.env.MAIL_USER}>`,
    to,
    subject,
    html
  };
  return adminMailTransporter.sendMail(mailOptions);
}
// Helper to generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ============================================
// SIGNUP (CREATE USER + SEND OTP)
// ============================================
exports.signup = (req, res) => {
  const { username, password, email, full_name, gender, bio } = req.body;

  // profile image from multer (optional)
  let profileImageUrl = null;
  if (req.file) {
    // Cloudinary returns the full URL in req.file.path
    profileImageUrl = req.file.path;
  }

  if (!username || !password || !email) {
    return res.render('signup', { message: 'Please fill in all required fields.' });
  }

  // Check if username or email already exists
  const checkQuery = 'SELECT * FROM users WHERE username = ? OR email = ?';
  db.query(checkQuery, [username, email], (err, results) => {
    if (err) {
      console.error('DB error during signup:', err);
      return res.render('signup', { message: 'Server error. Please try again.' });
    }

    if (results.length > 0) {
      return res.render('signup', { message: 'Username or email already exists.' });
    }

    // Hash password
    const hashedPassword = bcrypt.hashSync(password, 10);

    const insertUserQuery = `
      INSERT INTO users 
        (username, password_hash, email, full_name, bio, gender, profile_image_url, role, is_email_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 0)
    `;

    db.query(
      insertUserQuery,
      [
        username,
        hashedPassword,
        email,
        full_name || null,
        bio || null,
        gender || null,          // must be 'male','female','other' or NULL
        profileImageUrl || null
      ],
      (err2, result) => {
        if (err2) {
          console.error('Insert user error:', err2);
          return res.render('signup', { message: 'Could not create user. Please try again.' });
        }

        const userId = result.insertId;
        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        const insertOtpQuery = `
          INSERT INTO email_otps (user_id, email, otp_code, purpose, expires_at, is_used)
          VALUES (?, ?, ?, 'registration', ?, 0)
        `;

        db.query(
          insertOtpQuery,
          [userId, email, otp, expiresAt],
          async (err3) => {
            if (err3) {
              console.error('Insert OTP error:', err3);
              return res.render('signup', { message: 'Could not generate OTP. Try again.' });
            }

            try {
              await sendOTPEmail(email, otp);
              // Go to OTP verification page
              return res.render('verifyOtp', { email, message: null });
            } catch (emailError) {
              console.error('Error sending OTP email:', emailError);
              return res.render('signup', { message: 'Failed to send OTP email. Try again later.' });
            }
          }
        );
      }
    );
  });
};

// ============================================
// RENDER VERIFY OTP PAGE
// ============================================
exports.verifyOtpPage = (req, res) => {
  const email = req.query.email || '';
  res.render('verifyOtp', { email, message: null });
};

// ============================================
// VERIFY OTP (ACTIVATE USER)
// ============================================
exports.verifyOtp = (req, res) => {
  const { email, otp_code } = req.body;

  if (!email || !otp_code) {
    return res.render('verifyOtp', { email, message: 'Email and OTP are required.' });
  }

  const findOtpQuery = `
    SELECT * FROM email_otps
    WHERE email = ?
      AND otp_code = ?
      AND purpose = 'registration'
      AND is_used = 0
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `;

  db.query(findOtpQuery, [email, otp_code], (err, otpResults) => {
    if (err) {
      console.error('DB error during OTP verify:', err);
      return res.render('verifyOtp', { email, message: 'Server error. Try again.' });
    }

    if (otpResults.length === 0) {
      return res.render('verifyOtp', { email, message: 'Invalid or expired OTP.' });
    }

    const otpRow = otpResults[0];
    const userId = otpRow.user_id;

    const markUsedQuery = 'UPDATE email_otps SET is_used = 1 WHERE otp_id = ?';
    const verifyUserQuery = 'UPDATE users SET is_email_verified = 1 WHERE user_id = ?';

    db.query(markUsedQuery, [otpRow.otp_id], (err2) => {
      if (err2) {
        console.error('Error marking OTP used:', err2);
        // still proceed to verify user
      }

      db.query(verifyUserQuery, [userId], (err3) => {
        if (err3) {
          console.error('Error verifying user email:', err3);
          return res.render('verifyOtp', { email, message: 'Could not verify account. Try again.' });
        }

        req.flash('success_msg', 'Email verified! You can now log in.');
        return res.redirect('/login');
      });
    });
  });
};

// ============================================
// LOGIN
// ============================================
exports.login = (req, res) => {
  const { identifier, password } = req.body; // identifier = username or email

  if (!identifier || !password) {
    return res.render('login', { message: 'Please enter your username/email and password.' });
  }

  const findUserQuery = `
    SELECT * FROM users
    WHERE username = ? OR email = ?
    LIMIT 1
  `;

  db.query(findUserQuery, [identifier, identifier], (err, results) => {
    if (err) {
      console.error('DB error during login:', err);
      return res.render('login', { message: 'Server error. Please try again.' });
    }

    if (results.length === 0) {
      return res.render('login', { message: 'Invalid username/email or password.' });
    }

    const user = results[0];

    if (!user.is_email_verified || user.is_email_verified != 1) {
      return res.render('login', { message: 'Please verify your email via OTP before logging in.' });
    }

    const isPasswordValid = bcrypt.compareSync(password, user.password_hash);
    if (!isPasswordValid) {
      return res.render('login', { message: 'Invalid username/email or password.' });
    }

    // Store basic user info in session
    req.session.user = {
      user_id: user.user_id,
      username: user.username,
      full_name: user.full_name,
      role: user.role
    };

    if (user.role === 'admin') {
      return res.redirect('/adminpage');
    }

    return res.redirect('/');
  });
};

// ============================================
// LOGOUT
// ============================================
exports.logout = (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
};

// ============================================
// PROFILE (placeholder - to be expanded later)
// ============================================
// ============================================
// PROFILE PAGE
// ============================================
exports.profile = (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const currentUser = req.session.user;
    const userId = currentUser.user_id;

    // 1) Get the full user row (in case we want gender/email/etc.)
    const userQuery = 'SELECT * FROM users WHERE user_id = ?';

    db.query(userQuery, [userId], (errUser, userRows) => {
        if (errUser) {
            console.error('DB error loading profile user:', errUser);
            return res.render('profile', {
                user: currentUser,
                message: 'Error loading profile.',
                ootdPosts: [],
                wardrobeStats: { total: 0, swap: 0, personal: 0 }
            });
        }

        if (!userRows || userRows.length === 0) {
            return res.render('profile', {
                user: currentUser,
                message: 'User not found.',
                ootdPosts: [],
                wardrobeStats: { total: 0, swap: 0, personal: 0 }
            });
        }

        const fullUser = userRows[0];

        // 2) Load THIS USER'S OOTD posts (similar style to getHomeFeed)
        const ootdSql = `
            SELECT 
                p.post_id,
                p.user_id,
                p.caption,
                p.visibility,
                p.image_url_1,
                p.image_url_2,
                p.image_url_3,
                p.created_at,
                (SELECT COUNT(*) FROM ootd_likes l WHERE l.post_id = p.post_id) AS like_count,
                (SELECT COUNT(*) FROM ootd_comments c WHERE c.post_id = p.post_id) AS comment_count
            FROM ootd_posts p
            WHERE p.user_id = ?
            ORDER BY p.created_at DESC
        `;

        db.query(ootdSql, [userId], (errOotd, ootdRows) => {
            if (errOotd) {
                console.error('Error loading own OOTD posts for profile:', errOotd);
                return res.render('profile', {
                    user: fullUser,
                    message: 'Error loading your OOTD posts.',
                    ootdPosts: [],
                    wardrobeStats: { total: 0, swap: 0, personal: 0 }
                });
            }

            const ootdPosts = ootdRows || [];
            console.log('Profile – ootdPosts length:', ootdPosts.length);

            // 3) Wardrobe stats
            const wardrobeStatsQuery = `
                SELECT 
                    COUNT(*) AS total,
                    SUM(CASE WHEN is_for_swap = 1 THEN 1 ELSE 0 END) AS swap,
                    SUM(CASE WHEN is_for_swap = 0 THEN 1 ELSE 0 END) AS personal
                FROM clothing_items
                WHERE owner_user_id = ?
            `;

            db.query(wardrobeStatsQuery, [userId], (errStats, statsRows) => {
                let wardrobeStats = { total: 0, swap: 0, personal: 0 };

                if (!errStats && statsRows && statsRows.length > 0) {
                    const row = statsRows[0];
                    wardrobeStats = {
                        total: row.total || 0,
                        swap: row.swap || 0,
                        personal: row.personal || 0
                    };
                } else if (errStats) {
                    console.error('Error loading wardrobe stats:', errStats);
                }

                return res.render('profile', {
                    user: fullUser,
                    message: null,
                    ootdPosts,          // <-- ALWAYS passed
                    wardrobeStats
                });
            });
        });
    });
};


// ============================================
// UPLOAD OOTD (placeholder - to be expanded later)
// ============================================
exports.uploadOOTD = (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  // For now just placeholder logic so app.js doesn't break
  // You can expand this later to actually insert into ootd_posts
  req.flash('success_msg', 'OOTD upload endpoint not implemented yet.');
  return res.redirect('/profile');
};




exports.searchUsersInline = (req, res) => {
    const currentUser = req.session.user || null;
    const q = (req.query.q || '').trim();

    if (!q) {
        return res.render('index', {
            user: currentUser,
            ootdPosts: [],       // empty feed during search
            searchResults: [],
            query: '',
            message: null
        });
    }

    const like = `%${q}%`;

    const sql = `
        SELECT 
            user_id,
            username,
            email,
            profile_image_url
        FROM users
        WHERE username LIKE ? OR email LIKE ?
        ORDER BY username ASC
        LIMIT 30
    `;

    db.query(sql, [like, like], (err, results) => {
        if (err) {
            console.error("Search error:", err);
            return res.render('index', {
                user: currentUser,
                ootdPosts: [],
                searchResults: [],
                query: q,
                message: "Error searching users."
            });
        }

        // IMPORTANT:
        // results = searchResults
        // ootdPosts = empty array during search
        res.render('index', {
            user: currentUser,
            ootdPosts: [],            // hide feed while searching
            searchResults: results,   // ⬅️ correct
            query: q,
            message: null
        });
    });
};


// =====================================
// VIEW ANOTHER USER'S PUBLIC PROFILE
// GET /users/:id
// Shows their public wardrobe + (optionally) OOTD feed
// =====================================
exports.viewPublicProfile = (req, res) => {
    const currentUser = req.session.user || null;
    const profileUserId = req.params.id;

    // 1. Get basic user info
    const userSql = `
        SELECT 
            user_id,
            username,
            email,
            profile_image_url,
            gender
        FROM users
        WHERE user_id = ?
    `;

    db.query(userSql, [profileUserId], (errUser, userRows) => {
        if (errUser) {
            console.error('Error loading profile user:', errUser);
            req.flash('error_msg', 'Error loading user profile.');
            return res.redirect('/');
        }

        if (userRows.length === 0) {
            req.flash('error_msg', 'User not found.');
            return res.redirect('/');
        }

        const profileUser = userRows[0];
        const isSelf = currentUser && currentUser.user_id === profileUser.user_id;

        // 2. Get their PUBLIC wardrobe items
        const wardrobeSql = `
            SELECT 
                ci.item_id,
                ci.title,
                ci.category,
                ci.size_label,
                ci.color,
                ci.condition_grade,
                ci.description,
                ci.is_for_swap,
                ci.is_public,
                ci.image_url_1,
                ci.image_url_2,
                ci.image_url_3,
                b.name AS brand_name
            FROM clothing_items ci
            LEFT JOIN brands b ON ci.brand_id = b.brand_id
            WHERE ci.owner_user_id = ?
              AND ci.is_public = 1
            ORDER BY ci.created_at DESC
        `;

        db.query(wardrobeSql, [profileUserId], (errWardrobe, items) => {
            if (errWardrobe) {
                console.error('Error loading public wardrobe:', errWardrobe);
                req.flash('error_msg', 'Error loading user wardrobe.');
                return res.redirect('/');
            }

            const publicItems = items || [];
            const publicSwapItems = publicItems.filter(i => i.is_for_swap === 1);

            // 3. (Optional) their public OOTD posts for profile page
            const ootdSql = `
                SELECT 
                    p.post_id,
                    p.image_url_1,
                    p.image_url_2,
                    p.image_url_3,
                    p.caption,
                    p.visibility,
                    p.created_at,
                    (SELECT COUNT(*) FROM ootd_likes l WHERE l.post_id = p.post_id) AS like_count,
                    (SELECT COUNT(*) FROM ootd_comments c WHERE c.post_id = p.post_id) AS comment_count
                FROM ootd_posts p
                WHERE p.user_id = ?
                  AND (p.visibility = 'public' OR p.visibility IS NULL)
                ORDER BY p.created_at DESC
            `;

            db.query(ootdSql, [profileUserId], (errOotd, ootdPosts) => {
                if (errOotd) {
                    console.error('Error loading user OOTD posts:', errOotd);
                    // still continue, just show no posts
                    ootdPosts = [];
                }

                res.render('publicProfile', {
                    user: currentUser,       // logged-in user (for navbar)
                    profileUser,            // the profile being viewed
                    isSelf,
                    publicItems,
                    publicSwapItems,
                    ootdPosts: ootdPosts || []
                });
            });
        });
    });
};




// ============================================
// ADMIN DASHBOARD (only for role = 'admin')
// ============================================
function requireAdmin(req, res) {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    res.redirect('/login');
    return false;
  }
  if (req.session.user.role !== 'admin') {
    req.flash('error_msg', 'Access denied. Admins only.');
    res.redirect('/');
    return false;
  }
  return true;
}

// ============================================
// PAYPAL (refunds) - uses same sandbox/live env
// ============================================
function getPayPalBaseUrl() {
  return (process.env.PAYPAL_MODE || 'sandbox') === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !secret) throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET');

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const resp = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`PayPal token error: ${JSON.stringify(json)}`);
  return json.access_token;
}

// Refund a CAPTURE (this is what you have saved in swap_payments.provider_capture_id)
async function paypalRefundCapture(captureId, { amount, currency = 'SGD', note } = {}) {
  if (!captureId) throw new Error('Missing PayPal captureId');
  const token = await getPayPalAccessToken();

  // PayPal allows full refund without amount, but we pass amount for safety.
  const body = {};
  if (amount != null) {
    body.amount = {
      value: Number(amount).toFixed(2),
      currency_code: String(currency || 'SGD').toUpperCase()
    };
  }
  if (note) body.note_to_payer = String(note).slice(0, 255);

  const resp = await fetch(`${getPayPalBaseUrl()}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`PayPal refund error: ${JSON.stringify(json)}`);
  return json; // includes id + status
}

async function paypalGetRefund(refundId) {
  if (!refundId) throw new Error('Missing PayPal refundId');
  const token = await getPayPalAccessToken();

  const resp = await fetch(`${getPayPalBaseUrl()}/v2/payments/refunds/${refundId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`PayPal refund status error: ${JSON.stringify(json)}`);
  return json;
}

function getPayPalBaseUrl() {
  return (process.env.PAYPAL_MODE || 'sandbox') === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !secret) throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET');

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const resp = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`PayPal token error: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function paypalSendPayout({ receiverEmail, amount, currency, senderBatchId, note }) {
  const token = await getPayPalAccessToken();

  const body = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'You have received a payout',
      email_message: 'Your SAHM payout has been processed.'
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: Number(amount).toFixed(2), currency },
        receiver: receiverEmail,
        note: note || 'SAHM payout',
        sender_item_id: `item-${senderBatchId}`
      }
    ]
  };

  const resp = await fetch(`${getPayPalBaseUrl()}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`PayPal payout error: ${JSON.stringify(json)}`);
  return json;
}

async function paypalGetPayoutBatch(payoutBatchId) {
  if (!payoutBatchId) throw new Error('Missing payoutBatchId');

  const token = await getPayPalAccessToken();

  const resp = await fetch(`${getPayPalBaseUrl()}/v1/payments/payouts/${payoutBatchId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`PayPal get batch error: ${JSON.stringify(json)}`);
  return json;
}

// Decides if we should mark as "paid" based on batch + item transaction status
function evaluatePayoutCredited(batchDetails) {
  const batchStatus = String(batchDetails?.batch_header?.batch_status || '').toUpperCase();
  if (batchStatus === 'SUCCESS') return { ok: true, reason: 'BATCH_SUCCESS' };

  const items = batchDetails?.items || [];
  if (!items.length) return { ok: false, reason: 'NO_ITEMS' };

  // PayPal sometimes nests transaction status differently; try common paths
  const item0 = items[0] || {};
  const itemStatus =
    String(
      item0?.transaction_status ||
      item0?.payout_item?.transaction_status ||
      item0?.payout_item?.transaction_status ||
      ''
    ).toUpperCase();

  // Treat UNCLAIMED as "credited" for your app flow (money sent, waiting acceptance)
  if (itemStatus === 'SUCCESS' || itemStatus === 'UNCLAIMED') {
    return { ok: true, reason: `ITEM_${itemStatus}` };
  }

  // Hard fail statuses
  if (['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'CANCELED', 'DENIED'].includes(itemStatus)) {
    return { ok: false, reason: `ITEM_${itemStatus}`, hardFail: true };
  }

  return { ok: false, reason: `ITEM_${itemStatus || 'UNKNOWN'}` };
}


exports.adminApprovePayout = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const adminId = req.session.user.user_id;
  const payoutId = Number(req.params.id);

  if (!payoutId) {
    req.flash('error_msg', 'Invalid payout request.');
    return res.redirect('/admin');
  }

  const loadSql = `
    SELECT
      spr.*,
      u.username AS sahm_username,
      u.email AS sahm_email
    FROM sahm_payout_requests spr
    JOIN users u ON u.user_id = spr.sahm_user_id
    WHERE spr.payout_id = ?
    LIMIT 1
  `;

  db.query(loadSql, [payoutId], (err, rows) => {
    if (err) {
      console.error('adminApprovePayout loadSql error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/admin');
    }
    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'Payout request not found.');
      return res.redirect('/admin');
    }

    const pr = rows[0];
    if (String(pr.status).toLowerCase() !== 'pending') {
      req.flash('error_msg', `Cannot approve. Current status: ${pr.status}`);
      return res.redirect('/admin');
    }

    const receiverEmail = (pr.receiver_email || '').trim();
    const currency = (pr.currency || process.env.PAYPAL_CURRENCY || 'SGD').toUpperCase();
    const totalAmount = Number(pr.total_amount || 0);

    if (!receiverEmail) {
      req.flash('error_msg', 'Missing receiver PayPal email for this payout request.');
      return res.redirect('/admin');
    }
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      req.flash('error_msg', 'Invalid payout amount.');
      return res.redirect('/admin');
    }

    // Rule: SAHM cannot cash out if they have active jobs
    const ongoingSql = `
      SELECT COUNT(*) AS ongoingCount
      FROM pickup_delivery_requests
      WHERE sahm_user_id = ?
        AND status IN ('accepted','in_progress')
    `;

    db.query(ongoingSql, [pr.sahm_user_id], (oErr, oRows) => {
      if (oErr) {
        console.error('adminApprovePayout ongoingSql error:', oErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect('/admin');
      }

      const ongoingCount = Number(oRows?.[0]?.ongoingCount || 0);
      if (ongoingCount > 0) {
        req.flash('error_msg', 'Cannot approve: SAHM has ongoing jobs.');
        return res.redirect('/admin');
      }

      // Validate linked legs exist & totals match
      const legsSql = `
        SELECT
          COUNT(*) AS legCount,
          COALESCE(SUM(IFNULL(sahm_earning,0)),0) AS legTotal
        FROM pickup_delivery_requests
        WHERE payout_id = ?
          AND sahm_user_id = ?
          AND status = 'completed'
          AND is_earning_paid = 0
      `;

      db.query(legsSql, [payoutId, pr.sahm_user_id], (lErr, lRows) => {
        if (lErr) {
          console.error('adminApprovePayout legsSql error:', lErr);
          req.flash('error_msg', 'Server error.');
          return res.redirect('/admin');
        }

        const legCount = Number(lRows?.[0]?.legCount || 0);
        const legTotal = Number(lRows?.[0]?.legTotal || 0);

        if (legCount <= 0 || legTotal <= 0) {
          req.flash('error_msg', 'No eligible completed earnings found for this payout.');
          return res.redirect('/admin');
        }

        if (Math.abs(legTotal - totalAmount) > 0.01) {
          req.flash('error_msg', 'Payout total mismatch. Please ask SAHM to re-request payout.');
          return res.redirect('/admin');
        }

        // Approve -> processing
        const senderBatchId = `SPR-${payoutId}-${Date.now()}`;

        const approveSql = `
          UPDATE sahm_payout_requests
          SET
            status='processing',
            approved_by=?,
            approved_at=NOW(),
            paypal_sender_batch_id=?,
            updated_at=NOW()
          WHERE payout_id=? AND status='pending'
          LIMIT 1
        `;

        db.query(approveSql, [adminId, senderBatchId, payoutId], async (aErr, aRes) => {
          if (aErr || !aRes || aRes.affectedRows === 0) {
            console.error('adminApprovePayout approveSql error:', aErr);
            req.flash('error_msg', 'Failed to approve payout.');
            return res.redirect('/admin');
          }

          try {
            // 1) Create payout
            const resp = await paypalSendPayout({
              receiverEmail,
              amount: totalAmount,
              currency,
              senderBatchId,
              note: `SAHM payout #${payoutId}`
            });

            const batchId = resp?.batch_header?.payout_batch_id || null;
            const batchStatus = resp?.batch_header?.batch_status || null;

            // 2) Save PayPal response
            db.query(
              `
                UPDATE sahm_payout_requests
                SET paypal_payout_batch_id=?,
                    paypal_batch_status=?,
                    updated_at=NOW()
                WHERE payout_id=?
                LIMIT 1
              `,
              [batchId, batchStatus, payoutId],
              () => {}
            );

            // ✅ Email #1: Admin approved (after PayPal create)
            if (pr.sahm_email) {
              sendSahmPayoutDecisionEmail(pr.sahm_email, {
                username: pr.sahm_username,
                payoutId,
                status: 'approved',
                amount: totalAmount,
                currency,
                receiverEmail,
                paypalBatchId: batchId,
                paypalBatchStatus: batchStatus
              }).catch(e => console.error('[MAIL] decision email error:', e));
            }

            // 3) QUICK CHECK (so it can flip to PAID immediately if item already success/unclaimed)
            let details = null;
            try {
              if (batchId) {
                await new Promise(r => setTimeout(r, 800));
                details = await paypalGetPayoutBatch(batchId);
              }
            } catch (e) {
              console.warn('PayPal batch GET failed (remain processing):', e?.message || e);
            }

            if (details) {
              const credited = evaluatePayoutCredited(details);
              const latestBatchStatus = String(details?.batch_header?.batch_status || batchStatus || '');

              // always keep latest paypal batch status in DB
              db.query(
                `
                  UPDATE sahm_payout_requests
                  SET paypal_batch_status=?, updated_at=NOW()
                  WHERE payout_id=? LIMIT 1
                `,
                [latestBatchStatus, payoutId],
                () => {}
              );

              if (credited.ok) {
                // mark PAID + legs PAID + send receipt email
                db.query(
                  `
                    UPDATE sahm_payout_requests
                    SET status='paid', processed_at=NOW(), updated_at=NOW()
                    WHERE payout_id=? LIMIT 1
                  `,
                  [payoutId],
                  (mpErr) => {
                    if (mpErr) console.error('adminApprovePayout markPaid error:', mpErr);

                    db.query(
                      `
                        UPDATE pickup_delivery_requests
                        SET is_earning_paid=1, updated_at=NOW()
                        WHERE payout_id=? AND sahm_user_id=? AND status='completed' AND is_earning_paid=0
                      `,
                      [payoutId, pr.sahm_user_id],
                      (lpErr) => {
                        if (lpErr) console.error('adminApprovePayout legsPaid error:', lpErr);

                        if (pr.sahm_email) {
                          sendSahmPayoutCreditedEmail(pr.sahm_email, {
                            username: pr.sahm_username,
                            payoutId,
                            amount: totalAmount,
                            currency,
                            receiverEmail,
                            paypalBatchId: batchId,
                            paypalBatchStatus: latestBatchStatus
                          }).catch(e => console.error('[MAIL] credited email error:', e));
                        }

                        req.flash('success_msg', `Payout credited (#${payoutId}).`);
                        return res.redirect('/admin');
                      }
                    );
                  }
                );
                return;
              }

              if (credited.hardFail) {
                const msg = `PayPal payout failed: ${credited.reason}`;
                db.query(
                  `
                    UPDATE sahm_payout_requests
                    SET status='failed', last_error=?, updated_at=NOW()
                    WHERE payout_id=? LIMIT 1
                  `,
                  [msg, payoutId],
                  () => {}
                );

                if (pr.sahm_email) {
                  sendSahmPayoutDecisionEmail(pr.sahm_email, {
                    username: pr.sahm_username,
                    payoutId,
                    status: 'failed',
                    amount: totalAmount,
                    currency,
                    receiverEmail,
                    reason: msg,
                    paypalBatchId: batchId,
                    paypalBatchStatus: latestBatchStatus
                  }).catch(e => console.error('[MAIL] failed email error:', e));
                }

                req.flash('error_msg', `Payout failed (#${payoutId}).`);
                return res.redirect('/admin');
              }
            }

            // Remain processing (admin can Sync Status)
            req.flash(
              'success_msg',
              `Payout approved (#${payoutId}). PayPal status: ${batchStatus || 'processing'}. You can Sync Status if needed.`
            );
            return res.redirect('/admin');

          } catch (e) {
            console.error('adminApprovePayout PayPal error:', e);

            db.query(
              `
                UPDATE sahm_payout_requests
                SET status='failed', last_error=?, updated_at=NOW()
                WHERE payout_id=? LIMIT 1
              `,
              [String(e?.message || e), payoutId],
              () => {
                if (pr.sahm_email) {
                  sendSahmPayoutDecisionEmail(pr.sahm_email, {
                    username: pr.sahm_username,
                    payoutId,
                    status: 'failed',
                    amount: totalAmount,
                    currency,
                    receiverEmail,
                    reason: String(e?.message || e)
                  }).catch(ex => console.error('[MAIL] failed email error:', ex));
                }

                req.flash('error_msg', `PayPal payout failed for #${payoutId}. Marked as failed.`);
                return res.redirect('/admin');
              }
            );
          }
        });
      });
    });
  });
};

// ============================================
// ADMIN: Sync PayPal status for a processing payout
// POST /admin/payouts/:id/sync
// ============================================
exports.adminSyncPayoutStatus = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const payoutId = Number(req.params.id);
  if (!payoutId) {
    req.flash('error_msg', 'Invalid payout request.');
    return res.redirect('/admin');
  }

  const loadSql = `
    SELECT
      spr.*,
      u.username AS sahm_username,
      u.email AS sahm_email
    FROM sahm_payout_requests spr
    JOIN users u ON u.user_id = spr.sahm_user_id
    WHERE spr.payout_id = ?
    LIMIT 1
  `;

  db.query(loadSql, [payoutId], async (err, rows) => {
    if (err) {
      console.error('adminSyncPayoutStatus loadSql error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/admin');
    }
    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'Payout request not found.');
      return res.redirect('/admin');
    }

    const pr = rows[0];

    if (String(pr.status).toLowerCase() === 'paid') {
      req.flash('success_msg', `Payout #${payoutId} is already paid.`);
      return res.redirect('/admin');
    }

    if (String(pr.status).toLowerCase() !== 'processing') {
      req.flash('error_msg', `Only processing payouts can be synced. Current: ${pr.status}`);
      return res.redirect('/admin');
    }

    if (!pr.paypal_payout_batch_id) {
      req.flash('error_msg', 'Missing PayPal batch id for this payout.');
      return res.redirect('/admin');
    }

    try {
      const details = await paypalGetPayoutBatch(pr.paypal_payout_batch_id);
      const credited = evaluatePayoutCredited(details);
      const latestBatchStatus = String(details?.batch_header?.batch_status || '');

      // Always store latest PayPal status
      db.query(
        `
          UPDATE sahm_payout_requests
          SET paypal_batch_status=?, updated_at=NOW()
          WHERE payout_id=? LIMIT 1
        `,
        [latestBatchStatus, payoutId],
        () => {}
      );

      if (credited.ok) {
        // Mark paid + legs paid
        db.query(
          `
            UPDATE sahm_payout_requests
            SET status='paid', processed_at=NOW(), updated_at=NOW()
            WHERE payout_id=? LIMIT 1
          `,
          [payoutId],
          (mpErr) => {
            if (mpErr) console.error('adminSyncPayoutStatus markPaid error:', mpErr);

            db.query(
              `
                UPDATE pickup_delivery_requests
                SET is_earning_paid=1, updated_at=NOW()
                WHERE payout_id=? AND sahm_user_id=? AND status='completed' AND is_earning_paid=0
              `,
              [payoutId, pr.sahm_user_id],
              (lpErr) => {
                if (lpErr) console.error('adminSyncPayoutStatus legsPaid error:', lpErr);

                // Send credited email now
                if (pr.sahm_email) {
                  sendSahmPayoutCreditedEmail(pr.sahm_email, {
                    username: pr.sahm_username,
                    payoutId,
                    amount: Number(pr.total_amount || 0),
                    currency: (pr.currency || 'SGD').toUpperCase(),
                    receiverEmail: pr.receiver_email,
                    paypalBatchId: pr.paypal_payout_batch_id,
                    paypalBatchStatus: latestBatchStatus
                  }).catch(e => console.error('[MAIL] credited email error:', e));
                }

                req.flash('success_msg', `Synced: payout credited (#${payoutId}).`);
                return res.redirect('/admin');
              }
            );
          }
        );
        return;
      }

      if (credited.hardFail) {
        const msg = `PayPal payout failed: ${credited.reason}`;
        db.query(
          `
            UPDATE sahm_payout_requests
            SET status='failed', last_error=?, updated_at=NOW()
            WHERE payout_id=? LIMIT 1
          `,
          [msg, payoutId],
          () => {}
        );

        if (pr.sahm_email) {
          sendSahmPayoutDecisionEmail(pr.sahm_email, {
            username: pr.sahm_username,
            payoutId,
            status: 'failed',
            amount: Number(pr.total_amount || 0),
            currency: (pr.currency || 'SGD').toUpperCase(),
            receiverEmail: pr.receiver_email,
            reason: msg,
            paypalBatchId: pr.paypal_payout_batch_id,
            paypalBatchStatus: latestBatchStatus
          }).catch(e => console.error('[MAIL] failed email error:', e));
        }

        req.flash('error_msg', `Synced: payout failed (#${payoutId}).`);
        return res.redirect('/admin');
      }

      req.flash('success_msg', `Synced: still processing (#${payoutId}). PayPal: ${latestBatchStatus || 'processing'}`);
      return res.redirect('/admin');

    } catch (e) {
      console.error('adminSyncPayoutStatus PayPal error:', e);
      req.flash('error_msg', 'Failed to sync PayPal status. Try again.');
      return res.redirect('/admin');
    }
  });
};


// ============================================
// ADMIN: Reject payout (releases locked legs)
// POST /admin/payouts/:id/reject
// Email: Decision email (rejected)
// ============================================
exports.adminRejectPayout = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const adminId = req.session.user.user_id;
  const payoutId = Number(req.params.id);
  const reason = (req.body.reject_reason || '').trim() || null;

  if (!payoutId) {
    req.flash('error_msg', 'Invalid payout request.');
    return res.redirect('/admin');
  }

  const loadSql = `
    SELECT
      spr.*,
      u.username AS sahm_username,
      u.email AS sahm_email
    FROM sahm_payout_requests spr
    JOIN users u ON u.user_id = spr.sahm_user_id
    WHERE spr.payout_id = ?
    LIMIT 1
  `;

  db.query(loadSql, [payoutId], (err, rows) => {
    if (err) {
      console.error('adminRejectPayout loadSql error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/admin');
    }
    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'Payout request not found.');
      return res.redirect('/admin');
    }

    const pr = rows[0];
    if (String(pr.status).toLowerCase() !== 'pending') {
      req.flash('error_msg', `Cannot reject. Current status: ${pr.status}`);
      return res.redirect('/admin');
    }

    const rejectSql = `
      UPDATE sahm_payout_requests
      SET status='rejected',
          rejected_by=?,
          rejected_at=NOW(),
          reject_reason=?,
          updated_at=NOW()
      WHERE payout_id=? AND status='pending'
      LIMIT 1
    `;

    db.query(rejectSql, [adminId, reason, payoutId], (rErr, rRes) => {
      if (rErr || !rRes || rRes.affectedRows === 0) {
        console.error('adminRejectPayout rejectSql error:', rErr);
        req.flash('error_msg', 'Failed to reject payout.');
        return res.redirect('/admin');
      }

      // Release deliveries so SAHM can request again
      const releaseSql = `
        UPDATE pickup_delivery_requests
        SET payout_id=NULL, updated_at=NOW()
        WHERE payout_id=?
          AND sahm_user_id=?
          AND status='completed'
          AND is_earning_paid=0
      `;

      db.query(releaseSql, [payoutId, pr.sahm_user_id], (relErr) => {
        if (relErr) console.error('adminRejectPayout releaseSql error:', relErr);

        // Email rejection
        if (pr.sahm_email) {
          sendSahmPayoutDecisionEmail(pr.sahm_email, {
            username: pr.sahm_username,
            payoutId,
            status: 'rejected',
            amount: pr.total_amount,
            currency: pr.currency || 'SGD',
            receiverEmail: pr.receiver_email,
            reason
          }).catch(e => console.error('[MAIL] sendSahmPayoutDecisionEmail reject error:', e));
        }

        req.flash('success_msg', `Payout rejected (#${payoutId}). Earnings released back to SAHM.`);
        return res.redirect('/admin');
      });
    });
  });
};
exports.adminDashboard = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const adminUser = req.session.user;
  let pageMessage = null;

  const usersStatsSql = `
    SELECT
      COUNT(*) AS totalUsers,
      SUM(role = 'sahm') AS sahmUsers,
      SUM(role = 'admin') AS adminUsers
    FROM users
  `;

  db.query(usersStatsSql, (errUsers, userStatsRows) => {
    if (errUsers) {
      console.error('adminDashboard usersStatsSql error:', errUsers);
      pageMessage = 'Error loading user statistics.';
    }

    const userStats = (userStatsRows && userStatsRows[0]) ? userStatsRows[0] : {
      totalUsers: 0,
      sahmUsers: 0,
      adminUsers: 0
    };

    const sahmStatsSql = `
      SELECT
        SUM(status = 'submitted') AS submitted,
        SUM(status = 'under_review') AS under_review,
        SUM(status = 'approved') AS approved,
        SUM(status = 'rejected') AS rejected
      FROM sahm_applications
    `;

    db.query(sahmStatsSql, (errSahm, sahmStatsRows) => {
      let sahmStats = { submitted: 0, under_review: 0, approved: 0, rejected: 0 };

      if (errSahm) {
        console.error('adminDashboard sahmStatsSql error:', errSahm);
        if (!pageMessage) pageMessage = 'Error loading SAHM statistics.';
      } else if (sahmStatsRows && sahmStatsRows[0]) {
        sahmStats = sahmStatsRows[0];
      }

      const applicationsSql = `
        SELECT
          sa.application_id,
          sa.user_id,
          sa.document_url,
          sa.status,
          sa.admin_comment,
          sa.created_at,
          sa.updated_at,
          u.username,
          u.email
        FROM sahm_applications sa
        JOIN users u ON sa.user_id = u.user_id
        ORDER BY sa.created_at DESC
        LIMIT 20
      `;

      db.query(applicationsSql, (errApps, appRows) => {
        const applications = errApps ? [] : (appRows || []);
        if (errApps) {
          console.error('adminDashboard applicationsSql error:', errApps);
          if (!pageMessage) pageMessage = 'Error loading SAHM applications.';
        }

        const locationsSql = `
          SELECT
            l.location_id,
            l.user_id,
            u.username AS owner_username,
            l.label,
            l.address_line,
            l.city,
            l.postal_code,
            l.latitude,
            l.longitude,
            l.created_at
          FROM locations l
          LEFT JOIN users u ON l.user_id = u.user_id
          ORDER BY l.created_at DESC
          LIMIT 300
        `;

        db.query(locationsSql, (errLoc, locRows) => {
          const locations = errLoc ? [] : (locRows || []);
          if (errLoc) {
            console.error('adminDashboard locationsSql error:', errLoc);
            if (!pageMessage) pageMessage = 'Error loading locations.';
          }

          const payoutStatsSql = `
            SELECT
              SUM(status='pending')    AS pending,
              SUM(status='approved')   AS approved,
              SUM(status='processing') AS processing,
              SUM(status='paid')       AS paid,
              SUM(status='rejected')   AS rejected,
              SUM(status='failed')     AS failed
            FROM sahm_payout_requests
          `;

          const payoutListSql = `
            SELECT
              spr.*,
              u.username AS sahm_username,
              u.email AS sahm_email,
              sp.paypal_email AS sahm_paypal_email
            FROM sahm_payout_requests spr
            JOIN users u ON spr.sahm_user_id = u.user_id
            LEFT JOIN sahm_profiles sp ON sp.sahm_user_id = spr.sahm_user_id
            ORDER BY spr.created_at DESC
            LIMIT 50
          `;

          db.query(payoutStatsSql, (psErr, psRows) => {
            const payoutStats = (psErr || !psRows || !psRows[0]) ? {
              pending: 0, approved: 0, processing: 0, paid: 0, rejected: 0, failed: 0
            } : psRows[0];

            if (psErr) {
              console.error('adminDashboard payoutStatsSql error:', psErr);
              if (!pageMessage) pageMessage = 'Error loading payout stats.';
            }

            db.query(payoutListSql, (plErr, plRows) => {
              const payouts = plErr ? [] : (plRows || []);
              if (plErr) {
                console.error('adminDashboard payoutListSql error:', plErr);
                if (!pageMessage) pageMessage = 'Error loading payout requests.';
              }

              // ✅ SWAP CASES for /help
              const swapCasesSql = `
                SELECT
                  sc.case_id,
                  sc.match_id,
                  sc.case_type,
                  sc.reason,
                  sc.status,
                  sc.opened_by_user_id,
                  opener.username AS opened_by_username,
                  sc.created_at,
                  sc.updated_at,
                  c.chat_id
                FROM swap_cases sc
                JOIN users opener ON opener.user_id = sc.opened_by_user_id
                LEFT JOIN chats c ON c.match_id = sc.match_id
                WHERE sc.status IN ('open','under_review','resolved','rejected')
                ORDER BY sc.created_at DESC
                LIMIT 200
              `;

              db.query(swapCasesSql, (csErr, csRows) => {
                const swapCases = csErr ? [] : (csRows || []);
                if (csErr) {
                  console.error('adminDashboard swapCasesSql error:', csErr);
                  if (!pageMessage) pageMessage = 'Error loading swap cases.';
                }

                // ✅ REFUNDS
                const refundStatsSql = `
                  SELECT
                    SUM(status='pending') AS pending,
                    SUM(status='processing') AS processing,
                    SUM(status='refunded') AS refunded,
                    SUM(status='failed') AS failed
                  FROM swap_refunds
                `;

                const refundListSql = `
                  SELECT
                    sr.refund_id,
                    sr.case_id,
                    sr.match_id,
                    sr.payer_user_id AS user_id,
                    u.username AS user_username,
                    sr.amount,
                    sr.currency,
                    sr.status,
                    sr.paypal_refund_id,
                    sr.created_at
                  FROM swap_refunds sr
                  LEFT JOIN users u ON u.user_id = sr.payer_user_id
                  ORDER BY sr.created_at DESC
                  LIMIT 200
                `;

                db.query(refundStatsSql, (rsErr, rsRows) => {
                  const refundStats = (rsErr || !rsRows || !rsRows[0]) ? {
                    pending: 0, processing: 0, refunded: 0, failed: 0
                  } : rsRows[0];

                  if (rsErr) {
                    console.error('adminDashboard refundStatsSql error:', rsErr);
                    if (!pageMessage) pageMessage = 'Error loading refund stats.';
                  }

                  db.query(refundListSql, (rlErr, rlRows) => {
                    const swapRefunds = rlErr ? [] : (rlRows || []);
                    if (rlErr) {
                      console.error('adminDashboard refundListSql error:', rlErr);
                      if (!pageMessage) pageMessage = 'Error loading refunds.';
                    }

                    // Query for recent comments
                    const commentsSql = `
                      SELECT
                        oc.comment_id,
                        oc.post_id,
                        oc.user_id,
                        u.username,
                        oc.content AS comment_text,
                        oc.created_at
                      FROM ootd_comments oc
                      JOIN users u ON oc.user_id = u.user_id
                      ORDER BY oc.created_at DESC
                      LIMIT 50
                    `;

                    db.query(commentsSql, (cmErr, cmRows) => {
                      const comments = cmErr ? [] : (cmRows || []);
                      if (cmErr) {
                        console.error('adminDashboard commentsSql error:', cmErr);
                      }

                      const stats = {
                        users: userStats,
                        sahm: sahmStats,
                        payouts: payoutStats,
                        refunds: refundStats
                      };

                      return res.render('adminDashboard', {
                        user: adminUser,
                        stats,
                        applications,
                        payouts,
                        locations,
                        swapCases,
                        swapRefunds,
                        comments,
                        message: pageMessage
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
};




exports.adminAddLocation = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const label = (req.body.label || '').trim();
  const addressLine = (req.body.address_line || '').trim();
  const city = (req.body.city || '').trim();
  const postalCode = (req.body.postal_code || '').trim();

  const latRaw = (req.body.latitude || '').trim();
  const lngRaw = (req.body.longitude || '').trim();

  if (!label) {
    req.flash('error_msg', 'Location label is required.');
    return res.redirect('/admin');
  }

  let latitude = null;
  let longitude = null;

  if (latRaw || lngRaw) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      req.flash('error_msg', 'Latitude/Longitude must be valid numbers (or leave both blank).');
      return res.redirect('/admin');
    }

    latitude = lat;
    longitude = lng;
  }

  const insertSql = `
    INSERT INTO locations (user_id, label, address_line, city, postal_code, latitude, longitude)
    VALUES (NULL, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    insertSql,
    [label, addressLine || null, city || null, postalCode || null, latitude, longitude],
    (err) => {
      if (err) {
        console.error('adminAddLocation error:', err);
        req.flash('error_msg', 'Failed to add location.');
        return res.redirect('/admin');
      }

      req.flash('success_msg', 'Location added.');
      return res.redirect('/admin');
    }
  );
};

exports.adminDeleteLocation = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const locationId = Number(req.params.id);
  if (!locationId) {
    req.flash('error_msg', 'Invalid location.');
    return res.redirect('/admin');
  }

  // Block delete if used anywhere (your FKs RESTRICT this anyway; we pre-check for nicer UX)
  const usageSql = `
    SELECT
      (
        SELECT COUNT(*)
        FROM pickup_delivery_requests p
        WHERE p.pickup_location_id = ?
           OR p.dropoff_location_id = ?
      ) AS used_in_deliveries,
      (
        SELECT COUNT(*)
        FROM sahm_profiles sp
        WHERE sp.default_location_id = ?
      ) AS used_in_profiles
  `;

  db.query(usageSql, [locationId, locationId, locationId], (uErr, uRows) => {
    if (uErr) {
      console.error('adminDeleteLocation usage error:', uErr);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/admin');
    }

    const usedDeliveries = Number(uRows?.[0]?.used_in_deliveries || 0);
    const usedProfiles = Number(uRows?.[0]?.used_in_profiles || 0);
    const useCount = usedDeliveries + usedProfiles;

    if (useCount > 0) {
      req.flash('error_msg', 'Cannot delete. This location is in use.');
      return res.redirect('/admin');
    }

    const delSql = `
      DELETE FROM locations
      WHERE location_id = ?
        AND user_id IS NULL
      LIMIT 1
    `;

    db.query(delSql, [locationId], (dErr, result) => {
      if (dErr) {
        console.error('adminDeleteLocation delete error:', dErr);
        req.flash('error_msg', 'Failed to delete location.');
        return res.redirect('/admin');
      }

      if (!result || result.affectedRows === 0) {
        req.flash('error_msg', 'Location not found (or not admin-managed).');
        return res.redirect('/admin');
      }

      req.flash('success_msg', 'Location deleted.');
      return res.redirect('/admin');
    });
  });
};

// ============================================
// ADMIN: /help (swap_cases) + Refunds (swap_refunds)
// ============================================
function nl2br(s) {
  return String(s || '').replace(/\n/g, '<br>');
}

function mapPayPalRefundStatus(ppStatus) {
  const s = String(ppStatus || '').toUpperCase();
  if (s === 'COMPLETED') return 'refunded';
  if (s === 'PENDING') return 'processing';
  if (s === 'CANCELLED' || s === 'FAILED' || s === 'DENIED') return 'failed';
  return 'processing';
}

function buildRefundSummaryHtml(refundResults = []) {
  if (!refundResults.length) return '';

  const rowsHtml = refundResults.map(r => {
    const payer = r.payer_username || `User #${r.payer_user_id}`;
    const amt = `${r.currency || 'SGD'} ${Number(r.amount || 0).toFixed(2)}`;
    const status = String(r.status || '').toUpperCase();
    const refId = r.paypal_refund_id ? String(r.paypal_refund_id) : '-';
    const err = r.error_message
      ? `<br><span style="color:#b91c1c;">${String(r.error_message).slice(0, 220)}</span>`
      : '';
    return `<tr>
      <td style="padding:8px;border:1px solid #e5e7eb;">${payer}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;">${amt}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;">${status}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;">${refId}${err}</td>
    </tr>`;
  }).join('');

  return `
    <div style="margin-top:14px;">
      <h3 style="margin:0 0 8px;">Refunds</h3>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px;border:1px solid #e5e7eb;">Payer</th>
            <th style="text-align:left;padding:8px;border:1px solid #e5e7eb;">Amount</th>
            <th style="text-align:left;padding:8px;border:1px solid #e5e7eb;">Status</th>
            <th style="text-align:left;padding:8px;border:1px solid #e5e7eb;">PayPal Refund ID / Notes</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      <p style="margin:10px 0 0;font-size:12px;color:#6b7280;">
        If a refund is processing, it may take a short while to fully complete in PayPal.
      </p>
    </div>
  `;
}

// Refund ALL captured payments for this match (both users if both paid)
async function processRefundsForMatch({ caseId, matchId, adminId, note }) {
  const payments = await new Promise((resolve, reject) => {
    const sql = `
      SELECT
        sp.payment_id,
        sp.payer_user_id,
        sp.amount,
        sp.currency,
        sp.provider_capture_id,
        u.username AS payer_username
      FROM swap_payments sp
      JOIN users u ON u.user_id = sp.payer_user_id
      WHERE sp.match_id = ?
        AND sp.status = 'captured'
        AND sp.provider_capture_id IS NOT NULL
        AND sp.provider_capture_id <> ''
      ORDER BY sp.payment_id ASC
    `;
    db.query(sql, [matchId], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

  const results = [];

  for (const p of payments) {
    // Prevent duplicates
    const existing = await new Promise((resolve, reject) => {
      const chk = `
        SELECT refund_id, status
        FROM swap_refunds
        WHERE payment_id = ?
          AND status IN ('pending','processing','refunded')
        ORDER BY refund_id DESC
        LIMIT 1
      `;
      db.query(chk, [p.payment_id], (err, rows) => (err ? reject(err) : resolve(rows?.[0] || null)));
    });

    if (existing) {
      results.push({
        payment_id: p.payment_id,
        payer_user_id: p.payer_user_id,
        payer_username: p.payer_username,
        amount: p.amount,
        currency: p.currency,
        status: existing.status,
        paypal_refund_id: null,
        error_message: 'Refund already exists / in progress.'
      });
      continue;
    }

    // Create refund row first
    const refundId = await new Promise((resolve, reject) => {
      const ins = `
        INSERT INTO swap_refunds
          (case_id, match_id, payment_id, payer_user_id, amount, currency, status, paypal_capture_id, admin_user_id, admin_note, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, NOW(), NOW())
      `;
      db.query(
        ins,
        [caseId, matchId, p.payment_id, p.payer_user_id, p.amount, p.currency, p.provider_capture_id, adminId, note || null],
        (err, r) => (err ? reject(err) : resolve(r.insertId))
      );
    });

    try {
      const refunded = await paypalRefundCapture(p.provider_capture_id, {
        amount: p.amount,
        currency: p.currency,
        note: note || `Refund for match #${matchId}`
      });

      const ppRefundId = refunded?.id || null;
      const ppStatus = refunded?.status || null;
      const mapped = mapPayPalRefundStatus(ppStatus);

      await new Promise((resolve, reject) => {
        const upd = `
          UPDATE swap_refunds
          SET paypal_refund_id=?, paypal_refund_status=?, status=?, processed_at=NOW(), updated_at=NOW()
          WHERE refund_id=?
          LIMIT 1
        `;
        db.query(upd, [ppRefundId, ppStatus, mapped, refundId], (err) => (err ? reject(err) : resolve()));
      });

      if (mapped === 'refunded') {
        await new Promise((resolve, reject) => {
          db.query(
            `UPDATE swap_payments SET status='refunded', updated_at=NOW() WHERE payment_id=? LIMIT 1`,
            [p.payment_id],
            (err) => (err ? reject(err) : resolve())
          );
        });
      }

      results.push({
        payment_id: p.payment_id,
        payer_user_id: p.payer_user_id,
        payer_username: p.payer_username,
        amount: p.amount,
        currency: p.currency,
        status: mapped,
        paypal_refund_id: ppRefundId,
        error_message: null
      });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 800);

      await new Promise((resolve) => {
        const upd = `
          UPDATE swap_refunds
          SET status='failed', error_message=?, processed_at=NOW(), updated_at=NOW()
          WHERE refund_id=?
          LIMIT 1
        `;
        db.query(upd, [msg, refundId], () => resolve());
      });

      results.push({
        payment_id: p.payment_id,
        payer_user_id: p.payer_user_id,
        payer_username: p.payer_username,
        amount: p.amount,
        currency: p.currency,
        status: 'failed',
        paypal_refund_id: null,
        error_message: msg
      });
    }
  }

  return results;
}

// POST /admin/swap-cases/:id/review
exports.adminMarkSwapCaseUnderReview = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const adminId = req.session.user.user_id;
  const caseId = Number(req.params.id);
  if (!caseId) {
    req.flash('error_msg', 'Invalid case.');
    return res.redirect('/admin');
  }

  const sql = `
    UPDATE swap_cases
    SET status='under_review', admin_user_id=?, updated_at=NOW()
    WHERE case_id=? AND status='open'
    LIMIT 1
  `;

  db.query(sql, [adminId, caseId], (err, result) => {
    if (err) {
      console.error('adminMarkSwapCaseUnderReview error:', err);
      req.flash('error_msg', 'Failed to mark under review.');
      return res.redirect('/admin');
    }
    if (!result || result.affectedRows === 0) {
      req.flash('error_msg', 'Case not found or already being handled.');
      return res.redirect('/admin');
    }
    req.flash('success_msg', 'Case marked as under review.');
    return res.redirect('/admin');
  });
};

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function computeSplitAmounts(total, user1Id, user2Id, splitEnum) {
  const t = round2(total || 0);

  if (splitEnum === 'user1_pays_all') {
    return { [Number(user1Id)]: t, [Number(user2Id)]: 0 };
  }
  if (splitEnum === 'user2_pays_all') {
    return { [Number(user1Id)]: 0, [Number(user2Id)]: t };
  }

  const half = Math.floor((t / 2) * 100) / 100;
  const otherHalf = round2(t - half);
  return { [Number(user1Id)]: half, [Number(user2Id)]: otherHalf };
}


// POST /admin/swap-cases/:id/resolve
// Body: { action: 'approve'|'reject', admin_comment, email_subject, email_body }
// POST /admin/swap-cases/:id/resolve
// Body supports BOTH:
// - { action: 'approve'|'reject', ... }  (new/consistent)
// - { decision: 'resolve'|'reject', ... } (your current adminDashboard.ejs)
// POST /admin/swap-cases/:id/resolve
// Body supports BOTH:
// - { action: 'approve'|'reject', . }  (new/consistent)
// - { decision: 'resolve'|'reject', . } (your current adminDashboard.ejs)
exports.adminResolveSwapCase = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const adminId = req.session.user.user_id;
  const caseId = Number(req.params.id);

  // ✅ accept either field name
  const actionRaw = String(req.body.action || req.body.decision || '').toLowerCase().trim();

  // ✅ normalize values
  const action =
    actionRaw === 'resolve' ? 'approve' :
    actionRaw === 'approved' ? 'approve' :
    actionRaw === 'rejected' ? 'reject' :
    actionRaw;

  const adminComment = (req.body.admin_comment || '').trim();
  const emailSubjectIn = (req.body.email_subject || '').trim();
  const emailBodyIn = (req.body.email_body || '').trim();

  if (!caseId || !['approve', 'reject'].includes(action)) {
    req.flash('error_msg', 'Invalid request.');
    return res.redirect('/admin');
  }

  // Small helper: run a query (works for pool connection)
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) => {
      conn.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)));
    });

  // Transaction helper (uses a pool connection if available)
  const withTx = async (fn) => {
    if (typeof db.getConnection !== 'function') {
      // Fallback (no transaction support available)
      return fn(db);
    }

    const conn = await new Promise((resolve, reject) => {
      db.getConnection((err, c) => (err ? reject(err) : resolve(c)));
    });

    try {
      await q(conn, 'START TRANSACTION');
      const out = await fn(conn);
      await q(conn, 'COMMIT');
      conn.release();
      return out;
    } catch (e) {
      try { await q(conn, 'ROLLBACK'); } catch (_) {}
      conn.release();
      throw e;
    }
  };

  try {
    const row = await new Promise((resolve, reject) => {
      const load = `
        SELECT
          sc.*,
          sm.status AS match_status,
          sm.details_locked,
          sm.user1_id,
          sm.user2_id,
          u1.username AS user1_username,
          u1.email AS user1_email,
          u2.username AS user2_username,
          u2.email AS user2_email,
          uo.username AS opened_by_username,
          c.chat_id
        FROM swap_cases sc
        JOIN swap_matches sm ON sm.match_id = sc.match_id
        JOIN users u1 ON u1.user_id = sm.user1_id
        JOIN users u2 ON u2.user_id = sm.user2_id
        LEFT JOIN users uo ON uo.user_id = sc.opened_by_user_id
        LEFT JOIN chats c ON c.match_id = sc.match_id
        WHERE sc.case_id = ?
        LIMIT 1
      `;
      db.query(load, [caseId], (err, rows) => (err ? reject(err) : resolve(rows?.[0] || null)));
    });

    if (!row) {
      req.flash('error_msg', 'Case not found.');
      return res.redirect('/admin');
    }

    const currentStatus = String(row.status || '').toLowerCase();
    if (!['open', 'under_review'].includes(currentStatus)) {
      req.flash('error_msg', `Case already resolved. Current status: ${row.status}`);
      return res.redirect('/admin');
    }

    const caseType = String(row.case_type || '').toLowerCase();

    // cancel cannot be approved after details locked (keep your original rule)
    if (action === 'approve' && caseType === 'cancel_request' && Number(row.details_locked) === 1) {
      req.flash('error_msg', 'Cannot approve cancel: details are already locked.');
      return res.redirect('/admin');
    }

    // ✅ If approve and (cancel_request OR scam_report) -> cancel match + reset items + cancel pickup jobs
    if (action === 'approve' && (caseType === 'cancel_request' || caseType === 'scam_report')) {
      await withTx(async (conn) => {
        // 1) Cancel the match
        await q(
          conn,
          `UPDATE swap_matches
           SET status='cancelled', updated_at=NOW()
           WHERE match_id=? LIMIT 1`,
          [row.match_id]
        );

        // 2) Cancel pickup/delivery requests tied to this match (so SAHM jobs don’t remain)
        //    (We avoid touching completed ones.)
        await q(
          conn,
          `UPDATE pickup_delivery_requests
           SET status='cancelled'
           WHERE match_id=?
             AND status NOT IN ('completed','cancelled')`,
          [row.match_id]
        );

        // 3) Make BOTH items available again (item1 + item2)
        await q(
          conn,
          `UPDATE clothing_items ci
           JOIN swap_matches sm
             ON ci.item_id IN (sm.item1_id, sm.item2_id)
           SET ci.status='available', ci.updated_at=NOW()
           WHERE sm.match_id=?`,
          [row.match_id]
        );
      });
    }

    // Refunds go to BOTH users who paid (approve only) — keep your existing logic
    let refundResults = [];
    if (action === 'approve') {
      refundResults = await processRefundsForMatch({
        caseId,
        matchId: row.match_id,
        adminId,
        note: `Refund for /help case #${caseId}`
      });
    }

    const newStatus = action === 'approve' ? 'resolved' : 'rejected';

    const defaultSubject = `[Wardrobe Plug] /help ${newStatus.toUpperCase()} - ${String(row.case_type || '').replace(/_/g, ' ')}`;
    const subject = emailSubjectIn || defaultSubject;

    const headerHtml = `
      <p>Hi,</p>
      <p>Your <b>/help</b> request has been <b>${newStatus.toUpperCase()}</b>.</p>
      <div style="margin-top:10px;padding:12px;border-radius:12px;background:#f9fafb;border:1px solid #e5e7eb;">
        <p style="margin:0;"><b>Case #</b> ${caseId}</p>
        <p style="margin:6px 0 0;"><b>Type:</b> ${String(row.case_type || '').replace(/_/g, ' ')}</p>
        <p style="margin:6px 0 0;"><b>Match ID:</b> ${row.match_id}</p>
        <p style="margin:6px 0 0;"><b>Opened by:</b> ${row.opened_by_username || 'Unknown user'}</p>
      </div>
    `;

    const adminCommentHtml = adminComment
      ? `<div style="margin-top:12px;"><b>Admin comment</b><div style="background:#fff7ed;padding:12px;border-radius:10px;margin-top:6px;">${nl2br(adminComment)}</div></div>`
      : '';

    const configuredBodyHtml = emailBodyIn ? `<div style="margin-top:12px;">${nl2br(emailBodyIn)}</div>` : '';
    const refundHtml = buildRefundSummaryHtml(refundResults);

    const html = `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Arial, sans-serif; line-height:1.5; color:#111;">
        ${headerHtml}
        ${configuredBodyHtml}
        ${adminCommentHtml}
        ${refundHtml}
        <p style="margin-top:14px;font-size:12px;color:#6b7280;">Please do not reply to this email.</p>
      </div>
    `;

    await new Promise((resolve, reject) => {
      const updCase = `
        UPDATE swap_cases
        SET status=?, admin_user_id=?, admin_comment=?, email_subject=?, email_body=?, email_sent_at=NOW(), updated_at=NOW()
        WHERE case_id=?
        LIMIT 1
      `;
      db.query(updCase, [newStatus, adminId, adminComment || null, subject, emailBodyIn || null, caseId], (err) =>
        err ? reject(err) : resolve()
      );
    });

    // chat system message
    if (row.chat_id) {
      await new Promise((resolve) => {
        const msg = `[SYSTEM] /help case #${caseId} has been ${newStatus}. Please check your email for details.`;
        db.query(
          `INSERT INTO chat_messages (chat_id, sender_user_id, message_text, created_at) VALUES (?, ?, ?, NOW())`,
          [row.chat_id, adminId, msg],
          () => resolve()
        );
      });
    }

    // Email BOTH users (ACCOUNT email, not PayPal email)
    const targets = [row.user1_email, row.user2_email].filter(Boolean);

    for (const email of targets) {
      try {
        await sendAdminConfigurableEmail(email, subject, html);
      } catch (e) {
        console.error('adminResolveSwapCase email error:', e);
      }
    }

    req.flash('success_msg', `Case #${caseId} ${newStatus}. Emails sent to both users.`);
    return res.redirect('/admin');
  } catch (e) {
    console.error('adminResolveSwapCase error:', e);
    req.flash('error_msg', 'Failed to resolve case.');
    return res.redirect('/admin');
  }
};


// POST /admin/swap-refunds/sync
// Sync PayPal refund statuses for processing refunds
exports.adminSyncSwapRefunds = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const pending = await new Promise((resolve, reject) => {
      const sql = `
        SELECT refund_id, payment_id, paypal_refund_id
        FROM swap_refunds
        WHERE status IN ('pending','processing')
          AND paypal_refund_id IS NOT NULL
          AND paypal_refund_id <> ''
        ORDER BY updated_at ASC
        LIMIT 50
      `;
      db.query(sql, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });

    let updated = 0;

    for (const r of pending) {
      try {
        const info = await paypalGetRefund(r.paypal_refund_id);
        const ppStatus = info?.status || null;
        const mapped = mapPayPalRefundStatus(ppStatus);

        await new Promise((resolve, reject) => {
          const upd = `
            UPDATE swap_refunds
            SET paypal_refund_status=?, status=?, processed_at=IF(?='refunded', NOW(), processed_at), updated_at=NOW()
            WHERE refund_id=?
            LIMIT 1
          `;
          db.query(upd, [ppStatus, mapped, mapped, r.refund_id], (err) => (err ? reject(err) : resolve()));
        });

        if (mapped === 'refunded') {
          await new Promise((resolve) => {
            db.query(
              `UPDATE swap_payments SET status='refunded', updated_at=NOW() WHERE payment_id=? LIMIT 1`,
              [r.payment_id],
              () => resolve()
            );
          });
        }

        updated += 1;
      } catch (e) {
        // ignore per-row errors
      }
    }

    req.flash('success_msg', `Refund sync completed. Checked: ${pending.length}, Updated: ${updated}.`);
    return res.redirect('/admin');
  } catch (e) {
    console.error('adminSyncSwapRefunds error:', e);
    req.flash('error_msg', 'Refund sync failed.');
    return res.redirect('/admin');
  }
};


exports.viewAllUsers = (req, res) => {
   if (!req.session.user) {
        req.flash('error_msg', 'Please sign in first.');
        return res.redirect('/login');
    }
  const sql = `
  
    SELECT
      user_id,
      full_name,
      username,
      email,
      gender,
      profile_image_url,
      role,
      is_email_verified,
      created_at
    FROM users
    ORDER BY created_at DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error('Error loading users:', err);
      req.flash('error_msg', 'Error loading users list.');
      return res.redirect('/admin/dashboard');
    }

    res.render('adminUsers', {
      user: req.session.user,
      users: rows || []
    });
  });
};


exports.postEditUser = (req, res) => {

   if (!req.session.user) {
        req.flash('error_msg', 'Please sign in first.');
        return res.redirect('/login');
    }
  const targetId = req.params.id;
  const { username, email, gender, role } = req.body;

  const allowedRoles = ['user', 'sahm', 'admin'];
  const safeRole = (role || 'user').toLowerCase();

  if (!allowedRoles.includes(safeRole)) {
    req.flash('error_msg', 'Invalid role selected.');
    return res.redirect('/admin/users');
  }

  // Optional safety: prevent admin from demoting themselves accidentally
  // You can comment this out if you want
  if (req.session.user.user_id == targetId && safeRole !== 'admin') {
    req.flash('error_msg', 'You cannot remove your own admin role.');
    return res.redirect('/users');
  }

  const updateSql = `
    UPDATE users
    SET username = ?, email = ?, gender = ?, role = ?
    WHERE user_id = ?
  `;

  db.query(updateSql, [username, email, gender || null, safeRole, targetId], (err) => {
    if (err) {
      console.error('Admin edit user error:', err);
      req.flash('error_msg', 'Failed to update user. Email/username might already exist.');
      return res.redirect('/users');
    }

    // If edited the currently logged-in admin, refresh session values
    if (req.session.user.user_id == targetId) {
      req.session.user.username = username;
      req.session.user.email = email;
      req.session.user.gender = gender;
      req.session.user.role = safeRole;
    }

    req.flash('success_msg', 'User updated successfully.');
    return res.redirect('/users');
  });
};

// ============================
// Delete User + Email
// POST /admin/users/:id/delete
// Body: { reason }
// ============================
exports.postDeleteUser = (req, res) => {
  const targetId = req.params.id;
  const reason = (req.body.reason || '').trim();

  if (!req.session.user) {
    req.flash('error_msg', 'Please log in again.');
    return res.redirect('/login');
  }

  if (!reason) {
    req.flash('error_msg', 'Termination reason is required.');
    return res.redirect('/users');
  }

  // Safety: prevent deleting yourself
  if (String(req.session.user.user_id) === String(targetId)) {
    req.flash('error_msg', 'You cannot delete your own admin account.');
    return res.redirect('/users');
  }

  const getSql = `SELECT user_id, username, email FROM users WHERE user_id = ?`;

  db.query(getSql, [targetId], async (errGet, rows) => {
    if (errGet) {
      console.error('Admin delete user lookup error:', errGet);
      req.flash('error_msg', 'Error finding user to delete.');
      return res.redirect('/users');
    }

    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'User not found.');
      return res.redirect('/users');
    }

    const targetUser = rows[0];

    // 1) Email best-effort (don’t block delete if email fails)
    try {
      if (targetUser.email) {
        await sendAccountTerminationEmail(targetUser.email, targetUser.username, reason);
      }
    } catch (emailErr) {
      console.error('Termination email failed:', emailErr);
    }

    // 2) Delete user
    const delSql = `DELETE FROM users WHERE user_id = ?`;
    db.query(delSql, [targetId], (errDel) => {
      if (errDel) {
        console.error('Admin delete user error:', errDel);
        req.flash('error_msg', 'Failed to delete user (might have related records / FK constraints).');
        return res.redirect('/users');
      }

      req.flash('success_msg', `User deleted. Termination email attempted to ${targetUser.email || 'user email'}.`);
      return res.redirect('/users');
    });
  });
};

exports.adminViewChat = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const adminUser = req.session.user;
  const adminId = adminUser.user_id;
  const chatId = Number(req.params.chatId);
  let openModal = (req.query.open || '').trim(); // keep same signature as getChat

  if (!chatId) {
    req.flash('error_msg', 'Invalid chat.');
    return res.redirect('/admin');
  }

  // Same SELECT as getChat, but WITHOUT participant restriction
  const chatSql = `
    SELECT
      c.chat_id,
      c.match_id,

      sm.user1_id,
      sm.user2_id,
      sm.item1_id,
      sm.item2_id,
      sm.status,
      sm.swap_method,
      sm.payment_split,
      sm.meetup_location_id,
      sm.scheduled_time,
      sm.details_locked,

      u1.username AS user1_username,
      u2.username AS user2_username,

      i1.title AS item1_title,
      i1.image_url_1 AS item1_image,

      i2.title AS item2_title,
      i2.image_url_1 AS item2_image
    FROM chats c
    JOIN swap_matches sm ON c.match_id = sm.match_id
    JOIN users u1 ON sm.user1_id = u1.user_id
    JOIN users u2 ON sm.user2_id = u2.user_id
    JOIN clothing_items i1 ON sm.item1_id = i1.item_id
    JOIN clothing_items i2 ON sm.item2_id = i2.item_id
    WHERE c.chat_id = ?
    LIMIT 1
  `;

  db.query(chatSql, [chatId], (err, chatRows) => {
    if (err) {
      console.error('adminViewChat chatSql error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/admin');
    }
    if (!chatRows || chatRows.length === 0) {
      req.flash('error_msg', 'Chat not found.');
      return res.redirect('/admin');
    }

    const chat = chatRows[0];

    const msgSql = `
      SELECT
        cm.message_id,
        cm.chat_id,
        cm.sender_user_id,
        cm.message_text,
        cm.created_at,
        u.username AS sender_username
      FROM chat_messages cm
      JOIN users u ON cm.sender_user_id = u.user_id
      WHERE cm.chat_id = ?
      ORDER BY cm.created_at ASC
    `;

    db.query(msgSql, [chatId], (err2, messages) => {
      if (err2) {
        console.error('adminViewChat msgSql error:', err2);
        req.flash('error_msg', 'Failed to load messages.');
        return res.redirect('/admin');
      }

      // Same queries as getChat
      const pendingSwapSql = `
        SELECT sc.*, u.username AS proposed_by_username
        FROM swap_confirmations sc
        JOIN users u ON sc.proposed_by_user_id = u.user_id
        WHERE sc.match_id = ?
          AND sc.type = 'swap_method'
          AND sc.status = 'pending'
        ORDER BY sc.offer_round DESC
        LIMIT 1
      `;

      const myLocationsSql = `
        SELECT location_id, label, address_line, city, postal_code
        FROM locations
        WHERE user_id = ?
        ORDER BY created_at DESC
      `;

      const pendingMeetupSql = `
        SELECT sc.*, u.username AS proposed_by_username, l.label AS location_label
        FROM swap_confirmations sc
        JOIN users u ON sc.proposed_by_user_id = u.user_id
        LEFT JOIN locations l ON l.location_id = CAST(sc.proposed_value AS UNSIGNED)
        WHERE sc.match_id = ?
          AND sc.type = 'locations'
          AND sc.status = 'pending'
        ORDER BY sc.offer_round DESC
        LIMIT 1
      `;

      const meetupLocationSql = `
        SELECT location_id, label, address_line, city, postal_code
        FROM locations
        WHERE location_id = ?
        LIMIT 1
      `;

      const sahmAddressesSql = `
        SELECT
          sda.user_id,
          l.location_id,
          l.label,
          l.address_line,
          l.city,
          l.postal_code
        FROM swap_delivery_addresses sda
        JOIN locations l ON sda.location_id = l.location_id
        WHERE sda.match_id = ?
      `;

      const feeSql = `
        SELECT
          pdr.leg,
          pdr.status,
          pdr.delivery_fee,
          pdr.sahm_earning,
          pdr.pickup_location_id,
          pdr.dropoff_location_id,
          pdr.sahm_user_id,
          lp.label AS pickup_label,
          ld.label AS dropoff_label,
          su.username AS sahm_username
        FROM pickup_delivery_requests pdr
        LEFT JOIN locations lp ON lp.location_id = pdr.pickup_location_id
        LEFT JOIN locations ld ON ld.location_id = pdr.dropoff_location_id
        LEFT JOIN users su ON su.user_id = pdr.sahm_user_id
        WHERE pdr.match_id = ?
        ORDER BY FIELD(pdr.leg,'u1_to_u2','u2_to_u1')
      `;

      const pendingPaymentSql = `
        SELECT sc.*, u.username AS proposed_by_username
        FROM swap_confirmations sc
        JOIN users u ON sc.proposed_by_user_id = u.user_id
        WHERE sc.match_id = ?
          AND sc.type = 'payment_split'
          AND sc.status = 'pending'
        ORDER BY sc.offer_round DESC
        LIMIT 1
      `;

      const payRowsSql = `
        SELECT payer_user_id, amount, status, provider_order_id, provider_capture_id
        FROM swap_payments
        WHERE match_id = ?
      `;

      const pendingTimeSql = `
        SELECT sc.*, u.username AS proposed_by_username
        FROM swap_confirmations sc
        JOIN users u ON sc.proposed_by_user_id = u.user_id
        WHERE sc.match_id = ?
          AND sc.type = 'scheduled_time'
          AND sc.status = 'pending'
        ORDER BY sc.offer_round DESC
        LIMIT 1
      `;

      // ✅ Active case for freezing (admin is read-only anyway)
      const activeCaseSql = `
        SELECT *
        FROM swap_cases
        WHERE match_id = ?
          AND status IN ('open','under_review')
        ORDER BY created_at DESC
        LIMIT 1
      `;

      db.query(pendingSwapSql, [chat.match_id], (pErr, pRows) => {
        const pendingSwapMethod = (!pErr && pRows && pRows[0]) ? pRows[0] : null;

        db.query(myLocationsSql, [adminId], (locErr, locations) => {
          locations = (!locErr && locations) ? locations : [];

          let pendingMeetupLocation = null;
          let meetupLocation = null;
          let mySahmAddress = null;
          let otherSahmAddress = null;
          let pickupDeliveryRequests = [];
          let sahmFeeTotal = null;

          let pendingPaymentSplit = null;
          let paymentRows = [];
          let myPay = { required: false, amount: 0, status: null };
          let otherPay = { required: false, amount: 0, status: null };
          let paymentComplete = false;

          let pendingScheduledTime = null;

          const done = (activeCase) => {
            const commandsFrozen = !!activeCase;

            // For admin, don’t auto-open modals
            openModal = null;

            return res.render('chat', {
              user: adminUser,
              chat,
              messages: messages || [],

              pendingSwapMethod,
              pendingMeetupLocation,
              meetupLocation,
              mySahmAddress,
              otherSahmAddress,
              pickupDeliveryRequests,
              sahmFeeTotal,
              locations,
              openModal,

              pendingPaymentSplit,
              paymentRows,
              myPay,
              otherPay,
              paymentComplete,

              pendingScheduledTime,

              paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
              paypalCurrency: process.env.PAYPAL_CURRENCY || 'SGD',
              paypalMode: process.env.PAYPAL_MODE || 'sandbox',

              // extra flag for your read-only admin UI (your chat.ejs already supports this)
              adminView: true,
              activeCase,
              commandsFrozen
            });
          };

          // load active case first (so admin sees freeze state)
          db.query(activeCaseSql, [chat.match_id], (acErr, acRows) => {
            const activeCase = (!acErr && acRows && acRows[0]) ? acRows[0] : null;

            if (!chat.swap_method) {
              return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
                pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
                return done(activeCase);
              });
            }

            if (chat.swap_method === 'meetup') {
              return db.query(pendingMeetupSql, [chat.match_id], (pmErr, pmRows) => {
                if (!pmErr && pmRows && pmRows[0]) pendingMeetupLocation = pmRows[0];

                if (!chat.meetup_location_id) {
                  return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
                    pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
                    return done(activeCase);
                  });
                }

                return db.query(meetupLocationSql, [chat.meetup_location_id], (mlErr, mlRows) => {
                  if (!mlErr && mlRows && mlRows[0]) meetupLocation = mlRows[0];

                  return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
                    pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
                    return done(activeCase);
                  });
                });
              });
            }

            if (chat.swap_method === 'sahm') {
              return db.query(sahmAddressesSql, [chat.match_id], (saErr, saRows) => {
                if (!saErr && saRows && saRows.length) {
                  saRows.forEach(r => {
                    if (String(r.user_id) === String(adminId)) mySahmAddress = r;
                    else otherSahmAddress = r;
                  });
                }

                return db.query(feeSql, [chat.match_id], (fErr, fRows) => {
                  if (!fErr && fRows && fRows.length) {
                    pickupDeliveryRequests = fRows;
                    const total = fRows
                      .map(r => Number(r.delivery_fee))
                      .filter(v => Number.isFinite(v))
                      .reduce((a, b) => a + b, 0);
                    sahmFeeTotal = Number.isFinite(total) ? round2(total) : null;
                  }

                  return db.query(pendingPaymentSql, [chat.match_id], (ppErr, ppRows) => {
                    pendingPaymentSplit = (!ppErr && ppRows && ppRows[0]) ? ppRows[0] : null;

                    return db.query(payRowsSql, [chat.match_id], (prErr, prRows) => {
                      paymentRows = (!prErr && prRows) ? prRows : [];

                      if (chat.payment_split && sahmFeeTotal !== null) {
                        const amounts = computeSplitAmounts(
                          sahmFeeTotal,
                          Number(chat.user1_id),
                          Number(chat.user2_id),
                          chat.payment_split
                        );

                        const requiredPayers = Object.entries(amounts)
                          .filter(([_, amt]) => round2(amt) > 0)
                          .map(([uid]) => Number(uid));

                        const payMap = new Map(paymentRows.map(r => [Number(r.payer_user_id), r]));

                        paymentComplete = requiredPayers.every(uid => {
                          const row = payMap.get(uid);
                          return row && row.status === 'captured';
                        });

                        const otherId = (Number(chat.user1_id) === Number(adminId)) ? Number(chat.user2_id) : Number(chat.user1_id);
                        const myRow = payMap.get(Number(adminId));
                        const otherRow = payMap.get(otherId);

                        myPay = {
                          required: requiredPayers.includes(Number(adminId)),
                          amount: round2(amounts[Number(adminId)] || 0),
                          status: myRow ? myRow.status : null
                        };

                        otherPay = {
                          required: requiredPayers.includes(otherId),
                          amount: round2(amounts[otherId] || 0),
                          status: otherRow ? otherRow.status : null
                        };
                      }

                      return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
                        pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
                        return done(activeCase);
                      });
                    });
                  });
                });
              });
            }

            return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
              pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
              return done(activeCase);
            });
          });
        });
      });
    });
  });
};
// ============================================
// REVIEW SUBMISSION
// ============================================
exports.postSubmitReview = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const { match_id, rating, comment } = req.body;
  const reviewerUserId = req.session.user.user_id;

  if (!match_id || !rating) {
    req.flash('error_msg', 'Rating is required.');
    return res.redirect('back');
  }

  // Validate rating is between 1-5
  const ratingNum = parseInt(rating, 10);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    req.flash('error_msg', 'Rating must be between 1 and 5.');
    return res.redirect('back');
  }

  // Get the match details to find the reviewee
  const matchSql = `
    SELECT user1_id, user2_id, status
    FROM swap_matches
    WHERE match_id = ?
    LIMIT 1
  `;

  db.query(matchSql, [match_id], (err, rows) => {
    if (err) {
      console.error('Error fetching match:', err);
      req.flash('error_msg', 'Could not submit review.');
      return res.redirect('back');
    }

    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'Match not found.');
      return res.redirect('back');
    }

    const match = rows[0];

    // Verify user is part of the match
    if (match.user1_id !== reviewerUserId && match.user2_id !== reviewerUserId) {
      req.flash('error_msg', 'You are not part of this swap.');
      return res.redirect('back');
    }

    // Verify match is completed
    if (match.status !== 'completed') {
      req.flash('error_msg', 'You can only review completed swaps.');
      return res.redirect('back');
    }

    // Determine reviewee
    const revieweeUserId = match.user1_id === reviewerUserId ? match.user2_id : match.user1_id;

    // Insert review
    const reviewSql = `
      INSERT INTO user_reviews (match_id, reviewer_user_id, reviewee_user_id, rating, comment)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        rating = VALUES(rating),
        comment = VALUES(comment),
        created_at = CURRENT_TIMESTAMP
    `;

    db.query(reviewSql, [match_id, reviewerUserId, revieweeUserId, ratingNum, comment || null], (err) => {
      if (err) {
        console.error('Error submitting review:', err);
        req.flash('error_msg', 'Could not submit review.');
        return res.redirect('back');
      }

      req.flash('success_msg', 'Review submitted successfully!');
      return res.redirect('back');
    });
  });
};

// ============================================
// GET USER REVIEWS (for profile page)
// ============================================
exports.getUserReviews = (req, res) => {
  const userId = req.params.userId;

  const sql = `
    SELECT 
      ur.review_id,
      ur.rating,
      ur.comment,
      ur.created_at,
      u.username,
      u.profile_image_url
    FROM user_reviews ur
    JOIN users u ON ur.reviewer_user_id = u.user_id
    WHERE ur.reviewee_user_id = ?
    ORDER BY ur.created_at DESC
  `;

  db.query(sql, [userId], (err, reviews) => {
    if (err) {
      console.error('Error fetching reviews:', err);
      return res.json({ success: false, error: 'Could not load reviews' });
    }

    return res.json({ success: true, reviews: reviews || [] });
  });
};

// ============================================
// ADMIN: View a user's wardrobe + posts
// GET /admin/users/:id/content
// ============================================
exports.adminViewUserContent = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const targetUserId = parseInt(req.params.id, 10);
  if (!targetUserId) {
    req.flash('error_msg', 'Invalid user id.');
    return res.redirect('/admin/users');
  }

  const q = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    const uRows = await q(
      `SELECT user_id, username, email, profile_image_url, role, created_at
       FROM users
       WHERE user_id=? LIMIT 1`,
      [targetUserId]
    );

    if (!uRows || uRows.length === 0) {
      req.flash('error_msg', 'User not found.');
      return res.redirect('/admin/users');
    }

    const wardrobeItems = await q(
      `SELECT item_id, owner_user_id, title, category, size_label, color, condition_grade,
              is_for_swap, is_public, status, image_url_1, created_at, updated_at
       FROM clothing_items
       WHERE owner_user_id=?
       ORDER BY created_at DESC`,
      [targetUserId]
    );

    const posts = await q(
      `SELECT post_id, user_id, caption, visibility, image_url_1, image_url_2, image_url_3,
              created_at, updated_at
       FROM ootd_posts
       WHERE user_id=?
       ORDER BY created_at DESC`,
      [targetUserId]
    );

    return res.render('adminUserContent', {
      user: req.session.user,
      targetUser: uRows[0],
      wardrobeItems: wardrobeItems || [],
      posts: posts || []
    });
  } catch (e) {
    console.error('adminViewUserContent error:', e);
    req.flash('error_msg', 'Failed to load user content.');
    return res.redirect('/admin/users');
  }
};


// ============================================
// ADMIN: Hide a wardrobe item (SAFE)
// POST /admin/users/:id/wardrobe/:itemId/hide
// ============================================
exports.adminHideUserWardrobeItem = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const targetUserId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);

  if (!targetUserId || !itemId) {
    req.flash('error_msg', 'Invalid request.');
    return res.redirect('/admin/users');
  }

  const sql = `
    UPDATE clothing_items
    SET status='hidden', is_public=0, is_for_swap=0, updated_at=NOW()
    WHERE item_id=? AND owner_user_id=?
    LIMIT 1
  `;

  db.query(sql, [itemId, targetUserId], (err, result) => {
    if (err) {
      console.error('adminHideUserWardrobeItem error:', err);
      req.flash('error_msg', 'Failed to hide item.');
      return res.redirect(`/admin/users/${targetUserId}/content`);
    }

    if (!result || result.affectedRows === 0) {
      req.flash('error_msg', 'Item not found (or not owned by this user).');
      return res.redirect(`/admin/users/${targetUserId}/content`);
    }

    req.flash('success_msg', 'Item hidden successfully.');
    return res.redirect(`/admin/users/${targetUserId}/content`);
  });
};


// ============================================
// ADMIN: Hard delete a wardrobe item (BLOCK if referenced by any swap_matches)
// POST /admin/users/:id/wardrobe/:itemId/delete
// ============================================
exports.adminDeleteUserWardrobeItem = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const targetUserId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);

  if (!targetUserId || !itemId) {
    req.flash('error_msg', 'Invalid request.');
    return res.redirect('/admin/users');
  }

  // Safety: do NOT hard-delete if the item is referenced by any swap_matches
  // (because your DB has FK swap_matches.item1_id/item2_id -> clothing_items.item_id ON DELETE CASCADE)
  const checkSql = `
    SELECT COUNT(*) AS cnt
    FROM swap_matches
    WHERE item1_id=? OR item2_id=?
  `;

  db.query(checkSql, [itemId, itemId], (err, rows) => {
    if (err) {
      console.error('adminDeleteUserWardrobeItem check error:', err);
      req.flash('error_msg', 'Failed to validate item delete.');
      return res.redirect(`/admin/users/${targetUserId}/content`);
    }

    const cnt = rows && rows[0] ? Number(rows[0].cnt) : 0;
    if (cnt > 0) {
      req.flash(
        'error_msg',
        'Hard delete blocked: this item has swap history. Use "Hide" instead to avoid deleting swap data.'
      );
      return res.redirect(`/admin/users/${targetUserId}/content`);
    }

    const delSql = `
      DELETE FROM clothing_items
      WHERE item_id=? AND owner_user_id=?
      LIMIT 1
    `;

    db.query(delSql, [itemId, targetUserId], (err2, result) => {
      if (err2) {
        console.error('adminDeleteUserWardrobeItem delete error:', err2);
        req.flash('error_msg', 'Failed to delete item.');
        return res.redirect(`/admin/users/${targetUserId}/content`);
      }

      if (!result || result.affectedRows === 0) {
        req.flash('error_msg', 'Item not found (or not owned by this user).');
        return res.redirect(`/admin/users/${targetUserId}/content`);
      }

      req.flash('success_msg', 'Item deleted successfully.');
      return res.redirect(`/admin/users/${targetUserId}/content`);
    });
  });
};


// ============================================
// ADMIN: Delete an OOTD post
// POST /admin/users/:id/ootd/:postId/delete
// ============================================
exports.adminDeleteUserOotdPost = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const targetUserId = parseInt(req.params.id, 10);
  const postId = parseInt(req.params.postId, 10);

  if (!targetUserId || !postId) {
    req.flash('error_msg', 'Invalid request.');
    return res.redirect('/admin/users');
  }

  const delSql = `
    DELETE FROM ootd_posts
    WHERE post_id=? AND user_id=?
    LIMIT 1
  `;

  db.query(delSql, [postId, targetUserId], (err, result) => {
    if (err) {
      console.error('adminDeleteUserOotdPost error:', err);
      req.flash('error_msg', 'Failed to delete post.');
      return res.redirect(`/admin/users/${targetUserId}/content`);
    }

    if (!result || result.affectedRows === 0) {
      req.flash('error_msg', 'Post not found (or not owned by this user).');
      return res.redirect(`/admin/users/${targetUserId}/content`);
    }

    req.flash('success_msg', 'Post deleted successfully.');
    return res.redirect(`/admin/users/${targetUserId}/content`);
  });
};

// ============================================
// EDIT PROFILE (GET/POST)
// ============================================
function requireLogin(req, res) {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    res.redirect('/login');
    return false;
  }
  return true;
}

// GET /profile/edit
exports.getEditProfile = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;

  const sql = `
    SELECT
      user_id,
      username,
      email,
      full_name,
      bio,
      gender,
      profile_image_url
    FROM users
    WHERE user_id = ?
    LIMIT 1
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      console.error('getEditProfile error:', err);
      return res.render('editProfile', {
        profileUser: null,
        message: 'Server error loading profile.',
        success_msg: null
      });
    }

    if (!rows || rows.length === 0) {
      return res.render('editProfile', {
        profileUser: null,
        message: 'User not found.',
        success_msg: null
      });
    }

    return res.render('editProfile', {
      profileUser: rows[0],
      message: req.flash('error_msg')[0] || null,
      success_msg: req.flash('success_msg')[0] || null
    });
  });
};

// POST /profile/edit
exports.postEditProfile = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;

  const username = (req.body.username || '').trim();
  const full_name = (req.body.full_name || '').trim();
  const bio = (req.body.bio || '').trim();
  const gender = (req.body.gender || '').trim(); // male|female|other|''

  if (!username) {
    req.flash('error_msg', 'Username is required.');
    return res.redirect('/profile/edit');
  }

  // Optional new profile image
  let profileImageUrl = null;
  if (req.file) {
    // Cloudinary returns the full URL in req.file.path
    profileImageUrl = req.file.path;
  }

  // Validate gender enum
  const validGender = ['male', 'female', 'other', ''];
  if (!validGender.includes(gender)) {
    req.flash('error_msg', 'Invalid gender selection.');
    return res.redirect('/profile/edit');
  }

  // 1) Ensure username is unique (excluding current user)
  const checkSql = `
    SELECT user_id
    FROM users
    WHERE username = ?
      AND user_id <> ?
    LIMIT 1
  `;

  db.query(checkSql, [username, userId], (cErr, cRows) => {
    if (cErr) {
      console.error('postEditProfile checkSql error:', cErr);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/profile/edit');
    }

    if (cRows && cRows.length > 0) {
      req.flash('error_msg', 'That username is already taken.');
      return res.redirect('/profile/edit');
    }

    // 2) Update user
    // If no new file uploaded, keep existing profile_image_url
    const updSql = `
      UPDATE users
      SET
        username = ?,
        full_name = ?,
        bio = ?,
        gender = ?,
        profile_image_url = COALESCE(?, profile_image_url)
      WHERE user_id = ?
      LIMIT 1
    `;

    db.query(
      updSql,
      [
        username,
        full_name || null,
        bio || null,
        gender || null,
        profileImageUrl,
        userId
      ],
      (uErr) => {
        if (uErr) {
          console.error('postEditProfile updSql error:', uErr);
          req.flash('error_msg', 'Failed to update profile.');
          return res.redirect('/profile/edit');
        }

        // Keep session in sync (so UI updates immediately)
        req.session.user.username = username;
        req.session.user.full_name = full_name || req.session.user.full_name;

        req.flash('success_msg', 'Profile updated!');
        return res.redirect('/profile');
      }
    );
  });
};

// POST /profile/delete
exports.postDeleteProfile = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const userId = req.session.user.user_id;
  const confirmText = (req.body.confirm_text || '').trim();

  if (confirmText !== 'DELETE') {
    req.flash('error_msg', 'Type DELETE to confirm.');
    return res.redirect('/profile/edit');
  }

  // ✅ Safe "delete": anonymize + clear profile fields so user cannot log in again
  const anonUsername = `deleted_${userId}`;
  const anonEmail = `deleted_${userId}@deleted.local`;

  const sql = `
    UPDATE users
    SET
      username = ?,
      email = ?,
      full_name = NULL,
      bio = NULL,
      gender = NULL,
      profile_image_url = NULL,
      updated_at = NOW()
    WHERE user_id = ?
    LIMIT 1
  `;

  db.query(sql, [anonUsername, anonEmail, userId], (err) => {
    if (err) {
      console.error('postDeleteProfile error:', err);
      req.flash('error_msg', 'Failed to delete profile.');
      return res.redirect('/profile/edit');
    }

    // Destroy session so they are logged out immediately
    req.session.destroy(() => {
      // If you use connect-flash, session destroy clears flash too.
      // So redirect to login with a query OR render a simple message page.
      return res.redirect('/login');
    });
  });
};
