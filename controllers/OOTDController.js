const db = require('../db');

// --------------------------------------------
// Helpers
// --------------------------------------------
function redirectBack(req, res, fallback = '/') {
  const ref = req.get('Referer') || req.get('Referrer');
  return res.redirect(ref || fallback);
}

function requireLogin(req, res) {
  if (!req.session.user) {
    req.flash('error_msg', 'You need to be logged in to do that.');
    res.redirect('/login');
    return true;
  }
  return false;
}

function requireLoginAdmin(req, res) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    req.flash('error_msg', 'You need to be an admin to do that.');
    res.redirect('/login');
    return true;
  }
  return false;
}

// Attach latest 3 comments to each post (for feed + search)
function attachLatestCommentsToPosts(posts, cb) {
  const postIds = (posts || []).map(p => p.post_id);

  if (postIds.length === 0) return cb(null, posts);

  const commentSql = `
    SELECT 
      c.comment_id,
      c.post_id,
      c.user_id,
      c.content,
      c.created_at,
      u.username
    FROM ootd_comments c
    JOIN users u ON c.user_id = u.user_id
    WHERE c.post_id IN (?)
    ORDER BY c.created_at DESC
  `;

  db.query(commentSql, [postIds], (err, rows) => {
    if (err) return cb(err);

    const byPost = {};
    for (const r of (rows || [])) {
      if (!byPost[r.post_id]) byPost[r.post_id] = [];
      if (byPost[r.post_id].length < 3) byPost[r.post_id].push(r);
    }

    for (const p of posts) p.comments = byPost[p.post_id] || [];
    cb(null, posts);
  });
}

// --------------------------------------------
// HOME FEED
// --------------------------------------------
exports.getHomeFeed = (req, res) => {
  const currentUser = req.session.user || null;
  const currentUserId = currentUser ? currentUser.user_id : 0;

  const sql = `
    SELECT 
      p.post_id,
      p.user_id,
      p.caption,
      p.visibility,
      p.image_url_1,
      p.image_url_2,
      p.image_url_3,
      p.created_at,
      u.username,
      u.profile_image_url,

      (SELECT COUNT(*) FROM ootd_likes l WHERE l.post_id = p.post_id) AS like_count,
      (SELECT COUNT(*) FROM ootd_comments c WHERE c.post_id = p.post_id) AS comment_count,
      (
        SELECT COUNT(*)
        FROM ootd_likes l2
        WHERE l2.post_id = p.post_id AND l2.user_id = ?
      ) AS liked_by_me
    FROM ootd_posts p
    JOIN users u ON p.user_id = u.user_id
    WHERE p.visibility = 'public'
    ORDER BY p.created_at DESC
  `;

  db.query(sql, [currentUserId], (err, rows) => {
    if (err) {
      console.error('Error loading OOTD feed:', err);
      return res.render('index', {
        user: currentUser,
        ootdPosts: [],
        userResults: [],
        ootdResults: [],
        q: '',
        message: 'Error loading OOTD feed.'
      });
    }

    const posts = rows || [];
    attachLatestCommentsToPosts(posts, (cErr, enriched) => {
      if (cErr) {
        console.error('Error loading comments:', cErr);
        enriched = posts;
      }

      return res.render('index', {
        user: currentUser,
        ootdPosts: enriched,
        userResults: [],
        ootdResults: [],
        q: '',
        message: null
      });
    });
  });
};

