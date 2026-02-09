const db = require('../db');
const https = require('https');
const { sendPayPalReceiptEmail, sendPaymentOTPEmail } = require('../utils/mailer');
const crypto = require('crypto');
const fetch = require('node-fetch');
require('dotenv').config();

// ============================================
// SWAP FEED (Browse items to like/pass)
// GET /swap
// ============================================
exports.getSwapFeed = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const userId = req.session.user.user_id;

  // 1) Check if THIS user has at least 1 item that is available for swapping
  const checkSql = `
    SELECT COUNT(*) AS cnt
    FROM clothing_items
    WHERE owner_user_id = ?
      AND is_for_swap = 1
      AND status = 'available'
  `;

  db.query(checkSql, [userId], (checkErr, checkRows) => {
    if (checkErr) {
      console.error('Swap feed check error:', checkErr);
      req.flash('error_msg', 'Error loading swap feed.');
      return res.redirect('/');
    }

    const mySwapCount = (checkRows && checkRows[0] && checkRows[0].cnt) ? Number(checkRows[0].cnt) : 0;

    // If user has NO swap items -> don't show feed, show message instead
    if (mySwapCount === 0) {
      return res.render('swapFeed', {
        user: req.session.user,
        items: [],
        mustAddSwapItem: true
      });
    }

    // 2) Load the swipe deck as usual
    const sql = `
      SELECT
        ci.item_id,
        ci.owner_user_id,
        ci.title,
        ci.category,
        ci.size_label,
        ci.color,
        ci.condition_grade,
        ci.image_url_1,
        ci.created_at,
        u.username AS owner_username,
        u.profile_image_url AS owner_profile_image,
        b.name AS brand_name
      FROM clothing_items ci
      JOIN users u ON ci.owner_user_id = u.user_id
      LEFT JOIN brands b ON ci.brand_id = b.brand_id
      WHERE ci.is_for_swap = 1
        AND ci.is_public = 1
        AND ci.status = 'available'
        AND ci.owner_user_id <> ?
        AND ci.item_id NOT IN (
          SELECT item_id
          FROM swap_swipes
          WHERE swiper_user_id = ?
        )
      ORDER BY ci.created_at DESC
      LIMIT 50
    `;

    db.query(sql, [userId, userId], (err, rows) => {
      if (err) {
        console.error('Swap feed load error:', err);
        req.flash('error_msg', 'Error loading swap feed.');
        return res.redirect('/');
      }

      return res.render('swapFeed', {
        user: req.session.user,
        items: rows || [],
        mustAddSwapItem: false
      });
    });
  });
};


// ============================================
// SWIPE (Like / Pass)
// POST /swap/swipe
// Body: { item_id, decision } decision = 'like' | 'pass'
// ============================================
exports.postSwipe = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const userId = req.session.user.user_id;
  const itemId = Number(req.body.item_id);
  const decision = (req.body.decision || '').toLowerCase();
  const isLike = decision === 'like' ? 1 : 0;

  if (!itemId || !['like', 'pass'].includes(decision)) {
    req.flash('error_msg', 'Invalid swipe.');
    return res.redirect('/swap');
  }

  // Guard against duplicate swipes in-app (SQL doesn’t enforce uniqueness yet)
  const checkSql = `
    SELECT swipe_id
    FROM swap_swipes
    WHERE swiper_user_id = ? AND item_id = ?
    LIMIT 1
  `;

  db.query(checkSql, [userId, itemId], (errCheck, existing) => {
    if (errCheck) {
      console.error('Swipe check error:', errCheck);
      req.flash('error_msg', 'Server error. Please try again.');
      return res.redirect('/swap');
    }

    if (existing && existing.length > 0) {
      // Already swiped; just continue
      return res.redirect('/swap');
    }

    const insertSql = `
      INSERT INTO swap_swipes (swiper_user_id, item_id, is_like)
      VALUES (?, ?, ?)
    `;

    db.query(insertSql, [userId, itemId, isLike], (errIns) => {
      if (errIns) {
        console.error('Swipe insert error:', errIns);
        req.flash('error_msg', 'Failed to save swipe.');
        return res.redirect('/swap');
      }

      return res.redirect('/swap');
    });
  });
};

// ============================================
// INCOMING LIKES (Owner sees who liked their items)
// GET /swap/incoming
// ============================================
exports.getIncomingLikes = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const ownerId = req.session.user.user_id;

  const sql = `
    SELECT
      ss.swipe_id,
      ss.created_at AS liked_at,
      ss.swiper_user_id AS liker_user_id,
      liker.username AS liker_username,
      liker.profile_image_url AS liker_profile_image,
      ci.item_id AS liked_item_id,
      ci.title AS liked_item_title,
      ci.image_url_1 AS liked_item_image
    FROM swap_swipes ss
    JOIN clothing_items ci ON ss.item_id = ci.item_id
    JOIN users liker ON ss.swiper_user_id = liker.user_id
    WHERE ss.is_like = 1
      AND ci.owner_user_id = ?
    ORDER BY ss.created_at DESC
  `;

  db.query(sql, [ownerId], (err, rows) => {
    if (err) {
      console.error('Incoming likes load error:', err);
      req.flash('error_msg', 'Error loading incoming likes.');
      return res.redirect('/');
    }

    return res.render('swapIncoming', {
      user: req.session.user,
      likes: rows || []
    });
  });
};

// ============================================
// OWNER CHOOSES A COUNTER-ITEM FROM LIKER
// GET /swap/incoming/:swipeId/choose
// ============================================
exports.getChooseCounterItem = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const ownerId = req.session.user.user_id;
  const swipeId = Number(req.params.swipeId);

  if (!swipeId) {
    req.flash('error_msg', 'Invalid request.');
    return res.redirect('/swap/incoming');
  }

  const swipeSql = `
    SELECT
      ss.swipe_id,
      ss.swiper_user_id AS liker_user_id,
      ss.item_id AS liked_item_id,
      ci.owner_user_id,
      ci.title AS liked_item_title,
      ci.image_url_1 AS liked_item_image,
      liker.username AS liker_username,
      liker.profile_image_url AS liker_profile_image
    FROM swap_swipes ss
    JOIN clothing_items ci ON ss.item_id = ci.item_id
    JOIN users liker ON ss.swiper_user_id = liker.user_id
    WHERE ss.swipe_id = ?
      AND ss.is_like = 1
    LIMIT 1
  `;

  db.query(swipeSql, [swipeId], (errSwipe, swipeRows) => {
    if (errSwipe) {
      console.error('Swipe lookup error:', errSwipe);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/incoming');
    }

    if (!swipeRows || swipeRows.length === 0) {
      req.flash('error_msg', 'Like not found.');
      return res.redirect('/swap/incoming');
    }

    const swipe = swipeRows[0];

    // Must be the owner of the liked item
    if (Number(swipe.owner_user_id) !== Number(ownerId)) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/incoming');
    }

    // Load LIKER's available swap items
    const itemsSql = `
      SELECT
        item_id,
        title,
        category,
        size_label,
        color,
        condition_grade,
        image_url_1,
        created_at
      FROM clothing_items
      WHERE owner_user_id = ?
        AND is_for_swap = 1
        AND is_public = 1
        AND status = 'available'
      ORDER BY created_at DESC
    `;

    db.query(itemsSql, [swipe.liker_user_id], (errItems, items) => {
      if (errItems) {
        console.error('Liker items load error:', errItems);
        req.flash('error_msg', 'Error loading user items.');
        return res.redirect('/swap/incoming');
      }

      return res.render('swapChooseCounterItem', {
        user: req.session.user,
        swipe,
        likerItems: items || []
      });
    });
  });
};

// ============================================
// ACCEPT LIKE -> CREATE MATCH + CREATE CHAT
// POST /swap/incoming/:swipeId/accept
// Body: { selected_item_id }
// ============================================
exports.postAcceptLike = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const ownerId = req.session.user.user_id;
  const swipeId = Number(req.params.swipeId);
  const selectedItemId = Number(req.body.selected_item_id);

  if (!swipeId || !selectedItemId) {
    req.flash('error_msg', 'Please select an item to proceed.');
    return res.redirect(`/swap/incoming/${swipeId}/choose`);
  }

  db.beginTransaction((txErr) => {
    if (txErr) {
      console.error('Transaction begin error:', txErr);
      req.flash('error_msg', 'Server error. Please try again.');
      return res.redirect('/swap/incoming');
    }

    const swipeSql = `
      SELECT
        ss.swipe_id,
        ss.swiper_user_id AS liker_user_id,
        ss.item_id AS liked_item_id,
        ci.owner_user_id
      FROM swap_swipes ss
      JOIN clothing_items ci ON ss.item_id = ci.item_id
      WHERE ss.swipe_id = ?
        AND ss.is_like = 1
      LIMIT 1
    `;

    db.query(swipeSql, [swipeId], (errSwipe, swipeRows) => {
      if (errSwipe || !swipeRows || swipeRows.length === 0) {
        console.error('Swipe lookup error:', errSwipe);
        return db.rollback(() => {
          req.flash('error_msg', 'Like not found.');
          return res.redirect('/swap/incoming');
        });
      }

      const swipe = swipeRows[0];

      // Must be owner of the liked item
      if (Number(swipe.owner_user_id) !== Number(ownerId)) {
        return db.rollback(() => {
          req.flash('error_msg', 'Access denied.');
          return res.redirect('/swap/incoming');
        });
      }

      // Validate selected item belongs to LIKER and is available + for swap
      const selectedSql = `
        SELECT item_id, owner_user_id, status, is_for_swap
        FROM clothing_items
        WHERE item_id = ?
        LIMIT 1
      `;

      db.query(selectedSql, [selectedItemId], (errSel, selRows) => {
        if (errSel || !selRows || selRows.length === 0) {
          console.error('Selected item lookup error:', errSel);
          return db.rollback(() => {
            req.flash('error_msg', 'Selected item not found.');
            return res.redirect(`/swap/incoming/${swipeId}/choose`);
          });
        }

        const selected = selRows[0];

        if (Number(selected.owner_user_id) !== Number(swipe.liker_user_id)) {
          return db.rollback(() => {
            req.flash('error_msg', 'Invalid selection (not owned by liker).');
            return res.redirect(`/swap/incoming/${swipeId}/choose`);
          });
        }

        if (selected.is_for_swap !== 1 || selected.status !== 'available') {
          return db.rollback(() => {
            req.flash('error_msg', 'Selected item is not available for swap.');
            return res.redirect(`/swap/incoming/${swipeId}/choose`);
          });
        }

        // Create match:
        // user1 = liker, item1 = selected (liker’s item)
        // user2 = owner, item2 = liked item (owner’s item)
        const matchSql = `
          INSERT INTO swap_matches (user1_id, item1_id, user2_id, item2_id, status)
          VALUES (?, ?, ?, ?, 'pending')
        `;

        db.query(
          matchSql,
          [swipe.liker_user_id, selectedItemId, ownerId, swipe.liked_item_id],
          (errMatch, matchResult) => {
            if (errMatch) {
              console.error('Create match error:', errMatch);
              return db.rollback(() => {
                req.flash('error_msg', 'Failed to create match.');
                return res.redirect('/swap/incoming');
              });
            }

            const matchId = matchResult.insertId;

            // Create chat for the match
            const chatSql = `INSERT INTO chats (match_id) VALUES (?)`;
            db.query(chatSql, [matchId], (errChat) => {
              if (errChat) {
                console.error('Create chat error:', errChat);
                return db.rollback(() => {
                  req.flash('error_msg', 'Failed to create chat.');
                  return res.redirect('/swap/incoming');
                });
              }

              // Reserve both items so they don’t get double-booked
              const reserveSql = `
                UPDATE clothing_items
                SET status = 'reserved'
                WHERE item_id IN (?, ?)
              `;

              db.query(reserveSql, [swipe.liked_item_id, selectedItemId], (errRes) => {
                if (errRes) {
                  console.error('Reserve items error:', errRes);
                  return db.rollback(() => {
                    req.flash('error_msg', 'Failed to reserve items.');
                    return res.redirect('/swap/incoming');
                  });
                }

                // Remove the incoming like so it disappears from the owner’s list
                const deleteSwipeSql = `DELETE FROM swap_swipes WHERE swipe_id = ?`;
                db.query(deleteSwipeSql, [swipeId], (errDel) => {
                  if (errDel) {
                    console.error('Delete swipe error:', errDel);
                    return db.rollback(() => {
                      req.flash('error_msg', 'Server error. Please try again.');
                      return res.redirect('/swap/incoming');
                    });
                  }

                  db.commit((errCommit) => {
                    if (errCommit) {
                      console.error('Commit error:', errCommit);
                      return db.rollback(() => {
                        req.flash('error_msg', 'Server error. Please try again.');
                        return res.redirect('/swap/incoming');
                      });
                    }

                    req.flash('success_msg', 'Match created! A chat has been opened.');
                    return res.redirect('/swap/matches');
                  });
                });
              });
            });
          }
        );
      });
    });
  });
};

// ============================================
// REJECT LIKE (dismiss incoming like)
// POST /swap/incoming/:swipeId/reject
// ============================================
exports.postRejectLike = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const ownerId = req.session.user.user_id;
  const swipeId = Number(req.params.swipeId);

  if (!swipeId) {
    req.flash('error_msg', 'Invalid request.');
    return res.redirect('/swap/incoming');
  }

  // Only delete if the liked item belongs to this owner
  const sql = `
    DELETE ss
    FROM swap_swipes ss
    JOIN clothing_items ci ON ss.item_id = ci.item_id
    WHERE ss.swipe_id = ?
      AND ss.is_like = 1
      AND ci.owner_user_id = ?
  `;

  db.query(sql, [swipeId, ownerId], (err, result) => {
    if (err) {
      console.error('Reject like error:', err);
      req.flash('error_msg', 'Failed to reject like.');
      return res.redirect('/swap/incoming');
    }

    if (!result || result.affectedRows === 0) {
      req.flash('error_msg', 'Like not found or access denied.');
      return res.redirect('/swap/incoming');
    }

    req.flash('success_msg', 'Rejected.');
    return res.redirect('/swap/incoming');
  });
};

// ============================================
// MY MATCHES
// GET /swap/matches
// ============================================
exports.getMyMatches = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const userId = req.session.user.user_id;

  const sql = `
  SELECT
    sm.match_id,
    sm.status,
    sm.created_at,

    sm.user1_id,
    u1.username AS user1_username,

    sm.user2_id,
    u2.username AS user2_username,

    sm.item1_id,
    i1.title AS item1_title,
    i1.image_url_1 AS item1_image,

    sm.item2_id,
    i2.title AS item2_title,
    i2.image_url_1 AS item2_image,

    c.chat_id
  FROM swap_matches sm
  JOIN users u1 ON sm.user1_id = u1.user_id
  JOIN users u2 ON sm.user2_id = u2.user_id
  JOIN clothing_items i1 ON sm.item1_id = i1.item_id
  JOIN clothing_items i2 ON sm.item2_id = i2.item_id
  LEFT JOIN chats c ON sm.match_id = c.match_id
  WHERE (sm.user1_id = ? OR sm.user2_id = ?)
    AND sm.status <> 'cancelled'
  ORDER BY sm.created_at DESC
`;

  db.query(sql, [userId, userId], (err, rows) => {
    if (err) {
      console.error('My matches load error:', err);
      req.flash('error_msg', 'Error loading matches.');
      return res.redirect('/');
    }

    return res.render('swapMatches', {
      user: req.session.user,
      matches: rows || []
    });
  });
};

