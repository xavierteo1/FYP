const db = require('../db');
const { sendSahmApplicationStatusEmail } = require('../utils/mailer');

// -------------------------
// Guards
// -------------------------
function requireLogin(req, res) {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    res.redirect('/login');
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  if (!requireLogin(req, res)) return false;

  if (!req.session.user || req.session.user.role !== 'admin') {
    req.flash('error_msg', 'Access denied. Admins only.');
    res.redirect('/');
    return false;
  }
  return true;
}

// =====================================================
// GET /sahm/apply
// - show apply page + latest application status (if any)
// =====================================================
exports.getApplySAHM = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;

  // already SAHM -> no need apply
  if (req.session.user.role === 'sahm') {
    req.flash('success_msg', 'You are already a SAHM.');
    return res.redirect('/sahm');
  }

  const sql = `
    SELECT
      application_id,
      user_id,
      document_url,
      status,
      admin_id,
      admin_comment,
      created_at,
      updated_at
    FROM sahm_applications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      console.error('getApplySAHM error:', err);
      req.flash('error_msg', 'Error loading SAHM application.');
      return res.redirect('/');
    }

    return res.render('sahmApply', {
      user: req.session.user,
      application: rows && rows.length ? rows[0] : null
    });
  });
};

// =====================================================
// POST /sahm/apply
// - user submits application with document upload
// - expects multer middleware before this controller:
//   uploadSahmDoc.single('document')
// =====================================================
exports.postApplySAHM = (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user.user_id;

  if (req.session.user.role === 'sahm') {
    req.flash('success_msg', 'You are already a SAHM.');
    return res.redirect('/sahm');
  }

  // document_url uses Cloudinary URL from req.file.path
  const docUrl = req.file ? req.file.path : null;

  if (!docUrl) {
    req.flash('error_msg', 'Please upload your resume + IC verification document (PDF/ZIP/JPG/PNG).');
    return res.redirect('/sahm/apply');
  }

  // prevent duplicates if existing app is still active
  const checkSql = `
    SELECT application_id, status
    FROM sahm_applications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `;

  db.query(checkSql, [userId], (checkErr, checkRows) => {
    if (checkErr) {
      console.error('postApplySAHM check error:', checkErr);
      req.flash('error_msg', 'Error submitting SAHM application.');
      return res.redirect('/sahm/apply');
    }

    const latest = checkRows && checkRows.length ? checkRows[0] : null;

    // if still in progress OR already approved, block new submissions
    if (latest && ['submitted', 'under_review', 'approved'].includes(latest.status)) {
      req.flash('error_msg', `You already have an application in progress (${latest.status}).`);
      return res.redirect('/sahm/apply');
    }

    const insertSql = `
      INSERT INTO sahm_applications
        (user_id, document_url, status, admin_id, admin_comment, created_at, updated_at)
      VALUES
        (?, ?, 'submitted', NULL, NULL, NOW(), NOW())
    `;

    db.query(insertSql, [userId, docUrl], (insErr) => {
      if (insErr) {
        console.error('postApplySAHM insert error:', insErr);
        req.flash('error_msg', 'Error submitting SAHM application.');
        return res.redirect('/sahm/apply');
      }

      req.flash('success_msg', 'SAHM application submitted! Please wait for admin review.');
      return res.redirect('/sahm/apply');
    });
  });
};

// =====================================================
// ADMIN: POST /admin/sahm-applications/:id/status
// Body: { status, admin_comment }
// - updates sahm_applications: status + admin_id + admin_comment + updated_at
// - if approved: sets users.role = 'sahm'
// - optional: ensure sahm_profiles exists (non-destructive)
// =====================================================
exports.adminUpdateApplicationStatus = (req, res) => {
  if (!requireAdmin(req, res)) return;

  const adminId = req.session.user.user_id;
  const applicationId = Number(req.params.id);

  const newStatus = (req.body.status || '').trim();
  const adminComment = (req.body.admin_comment || '').trim();

  const allowed = ['submitted', 'under_review', 'approved', 'rejected'];

  if (!applicationId || !allowed.includes(newStatus)) {
    req.flash('error_msg', 'Invalid application update request.');
    return res.redirect('/admin');
  }

  // Load application + applicant email + username
  const getSql = `
    SELECT sa.application_id, sa.user_id, u.email, u.username
    FROM sahm_applications sa
    JOIN users u ON sa.user_id = u.user_id
    WHERE sa.application_id = ?
    LIMIT 1
  `;

  db.query(getSql, [applicationId], (getErr, rows) => {
    if (getErr) {
      console.error('adminUpdateApplicationStatus get error:', getErr);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/admin');
    }

    if (!rows || rows.length === 0) {
      req.flash('error_msg', 'Application not found.');
      return res.redirect('/admin');
    }

    const targetUserId = rows[0].user_id;
    const applicantEmail = rows[0].email;
    const applicantUsername = rows[0].username;

    const updateSql = `
      UPDATE sahm_applications
      SET
        status = ?,
        admin_id = ?,
        admin_comment = ?,
        updated_at = NOW()
      WHERE application_id = ?
    `;

    db.query(updateSql, [newStatus, adminId, adminComment || null, applicationId], (updErr) => {
      if (updErr) {
        console.error('adminUpdateApplicationStatus update error:', updErr);
        req.flash('error_msg', 'Failed to update application.');
        return res.redirect('/admin');
      }

      // Helper: send email but don't block success
      const sendEmailAndFinish = (successMsg) => {
        if (!applicantEmail) {
          req.flash('success_msg', successMsg);
          return res.redirect('/admin');
        }

        sendSahmApplicationStatusEmail(
          applicantEmail,
          { username: applicantUsername, status: newStatus, adminComment },
          (mailErr) => {
            if (mailErr) {
              console.error('SwapMates status email failed:', mailErr);
              req.flash('success_msg', successMsg + ' (Email failed to send)');
              return res.redirect('/admin');
            }

            req.flash('success_msg', successMsg + ' (Email sent)');
            return res.redirect('/admin');
          }
        );
      };

      // If not approving, email + done
      if (newStatus !== 'approved') {
        return sendEmailAndFinish(`Application updated to "${newStatus}".`);
      }

      // Approve -> convert user role to sahm
      const roleSql = `
        UPDATE users
        SET role = 'sahm'
        WHERE user_id = ?
      `;

      db.query(roleSql, [targetUserId], (roleErr) => {
        if (roleErr) {
          console.error('adminUpdateApplicationStatus role error:', roleErr);
          req.flash('error_msg', 'Approved, but failed to update user role.');
          return res.redirect('/admin');
        }

        // Ensure sahm_profiles exists (your schema uses sahm_user_id)
        const profileSql = `
          INSERT INTO sahm_profiles (sahm_user_id)
          SELECT ?
          WHERE NOT EXISTS (
            SELECT 1 FROM sahm_profiles WHERE sahm_user_id = ?
          )
        `;

        db.query(profileSql, [targetUserId, targetUserId], (pErr) => {
          if (pErr) console.error('ensure sahm_profiles error:', pErr);

          // Now email applicant and finish
          return sendEmailAndFinish('Application approved. User is now a SwapMates.');
        });
      });
    });
  });
};