exports.getHomeFeedAdmin = (req, res) => {
  const currentUser = req.session.user || null;
  const currentUserId = currentUser ? currentUser.user_id : 0;

  // if (requireLoginAdmin(req, res)) return;

  const sql = `
    SELECT 
      p.post_id,
      p.user_id,
      p.caption,
      p.visibility,
      p.image_url_1,
      p.image_url_2,
      p.image_url_3,
      p.created_at,
      u.username,
      u.profile_image_url,

      (SELECT COUNT(*) FROM ootd_likes l WHERE l.post_id = p.post_id) AS like_count,
      (SELECT COUNT(*) FROM ootd_comments c WHERE c.post_id = p.post_id) AS comment_count,
      (
        SELECT COUNT(*)
        FROM ootd_likes l2
        WHERE l2.post_id = p.post_id AND l2.user_id = ?
      ) AS liked_by_me
    FROM ootd_posts p
    JOIN users u ON p.user_id = u.user_id
    WHERE p.visibility = 'public'
    ORDER BY p.created_at DESC
  `;

  db.query(sql, [currentUserId], (err, rows) => {
    if (err) {
      console.error('Error loading OOTD feed:', err);
      return res.render('indexAdmin', {
        user: currentUser,
        ootdPosts: [],
        searchResults: [],
        message: 'Error loading OOTD feed.'
      });
    }

    const posts = rows || [];
    attachLatestCommentsToPosts(posts, (cErr, enriched) => {
      if (cErr) {
        console.error('Error loading comments:', cErr);
        enriched = posts;
      }

      return res.render('indexAdmin', {
        user: currentUser,
        ootdPosts: enriched,
        searchResults: [],
        message: null
      });
    });
  });
};

// --------------------------------------------
// CREATE / EDIT / DELETE
// --------------------------------------------
exports.getCreateOotdForm = (req, res) => {
  if (requireLogin(req, res)) return;

  res.render('createOotd', {
    user: req.session.user,
    errors: [],
    formData: {}
  });
};