// Get a specific match by ID
exports.getMatchDetails = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const matchId = req.params.matchId;
  const userId = req.session.user.user_id;

  const sql = `
    SELECT
      sm.match_id,
      sm.user1_id,
      sm.item1_id,
      sm.user2_id,
      sm.item2_id,
      sm.status,
      sm.swap_method,
      sm.payment_split,
      sm.meetup_location_id,
      sm.scheduled_time,
      sm.details_locked,
      sm.created_at,
      sm.updated_at,
      u1.username AS user1_username,
      u1.profile_image_url AS user1_image,
      u2.username AS user2_username,
      u2.profile_image_url AS user2_image,
      ci1.title AS item1_title,
      ci1.description AS item1_description,
      ci1.image_url_1 AS item1_image,
      ci2.title AS item2_title,
      ci2.description AS item2_description,
      ci2.image_url_1 AS item2_image,
      c.chat_id
    FROM swap_matches sm
    JOIN users u1 ON sm.user1_id = u1.user_id
    JOIN users u2 ON sm.user2_id = u2.user_id
    JOIN clothing_items ci1 ON sm.item1_id = ci1.item_id
    JOIN clothing_items ci2 ON sm.item2_id = ci2.item_id
    LEFT JOIN chats c ON sm.match_id = c.match_id
    WHERE sm.match_id = ?
      AND (sm.user1_id = ? OR sm.user2_id = ?)
    LIMIT 1
  `;

  db.query(sql, [matchId, userId, userId], (err, rows) => {
    if (err) {
      console.error('Error loading match details:', err);
      req.flash('error_msg', 'Could not load match details.');
      return res.redirect('/inbox');
    }

    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'Match not found.');
      return res.redirect('/inbox');
    }

    const match = rows[0];
    res.render('swapMatches', {
      user: req.session.user,
      match: match,
      currentUserId: userId,
      otherUserId: userId === match.user1_id ? match.user2_id : match.user1_id
    });
  });
};

// Redirect from match_id to chat or details page
exports.getChatFromMatch = (req, res) => {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    return res.redirect('/login');
  }

  const matchId = req.params.matchId;
  const userId = req.session.user.user_id;

  // Get the chat_id for this match
  const sql = `
    SELECT c.chat_id
    FROM chats c
    JOIN swap_matches sm ON c.match_id = sm.match_id
    WHERE sm.match_id = ?
      AND (sm.user1_id = ? OR sm.user2_id = ?)
    LIMIT 1
  `;

  db.query(sql, [matchId, userId, userId], (err, rows) => {
    if (err) {
      console.error('Error finding chat:', err);
      req.flash('error_msg', 'Could not find chat.');
      return res.redirect('/inbox');
    }

    if (!rows || rows.length === 0) {
      // No chat yet, create one
      const createChatSql = `
        INSERT INTO chats (match_id) VALUES (?)
      `;
      db.query(createChatSql, [matchId], (err, result) => {
        if (err) {
          console.error('Error creating chat:', err);
          req.flash('error_msg', 'Could not create chat.');
          return res.redirect('/inbox');
        }
        return res.redirect(`/chats/${result.insertId}`);
      });
    } else {
      return res.redirect(`/chats/${rows[0].chat_id}`);
    }
  });
};


function requireLogin(req, res) {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    res.redirect('/login');
    return false;
  }
  return true;
}

function getChatAndMatch(dbConn, chatId, userId, cb) {
  const sql = `
    SELECT
      c.chat_id,
      c.match_id,
      sm.user1_id,
      sm.user2_id,
      u1.username AS user1_username,
      u2.username AS user2_username,
      sm.swap_method,
      sm.payment_split,
      sm.meetup_location_id,
      sm.scheduled_time,
      sm.details_locked,
      sm.status
    FROM chats c
    JOIN swap_matches sm ON c.match_id = sm.match_id
    JOIN users u1 ON sm.user1_id = u1.user_id
    JOIN users u2 ON sm.user2_id = u2.user_id
    WHERE c.chat_id = ?
      AND (sm.user1_id = ? OR sm.user2_id = ?)
    LIMIT 1
  `;
  dbConn.query(sql, [chatId, userId, userId], (err, rows) => {
    if (err) return cb(err);
    if (!rows || rows.length === 0) return cb(null, null);
    return cb(null, rows[0]);
  });
}


function insertSystemMessage(dbConn, chatId, actorUserId, text, cb) {
  const sql = `
    INSERT INTO chat_messages (chat_id, sender_user_id, message_text, created_at)
    VALUES (?, ?, ?, NOW())
  `;
  dbConn.query(sql, [chatId, actorUserId, text], () => cb && cb());
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// total = SAHM total fee (sum of pickup_delivery_requests.delivery_fee)
// returns object keyed by user_id with amount owed
/***********************
 * Payment Split Helpers
 ***********************/
function computeSplitAmounts(total, user1Id, user2Id, splitEnum) {
  const t = round2(total || 0);

  if (splitEnum === 'user1_pays_all') {
    return { [Number(user1Id)]: t, [Number(user2Id)]: 0 };
  }
  if (splitEnum === 'user2_pays_all') {
    return { [Number(user1Id)]: 0, [Number(user2Id)]: t };
  }

  // split_evenly (default)
  const half = Math.floor((t / 2) * 100) / 100; // floor 2dp
  const otherHalf = round2(t - half);           // remainder to preserve exact sum
  return { [Number(user1Id)]: half, [Number(user2Id)]: otherHalf };
}

// UI choices: 'split' or 'i_pay' (user never sees "other pays")
function mapUiChoiceToEnum(choice, viewerUserId, user1Id, user2Id) {
  const c = String(choice || '').trim();

  if (c === 'split') return 'split_evenly';

  if (c === 'i_pay') {
    if (Number(viewerUserId) === Number(user1Id)) return 'user1_pays_all';
    if (Number(viewerUserId) === Number(user2Id)) return 'user2_pays_all';
    return null;
  }

  // allow enum direct too
  if (['split_evenly', 'user1_pays_all', 'user2_pays_all'].includes(c)) return c;

  return null;
}

/***********************
 * OneMap + Locations
 ***********************/
let ONEMAP_TOKEN_CACHE = { token: null, expMs: 0 };

function normalizeSgPostal(postal) {
  const digits = String(postal || '').replace(/\D/g, '');
  return digits.length === 6 ? digits : null;
}

async function getOneMapToken() {
  const email = process.env.ONEMAP_EMAIL;
  const password = process.env.ONEMAP_PASSWORD;

  if (!email || !password) {
    console.warn('[ONEMAP] Missing ONEMAP_EMAIL / ONEMAP_PASSWORD in .env');
    return null;
  }

  const now = Date.now();
  if (ONEMAP_TOKEN_CACHE.token && ONEMAP_TOKEN_CACHE.expMs > now + 60_000) {
    return ONEMAP_TOKEN_CACHE.token;
  }

  try {
    // ✅ Correct: send JSON body (this is what fixes "email field is empty")
    const resp = await fetch('https://www.onemap.gov.sg/api/auth/post/getToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const json = await resp.json().catch(() => ({}));
    const token = json?.access_token || json?.token || null;

    if (!token) {
      console.warn('[ONEMAP] Token fetch failed:', json);
      return null;
    }

    // Cache ~70 hours (token typically lasts 72h, we keep buffer)
    ONEMAP_TOKEN_CACHE = { token, expMs: now + 70 * 60 * 60 * 1000 };
    console.log('[ONEMAP] Token fetched OK');
    return token;
  } catch (e) {
    console.warn('[ONEMAP] Token fetch exception:', e?.message || e);
    return null;
  }
}

async function oneMapSearch(searchVal) {
  const q = String(searchVal || '').trim();
  if (!q) return null;

  const token = await getOneMapToken();
  if (!token) {
    console.warn('[ONEMAP] No token -> skipping search');
    return null;
  }

  const url =
    `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(q)}` +
    `&returnGeom=Y&getAddrDetails=Y&pageNum=1`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: token }
    });

    const json = await resp.json().catch(() => ({}));
    if (json?.error) {
      console.warn('[ONEMAP] search error:', json.error, '| q=', q);
      return null;
    }

    const r0 = json?.results?.[0];
    if (!r0) return null;

    const lat = Number(r0.LATITUDE);
    const lng = Number(r0.LONGITUDE ?? r0.LONGTITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { lat, lng };
  } catch (e) {
    console.warn('[ONEMAP] search exception:', e?.message || e, '| q=', q);
    return null;
  }
}

/**
 * ✅ Critical fix: NULL lat/lng must NOT be treated as 0.
 * Number(null) === 0, so we convert NULL -> NaN, forcing geocode.
 */
function ensureLocationHasLatLng(dbConn, locationId, cb) {
  const sql = `
    SELECT location_id, postal_code, address_line, city, latitude, longitude
    FROM locations
    WHERE location_id = ?
    LIMIT 1
  `;

  dbConn.query(sql, [locationId], async (err, rows) => {
    if (err) return cb(err);

    const loc = rows?.[0];
    if (!loc) return cb(null, null);

    const latRaw = loc.latitude;
    const lngRaw = loc.longitude;

    const lat0 = (latRaw === null || latRaw === undefined || latRaw === '') ? NaN : Number(latRaw);
    const lng0 = (lngRaw === null || lngRaw === undefined || lngRaw === '') ? NaN : Number(lngRaw);

    if (Number.isFinite(lat0) && Number.isFinite(lng0)) {
      return cb(null, { ...loc, latitude: lat0, longitude: lng0 });
    }

    const postal = normalizeSgPostal(loc.postal_code);
    const addressLine = (loc.address_line || '').trim();
    const city = (loc.city || '').trim();

    const hasMeaningfulAddress = addressLine.length >= 6;
    if (!postal && !hasMeaningfulAddress) {
      return cb(null, { ...loc, latitude: null, longitude: null });
    }

    const q = postal || [addressLine, city, 'Singapore'].filter(Boolean).join(' ').trim();

    try {
      const coords = await oneMapSearch(q);
      if (!coords) return cb(null, { ...loc, latitude: null, longitude: null });

      // ✅ Your DB column is "longitude"
      const upd = `UPDATE locations SET latitude = ?, longitude = ? WHERE location_id = ?`;
      dbConn.query(upd, [coords.lat, coords.lng, locationId], (uErr, uRes) => {
        if (uErr) return cb(uErr);
        console.log('[LOC] Updated location', locationId, 'affectedRows=', uRes?.affectedRows);
        return cb(null, { ...loc, latitude: coords.lat, longitude: coords.lng });
      });
    } catch {
      return cb(null, { ...loc, latitude: null, longitude: null });
    }
  });
}
/***********************
 * SAHM Fee Calculation
 ***********************/
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Tune these numbers however you want
const SAHM_BASE_FEE = 3.0;
const SAHM_PER_KM = 0.9;
const SAHM_MIN_FEE = 4.0;
const SAHM_EARNING_RATE = 0.7;

function calcSahmLegFee(distanceKm) {
  const fee = Math.max(SAHM_MIN_FEE, SAHM_BASE_FEE + SAHM_PER_KM * Math.max(0, distanceKm));
  return round2(fee);
}

function upsertPickupDeliveryLeg(dbConn, matchId, leg, pickupLocationId, dropoffLocationId, deliveryFee, sahmEarning, cb) {
  const sql = `
    INSERT INTO pickup_delivery_requests
      (match_id, leg, pickup_location_id, dropoff_location_id, status, delivery_fee, sahm_earning, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      pickup_location_id = VALUES(pickup_location_id),
      dropoff_location_id = VALUES(dropoff_location_id),
      status = 'pending',
      delivery_fee = VALUES(delivery_fee),
      sahm_earning = VALUES(sahm_earning),
      updated_at = NOW()
  `;
  dbConn.query(sql, [matchId, leg, pickupLocationId, dropoffLocationId, deliveryFee, sahmEarning], cb);
}

function computeAndUpsertSahmFees(dbConn, matchId, user1Id, user2Id, chatId, actorUserId, cb) {
  const addrSql = `
    SELECT user_id, location_id
    FROM swap_delivery_addresses
    WHERE match_id = ?
  `;

  dbConn.query(addrSql, [matchId], (aErr, aRows) => {
    if (aErr) return cb(aErr);

    const u1 = (aRows || []).find(r => String(r.user_id) === String(user1Id));
    const u2 = (aRows || []).find(r => String(r.user_id) === String(user2Id));
    if (!u1 || !u2) return cb(null, { ok: false, reason: 'missing_addresses' });

    ensureLocationHasLatLng(dbConn, u1.location_id, (e1Err, loc1) => {
      if (e1Err) return cb(e1Err);

      ensureLocationHasLatLng(dbConn, u2.location_id, (e2Err, loc2) => {
        if (e2Err) return cb(e2Err);

        const lat1 = loc1?.latitude === null ? NaN : Number(loc1?.latitude);
        const lng1 = loc1?.longitude === null ? NaN : Number(loc1?.longitude);
        const lat2 = loc2?.latitude === null ? NaN : Number(loc2?.latitude);
        const lng2 = loc2?.longitude === null ? NaN : Number(loc2?.longitude);

        if (!Number.isFinite(lat1) || !Number.isFinite(lng1) || !Number.isFinite(lat2) || !Number.isFinite(lng2)) {
          return cb(null, { ok: false, reason: 'missing_coords' });
        }

        const distanceKm = round2(haversineKm(lat1, lng1, lat2, lng2));
        const legFee = calcSahmLegFee(distanceKm);
        const legEarning = round2(legFee * SAHM_EARNING_RATE);
        const totalFee = round2(legFee * 2);

        upsertPickupDeliveryLeg(dbConn, matchId, 'u1_to_u2', u1.location_id, u2.location_id, legFee, legEarning, (l1Err) => {
          if (l1Err) return cb(l1Err);

          upsertPickupDeliveryLeg(dbConn, matchId, 'u2_to_u1', u2.location_id, u1.location_id, legFee, legEarning, (l2Err) => {
            if (l2Err) return cb(l2Err);

            // This relies on your existing insertSystemMessage(db, chatId, userId, text, cb)
            insertSystemMessage(
              dbConn,
              chatId,
              actorUserId,
              `[SYSTEM] SAHM fee calculated: $${legFee.toFixed(2)} per leg (≈ ${distanceKm.toFixed(2)} km). Total: $${totalFee.toFixed(2)}.`,
              () => cb(null, { ok: true, distanceKm, legFee, totalFee })
            );
          });
        });
      });
    });
  });
}