exports.createOotdPost = (req, res) => {
  if (requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const body = req.body || {};

  let caption = (body.caption || '').trim();
  let visibility = body.visibility === 'private' ? 'private' : 'public';

  let image_url_1 = body.image_url_1 ? body.image_url_1.trim() : null;
  let image_url_2 = body.image_url_2 ? body.image_url_2.trim() : null;
  let image_url_3 = body.image_url_3 ? body.image_url_3.trim() : null;

  const files = req.files || {};
  const file1 = files.image1 && files.image1[0] ? files.image1[0].filename : null;
  const file2 = files.image2 && files.image2[0] ? files.image2[0].filename : null;
  const file3 = files.image3 && files.image3[0] ? files.image3[0].filename : null;

  const img1 = file1 ? `/images/${file1}` : image_url_1;
  const img2 = file2 ? `/images/${file2}` : image_url_2;
  const img3 = file3 ? `/images/${file3}` : image_url_3;

  const errors = [];
  if (!img1 && !img2 && !img3) {
    errors.push({ msg: 'Please upload at least one image or provide an image URL.' });
  }

  if (errors.length > 0) {
    return res.render('createOotd', {
      user: req.session.user,
      errors,
      formData: { caption, visibility, image_url_1, image_url_2, image_url_3 }
    });
  }

  const insertSql = `
    INSERT INTO ootd_posts
    (user_id, caption, visibility, image_url_1, image_url_2, image_url_3)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  db.query(insertSql, [userId, caption || null, visibility, img1, img2, img3], (err) => {
    if (err) {
      console.error('Error creating OOTD post:', err);
      req.flash('error_msg', 'Error creating OOTD post.');
      return res.redirect('/');
    }
    req.flash('success_msg', 'Your OOTD has been posted!');
    return res.redirect('/profile');
  });
};

exports.getEditOotdForm = (req, res) => {
  if (requireLogin(req, res)) return;

  const postId = req.params.id;
  const currentUserId = req.session.user.user_id;

  const sql = `
    SELECT 
      post_id, user_id, caption, visibility,
      image_url_1, image_url_2, image_url_3, created_at
    FROM ootd_posts
    WHERE post_id = ?
  `;

  db.query(sql, [postId], (err, rows) => {
    if (err) {
      console.error('Error loading OOTD for edit:', err);
      req.flash('error_msg', 'Error loading OOTD post.');
      return res.redirect('/profile');
    }

    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'OOTD post not found.');
      return res.redirect('/profile');
    }

    const post = rows[0];
    if (post.user_id !== currentUserId) {
      req.flash('error_msg', 'You are not allowed to edit this OOTD.');
      return res.redirect('/profile');
    }

    return res.render('editOotd', {
      user: req.session.user,
      post,
      errors: []
    });
  });
};

exports.updateOotdPost = (req, res) => {
  if (requireLogin(req, res)) return;

  const postId = req.params.id;
  const currentUserId = req.session.user.user_id;
  const body = req.body || {};

  let caption = (body.caption || '').trim();
  let visibility = body.visibility === 'private' ? 'private' : 'public';

  let image_url_1 = body.image_url_1 ? body.image_url_1.trim() : null;
  let image_url_2 = body.image_url_2 ? body.image_url_2.trim() : null;
  let image_url_3 = body.image_url_3 ? body.image_url_3.trim() : null;

  const errors = [];
  if (!image_url_1 && !image_url_2 && !image_url_3) {
    errors.push({ msg: 'Please provide at least one image URL.' });
  }

  const checkSql = `SELECT user_id FROM ootd_posts WHERE post_id = ?`;

  db.query(checkSql, [postId], (err, rows) => {
    if (err) {
      console.error('Error checking OOTD owner:', err);
      req.flash('error_msg', 'Error updating OOTD post.');
      return res.redirect('/profile');
    }

    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'OOTD post not found.');
      return res.redirect('/profile');
    }

    if (rows[0].user_id !== currentUserId) {
      req.flash('error_msg', 'You are not allowed to edit this OOTD.');
      return res.redirect('/profile');
    }

    if (errors.length > 0) {
      return res.render('editOotd', {
        user: req.session.user,
        post: {
          post_id: postId,
          caption,
          visibility,
          image_url_1,
          image_url_2,
          image_url_3
        },
        errors
      });
    }

    const updateSql = `
      UPDATE ootd_posts
      SET caption = ?,
          visibility = ?,
          image_url_1 = ?,
          image_url_2 = ?,
          image_url_3 = ?
      WHERE post_id = ?
    `;

    db.query(updateSql, [caption || null, visibility, image_url_1, image_url_2, image_url_3, postId], (err2) => {
      if (err2) {
        console.error('Error updating OOTD post:', err2);
        req.flash('error_msg', 'Error updating OOTD post.');
        return res.redirect('/profile');
      }

      req.flash('success_msg', 'OOTD updated successfully.');
      return res.redirect('/profile');
    });
  });
};

exports.deleteOotdPost = (req, res) => {
  if (requireLogin(req, res)) return;

  const postId = req.params.id;
  const currentUserId = req.session.user.user_id;

  // First verify the post belongs to the user
  const verifySql = `
    SELECT post_id FROM ootd_posts 
    WHERE post_id = ? AND user_id = ?
  `;

  db.query(verifySql, [postId, currentUserId], (err, results) => {
    if (err) {
      console.error('Error verifying OOTD post:', err);
      req.flash('error_msg', 'Error deleting OOTD post.');
      return res.redirect('/profile');
    }

    if (results.length === 0) {
      req.flash('error_msg', 'OOTD post not found or not owned by you.');
      return res.redirect('/profile');
    }

    // Delete in correct order to respect foreign key constraints
    const deleteNotifications = `DELETE FROM ootd_notifications WHERE post_id = ?`;
    const deleteComments = `DELETE FROM ootd_comments WHERE post_id = ?`;
    const deleteLikes = `DELETE FROM ootd_likes WHERE post_id = ?`;
    const deletePost = `DELETE FROM ootd_posts WHERE post_id = ?`;

    db.query(deleteNotifications, [postId], (err) => {
      if (err) {
        console.error('Error deleting notifications:', err);
        req.flash('error_msg', 'Error deleting OOTD post.');
        return res.redirect('/profile');
      }

      db.query(deleteComments, [postId], (err) => {
        if (err) {
          console.error('Error deleting comments:', err);
          req.flash('error_msg', 'Error deleting OOTD post.');
          return res.redirect('/profile');
        }

        db.query(deleteLikes, [postId], (err) => {
          if (err) {
            console.error('Error deleting likes:', err);
            req.flash('error_msg', 'Error deleting OOTD post.');
            return res.redirect('/profile');
          }

          db.query(deletePost, [postId], (err) => {
            if (err) {
              console.error('Error deleting OOTD post:', err);
              req.flash('error_msg', 'Error deleting OOTD post.');
              return res.redirect('/profile');
            }

            req.flash('success_msg', 'OOTD post deleted successfully.');
            return res.redirect('/profile');
          });
        });
      });
    });
  });
};

// --------------------------------------------
// SEARCH
// --------------------------------------------

// Standalone search page (optional)
exports.searchOotd = (req, res) => {
  const currentUser = req.session.user || null;
  let q = (req.query.q || '').trim();

  if (!q) {
    return res.render('search-ootd', {
      user: currentUser,
      ootdQuery: '',
      ootdSearchResults: [],
      message: null
    });
  }

  const terms = q.split(/\s+/).filter(Boolean);
  const whereParts = [];
  const params = [];

  for (const term of terms) {
    const t = term.toLowerCase();
    whereParts.push(`LOWER(p.caption) LIKE ?`);
    params.push(`%${t}%`);
  }

  const sql = `
    SELECT 
      p.post_id,
      p.user_id,
      p.caption,
      p.visibility,
      p.image_url_1,
      p.image_url_2,
      p.image_url_3,
      p.created_at,
      u.username,
      u.profile_image_url
    FROM ootd_posts p
    JOIN users u ON p.user_id = u.user_id
    WHERE p.visibility = 'public'
      AND p.caption IS NOT NULL
      AND (${whereParts.join(' OR ')})
    ORDER BY p.created_at DESC
  `;

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error('Error searching OOTD:', err);
      return res.render('search-ootd', {
        user: currentUser,
        ootdQuery: q,
        ootdSearchResults: [],
        message: 'Error searching OOTD posts.'
      });
    }

    return res.render('search-ootd', {
      user: currentUser,
      ootdQuery: q,
      ootdSearchResults: rows || [],
      message: null
    });
  });
};

// Combined search (Users + OOTD) — used by index.ejs
exports.searchAll = (req, res) => {
  const currentUser = req.session.user || null;
  const currentUserId = currentUser ? currentUser.user_id : 0;

  let q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');

  const qLower = q.toLowerCase();

  // USERS
  const userSql = `
    SELECT user_id, username, email, profile_image_url
    FROM users
    WHERE LOWER(username) LIKE ?
       OR LOWER(email) LIKE ?
    ORDER BY username ASC
    LIMIT 25
  `;
  const userParams = [`%${qLower}%`, `%${qLower}%`];

  // OOTD TERMS
  const terms = q.split(/\s+/).filter(Boolean);
  const whereParts = [];
  const ootdParams = [];

  for (const term of terms) {
    whereParts.push(`LOWER(p.caption) LIKE ?`);
    ootdParams.push(`%${term.toLowerCase()}%`);
  }
  if (whereParts.length === 0) {
    whereParts.push(`LOWER(p.caption) LIKE ?`);
    ootdParams.push(`%${qLower}%`);
  }

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
      u.username,
      u.profile_image_url,

      (SELECT COUNT(*) FROM ootd_likes l WHERE l.post_id = p.post_id) AS like_count,
      (SELECT COUNT(*) FROM ootd_comments c WHERE c.post_id = p.post_id) AS comment_count,
      (
        SELECT COUNT(*)
        FROM ootd_likes l2
        WHERE l2.post_id = p.post_id AND l2.user_id = ?
      ) AS liked_by_me
    FROM ootd_posts p
    JOIN users u ON p.user_id = u.user_id
    WHERE p.visibility = 'public'
      AND p.caption IS NOT NULL
      AND (${whereParts.join(' OR ')})
    ORDER BY p.created_at DESC
    LIMIT 60
  `;

  db.query(userSql, userParams, (userErr, userRows) => {
    if (userErr) {
      console.error('Error searching users:', userErr);
      return res.render('index', {
        user: currentUser,
        ootdPosts: [],
        q,
        userResults: [],
        ootdResults: [],
        message: 'Error searching users.'
      });
    }

    db.query(ootdSql, [currentUserId, ...ootdParams], (ootdErr, ootdRows) => {
      if (ootdErr) {
        console.error('Error searching OOTD:', ootdErr);
        return res.render('index', {
          user: currentUser,
          ootdPosts: [],
          q,
          userResults: userRows || [],
          ootdResults: [],
          message: 'Error searching OOTD posts.'
        });
      }

      const posts = ootdRows || [];
      attachLatestCommentsToPosts(posts, (cErr, enriched) => {
        if (cErr) {
          console.error('Error loading comments (search):', cErr);
          enriched = posts;
        }

        return res.render('index', {
          user: currentUser,
          ootdPosts: [], // feed hidden in search mode
          q,
          userResults: userRows || [],
          ootdResults: enriched,
          message: null
        });
      });
    });
  });
};

// --------------------------------------------
// LIKE / COMMENT + NOTIFICATIONS
// --------------------------------------------
exports.toggleLike = (req, res) => {
  if (requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const postId = req.params.id;

  const checkSql = `SELECT like_id FROM ootd_likes WHERE user_id = ? AND post_id = ?`;

  db.query(checkSql, [userId, postId], (err, rows) => {
    if (err) {
      console.error('Error checking like:', err);
      req.flash('error_msg', 'Could not update like.');
      return redirectBack(req, res, '/');
    }

    // Unlike
    if (rows && rows.length > 0) {
      const delSql = `DELETE FROM ootd_likes WHERE user_id = ? AND post_id = ?`;
      return db.query(delSql, [userId, postId], (err2) => {
        if (err2) {
          console.error('Error unliking:', err2);
          req.flash('error_msg', 'Could not unlike post.');
        }
        return redirectBack(req, res, '/');
      });
    }

    // Like
    const insSql = `INSERT INTO ootd_likes (user_id, post_id) VALUES (?, ?)`;
    db.query(insSql, [userId, postId], (err3) => {
      if (err3) {
        console.error('Error liking:', err3);
        req.flash('error_msg', 'Could not like post.');
      }
      return redirectBack(req, res, '/');
    });
  });
};

exports.addComment = (req, res) => {
  if (requireLogin(req, res)) return;

  const userId = req.session.user.user_id;
  const postId = req.params.id;
  const content = (req.body.content || '').trim();

  if (!content) {
    req.flash('error_msg', 'Comment cannot be empty.');
    return redirectBack(req, res, '/');
  }

  if (content.length > 500) {
    req.flash('error_msg', 'Comment is too long (max 500 chars).');
    return redirectBack(req, res, '/');
  }

  const sql = `INSERT INTO ootd_comments (post_id, user_id, content) VALUES (?, ?, ?)`;

  db.query(sql, [postId, userId, content], (err) => {
    if (err) {
      console.error('Error adding comment:', err);
      req.flash('error_msg', 'Could not add comment.');
      return redirectBack(req, res, '/');
    }

    // Notify post owner (if not self)
    const notifySql = `
      INSERT INTO ootd_notifications
      (recipient_user_id, actor_user_id, post_id, type, comment_preview)
      SELECT p.user_id, ?, ?, 'comment', ?
      FROM ootd_posts p
      WHERE p.post_id = ? AND p.user_id != ?
    `;

    db.query(
      notifySql,
      [userId, postId, content.substring(0, 100), postId, userId],
      (nErr) => {
        if (nErr) console.error('Notify comment error:', nErr);
        return redirectBack(req, res, '/');
      }
    );
  });
};

exports.deleteComment = (req, res) => {
  if (requireLogin(req, res)) return;

  const commentId = req.params.commentId;
  const currentUser = req.session.user;

  const sqlGet = `SELECT user_id FROM ootd_comments WHERE comment_id = ?`;
  db.query(sqlGet, [commentId], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      req.flash('error_msg', 'Comment not found.');
      return redirectBack(req, res, '/');
    }

    const ownerId = rows[0].user_id;
    const isAdmin = currentUser.role === 'admin';

    if (ownerId !== currentUser.user_id && !isAdmin) {
      req.flash('error_msg', 'You cannot delete this comment.');
      return redirectBack(req, res, '/');
    }

    const delSql = `DELETE FROM ootd_comments WHERE comment_id = ?`;
    db.query(delSql, [commentId], (err2) => {
      if (err2) {
        console.error('Error deleting comment:', err2);
        req.flash('error_msg', 'Could not delete comment.');
      }
      return redirectBack(req, res, '/');
    });
  });
};