// =============================
// PAYMENT OTP (Secure Pay Verification)
// =============================
function gen6DigitOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function otpHash(code) {
  const secret = process.env.PAYMENT_OTP_SECRET || process.env.SESSION_SECRET || 'otp_secret';
  return crypto.createHash('sha256').update(`${code}:${secret}`).digest('hex');
}

function getOtpRow(dbConn, matchId, payerUserId, cb) {
  const sql = `
    SELECT stepup_id, amount_snapshot, currency, otp_code_hash, expires_at, verified_at, last_sent_at, attempt_count
    FROM swap_payment_stepups
    WHERE match_id = ? AND payer_user_id = ?
    LIMIT 1
  `;
  dbConn.query(sql, [matchId, payerUserId], (err, rows) => {
    if (err) return cb(err);
    return cb(null, (rows && rows[0]) ? rows[0] : null);
  });
}

function isOtpVerifiedForAmount(row, expectedAmount) {
  if (!row || !row.verified_at) return false;

  const exp = row.expires_at ? new Date(row.expires_at) : null;
  if (!exp || Number.isNaN(exp.getTime())) return false;
  if (exp.getTime() < Date.now()) return false;

  const snapCents = Math.round(Number(row.amount_snapshot) * 100);
  const expCents  = Math.round(Number(expectedAmount) * 100);

  if (!Number.isFinite(snapCents) || !Number.isFinite(expCents)) return false;

  // must match exactly to the cent
  return snapCents === expCents;
}

function requirePaymentOtpVerified(dbConn, matchId, payerUserId, expectedAmount, cb) {
  // ✅ If called without cb, return a Promise instead of crashing
  if (typeof cb !== 'function') {
    return new Promise((resolve, reject) => {
      getOtpRow(dbConn, matchId, payerUserId, (err, row) => {
        if (err) return reject(err);
        return resolve(isOtpVerifiedForAmount(row, expectedAmount));
      });
    });
  }

  // ✅ Normal callback style (your existing code)
  getOtpRow(dbConn, matchId, payerUserId, (err, row) => {
    if (err) return cb(err);
    if (!isOtpVerifiedForAmount(row, expectedAmount)) return cb(null, false);
    return cb(null, true);
  });
}


function clearPaymentOtp(dbConn, matchId, payerUserId, cb) {
  const sql = `DELETE FROM swap_payment_stepups WHERE match_id = ? AND payer_user_id = ?`;
  dbConn.query(sql, [matchId, payerUserId], () => cb && cb());
}

// =============================
// /HELP CASE (Freeze commands + payment)
// =============================
function getActiveSwapCase(dbConn, matchId, cb) {
  const sql = `
    SELECT
      case_id, match_id, case_type, reason, status,
      opened_by_user_id, admin_user_id, admin_comment,
      created_at, updated_at
    FROM swap_cases
    WHERE match_id = ?
      AND status IN ('open', 'under_review')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  dbConn.query(sql, [matchId], (err, rows) => {
    if (err) return cb(err);
    return cb(null, (rows && rows[0]) ? rows[0] : null);
  });
}

function isFrozenByHelpCase(dbConn, matchId, cb) {
  getActiveSwapCase(dbConn, matchId, (err, row) => {
    if (err) return cb(err);
    return cb(null, !!row, row);
  });
}


// =====================================================
// REPLACE: GET /chats/:chatId
// =====================================================
// =====================================================
// REPLACE: GET /chats/:chatId
// =====================================================
exports.getChat = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  let openModal = (req.query.open || '').trim(); // swapMethod | location | paymentSplit | time | help

  if (!chatId) {
    req.flash('error_msg', 'Invalid chat.');
    return res.redirect('/swap/matches');
  }

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
      AND (sm.user1_id = ? OR sm.user2_id = ?) 
    LIMIT 1
  `;

  db.query(chatSql, [chatId, userId, userId], (err, chatRows) => {
    if (err) {
      console.error('getChat chatSql error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }

    if (!chatRows || chatRows.length === 0) {
      req.flash('error_msg', 'Access denied or chat not found.');
      return res.redirect('/swap/matches');
    }

    const chat = chatRows[0];

    // ✅ NEW: active /help case -> freeze commands + payment
    getActiveSwapCase(db, chat.match_id, (caseErr, activeCase) => {
      if (caseErr) {
        console.error('getChat getActiveSwapCase error:', caseErr);
        activeCase = null;
      }
      const commandsFrozen = !!activeCase;

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
          console.error('getChat msgSql error:', err2);
          req.flash('error_msg', 'Failed to load messages.');
          return res.redirect('/swap/matches');
        }

        const pendingSwapSql = `
          SELECT
            sc.*,
            u.username AS proposed_by_username
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
          SELECT
            sc.*,
            u.username AS proposed_by_username,
            l.label AS location_label
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
          SELECT
            sc.*,
            u.username AS proposed_by_username
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
          SELECT
            sc.*,
            u.username AS proposed_by_username
          FROM swap_confirmations sc
          JOIN users u ON sc.proposed_by_user_id = u.user_id
          WHERE sc.match_id = ?
            AND sc.type = 'scheduled_time'
            AND sc.status = 'pending'
          ORDER BY sc.offer_round DESC
          LIMIT 1
        `;

        db.query(pendingSwapSql, [chat.match_id], (pErr, pRows) => {
          const pendingSwapMethod = (!pErr && pRows && pRows[0]) ? pRows[0] : null;

          db.query(myLocationsSql, [userId], (locErr, locations) => {
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

            const done = () => {
              // Auto-open SAHM address modal if needed
              if (!openModal && chat.swap_method === 'sahm' && Number(chat.details_locked) !== 1) {
                if (!mySahmAddress) openModal = 'location';
              }

              // Auto-open pending payment split
              if (!openModal && pendingPaymentSplit && Number(chat.details_locked) !== 1) {
                if (pendingPaymentSplit.proposed_to_user_id && Number(pendingPaymentSplit.proposed_to_user_id) === Number(userId)) {
                  openModal = 'paymentSplit';
                }
              }

              // Auto-open pending time
              if (!openModal && pendingScheduledTime && Number(chat.details_locked) !== 1) {
                if (pendingScheduledTime.proposed_to_user_id && Number(pendingScheduledTime.proposed_to_user_id) === Number(userId)) {
                  openModal = 'time';
                }
              }

              return res.render('chat', {
                user: req.session.user,
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

                // ✅ NEW for /help
                activeCase,
                commandsFrozen,

                paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
                paypalCurrency: process.env.PAYPAL_CURRENCY || 'SGD',
                paypalMode: process.env.PAYPAL_MODE || 'sandbox'
              });
            };

            if (!chat.swap_method) {
              return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
                pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
                return done();
              });
            }

            if (chat.swap_method === 'meetup') {
              return db.query(pendingMeetupSql, [chat.match_id], (pmErr, pmRows) => {
                if (!pmErr && pmRows && pmRows[0]) pendingMeetupLocation = pmRows[0];

                if (!chat.meetup_location_id) {
                  return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
                    pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
                    return done();
                  });
                }

                return db.query(meetupLocationSql, [chat.meetup_location_id], (mlErr, mlRows) => {
                  if (!mlErr && mlRows && mlRows[0]) meetupLocation = mlRows[0];

                  return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
                    pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
                    return done();
                  });
                });
              });
            }

            if (chat.swap_method === 'sahm') {
              return db.query(sahmAddressesSql, [chat.match_id], (saErr, saRows) => {
                if (!saErr && saRows && saRows.length) {
                  saRows.forEach(r => {
                    if (String(r.user_id) === String(userId)) mySahmAddress = r;
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

                        const otherId = (Number(chat.user1_id) === Number(userId)) ? Number(chat.user2_id) : Number(chat.user1_id);
                        const myRow = payMap.get(Number(userId));
                        const otherRow = payMap.get(otherId);

                        myPay = {
                          required: requiredPayers.includes(Number(userId)),
                          amount: round2(amounts[Number(userId)] || 0),
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
                        return done();
                      });
                    });
                  });
                });
              });
            }

            return db.query(pendingTimeSql, [chat.match_id], (tErr, tRows) => {
              pendingScheduledTime = (!tErr && tRows && tRows[0]) ? tRows[0] : null;
              return done();
            });
          });
        });
      });
    });
  });
};



// =====================================================
// REPLACE: POST /chats/:chatId/messages
// Intercept /confirmSwapMethod + /confirmLocation to open modal
// =====================================================
// =====================================================
// REPLACE: POST /chats/:chatId/messages
// Intercept /confirmSwapMethod + /confirmLocation + /confirmPaymentSplit to open modal
// =====================================================
exports.postSendMessage = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);
  const messageText = String(req.body.message_text || '').trim();

  if (!chatId) {
    req.flash('error_msg', 'Invalid chat.');
    return res.redirect('/swap/matches');
  }
  if (!messageText) {
    req.flash('error_msg', 'Message cannot be empty.');
    return res.redirect(`/chats/${chatId}`);
  }

  const lower = messageText.toLowerCase();

  // Always allow /help to open modal (do not store as message)
  if (lower === '/help' || lower.startsWith('/help ')) {
    return res.redirect(`/chats/${chatId}?open=help`);
  }

  // Verify access + get match_id (needed for freeze check)
  const verifySql = `
    SELECT c.chat_id, c.match_id, sm.user1_id, sm.user2_id
    FROM chats c
    JOIN swap_matches sm ON c.match_id = sm.match_id
    WHERE c.chat_id = ?
      AND (sm.user1_id = ? OR sm.user2_id = ?)
    LIMIT 1
  `;

  db.query(verifySql, [chatId, userId, userId], (err, rows) => {
    if (err) {
      console.error('postSendMessage verify error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }
    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    const matchId = Number(rows[0].match_id);

    // If it's a slash command (anything starting with "/"), freeze everything except /help
    if (messageText.startsWith('/')) {
      return isFrozenByHelpCase(db, matchId, (fErr, frozen) => {
        if (fErr) {
          console.error('postSendMessage freeze check error:', fErr);
          req.flash('error_msg', 'Server error.');
          return res.redirect(`/chats/${chatId}`);
        }

        if (frozen) {
          req.flash('error_msg', 'Actions are under admin review. Commands and payment are temporarily disabled. You can still chat or use /help.');
          return res.redirect(`/chats/${chatId}`);
        }

        // Your existing commands -> open modal (do not store)
        if (lower === '/confirmswapmethod' || lower.startsWith('/confirmswapmethod ')) {
          return res.redirect(`/chats/${chatId}?open=swapMethod`);
        }
        if (lower === '/confirmlocation' || lower.startsWith('/confirmlocation ')) {
          return res.redirect(`/chats/${chatId}?open=location`);
        }
        if (lower === '/confirmpaymentsplit' || lower.startsWith('/confirmpaymentsplit ')) {
          return res.redirect(`/chats/${chatId}?open=paymentSplit`);
        }
        if (lower === '/confirmtime' || lower.startsWith('/confirmtime ')) {
          return res.redirect(`/chats/${chatId}?open=time`);
        }

        // Unknown slash command: just do nothing (or store as message if you prefer)
        req.flash('error_msg', 'Unknown command.');
        return res.redirect(`/chats/${chatId}`);
      });
    }

    // Normal messages: store as usual
    const insertSql = `
      INSERT INTO chat_messages (chat_id, sender_user_id, message_text, created_at)
      VALUES (?, ?, ?, NOW())
    `;

    db.query(insertSql, [chatId, userId, messageText], (err2) => {
      if (err2) {
        console.error('postSendMessage insert error:', err2);
        req.flash('error_msg', 'Failed to send message.');
        return res.redirect(`/chats/${chatId}`);
      }
      return res.redirect(`/chats/${chatId}`);
    });
  });
};



exports.postProposeSwapMethod = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const method = (req.body.swap_method || '').trim(); // meetup | sahm

  if (!chatId || !['meetup', 'sahm'].includes(method)) {
    req.flash('error_msg', 'Invalid swap method proposal.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postProposeSwapMethod getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.swap_method) {
      req.flash('error_msg', 'Swap method already confirmed.');
      return res.redirect(`/chats/${chatId}`);
    }

    const otherUserId = (Number(userId) === Number(cm.user1_id)) ? cm.user2_id : cm.user1_id;

    // Block if any pending exists
    const pendingSql = `
      SELECT confirmation_id
      FROM swap_confirmations
      WHERE match_id = ? AND type = 'swap_method' AND status = 'pending'
      LIMIT 1
    `;
    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error('postProposeSwapMethod pending check error:', pErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (pRows && pRows.length > 0) {
        req.flash('error_msg', 'There is already a pending swap method proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const nice = method === 'sahm' ? 'SAHM' : 'Meetup';

      // Upsert offer_round=0 (initial proposal)
      const findRound0 = `
        SELECT confirmation_id
        FROM swap_confirmations
        WHERE match_id = ? AND type = 'swap_method' AND offer_round = 0
        LIMIT 1
      `;
      db.query(findRound0, [cm.match_id], (fErr, fRows) => {
        if (fErr) {
          console.error('postProposeSwapMethod find round0 error:', fErr);
          req.flash('error_msg', 'Server error.');
          return res.redirect(`/chats/${chatId}`);
        }

        const afterWrite = () => {
          insertSystemMessage(db, chatId, userId, `[SYSTEM] Swap method proposed: ${nice}.`, () => {
            req.flash('success_msg', 'Swap method proposal sent.');
            return res.redirect(`/chats/${chatId}`);
          });
        };

        if (!fRows || fRows.length === 0) {
          const insSql = `
            INSERT INTO swap_confirmations
              (match_id, type, offer_round, proposed_by_user_id, proposed_to_user_id, proposed_value, status, created_at)
            VALUES
              (?, 'swap_method', 0, ?, ?, ?, 'pending', NOW())
          `;
          return db.query(insSql, [cm.match_id, userId, otherUserId, method], (iErr) => {
            if (iErr) {
              console.error('postProposeSwapMethod insert round0 error:', iErr);
              req.flash('error_msg', 'Failed to create proposal.');
              return res.redirect(`/chats/${chatId}`);
            }
            return afterWrite();
          });
        }

        const updSql = `
          UPDATE swap_confirmations
          SET
            proposed_by_user_id = ?,
            proposed_to_user_id = ?,
            proposed_value = ?,
            status = 'pending',
            responded_by_user_id = NULL,
            responded_at = NULL,
            counter_of_confirmation_id = NULL,
            created_at = NOW()
          WHERE match_id = ? AND type = 'swap_method' AND offer_round = 0
        `;
        db.query(updSql, [userId, otherUserId, method, cm.match_id], (uErr) => {
          if (uErr) {
            console.error('postProposeSwapMethod update round0 error:', uErr);
            req.flash('error_msg', 'Failed to update proposal.');
            return res.redirect(`/chats/${chatId}`);
          }

          // Safety: ensure round 1 isn't still pending from old attempts
          const resetRound1 = `
            UPDATE swap_confirmations
            SET status = 'cancelled'
            WHERE match_id = ? AND type = 'swap_method' AND offer_round = 1 AND status = 'pending'
          `;
          db.query(resetRound1, [cm.match_id], () => afterWrite());
        });
      });
    });
  });
};