// --------------------------------------------
// INBOX
// --------------------------------------------
exports.getInbox = (req, res) => {
  if (requireLogin(req, res)) return;

  const currentUserId = req.session.user.user_id;

  // Fetch OOTD notifications
  const notifSql = `
    SELECT 
      n.notification_id,
      n.recipient_user_id,
      n.actor_user_id,
      n.post_id,
      n.type,
      n.comment_preview,
      n.is_read,
      n.created_at,
      u.username AS actor_username,
      u.profile_image_url AS actor_profile_image
    FROM ootd_notifications n
    JOIN users u ON n.actor_user_id = u.user_id
    WHERE n.recipient_user_id = ?
    ORDER BY n.created_at DESC
  `;

  // Fetch swap matches where user is user1 or user2
  const swapSql = `
    SELECT 
      sm.match_id,
      sm.user1_id,
      sm.item1_id,
      sm.user2_id,
      sm.item2_id,
      sm.status,
      sm.swap_method,
      sm.payment_split,
      sm.created_at,
      CASE 
        WHEN ? = sm.user1_id THEN u2.username
        ELSE u1.username
      END AS other_user_username,
      CASE 
        WHEN ? = sm.user1_id THEN u2.profile_image_url
        ELSE u1.profile_image_url
      END AS other_user_profile_image,
      CASE 
        WHEN ? = sm.user1_id THEN u2.user_id
        ELSE u1.user_id
      END AS other_user_id,
      CASE 
        WHEN ? = sm.user1_id THEN ci2.title
        ELSE ci1.title
      END AS other_user_item_title,
      CASE 
        WHEN ? = sm.user1_id THEN ci2.image_url_1
        ELSE ci1.image_url_1
      END AS other_user_item_image,
      CASE 
        WHEN ? = sm.user1_id THEN ci1.title
        ELSE ci2.title
      END AS my_item_title,
      CASE 
        WHEN ? = sm.user1_id THEN ci1.image_url_1
        ELSE ci2.image_url_1
      END AS my_item_image
    FROM swap_matches sm
    JOIN users u1 ON sm.user1_id = u1.user_id
    JOIN users u2 ON sm.user2_id = u2.user_id
    JOIN clothing_items ci1 ON sm.item1_id = ci1.item_id
    JOIN clothing_items ci2 ON sm.item2_id = ci2.item_id
    WHERE sm.user1_id = ? OR sm.user2_id = ?
    ORDER BY sm.created_at DESC
  `;

  db.query(notifSql, [currentUserId], (err, notifications) => {
    if (err) {
      console.error('Error loading notifications:', err);
      req.flash('error_msg', 'Could not load inbox.');
      return res.redirect('/');
    }

    db.query(swapSql, [
      currentUserId, currentUserId, currentUserId, currentUserId,
      currentUserId, currentUserId, currentUserId, currentUserId, currentUserId
    ], (err, swapMatches) => {
      if (err) {
        console.error('Error loading swap matches:', err);
        req.flash('error_msg', 'Could not load inbox.');
        return res.redirect('/');
      }

      return res.render('inbox', {
        user: req.session.user,
        notifications: notifications || [],
        swapMatches: swapMatches || []
      });
    });
  });
};

exports.markNotificationRead = (req, res) => {
  if (requireLogin(req, res)) return;

  const notifId = req.params.id;

  const sql = `UPDATE ootd_notifications SET is_read = 1 WHERE notification_id = ?`;
  db.query(sql, [notifId], (err) => {
    if (err) console.error('Error marking notification read:', err);
    return redirectBack(req, res, '/inbox');
  });
};

// --------------------------------------------
// VIEW SINGLE POST PAGE (optional route)
// --------------------------------------------
exports.viewPost = (req, res) => {
  const currentUser = req.session.user || null;
  const currentUserId = currentUser ? currentUser.user_id : 0;
  const postId = req.params.id;

  const postSql = `
    SELECT
      p.post_id,
      p.user_id,
      p.caption,
      p.visibility,
      p.image_url_1,
      p.image_url_2,
      p.image_url_3,
      p.created_at,
      u.username,
      u.profile_image_url,

      (SELECT COUNT(*) FROM ootd_likes l WHERE l.post_id = p.post_id) AS like_count,
      (SELECT COUNT(*) FROM ootd_comments c WHERE c.post_id = p.post_id) AS comment_count,
      (
        SELECT COUNT(*)
        FROM ootd_likes l2
        WHERE l2.post_id = p.post_id AND l2.user_id = ?
      ) AS liked_by_me
    FROM ootd_posts p
    JOIN users u ON p.user_id = u.user_id
    WHERE p.post_id = ?
      AND (p.visibility = 'public' OR p.user_id = ?)
    LIMIT 1
  `;

  db.query(postSql, [currentUserId, postId, currentUserId], (err, rows) => {
    if (err) {
      console.error('Error loading post:', err);
      req.flash('error_msg', 'Could not load post.');
      return res.redirect('/');
    }

    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'Post not found or not accessible.');
      return res.redirect('/');
    }

    const post = rows[0];

    const commentsSql = `
      SELECT
        c.comment_id,
        c.post_id,
        c.user_id,
        c.content,
        c.created_at,
        u.username,
        u.profile_image_url
      FROM ootd_comments c
      JOIN users u ON c.user_id = u.user_id
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC
    `;

    db.query(commentsSql, [postId], (cErr, cRows) => {
      if (cErr) {
        console.error('Error loading comments:', cErr);
        cRows = [];
      }

      post.comments = cRows || [];

      return res.render('ootd-post', {
        user: currentUser,
        post,
        message: null
      });
    });
  });
};