exports.postRespondSwapMethod = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const action = (req.body.action || '').trim();

  if (!chatId || !['accept', 'reject'].includes(action)) {
    req.flash('error_msg', 'Invalid response.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postRespondSwapMethod getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.swap_method) {
      req.flash('error_msg', 'Swap method already confirmed.');
      return res.redirect(`/chats/${chatId}`);
    }

    const pendingSql = `
      SELECT *
      FROM swap_confirmations
      WHERE match_id = ? AND type = 'swap_method' AND status = 'pending'
      ORDER BY offer_round DESC
      LIMIT 1
    `;
    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error('postRespondSwapMethod pending error:', pErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (!pRows || pRows.length === 0) {
        req.flash('error_msg', 'No pending swap method proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const pending = pRows[0];

      if (pending.proposed_to_user_id && Number(pending.proposed_to_user_id) !== Number(userId)) {
        req.flash('error_msg', 'You cannot respond to this proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const newStatus = action === 'accept' ? 'accepted' : 'rejected';

      const updConfirmSql = `
        UPDATE swap_confirmations
        SET status = ?, responded_by_user_id = ?, responded_at = NOW()
        WHERE confirmation_id = ?
      `;
      db.query(updConfirmSql, [newStatus, userId, pending.confirmation_id], (uErr) => {
        if (uErr) {
          console.error('postRespondSwapMethod update confirmation error:', uErr);
          req.flash('error_msg', 'Failed to update response.');
          return res.redirect(`/chats/${chatId}`);
        }

        if (newStatus !== 'accepted') {
          insertSystemMessage(db, chatId, userId, `[SYSTEM] Swap method proposal was rejected.`, () => {
            req.flash('success_msg', 'Response saved.');
            return res.redirect(`/chats/${chatId}`);
          });
          return;
        }

        const setSql = `
          UPDATE swap_matches
          SET swap_method = ?, updated_at = NOW()
          WHERE match_id = ?
        `;
        db.query(setSql, [pending.proposed_value, cm.match_id], (sErr) => {
          if (sErr) {
            console.error('postRespondSwapMethod set swap_method error:', sErr);
            req.flash('error_msg', 'Accepted, but failed to save swap method.');
            return res.redirect(`/chats/${chatId}`);
          }

          const nice = pending.proposed_value === 'sahm' ? 'SAHM' : 'Meetup';
          insertSystemMessage(db, chatId, userId, `[SYSTEM] Swap method confirmed: ${nice}.`, () => {
            req.flash('success_msg', `Swap method confirmed: ${nice}.`);
            return res.redirect(`/chats/${chatId}`);
          });
        });
      });
    });
  });
};

exports.postCounterSwapMethod = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const counterValue = (req.body.counter_value || '').trim();

  if (!chatId || !['meetup', 'sahm'].includes(counterValue)) {
    req.flash('error_msg', 'Invalid counter offer.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postCounterSwapMethod getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.swap_method) {
      req.flash('error_msg', 'Swap method already confirmed.');
      return res.redirect(`/chats/${chatId}`);
    }

    const otherUserId = (Number(userId) === Number(cm.user1_id)) ? cm.user2_id : cm.user1_id;

    const pendingSql = `
      SELECT *
      FROM swap_confirmations
      WHERE match_id = ? AND type = 'swap_method' AND status = 'pending'
      ORDER BY offer_round DESC
      LIMIT 1
    `;
    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error('postCounterSwapMethod pending error:', pErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (!pRows || pRows.length === 0) {
        req.flash('error_msg', 'No pending proposal to counter.');
        return res.redirect(`/chats/${chatId}`);
      }

      const pending = pRows[0];

      if (Number(pending.offer_round) !== 0) {
        req.flash('error_msg', 'Counter offer already used. Only accept/reject now.');
        return res.redirect(`/chats/${chatId}`);
      }

      if (pending.proposed_to_user_id && Number(pending.proposed_to_user_id) !== Number(userId)) {
        req.flash('error_msg', 'You cannot counter this proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const cancelOriginal = `
        UPDATE swap_confirmations
        SET status = 'cancelled', responded_by_user_id = ?, responded_at = NOW()
        WHERE confirmation_id = ?
      `;
      db.query(cancelOriginal, [userId, pending.confirmation_id], (cErr) => {
        if (cErr) {
          console.error('postCounterSwapMethod cancel original error:', cErr);
          req.flash('error_msg', 'Failed to counter offer.');
          return res.redirect(`/chats/${chatId}`);
        }

        const nice = counterValue === 'sahm' ? 'SAHM' : 'Meetup';

        const findRound1 = `
          SELECT confirmation_id
          FROM swap_confirmations
          WHERE match_id = ? AND type = 'swap_method' AND offer_round = 1
          LIMIT 1
        `;
        db.query(findRound1, [cm.match_id], (fErr, fRows) => {
          if (fErr) {
            console.error('postCounterSwapMethod find round1 error:', fErr);
            req.flash('error_msg', 'Server error.');
            return res.redirect(`/chats/${chatId}`);
          }

          const afterWrite = () => {
            insertSystemMessage(db, chatId, userId, `[SYSTEM] Counter-offer proposed: ${nice}.`, () => {
              req.flash('success_msg', 'Counter-offer sent.');
              return res.redirect(`/chats/${chatId}`);
            });
          };

          if (!fRows || fRows.length === 0) {
            const ins = `
              INSERT INTO swap_confirmations
                (match_id, type, offer_round, proposed_by_user_id, proposed_to_user_id, proposed_value, status, counter_of_confirmation_id, created_at)
              VALUES
                (?, 'swap_method', 1, ?, ?, ?, 'pending', ?, NOW())
            `;
            return db.query(ins, [cm.match_id, userId, otherUserId, counterValue, pending.confirmation_id], (iErr) => {
              if (iErr) {
                console.error('postCounterSwapMethod insert round1 error:', iErr);
                req.flash('error_msg', 'Failed to create counter offer.');
                return res.redirect(`/chats/${chatId}`);
              }
              return afterWrite();
            });
          }

          const upd = `
            UPDATE swap_confirmations
            SET
              proposed_by_user_id = ?,
              proposed_to_user_id = ?,
              proposed_value = ?,
              status = 'pending',
              responded_by_user_id = NULL,
              responded_at = NULL,
              counter_of_confirmation_id = ?,
              created_at = NOW()
            WHERE match_id = ? AND type = 'swap_method' AND offer_round = 1
          `;
          db.query(upd, [userId, otherUserId, counterValue, pending.confirmation_id, cm.match_id], (uErr) => {
            if (uErr) {
              console.error('postCounterSwapMethod update round1 error:', uErr);
              req.flash('error_msg', 'Failed to update counter offer.');
              return res.redirect(`/chats/${chatId}`);
            }
            return afterWrite();
          });
        });
      });
    });
  });
};


exports.postAddChatLocation = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);

  const label = (req.body.label || '').trim();
  const addressLine = (req.body.address_line || '').trim();
  const city = (req.body.city || '').trim();
  const postalCodeRaw = (req.body.postal_code || '').trim();

  if (!chatId) {
    req.flash('error_msg', 'Invalid chat.');
    return res.redirect('/swap/matches');
  }
  if (!label) {
    req.flash('error_msg', 'Label is required.');
    return res.redirect(`/chats/${chatId}?open=location`);
  }

  // Ensure user belongs to this chat
  const verifySql = `
    SELECT c.chat_id
    FROM chats c
    JOIN swap_matches sm ON c.match_id = sm.match_id
    WHERE c.chat_id = ?
      AND (sm.user1_id = ? OR sm.user2_id = ?)
    LIMIT 1
  `;
  db.query(verifySql, [chatId, userId, userId], (vErr, vRows) => {
    if (vErr) {
      console.error('postAddChatLocation verify error:', vErr);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }
    if (!vRows || vRows.length === 0) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    const insSql = `
      INSERT INTO locations (user_id, label, address_line, city, postal_code)
      VALUES (?, ?, ?, ?, ?)
    `;
    const postalCode = postalCodeRaw || null;

    db.query(insSql, [userId, label, addressLine || null, city || null, postalCode], (iErr, iRes) => {
      if (iErr) {
        console.error('postAddChatLocation insert error:', iErr);
        req.flash('error_msg', 'Failed to add location.');
        return res.redirect(`/chats/${chatId}?open=location`);
      }

      const newLocId = Number(iRes.insertId || 0);
      const postal = normalizeSgPostal(postalCodeRaw);

      // Best-effort: fill lat/lng for new location if postal valid
      if (newLocId && postal) {
        return oneMapSearch(postal).then((coords) => {
          if (!coords) {
            req.flash('success_msg', 'Location added.');
            return res.redirect(`/chats/${chatId}?open=location`);
          }
          const upd = `UPDATE locations SET latitude = ?, longitude = ? WHERE location_id = ? AND user_id = ?`;
          db.query(upd, [coords.lat, coords.lng, newLocId, userId], (uErr) => {
            if (uErr) console.warn('postAddChatLocation lat/lng update failed:', uErr);
            req.flash('success_msg', 'Location added.');
            return res.redirect(`/chats/${chatId}?open=location`);
          });
        }).catch(() => {
          req.flash('success_msg', 'Location added.');
          return res.redirect(`/chats/${chatId}?open=location`);
        });
      }

      req.flash('success_msg', 'Location added.');
      return res.redirect(`/chats/${chatId}?open=location`);
    });
  });
};


exports.postSaveSahmAddress = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const locationId = Number(req.body.location_id);

  if (!chatId || !locationId) {
    req.flash('error_msg', 'Invalid address selection.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postSaveSahmAddress getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is locked.');
      return res.redirect(`/chats/${chatId}`);
    }

    if (cm.swap_method !== 'sahm') {
      req.flash('error_msg', 'SAHM address can only be set after confirming SAHM.');
      return res.redirect(`/chats/${chatId}`);
    }

    // Location must be accessible by user (yours or preset)
    const locCheckSql = `
      SELECT location_id
      FROM locations
      WHERE location_id = ? AND (user_id IS NULL OR user_id = ?)
      LIMIT 1
    `;

    db.query(locCheckSql, [locationId, userId], (lErr, lRows) => {
      if (lErr) {
        console.error('postSaveSahmAddress loc check error:', lErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}?open=location`);
      }
      if (!lRows || lRows.length === 0) {
        req.flash('error_msg', 'Invalid location.');
        return res.redirect(`/chats/${chatId}?open=location`);
      }

      // ✅ Force-fill lat/lng even for preset locations
      ensureLocationHasLatLng(db, locationId, (geoErr, loc) => {
        if (geoErr) {
          console.error('postSaveSahmAddress geocode error:', geoErr);
          req.flash('error_msg', 'Could not resolve location coordinates. Try again.');
          return res.redirect(`/chats/${chatId}?open=location`);
        }

        const lat = (loc?.latitude === null || loc?.latitude === undefined) ? NaN : Number(loc.latitude);
        const lng = (loc?.longitude === null || loc?.longitude === undefined) ? NaN : Number(loc.longitude);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          req.flash(
            'error_msg',
            'This location cannot be resolved. Please add a location with a valid 6-digit postal code (or a fuller address).'
          );
          return res.redirect(`/chats/${chatId}?open=location`);
        }

        const upsertSql = `
          INSERT INTO swap_delivery_addresses (match_id, user_id, location_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE location_id = VALUES(location_id)
        `;

        db.query(upsertSql, [cm.match_id, userId, locationId], (uErr) => {
          if (uErr) {
            console.error('postSaveSahmAddress upsert error:', uErr);
            req.flash('error_msg', 'Failed to save address.');
            return res.redirect(`/chats/${chatId}?open=location`);
          }

          insertSystemMessage(db, chatId, userId, `[SYSTEM] SAHM address saved.`, () => {
            const cntSql = `SELECT COUNT(*) AS cnt FROM swap_delivery_addresses WHERE match_id = ?`;
            db.query(cntSql, [cm.match_id], (cErr, cRows) => {
              if (cErr) {
                console.error('postSaveSahmAddress count error:', cErr);
                req.flash('success_msg', 'Address saved.');
                return res.redirect(`/chats/${chatId}`);
              }

              const cnt = Number(cRows?.[0]?.cnt || 0);

              if (cnt >= 2) {
                return computeAndUpsertSahmFees(
                  db,
                  cm.match_id,
                  cm.user1_id,
                  cm.user2_id,
                  chatId,
                  userId,
                  (feeErr, feeRes) => {
                    if (feeErr) {
                      console.error('postSaveSahmAddress fee calc error:', feeErr);
                      req.flash('success_msg', 'Address saved. (Fee calculation failed—check locations.)');
                      return res.redirect(`/chats/${chatId}`);
                    }

                    if (!feeRes?.ok) {
                      const msg =
                        feeRes?.reason === 'missing_coords'
                          ? 'Address saved. (Unable to calculate fee—missing coordinates. Ensure postal code/address is valid.)'
                          : 'Address saved.';
                      req.flash('success_msg', msg);
                      return res.redirect(`/chats/${chatId}`);
                    }

                    req.flash('success_msg', `SAHM fee calculated. Total: $${Number(feeRes.totalFee || 0).toFixed(2)}.`);
                    return res.redirect(`/chats/${chatId}`);
                  }
                );
              }

              req.flash('success_msg', 'SAHM address saved.');
              return res.redirect(`/chats/${chatId}`);
            });
          });
        });
      });
    });
  });
};





exports.postProposeMeetupLocation = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const locationId = Number(req.body.location_id);

  if (!chatId || !locationId) {
    req.flash('error_msg', 'Invalid meetup location proposal.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postProposeMeetupLocation getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.swap_method !== 'meetup') {
      req.flash('error_msg', 'Meetup location can only be proposed after confirming Meetup.');
      return res.redirect(`/chats/${chatId}`);
    }

    const pendingSql = `
      SELECT confirmation_id
      FROM swap_confirmations
      WHERE match_id = ? AND type = 'locations' AND status = 'pending'
      LIMIT 1
    `;
    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error('postProposeMeetupLocation pending check error:', pErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (pRows && pRows.length > 0) {
        req.flash('error_msg', 'There is already a pending location proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const otherUserId = (Number(userId) === Number(cm.user1_id)) ? cm.user2_id : cm.user1_id;

      const locCheckSql = `
        SELECT location_id, label
        FROM locations
        WHERE location_id = ? AND (user_id IS NULL OR user_id = ?)
        LIMIT 1
      `;
      db.query(locCheckSql, [locationId, userId], (lErr, lRows) => {
        if (lErr) {
          console.error('postProposeMeetupLocation loc check error:', lErr);
          req.flash('error_msg', 'Server error.');
          return res.redirect(`/chats/${chatId}?open=location`);
        }
        if (!lRows || lRows.length === 0) {
          req.flash('error_msg', 'Invalid location.');
          return res.redirect(`/chats/${chatId}?open=location`);
        }
        const locLabel = lRows[0].label;

        const findRound0 = `
          SELECT confirmation_id
          FROM swap_confirmations
          WHERE match_id = ? AND type = 'locations' AND offer_round = 0
          LIMIT 1
        `;
        db.query(findRound0, [cm.match_id], (fErr, fRows) => {
          if (fErr) {
            console.error('postProposeMeetupLocation find round0 error:', fErr);
            req.flash('error_msg', 'Server error.');
            return res.redirect(`/chats/${chatId}`);
          }

          const afterWrite = () => {
            insertSystemMessage(db, chatId, userId, `[SYSTEM] Meetup location proposed: ${locLabel}.`, () => {
              req.flash('success_msg', 'Meetup location proposal sent.');
              return res.redirect(`/chats/${chatId}`);
            });
          };

          if (!fRows || fRows.length === 0) {
            const insSql = `
              INSERT INTO swap_confirmations
                (match_id, type, offer_round, proposed_by_user_id, proposed_to_user_id, proposed_value, status, created_at)
              VALUES
                (?, 'locations', 0, ?, ?, ?, 'pending', NOW())
            `;
            return db.query(insSql, [cm.match_id, userId, otherUserId, String(locationId)], (iErr) => {
              if (iErr) {
                console.error('postProposeMeetupLocation insert round0 error:', iErr);
                req.flash('error_msg', 'Failed to create proposal.');
                return res.redirect(`/chats/${chatId}`);
              }
              return afterWrite();
            });
          }

          const updSql = `
            UPDATE swap_confirmations
            SET
              proposed_by_user_id = ?,
              proposed_to_user_id = ?,
              proposed_value = ?,
              status = 'pending',
              responded_by_user_id = NULL,
              responded_at = NULL,
              counter_of_confirmation_id = NULL,
              created_at = NOW()
            WHERE match_id = ? AND type = 'locations' AND offer_round = 0
          `;
          db.query(updSql, [userId, otherUserId, String(locationId), cm.match_id], (uErr) => {
            if (uErr) {
              console.error('postProposeMeetupLocation update round0 error:', uErr);
              req.flash('error_msg', 'Failed to update proposal.');
              return res.redirect(`/chats/${chatId}`);
            }

            const resetRound1 = `
              UPDATE swap_confirmations
              SET status = 'cancelled'
              WHERE match_id = ? AND type = 'locations' AND offer_round = 1 AND status = 'pending'
            `;
            db.query(resetRound1, [cm.match_id], () => afterWrite());
          });
        });
      });
    });
  });
};