// --------------------------------------------
// ADMIN COMMENT MANAGEMENT
// --------------------------------------------
exports.getAdminComments = (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    req.flash('error_msg', 'You need to be an admin to access this page.');
    return res.redirect('/');
  }

  const commentsSql = `
    SELECT 
      c.comment_id,
      c.post_id,
      c.user_id,
      c.content,
      c.created_at,
      u.username,
      p.caption AS post_caption,
      p.image_url_1,
      (SELECT COUNT(*) FROM ootd_comments WHERE post_id = p.post_id) AS total_comments_on_post
    FROM ootd_comments c
    JOIN users u ON c.user_id = u.user_id
    JOIN ootd_posts p ON c.post_id = p.post_id
    ORDER BY c.created_at DESC
    LIMIT 200
  `;

  db.query(commentsSql, (err, comments) => {
    if (err) {
      console.error('Error fetching admin comments:', err);
      req.flash('error_msg', 'Error loading comments.');
      return res.redirect('/admin');
    }

    return res.render('adminComments', {
      user: req.session.user,
      comments: comments || [],
      message: null
    });
  });
};

exports.deleteCommentAsAdmin = (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    req.flash('error_msg', 'You need to be an admin to delete comments.');
    return redirectBack(req, res, '/');
  }

  const commentId = req.params.commentId;

  const delSql = `DELETE FROM ootd_comments WHERE comment_id = ?`;
  db.query(delSql, [commentId], (err) => {
    if (err) {
      console.error('Error deleting comment as admin:', err);
      req.flash('error_msg', 'Could not delete comment.');
      return redirectBack(req, res, '/admin/comments');
    }

    req.flash('success_msg', 'Comment deleted successfully.');
    return res.redirect('/admin/comments');
  });
};