exports.postRespondMeetupLocation = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const action = (req.body.action || '').trim();

  if (!chatId || !['accept', 'reject'].includes(action)) {
    req.flash('error_msg', 'Invalid response.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postRespondMeetupLocation getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.swap_method !== 'meetup') {
      req.flash('error_msg', 'This swap is not Meetup.');
      return res.redirect(`/chats/${chatId}`);
    }

    const pendingSql = `
      SELECT *
      FROM swap_confirmations
      WHERE match_id = ? AND type = 'locations' AND status = 'pending'
      ORDER BY offer_round DESC
      LIMIT 1
    `;
    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error('postRespondMeetupLocation pending error:', pErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (!pRows || pRows.length === 0) {
        req.flash('error_msg', 'No pending meetup location proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const pending = pRows[0];
      if (pending.proposed_to_user_id && Number(pending.proposed_to_user_id) !== Number(userId)) {
        req.flash('error_msg', 'You cannot respond to this proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const newStatus = action === 'accept' ? 'accepted' : 'rejected';
      const updConfirmSql = `
        UPDATE swap_confirmations
        SET status = ?, responded_by_user_id = ?, responded_at = NOW()
        WHERE confirmation_id = ?
      `;
      db.query(updConfirmSql, [newStatus, userId, pending.confirmation_id], (uErr) => {
        if (uErr) {
          console.error('postRespondMeetupLocation update confirmation error:', uErr);
          req.flash('error_msg', 'Failed to update response.');
          return res.redirect(`/chats/${chatId}`);
        }

        if (newStatus !== 'accepted') {
          return insertSystemMessage(db, chatId, userId, `[SYSTEM] Meetup location proposal was rejected.`, () => {
            req.flash('success_msg', 'Response saved.');
            return res.redirect(`/chats/${chatId}`);
          });
        }

        const setSql = `
          UPDATE swap_matches
          SET meetup_location_id = ?, updated_at = NOW()
          WHERE match_id = ?
        `;
        const acceptedLocId = Number(pending.proposed_value);

        db.query(setSql, [acceptedLocId, cm.match_id], (sErr) => {
          if (sErr) {
            console.error('postRespondMeetupLocation set meetup_location_id error:', sErr);
            req.flash('error_msg', 'Accepted, but failed to save meetup location.');
            return res.redirect(`/chats/${chatId}`);
          }

          const locSql = `SELECT label FROM locations WHERE location_id = ? LIMIT 1`;
          db.query(locSql, [acceptedLocId], (lErr, lRows) => {
            const locLabel = (!lErr && lRows && lRows[0]) ? lRows[0].label : 'selected location';
            return insertSystemMessage(db, chatId, userId, `[SYSTEM] Meetup location confirmed: ${locLabel}.`, () => {
              req.flash('success_msg', 'Meetup location confirmed.');
              return res.redirect(`/chats/${chatId}`);
            });
          });
        });
      });
    });
  });
};

exports.postCounterMeetupLocation = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const counterLocationId = Number(req.body.counter_location_id);

  if (!chatId || !counterLocationId) {
    req.flash('error_msg', 'Invalid counter offer.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postCounterMeetupLocation getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/swap/matches');
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.swap_method !== 'meetup') {
      req.flash('error_msg', 'This swap is not Meetup.');
      return res.redirect(`/chats/${chatId}`);
    }

    const otherUserId = (Number(userId) === Number(cm.user1_id)) ? cm.user2_id : cm.user1_id;

    const pendingSql = `
      SELECT *
      FROM swap_confirmations
      WHERE match_id = ? AND type = 'locations' AND status = 'pending'
      ORDER BY offer_round DESC
      LIMIT 1
    `;
    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error('postCounterMeetupLocation pending error:', pErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (!pRows || pRows.length === 0) {
        req.flash('error_msg', 'No pending proposal to counter.');
        return res.redirect(`/chats/${chatId}`);
      }

      const pending = pRows[0];
      if (Number(pending.offer_round) !== 0) {
        req.flash('error_msg', 'Counter offer already used. Only accept/reject now.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (pending.proposed_to_user_id && Number(pending.proposed_to_user_id) !== Number(userId)) {
        req.flash('error_msg', 'You cannot counter this proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const locCheckSql = `
        SELECT location_id, label
        FROM locations
        WHERE location_id = ? AND (user_id IS NULL OR user_id = ?)
        LIMIT 1
      `;
      db.query(locCheckSql, [counterLocationId, userId], (lErr, lRows) => {
        if (lErr) {
          console.error('postCounterMeetupLocation loc check error:', lErr);
          req.flash('error_msg', 'Server error.');
          return res.redirect(`/chats/${chatId}?open=location`);
        }
        if (!lRows || lRows.length === 0) {
          req.flash('error_msg', 'Invalid location.');
          return res.redirect(`/chats/${chatId}?open=location`);
        }
        const locLabel = lRows[0].label;

        const cancelOriginal = `
          UPDATE swap_confirmations
          SET status = 'cancelled', responded_by_user_id = ?, responded_at = NOW()
          WHERE confirmation_id = ?
        `;
        db.query(cancelOriginal, [userId, pending.confirmation_id], (cErr) => {
          if (cErr) {
            console.error('postCounterMeetupLocation cancel original error:', cErr);
            req.flash('error_msg', 'Failed to counter offer.');
            return res.redirect(`/chats/${chatId}`);
          }

          const afterWrite = () => {
            insertSystemMessage(db, chatId, userId, `[SYSTEM] Meetup location counter-proposed: ${locLabel}.`, () => {
              req.flash('success_msg', 'Counter offer sent.');
              return res.redirect(`/chats/${chatId}`);
            });
          };

          const findRound1 = `
            SELECT confirmation_id
            FROM swap_confirmations
            WHERE match_id = ? AND type = 'locations' AND offer_round = 1
            LIMIT 1
          `;
          db.query(findRound1, [cm.match_id], (fErr, fRows) => {
            if (fErr) {
              console.error('postCounterMeetupLocation find round1 error:', fErr);
              req.flash('error_msg', 'Server error.');
              return res.redirect(`/chats/${chatId}`);
            }

            if (!fRows || fRows.length === 0) {
              const ins = `
                INSERT INTO swap_confirmations
                  (match_id, type, offer_round, proposed_by_user_id, proposed_to_user_id, proposed_value, status, counter_of_confirmation_id, created_at)
                VALUES
                  (?, 'locations', 1, ?, ?, ?, 'pending', ?, NOW())
              `;
              return db.query(ins, [cm.match_id, userId, otherUserId, String(counterLocationId), pending.confirmation_id], (iErr) => {
                if (iErr) {
                  console.error('postCounterMeetupLocation insert round1 error:', iErr);
                  req.flash('error_msg', 'Failed to create counter offer.');
                  return res.redirect(`/chats/${chatId}`);
                }
                return afterWrite();
              });
            }

            const upd = `
              UPDATE swap_confirmations
              SET
                proposed_by_user_id = ?,
                proposed_to_user_id = ?,
                proposed_value = ?,
                status = 'pending',
                responded_by_user_id = NULL,
                responded_at = NULL,
                counter_of_confirmation_id = ?,
                created_at = NOW()
              WHERE match_id = ? AND type = 'locations' AND offer_round = 1
            `;
            db.query(upd, [userId, otherUserId, String(counterLocationId), pending.confirmation_id, cm.match_id], (uErr) => {
              if (uErr) {
                console.error('postCounterMeetupLocation update round1 error:', uErr);
                req.flash('error_msg', 'Failed to update counter offer.');
                return res.redirect(`/chats/${chatId}`);
              }
              return afterWrite();
            });
          });
        });
      });
    });
  });
};

exports.postProposePaymentSplit = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const choice = (req.body.choice || '').trim(); // split | i_pay

  if (!chatId) {
    req.flash('error_msg', 'Invalid chat.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postProposePaymentSplit getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.swap_method !== 'sahm') {
      req.flash('error_msg', 'Payment split is only needed for SAHM.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.payment_split) {
      req.flash('error_msg', 'Payment split already confirmed.');
      return res.redirect(`/chats/${chatId}`);
    }

    // Fee must exist
    const feeSql = `SELECT delivery_fee FROM pickup_delivery_requests WHERE match_id = ?`;
    db.query(feeSql, [cm.match_id], (fErr, fRows) => {
      if (fErr) {
        console.error('postProposePaymentSplit feeSql error:', fErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }

      const total = (fRows || [])
        .map(r => Number(r.delivery_fee))
        .filter(v => Number.isFinite(v))
        .reduce((a, b) => a + b, 0);

      if (!Number.isFinite(total) || total <= 0) {
        req.flash('error_msg', 'Fee not ready yet. Save both SAHM addresses first.');
        return res.redirect(`/chats/${chatId}`);
      }

      const proposedEnum = mapUiChoiceToEnum(choice, userId, cm.user1_id, cm.user2_id);
      if (!proposedEnum) {
        req.flash('error_msg', 'Invalid payment split choice.');
        return res.redirect(`/chats/${chatId}`);
      }

      const otherUserId = (Number(cm.user1_id) === Number(userId)) ? cm.user2_id : cm.user1_id;

      // block if pending exists
      const pendingSql = `
        SELECT confirmation_id
        FROM swap_confirmations
        WHERE match_id = ? AND type = 'payment_split' AND status = 'pending'
        LIMIT 1
      `;
      db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
        if (pErr) {
          console.error('postProposePaymentSplit pendingSql error:', pErr);
          req.flash('error_msg', 'Server error.');
          return res.redirect(`/chats/${chatId}`);
        }
        if (pRows && pRows.length > 0) {
          req.flash('error_msg', 'There is already a pending payment split proposal.');
          return res.redirect(`/chats/${chatId}`);
        }

        // round 0 create/update
        const findRound0 = `
          SELECT confirmation_id
          FROM swap_confirmations
          WHERE match_id = ? AND type = 'payment_split' AND offer_round = 0
          LIMIT 1
        `;
        db.query(findRound0, [cm.match_id], (rErr, rRows) => {
          if (rErr) {
            console.error('postProposePaymentSplit findRound0 error:', rErr);
            req.flash('error_msg', 'Server error.');
            return res.redirect(`/chats/${chatId}`);
          }

          const afterWrite = () => {
            insertSystemMessage(
              db,
              chatId,
              userId,
              `[SYSTEM] Payment split proposed: ${proposedEnum}.`,
              () => res.redirect(`/chats/${chatId}`)
            );
          };

          if (!rRows || rRows.length === 0) {
            const ins = `
              INSERT INTO swap_confirmations
                (match_id, type, offer_round, proposed_by_user_id, proposed_to_user_id, proposed_value, status, created_at)
              VALUES
                (?, 'payment_split', 0, ?, ?, ?, 'pending', NOW())
            `;
            return db.query(ins, [cm.match_id, userId, otherUserId, proposedEnum], (iErr) => {
              if (iErr) {
                console.error('postProposePaymentSplit insert error:', iErr);
                req.flash('error_msg', 'Failed to create proposal.');
                return res.redirect(`/chats/${chatId}`);
              }
              return afterWrite();
            });
          }

          const upd = `
            UPDATE swap_confirmations
            SET
              proposed_by_user_id = ?,
              proposed_to_user_id = ?,
              proposed_value = ?,
              status = 'pending',
              responded_by_user_id = NULL,
              responded_at = NULL,
              counter_of_confirmation_id = NULL,
              created_at = NOW()
            WHERE match_id = ? AND type = 'payment_split' AND offer_round = 0
          `;
          db.query(upd, [userId, otherUserId, proposedEnum, cm.match_id], (uErr) => {
            if (uErr) {
              console.error('postProposePaymentSplit update error:', uErr);
              req.flash('error_msg', 'Failed to update proposal.');
              return res.redirect(`/chats/${chatId}`);
            }

            // cancel any stale round1 pending
            const resetRound1 = `
              UPDATE swap_confirmations
              SET status = 'cancelled'
              WHERE match_id = ? AND type = 'payment_split' AND offer_round = 1 AND status = 'pending'
            `;
            db.query(resetRound1, [cm.match_id], () => afterWrite());
          });
        });
      });
    });
  });
};


exports.postRespondPaymentSplit = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const action = (req.body.action || '').trim(); // accept | reject

  if (!chatId || !['accept', 'reject'].includes(action)) {
    req.flash('error_msg', 'Invalid response.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postRespondPaymentSplit getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.payment_split) {
      req.flash('error_msg', 'Payment split already confirmed.');
      return res.redirect(`/chats/${chatId}`);
    }

    const pendingSql = `
      SELECT *
      FROM swap_confirmations
      WHERE match_id = ? AND type = 'payment_split' AND status = 'pending'
      ORDER BY offer_round DESC
      LIMIT 1
    `;
    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error('postRespondPaymentSplit pendingSql error:', pErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (!pRows || pRows.length === 0) {
        req.flash('error_msg', 'No pending payment split proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const pending = pRows[0];

      if (pending.proposed_to_user_id && Number(pending.proposed_to_user_id) !== Number(userId)) {
        req.flash('error_msg', 'You cannot respond to this proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const newStatus = action === 'accept' ? 'accepted' : 'rejected';

      const updConfirm = `
        UPDATE swap_confirmations
        SET status = ?, responded_by_user_id = ?, responded_at = NOW()
        WHERE confirmation_id = ?
      `;
      db.query(updConfirm, [newStatus, userId, pending.confirmation_id], (uErr) => {
        if (uErr) {
          console.error('postRespondPaymentSplit updConfirm error:', uErr);
          req.flash('error_msg', 'Failed to save response.');
          return res.redirect(`/chats/${chatId}`);
        }

        if (newStatus !== 'accepted') {
          return insertSystemMessage(
            db,
            chatId,
            userId,
            `[SYSTEM] Payment split proposal was rejected.`,
            () => res.redirect(`/chats/${chatId}`)
          );
        }

        // accepted -> write to swap_matches.payment_split
        const setSql = `
          UPDATE swap_matches
          SET payment_split = ?, updated_at = NOW()
          WHERE match_id = ?
        `;
        db.query(setSql, [pending.proposed_value, cm.match_id], (sErr) => {
          if (sErr) {
            console.error('postRespondPaymentSplit setSql error:', sErr);
            req.flash('error_msg', 'Accepted, but failed to save payment split.');
            return res.redirect(`/chats/${chatId}`);
          }

          return insertSystemMessage(
            db,
            chatId,
            userId,
            `[SYSTEM] Payment split confirmed: ${pending.proposed_value}.`,
            () => res.redirect(`/chats/${chatId}?open=paymentSplit`) // open modal right after confirm
          );
        });
      });
    });
  });
};


exports.postCounterPaymentSplit = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const chatId = Number(req.params.chatId);
  const choice = (req.body.choice || '').trim(); // split | i_pay

  if (!chatId) {
    req.flash('error_msg', 'Invalid chat.');
    return res.redirect('/swap/matches');
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postCounterPaymentSplit getChatAndMatch error:', err);
      req.flash('error_msg', 'Server error.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (!cm) {
      req.flash('error_msg', 'Access denied.');
      return res.redirect('/swap/matches');
    }

    if (Number(cm.details_locked) === 1) {
      req.flash('error_msg', 'This swap is already locked.');
      return res.redirect(`/chats/${chatId}`);
    }
    if (cm.payment_split) {
      req.flash('error_msg', 'Payment split already confirmed.');
      return res.redirect(`/chats/${chatId}`);
    }

    const proposedEnum = mapUiChoiceToEnum(choice, userId, cm.user1_id, cm.user2_id);
    if (!proposedEnum) {
      req.flash('error_msg', 'Invalid counter offer.');
      return res.redirect(`/chats/${chatId}`);
    }

    const pendingSql = `
      SELECT *
      FROM swap_confirmations
      WHERE match_id = ? AND type = 'payment_split' AND status = 'pending'
      ORDER BY offer_round DESC
      LIMIT 1
    `;
    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error('postCounterPaymentSplit pendingSql error:', pErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (!pRows || pRows.length === 0) {
        req.flash('error_msg', 'No pending payment split proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      const pending = pRows[0];

      if (Number(pending.offer_round) !== 0) {
        req.flash('error_msg', 'Counter offer already used once.');
        return res.redirect(`/chats/${chatId}`);
      }
      if (pending.proposed_to_user_id && Number(pending.proposed_to_user_id) !== Number(userId)) {
        req.flash('error_msg', 'You cannot counter this proposal.');
        return res.redirect(`/chats/${chatId}`);
      }

      // ✅ Don't allow a counter that's identical to the pending offer (no-op counter)
      if (String(pending.proposed_value) === String(proposedEnum)) {
        req.flash('error_msg', 'That offer is already the current proposal. Please counter with a different option.');
        return res.redirect(`/chats/${chatId}?open=paymentSplit`);
      }


      const otherUserId = (Number(cm.user1_id) === Number(userId)) ? cm.user2_id : cm.user1_id;

      // cancel round0
      const cancelRound0 = `
        UPDATE swap_confirmations
        SET status = 'cancelled', responded_by_user_id = ?, responded_at = NOW()
        WHERE confirmation_id = ?
      `;
      db.query(cancelRound0, [userId, pending.confirmation_id], () => {
        const findRound1 = `
          SELECT confirmation_id
          FROM swap_confirmations
          WHERE match_id = ? AND type = 'payment_split' AND offer_round = 1
          LIMIT 1
        `;
        db.query(findRound1, [cm.match_id], (fErr, fRows) => {
          if (fErr) {
            console.error('postCounterPaymentSplit findRound1 error:', fErr);
            req.flash('error_msg', 'Server error.');
            return res.redirect(`/chats/${chatId}`);
          }

          const afterWrite = () => {
            insertSystemMessage(
              db,
              chatId,
              userId,
              `[SYSTEM] Counter payment split proposed: ${proposedEnum}.`,
              () => res.redirect(`/chats/${chatId}`)
            );
          };

          if (!fRows || fRows.length === 0) {
            const ins = `
              INSERT INTO swap_confirmations
                (match_id, type, offer_round, proposed_by_user_id, proposed_to_user_id, proposed_value, status, counter_of_confirmation_id, created_at)
              VALUES
                (?, 'payment_split', 1, ?, ?, ?, 'pending', ?, NOW())
            `;
            return db.query(ins, [cm.match_id, userId, otherUserId, proposedEnum, pending.confirmation_id], (iErr) => {
              if (iErr) {
                console.error('postCounterPaymentSplit insert error:', iErr);
                req.flash('error_msg', 'Failed to create counter offer.');
                return res.redirect(`/chats/${chatId}`);
              }
              return afterWrite();
            });
          }

          const upd = `
            UPDATE swap_confirmations
            SET
              proposed_by_user_id = ?,
              proposed_to_user_id = ?,
              proposed_value = ?,
              status = 'pending',
              responded_by_user_id = NULL,
              responded_at = NULL,
              counter_of_confirmation_id = ?,
              created_at = NOW()
            WHERE match_id = ? AND type = 'payment_split' AND offer_round = 1
          `;
          db.query(upd, [userId, otherUserId, proposedEnum, pending.confirmation_id, cm.match_id], (uErr) => {
            if (uErr) {
              console.error('postCounterPaymentSplit update error:', uErr);
              req.flash('error_msg', 'Failed to update counter offer.');
              return res.redirect(`/chats/${chatId}`);
            }
            return afterWrite();
          });
        });
      });
    });
  });
};

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

async function paypalCreateOrder(amount, currency, meta = {}) {
  const token = await getPayPalAccessToken();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: currency,
          value: amount.toFixed(2)
        },
        custom_id: meta.custom_id || undefined,
        description: meta.description || undefined
      }
    ]
  };

  const resp = await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`PayPal create order error: ${JSON.stringify(json)}`);
  return json; // includes id
}

async function paypalCaptureOrder(orderId) {
  const token = await getPayPalAccessToken();

  const resp = await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`PayPal capture error: ${JSON.stringify(json)}`);
  return json;
}

exports.postPayPalCreateOrder = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);

  if (!chatId) return res.status(400).json({ ok: false, error: 'Invalid chat' });

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postPayPalCreateOrder getChatAndMatch error:', err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
    if (!cm) return res.status(403).json({ ok: false, error: 'Access denied' });

    return isFrozenByHelpCase(db, cm.match_id, (fErr, frozen) => {
      if (fErr) {
        console.error('postPayPalCreateOrder freeze check error:', fErr);
        return res.status(500).json({ ok: false, error: 'Server error' });
      }
      if (frozen) {
        return res.status(423).json({ ok: false, error: 'Actions are under admin review. Payment is temporarily disabled.' });
      }

      if (cm.swap_method !== 'sahm') return res.status(400).json({ ok: false, error: 'Not SAHM' });
      if (!cm.payment_split) return res.status(400).json({ ok: false, error: 'Payment split not confirmed' });

      const feeSql = `SELECT delivery_fee FROM pickup_delivery_requests WHERE match_id = ?`;
      db.query(feeSql, [cm.match_id], async (fErr2, fRows) => {
        if (fErr2) {
          console.error('postPayPalCreateOrder feeSql error:', fErr2);
          return res.status(500).json({ ok: false, error: 'Server error' });
        }

        const total = (fRows || [])
          .map(r => Number(r.delivery_fee))
          .filter(v => Number.isFinite(v))
          .reduce((a, b) => a + b, 0);

        if (!Number.isFinite(total) || total <= 0) {
          return res.status(400).json({ ok: false, error: 'Fee not ready' });
        }

        const amounts = computeSplitAmounts(total, Number(cm.user1_id), Number(cm.user2_id), cm.payment_split);
        const amount = round2(amounts[userId] || 0);

        if (amount <= 0) {
          return res.status(400).json({ ok: false, error: 'You do not need to pay' });
        }

        const existingSql = `
          SELECT status, provider_order_id
          FROM swap_payments
          WHERE match_id = ? AND payer_user_id = ?
          LIMIT 1
        `;
        db.query(existingSql, [cm.match_id, userId], async (eErr, eRows) => {
          if (eErr) {
            console.error('postPayPalCreateOrder existingSql error:', eErr);
            return res.status(500).json({ ok: false, error: 'Server error' });
          }
          if (eRows && eRows[0] && eRows[0].status === 'captured') {
            return res.status(409).json({ ok: false, error: 'Already paid' });
          }

          return requirePaymentOtpVerified(db, cm.match_id, userId, amount, async (oErr, okOtp) => {
            if (oErr) {
              console.error('postPayPalCreateOrder OTP check error:', oErr);
              return res.status(500).json({ ok: false, error: 'Server error' });
            }
            if (!okOtp) {
              return res.status(403).json({ ok: false, error: 'Secure Pay Verification required' });
            }

            try {
              const currency = (process.env.PAYPAL_CURRENCY || 'SGD').toUpperCase();
              const order = await paypalCreateOrder(amount, currency, {
                custom_id: `match:${cm.match_id}|payer:${userId}`,
                description: `SAHM delivery fee (match ${cm.match_id})`
              });

              const upsert = `
                INSERT INTO swap_payments
                  (match_id, payer_user_id, amount, status, provider_order_id, created_at, updated_at)
                VALUES
                  (?, ?, ?, 'created', ?, NOW(), NOW())
                ON DUPLICATE KEY UPDATE
                  amount = VALUES(amount),
                  status = 'created',
                  provider_order_id = VALUES(provider_order_id),
                  updated_at = NOW()
              `;
              db.query(upsert, [cm.match_id, userId, amount, order.id], (uErr) => {
                if (uErr) {
                  console.error('postPayPalCreateOrder upsert error:', uErr);
                  return res.status(500).json({ ok: false, error: 'DB error' });
                }
                return res.json({ ok: true, orderID: order.id });
              });
            } catch (ex) {
              console.error('postPayPalCreateOrder paypal error:', ex);
              return res.status(500).json({ ok: false, error: 'PayPal create failed' });
            }
          });
        });
      });
    });
  });
};


exports.postPayPalCaptureOrder = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);
  const orderId = String(req.body.orderID || '').trim();

  if (!chatId || !orderId) return res.status(400).json({ ok: false, error: 'Invalid request' });

  // Small promise helpers so we don't get stuck in nested callbacks
  const q = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  const getChatAndMatchP = () =>
    new Promise((resolve, reject) => {
      getChatAndMatch(db, chatId, userId, (err, cm) => (err ? reject(err) : resolve(cm)));
    });

  const isFrozenP = (matchId) =>
    new Promise((resolve, reject) => {
      isFrozenByHelpCase(db, matchId, (err, frozen) => (err ? reject(err) : resolve(!!frozen)));
    });

  const otpVerifiedP = (matchId, expectedAmount) =>
    new Promise((resolve, reject) => {
      requirePaymentOtpVerified(db, matchId, userId, expectedAmount, (err, ok) =>
        err ? reject(err) : resolve(!!ok)
      );
    });

  const withTimeout = (p, ms, msg = 'Timeout') =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
    ]);

  (async () => {
    try {
      const cm = await getChatAndMatchP();
      if (!cm) return res.status(403).json({ ok: false, error: 'Access denied' });

      const frozen = await isFrozenP(cm.match_id);
      if (frozen) {
        return res.status(423).json({ ok: false, error: 'Actions are under admin review. Payment is temporarily disabled.' });
      }

      if (cm.swap_method !== 'sahm') return res.status(400).json({ ok: false, error: 'Not SAHM' });
      if (!cm.payment_split) return res.status(400).json({ ok: false, error: 'Payment split not confirmed' });

      // Compute how much THIS user must pay
      const feeRows = await q(`SELECT delivery_fee FROM pickup_delivery_requests WHERE match_id = ?`, [cm.match_id]);
      const total = (feeRows || [])
        .map(r => Number(r.delivery_fee))
        .filter(v => Number.isFinite(v))
        .reduce((a, b) => a + b, 0);

      if (!Number.isFinite(total) || total <= 0) {
        return res.status(400).json({ ok: false, error: 'Fee not ready' });
      }

      const amounts = computeSplitAmounts(total, Number(cm.user1_id), Number(cm.user2_id), cm.payment_split);
      const amount = round2(amounts[userId] || 0);

      if (amount <= 0) return res.status(400).json({ ok: false, error: 'You do not need to pay' });

      // Already captured?
      const existing = await q(
        `SELECT status FROM swap_payments WHERE match_id = ? AND payer_user_id = ? LIMIT 1`,
        [cm.match_id, userId]
      );
      if (existing && existing[0] && String(existing[0].status) === 'captured') {
        return res.json({ ok: true, status: 'COMPLETED', alreadyCaptured: true });
      }

      // OTP gate
      const okOtp = await otpVerifiedP(cm.match_id, amount);
      if (!okOtp) {
        return res.status(403).json({ ok: false, error: 'Secure Pay Verification required' });
      }

      // ✅ PayPal capture with a hard timeout so the request never stays pending forever
      let capture;
      try {
        capture = await withTimeout(paypalCaptureOrder(orderId), 20000, 'PayPal capture timeout');
      } catch (capErr) {
        console.error('postPayPalCaptureOrder paypalCaptureOrder error:', capErr);
        return res.status(500).json({ ok: false, error: capErr.message || 'PayPal capture failed' });
      }

      const topStatus = String(capture?.status || '').toUpperCase();
      const capObj = capture?.purchase_units?.[0]?.payments?.captures?.[0] || null;
      const capStatus = String(capObj?.status || '').toUpperCase();
      const captureId = capObj?.id || null;

      const completed = (topStatus === 'COMPLETED') || (capStatus === 'COMPLETED');
      if (!completed) {
        return res.status(400).json({
          ok: false,
          error: 'Payment not completed',
          status: topStatus || capStatus || 'UNKNOWN'
        });
      }

      if (!captureId) {
        // We must have a capture id for refunds/audit
        console.error('postPayPalCaptureOrder missing captureId:', JSON.stringify(capture, null, 2));
        return res.status(500).json({ ok: false, error: 'Capture succeeded but capture ID is missing' });
      }

      // ✅ Save captured payment (UPSERT)
      await q(
        `
        INSERT INTO swap_payments
          (match_id, payer_user_id, amount, status, provider_order_id, provider_capture_id, created_at, updated_at)
        VALUES
          (?, ?, ?, 'captured', ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          amount = VALUES(amount),
          status = 'captured',
          provider_order_id = VALUES(provider_order_id),
          provider_capture_id = VALUES(provider_capture_id),
          updated_at = NOW()
        `,
        [cm.match_id, userId, amount, orderId, captureId]
      );

      // Clear OTP + add system message (don’t block response)
      try { clearPaymentOtp(db, cm.match_id, userId, () => {}); } catch {}

      try {
        insertSystemMessage(
          db,
          chatId,
          userId,
          `[SYSTEM] Payment received via PayPal. Amount: $${amount.toFixed(2)}.`,
          () => {}
        );
      } catch {}

      // ✅ Respond immediately so the browser doesn't hang
      res.json({ ok: true, status: 'COMPLETED', captureId });

      // Receipt email (fire-and-forget — don't block the response)
      try {
        const userEmailRows = await q(`SELECT email, username FROM users WHERE user_id = ? LIMIT 1`, [userId]);
        const row = (userEmailRows && userEmailRows[0]) ? userEmailRows[0] : null;
        const toEmail = row?.email || null;
        const username = row?.username || req.session.user.username || 'there';

        if (toEmail) {
          let payerLabel = '';
          if (cm.payment_split === 'split_evenly') payerLabel = 'Split evenly';
          if (cm.payment_split === 'user1_pays_all') payerLabel = (String(cm.user1_id) === String(userId)) ? 'You paid all' : `${cm.user1_username} paid all`;
          if (cm.payment_split === 'user2_pays_all') payerLabel = (String(cm.user2_id) === String(userId)) ? 'You paid all' : `${cm.user2_username} paid all`;

          sendPayPalReceiptEmail(toEmail, {
            username,
            amount,
            currency: process.env.PAYPAL_CURRENCY || 'SGD',
            matchId: cm.match_id,
            chatId,
            orderId,
            captureId,
            payerLabel
          }).catch(e => console.error('[MAIL] Receipt email failed:', e));
        }
      } catch (mailErr) {
        console.error('[MAIL] Receipt email flow error:', mailErr);
      }

    } catch (ex) {
      console.error('postPayPalCaptureOrder fatal error:', ex);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  })();
};


// =====================================================
// HELPERS (add near your other helpers)
// =====================================================

function parseDatetimeLocalToMySql(dtLocal) {
  // Accepts: "YYYY-MM-DDTHH:MM" or "YYYY-MM-DD HH:MM" or "...:SS"
  const raw = String(dtLocal || "").trim();
  if (!raw) return null;

  let s = raw.replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s += ":00";

  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return null;
  return s;
}

function isFutureMySqlDatetime(mysqlDt, minMinutesAhead = 5) {
  // mysqlDt: "YYYY-MM-DD HH:MM:SS"
  const parts = String(mysqlDt || "").split(" ");
  if (parts.length !== 2) return false;

  const [Y, M, D] = parts[0].split("-").map(Number);
  const [h, m, s] = parts[1].split(":").map(Number);

  if (![Y, M, D, h, m, s].every(Number.isFinite)) return false;

  const d = new Date(Y, M - 1, D, h, m, s); // server local time
  const minMs = Date.now() + minMinutesAhead * 60 * 1000;
  return d.getTime() >= minMs;
}

function checkSahmPaymentComplete(dbConn, matchId, user1Id, user2Id, paymentSplitEnum, cb) {
  // Need fees
  const feeSql = `SELECT delivery_fee FROM pickup_delivery_requests WHERE match_id = ?`;
  dbConn.query(feeSql, [matchId], (fErr, fRows) => {
    if (fErr) return cb(fErr);

    const total = (fRows || [])
      .map(r => Number(r.delivery_fee))
      .filter(v => Number.isFinite(v))
      .reduce((a, b) => a + b, 0);

    if (!Number.isFinite(total) || total <= 0) return cb(null, false);

    if (!paymentSplitEnum) return cb(null, false);

    const amounts = computeSplitAmounts(
      round2(total),
      Number(user1Id),
      Number(user2Id),
      paymentSplitEnum
    );

    const requiredPayers = Object.entries(amounts)
      .filter(([_, amt]) => round2(amt) > 0)
      .map(([uid]) => Number(uid));

    if (requiredPayers.length === 0) return cb(null, true);

    const paySql = `SELECT payer_user_id, status FROM swap_payments WHERE match_id = ?`;
    dbConn.query(paySql, [matchId], (pErr, pRows) => {
      if (pErr) return cb(pErr);

      const payMap = new Map((pRows || []).map(r => [Number(r.payer_user_id), String(r.status || "")]));
      const ok = requiredPayers.every(uid => payMap.get(uid) === "captured");
      return cb(null, ok);
    });
  });
}

// =====================================================
// CONFIRM TIME (add these exports)
// =====================================================

// POST /chats/:chatId/confirm/time
exports.postProposeTime = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);

  const dt = parseDatetimeLocalToMySql(req.body.scheduled_time);
  if (!chatId) return res.redirect("/swap/matches");

  if (!dt || !isFutureMySqlDatetime(dt, 5)) {
    req.flash("error_msg", "Please choose a valid future time.");
    return res.redirect(`/chats/${chatId}?open=time`);
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error("postProposeTime getChatAndMatch error:", err);
      req.flash("error_msg", "Server error.");
      return res.redirect("/swap/matches");
    }
    if (!cm) {
      req.flash("error_msg", "Access denied.");
      return res.redirect("/swap/matches");
    }

    // must have swap method first
    if (!cm.swap_method) {
      req.flash("error_msg", "Confirm swap method first.");
      return res.redirect(`/chats/${chatId}?open=swapMethod`);
    }

    // if already locked / time already set, block
    if (Number(cm.details_locked) === 1 || cm.scheduled_time) {
      req.flash("error_msg", "Time is already confirmed.");
      return res.redirect(`/chats/${chatId}`);
    }

    // prerequisites by swap method
    if (cm.swap_method === "meetup") {
      if (!cm.meetup_location_id) {
        req.flash("error_msg", "Confirm meetup location first.");
        return res.redirect(`/chats/${chatId}?open=location`);
      }
    }

    if (cm.swap_method === "sahm") {
      if (!cm.payment_split) {
        req.flash("error_msg", "Confirm payment split first.");
        return res.redirect(`/chats/${chatId}?open=paymentSplit`);
      }

      // Require payment completion before time for SAHM
      return checkSahmPaymentComplete(
        db,
        cm.match_id,
        cm.user1_id,
        cm.user2_id,
        cm.payment_split,
        (pcErr, isComplete) => {
          if (pcErr) {
            console.error("postProposeTime checkSahmPaymentComplete error:", pcErr);
            req.flash("error_msg", "Server error.");
            return res.redirect(`/chats/${chatId}`);
          }
          if (!isComplete) {
            req.flash("error_msg", "Payment must be completed before confirming time (SAHM).");
            return res.redirect(`/chats/${chatId}?open=paymentSplit`);
          }

          return createPendingTimeOffer();
        }
      );
    }

    return createPendingTimeOffer();

    function createPendingTimeOffer() {
      const otherId = (Number(cm.user1_id) === Number(userId)) ? Number(cm.user2_id) : Number(cm.user1_id);

      // Cancel any existing pending time offers (keep it simple: 1 active thread)
      const cancelSql = `
        UPDATE swap_confirmations
        SET status = 'cancelled'
        WHERE match_id = ?
          AND type = 'scheduled_time'
          AND status = 'pending'
      `;

      db.query(cancelSql, [cm.match_id], (cErr) => {
        if (cErr) console.error("postProposeTime cancelSql error:", cErr);

        const insSql = `
          INSERT INTO swap_confirmations
            (match_id, type, status, offer_round, proposed_value, proposed_by_user_id, proposed_to_user_id, created_at)
          VALUES
            (?, 'scheduled_time', 'pending', 0, ?, ?, ?, NOW())
        `;

        db.query(insSql, [cm.match_id, dt, userId, otherId], (iErr) => {
          if (iErr) {
            console.error("postProposeTime insert error:", iErr);
            req.flash("error_msg", "Failed to propose time.");
            return res.redirect(`/chats/${chatId}`);
          }

          insertSystemMessage(
            db,
            chatId,
            userId,
            `[SYSTEM] Proposed time: ${dt}. Waiting for the other user's response.`,
            () => res.redirect(`/chats/${chatId}`)
          );
        });
      });
    }
  });
};

// POST /chats/:chatId/confirm/time/respond
exports.postRespondTime = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);
  const decision = String(req.body.decision || "").trim(); // accept | reject

  if (!chatId) return res.redirect("/swap/matches");

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error("postRespondTime getChatAndMatch error:", err);
      req.flash("error_msg", "Server error.");
      return res.redirect("/swap/matches");
    }
    if (!cm) {
      req.flash("error_msg", "Access denied.");
      return res.redirect("/swap/matches");
    }

    if (Number(cm.details_locked) === 1 || cm.scheduled_time) {
      req.flash("error_msg", "Time is already confirmed.");
      return res.redirect(`/chats/${chatId}`);
    }

    const pendingSql = `
      SELECT *
      FROM swap_confirmations
      WHERE match_id = ?
        AND type = 'scheduled_time'
        AND status = 'pending'
      ORDER BY offer_round DESC, created_at DESC
      LIMIT 1
    `;

    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error("postRespondTime pendingSql error:", pErr);
        req.flash("error_msg", "Server error.");
        return res.redirect(`/chats/${chatId}`);
      }

      const pending = (pRows && pRows[0]) ? pRows[0] : null;
      if (!pending) {
        req.flash("error_msg", "No pending time to respond to.");
        return res.redirect(`/chats/${chatId}`);
      }

      // Only the proposed_to_user_id can respond
      if (pending.proposed_to_user_id && Number(pending.proposed_to_user_id) !== Number(userId)) {
        req.flash("error_msg", "You cannot respond to this offer.");
        return res.redirect(`/chats/${chatId}`);
      }

      const proposedDt = String(pending.proposed_value || "").trim();
      if (!proposedDt) {
        req.flash("error_msg", "Invalid proposed time.");
        return res.redirect(`/chats/${chatId}`);
      }

      if (decision === "reject") {
        const rejSql = `
          UPDATE swap_confirmations
          SET status = 'rejected',
              responded_by_user_id = ?,
              responded_at = NOW()
          WHERE confirmation_id = ?
        `;
        return db.query(rejSql, [userId, pending.confirmation_id], (rErr) => {
          if (rErr) {
            console.error("postRespondTime reject update error:", rErr);
            req.flash("error_msg", "Failed to reject.");
            return res.redirect(`/chats/${chatId}`);
          }

          insertSystemMessage(
            db,
            chatId,
            userId,
            `[SYSTEM] Rejected proposed time: ${proposedDt}.`,
            () => res.redirect(`/chats/${chatId}`)
          );
        });
      }

      if (decision !== "accept") {
        req.flash("error_msg", "Invalid decision.");
        return res.redirect(`/chats/${chatId}`);
      }

      // If SAHM, re-check payment completion before accepting (safety)
      const acceptNow = () => {
        const accSql = `
          UPDATE swap_confirmations
          SET status = 'accepted',
              responded_by_user_id = ?,
              responded_at = NOW()
          WHERE confirmation_id = ?
        `;

        db.query(accSql, [userId, pending.confirmation_id], (aErr) => {
          if (aErr) {
            console.error("postRespondTime accept update error:", aErr);
            req.flash("error_msg", "Failed to accept.");
            return res.redirect(`/chats/${chatId}`);
          }

          const lockSql = `
            UPDATE swap_matches
            SET scheduled_time = ?,
                details_locked = 1,
                status = 'agreed'
            WHERE match_id = ?
          `;

          db.query(lockSql, [proposedDt, cm.match_id], (lErr) => {
            if (lErr) {
              console.error("postRespondTime lockSql error:", lErr);
              req.flash("error_msg", "Failed to lock time.");
              return res.redirect(`/chats/${chatId}`);
            }

            insertSystemMessage(
              db,
              chatId,
              userId,
              `[SYSTEM] Time confirmed: ${proposedDt}. Details are now locked.`,
              () => res.redirect(`/chats/${chatId}`)
            );
          });
        });
      };

      if (cm.swap_method === "sahm") {
        if (!cm.payment_split) {
          req.flash("error_msg", "Payment split not confirmed.");
          return res.redirect(`/chats/${chatId}?open=paymentSplit`);
        }

        return checkSahmPaymentComplete(
          db,
          cm.match_id,
          cm.user1_id,
          cm.user2_id,
          cm.payment_split,
          (pcErr, isComplete) => {
            if (pcErr) {
              console.error("postRespondTime checkSahmPaymentComplete error:", pcErr);
              req.flash("error_msg", "Server error.");
              return res.redirect(`/chats/${chatId}`);
            }
            if (!isComplete) {
              req.flash("error_msg", "Payment must be completed before confirming time (SAHM).");
              return res.redirect(`/chats/${chatId}?open=paymentSplit`);
            }
            return acceptNow();
          }
        );
      }

      return acceptNow();
    });
  });
};

// POST /chats/:chatId/confirm/time/counter
exports.postCounterTime = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);

  const dt = parseDatetimeLocalToMySql(req.body.scheduled_time);
  if (!chatId) return res.redirect("/swap/matches");

  if (!dt || !isFutureMySqlDatetime(dt, 5)) {
    req.flash("error_msg", "Please choose a valid future time.");
    return res.redirect(`/chats/${chatId}?open=time`);
  }

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error("postCounterTime getChatAndMatch error:", err);
      req.flash("error_msg", "Server error.");
      return res.redirect("/swap/matches");
    }
    if (!cm) {
      req.flash("error_msg", "Access denied.");
      return res.redirect("/swap/matches");
    }

    if (Number(cm.details_locked) === 1 || cm.scheduled_time) {
      req.flash("error_msg", "Time is already confirmed.");
      return res.redirect(`/chats/${chatId}`);
    }

    const pendingSql = `
      SELECT *
      FROM swap_confirmations
      WHERE match_id = ?
        AND type = 'scheduled_time'
        AND status = 'pending'
      ORDER BY offer_round DESC, created_at DESC
      LIMIT 1
    `;

    db.query(pendingSql, [cm.match_id], (pErr, pRows) => {
      if (pErr) {
        console.error("postCounterTime pendingSql error:", pErr);
        req.flash("error_msg", "Server error.");
        return res.redirect(`/chats/${chatId}`);
      }

      const pending = (pRows && pRows[0]) ? pRows[0] : null;
      if (!pending) {
        req.flash("error_msg", "No pending time to counter.");
        return res.redirect(`/chats/${chatId}`);
      }

      // Only the proposed_to_user_id can counter
      if (pending.proposed_to_user_id && Number(pending.proposed_to_user_id) !== Number(userId)) {
        req.flash("error_msg", "You cannot counter this offer.");
        return res.redirect(`/chats/${chatId}`);
      }

      // Mark current pending as "countered"
      const markSql = `
        UPDATE swap_confirmations
        SET status = 'countered',
            responded_by_user_id = ?,
            responded_at = NOW()
        WHERE confirmation_id = ?
      `;

      db.query(markSql, [userId, pending.confirmation_id], (mErr) => {
        if (mErr) {
          console.error("postCounterTime markSql error:", mErr);
          req.flash("error_msg", "Failed to counter.");
          return res.redirect(`/chats/${chatId}`);
        }

        const insSql = `
          INSERT INTO swap_confirmations
            (match_id, type, status, offer_round, proposed_value, proposed_by_user_id, proposed_to_user_id, counter_of_confirmation_id, created_at)
          VALUES
            (?, 'scheduled_time', 'pending', 1, ?, ?, ?, ?, NOW())
        `;

        db.query(insSql, [cm.match_id, dt, userId, pending.proposed_by_user_id, pending.confirmation_id], (iErr) => {
          if (iErr) {
            console.error("postCounterTime insert error:", iErr);
            req.flash("error_msg", "Failed to counter.");
            return res.redirect(`/chats/${chatId}`);
          }

          insertSystemMessage(
            db,
            chatId,
            userId,
            `[SYSTEM] Counter proposed time: ${dt}. Waiting for the other user's response.`,
            () => res.redirect(`/chats/${chatId}`)
          );
        });
      });
    });
  });
};


// =============================
// PAYMENT OTP ROUTES
// =============================
exports.getPaymentOtpStatus = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);

  if (!chatId) return res.status(400).json({ ok: false, error: 'Invalid chat' });

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('getPaymentOtpStatus getChatAndMatch error:', err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
    if (!cm) return res.status(403).json({ ok: false, error: 'Access denied' });

    if (cm.swap_method !== 'sahm') return res.status(400).json({ ok: false, error: 'Not SAHM' });
    if (!cm.payment_split) return res.status(400).json({ ok: false, error: 'Payment split not confirmed' });

    const feeSql = `SELECT delivery_fee FROM pickup_delivery_requests WHERE match_id = ?`;
    db.query(feeSql, [cm.match_id], (fErr, fRows) => {
      if (fErr) {
        console.error('getPaymentOtpStatus feeSql error:', fErr);
        return res.status(500).json({ ok: false, error: 'Server error' });
      }

      const total = (fRows || []).map(r => Number(r.delivery_fee)).filter(v => Number.isFinite(v)).reduce((a,b)=>a+b,0);
      const amounts = computeSplitAmounts(total, Number(cm.user1_id), Number(cm.user2_id), cm.payment_split);
      const amount = round2(amounts[userId] || 0);

      if (amount <= 0) return res.json({ ok: true, required: false, verified: true, amount });

      getOtpRow(db, cm.match_id, userId, (oErr, row) => {
        if (oErr) {
          console.error('getPaymentOtpStatus getOtpRow error:', oErr);
          return res.status(500).json({ ok: false, error: 'Server error' });
        }
        const verified = isOtpVerifiedForAmount(row, amount);
        return res.json({
          ok: true,
          required: true,
          verified,
          amount,
          expiresAt: row?.expires_at || null,
          lastSentAt: row?.last_sent_at || null
        });
      });
    });
  });
};

exports.postPaymentOtpSend = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);

  if (!chatId) return res.status(400).json({ ok: false, error: 'Invalid chat' });

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postPaymentOtpSend getChatAndMatch error:', err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
    if (!cm) return res.status(403).json({ ok: false, error: 'Access denied' });

    if (cm.swap_method !== 'sahm') return res.status(400).json({ ok: false, error: 'Not SAHM' });
    if (!cm.payment_split) return res.status(400).json({ ok: false, error: 'Payment split not confirmed' });

    const feeSql = `SELECT delivery_fee FROM pickup_delivery_requests WHERE match_id = ?`;
    db.query(feeSql, [cm.match_id], (fErr, fRows) => {
      if (fErr) {
        console.error('postPaymentOtpSend feeSql error:', fErr);
        return res.status(500).json({ ok: false, error: 'Server error' });
      }

      const total = (fRows || []).map(r => Number(r.delivery_fee)).filter(v => Number.isFinite(v)).reduce((a,b)=>a+b,0);
      if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ ok: false, error: 'Fee not ready' });

      const amounts = computeSplitAmounts(total, Number(cm.user1_id), Number(cm.user2_id), cm.payment_split);
      const amount = round2(amounts[userId] || 0);

      if (amount <= 0) return res.status(400).json({ ok: false, error: 'You do not need to pay' });

      const paidSql = `SELECT status FROM swap_payments WHERE match_id = ? AND payer_user_id = ? LIMIT 1`;
      db.query(paidSql, [cm.match_id, userId], (pErr, pRows) => {
        if (pErr) {
          console.error('postPaymentOtpSend paidSql error:', pErr);
          return res.status(500).json({ ok: false, error: 'Server error' });
        }
        if (pRows && pRows[0] && String(pRows[0].status) === 'captured') {
          return res.status(409).json({ ok: false, error: 'Already paid' });
        }

        const otp = gen6DigitOtp();
        const hash = otpHash(otp);
        const expiresMinutes = Number(process.env.PAYMENT_OTP_EXPIRES_MINUTES || 10);
        const expiresAtSql = `DATE_ADD(NOW(), INTERVAL ? MINUTE)`;

        const upsert = `
          INSERT INTO swap_payment_stepups
            (match_id, payer_user_id, amount_snapshot, currency, otp_code_hash, expires_at, verified_at, last_sent_at, attempt_count, created_at, updated_at)
          VALUES
            (?, ?, ?, ?, ?, ${expiresAtSql}, NULL, NOW(), 0, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            amount_snapshot = VALUES(amount_snapshot),
            currency = VALUES(currency),
            otp_code_hash = VALUES(otp_code_hash),
            expires_at = ${expiresAtSql},
            verified_at = NULL,
            last_sent_at = NOW(),
            attempt_count = 0,
            updated_at = NOW()
        `;

        const currency = (process.env.PAYPAL_CURRENCY || 'SGD').toUpperCase();
        db.query(upsert, [cm.match_id, userId, amount, currency, hash, expiresMinutes, expiresMinutes], (uErr) => {
          if (uErr) {
            console.error('postPaymentOtpSend upsert error:', uErr);
            return res.status(500).json({ ok: false, error: 'DB error' });
          }

          const userEmailSql = `SELECT email, username FROM users WHERE user_id = ? LIMIT 1`;
          db.query(userEmailSql, [userId], async (eErr, eRows) => {
            if (eErr) {
              console.error('postPaymentOtpSend userEmailSql error:', eErr);
              return res.status(500).json({ ok: false, error: 'Server error' });
            }

            const row = (eRows && eRows[0]) ? eRows[0] : null;
            const toEmail = row?.email || null;
            const username = row?.username || req.session.user.username || 'there';

            if (!toEmail) return res.status(400).json({ ok: false, error: 'No email found for your account' });

            try {
              await sendPaymentOTPEmail(toEmail, { username, otp, amount, currency, matchId: cm.match_id });
              return res.json({ ok: true, expiresMinutes, sentTo: toEmail });
            } catch (mailErr) {
              console.error('postPaymentOtpSend mail error:', mailErr);
              return res.status(500).json({ ok: false, error: 'Failed to send email' });
            }
          });
        });
      });
    });
  });
};

exports.postPaymentOtpVerify = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);
  const code = String(req.body.otp || '').trim();

  if (!chatId) return res.status(400).json({ ok: false, error: 'Invalid chat' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'OTP must be 6 digits' });

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postPaymentOtpVerify getChatAndMatch error:', err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
    if (!cm) return res.status(403).json({ ok: false, error: 'Access denied' });

    if (cm.swap_method !== 'sahm') return res.status(400).json({ ok: false, error: 'Not SAHM' });
    if (!cm.payment_split) return res.status(400).json({ ok: false, error: 'Payment split not confirmed' });

    const feeSql = `SELECT delivery_fee FROM pickup_delivery_requests WHERE match_id = ?`;
    db.query(feeSql, [cm.match_id], (fErr, fRows) => {
      if (fErr) {
        console.error('postPaymentOtpVerify feeSql error:', fErr);
        return res.status(500).json({ ok: false, error: 'Server error' });
      }

      const total = (fRows || []).map(r => Number(r.delivery_fee)).filter(v => Number.isFinite(v)).reduce((a,b)=>a+b,0);
      const amounts = computeSplitAmounts(total, Number(cm.user1_id), Number(cm.user2_id), cm.payment_split);
      const expectedAmount = round2(amounts[userId] || 0);

      if (expectedAmount <= 0) return res.status(400).json({ ok: false, error: 'You do not need to pay' });

      getOtpRow(db, cm.match_id, userId, (oErr, row) => {
        if (oErr) {
          console.error('postPaymentOtpVerify getOtpRow error:', oErr);
          return res.status(500).json({ ok: false, error: 'Server error' });
        }
        if (!row) return res.status(400).json({ ok: false, error: 'Please request a code first' });

        const exp = row.expires_at ? new Date(row.expires_at) : null;
        if (!exp || Number.isNaN(exp.getTime()) || exp.getTime() < Date.now()) {
          return res.status(400).json({ ok: false, error: 'Code expired. Please request a new one.' });
        }

        const snap = Number(row.amount_snapshot);
        if (!Number.isFinite(snap) || Math.abs(snap - expectedAmount) >= 0.005) {
          return res.status(400).json({ ok: false, error: 'Payment amount changed. Please request a new code.' });
        }

        const maxAttempts = Number(process.env.PAYMENT_OTP_MAX_ATTEMPTS || 5);
        if (Number(row.attempt_count) >= maxAttempts) {
          return res.status(429).json({ ok: false, error: 'Too many attempts. Please request a new code.' });
        }

        const ok = (otpHash(code) === String(row.otp_code_hash));
        if (!ok) {
          const inc = `UPDATE swap_payment_stepups SET attempt_count = attempt_count + 1, updated_at = NOW() WHERE stepup_id = ?`;
          db.query(inc, [row.stepup_id], () => res.status(400).json({ ok: false, error: 'Invalid code' }));
          return;
        }

        const upd = `UPDATE swap_payment_stepups SET verified_at = NOW(), updated_at = NOW() WHERE stepup_id = ?`;
        db.query(upd, [row.stepup_id], (uErr) => {
          if (uErr) {
            console.error('postPaymentOtpVerify update error:', uErr);
            return res.status(500).json({ ok: false, error: 'DB error' });
          }
          return res.json({ ok: true, verified: true });
        });
      });
    });
  });
};


// =============================
// POST /chats/:chatId/help/create
// Body: { case_type: 'cancel_request' | 'scam_report', reason: '...' }
// =============================
exports.postHelpCreateCase = (req, res) => {
  if (!requireLogin(req, res)) return;

  const wantsJson =
    String(req.get('X-Requested-With') || '').toLowerCase() === 'fetch' ||
    String(req.get('accept') || '').includes('application/json');

  const userId = Number(req.session.user.user_id);
  const chatId = Number(req.params.chatId);

  const caseType = String(req.body.case_type || '').trim(); // cancel_request | scam_report
  const reason = String(req.body.reason || '').trim();

  const respondError = (msg, redirectUrl, statusCode = 400) => {
    if (wantsJson) return res.status(statusCode).json({ ok: false, error: msg });
    req.flash('error_msg', msg);
    return res.redirect(redirectUrl);
  };

  const respondOk = (msg, redirectUrl) => {
    if (wantsJson) return res.json({ ok: true, message: msg });
    req.flash('success_msg', msg);
    return res.redirect(redirectUrl);
  };

  if (!chatId) return respondError('Invalid chat.', '/swap/matches', 400);
  if (!['cancel_request', 'scam_report'].includes(caseType)) {
    return respondError('Invalid help request.', `/chats/${chatId}`, 400);
  }
  if (!reason) return respondError('Please provide a reason.', `/chats/${chatId}`, 400);

  getChatAndMatch(db, chatId, userId, (err, cm) => {
    if (err) {
      console.error('postHelpCreateCase getChatAndMatch error:', err);
      return respondError('Server error.', `/chats/${chatId}`, 500);
    }
    if (!cm) return respondError('Access denied.', '/swap/matches', 403);

    // cancel only allowed before details_locked
    if (caseType === 'cancel_request' && Number(cm.details_locked) === 1) {
      return respondError('You cannot cancel after details are locked.', `/chats/${chatId}`, 400);
    }

    // prevent duplicates (only 1 active case per match)
    getActiveSwapCase(db, cm.match_id, (cErr, activeCase) => {
      if (cErr) {
        console.error('postHelpCreateCase getActiveSwapCase error:', cErr);
        return respondError('Server error.', `/chats/${chatId}`, 500);
      }

      if (activeCase) {
        return respondError('It is currently under review already.', `/chats/${chatId}`, 409);
      }

      const ins = `
        INSERT INTO swap_cases
          (match_id, case_type, reason, status, opened_by_user_id, created_at, updated_at)
        VALUES
          (?, ?, ?, 'open', ?, NOW(), NOW())
      `;

      db.query(ins, [cm.match_id, caseType, reason, userId], (iErr) => {
        if (iErr) {
          console.error('postHelpCreateCase insert error:', iErr);
          return respondError('Failed to submit help request.', `/chats/${chatId}`, 500);
        }

        const typeLabel = (caseType === 'cancel_request')
          ? 'Cancel Match Request'
          : 'Report Scam';
        const openerName = req.session.user.username || `User ${userId}`;

        insertSystemMessage(
          db,
          chatId,
          userId,
          `[SYSTEM] /help opened: ${typeLabel}. Opened by ${openerName}. Payments and commands are temporarily disabled until admin resolves.`,
          () => {
            return respondOk('Your request has been submitted for admin review.', `/chats/${chatId}`);
          }
        );
      });
    });
  });
};


