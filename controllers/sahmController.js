// controllers/sahmController.js
const db = require('../db');

// -------------------------
// Helpers
// -------------------------
function requireLogin(req, res) {
  if (!req.session.user) {
    req.flash('error_msg', 'Please sign in first.');
    res.redirect('/login');
    return false;
  }
  return true;
}

function requireSAHM(req, res) {
  if (!requireLogin(req, res)) return false;

  if (req.session.user.role !== 'sahm') {
    req.flash('error_msg', 'Access denied. SwapMates only.');
    res.redirect('/');
    return false;
  }
  return true;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// -------------------------
// OneMap helpers (SAHM Add Location)
// -------------------------
let _onemapTokenCache = { token: null, expMs: 0 };

function _nowMs() { return Date.now(); }

async function onemapGetToken() {
  const email = (process.env.ONEMAP_EMAIL || '').trim();
  const password = (process.env.ONEMAP_PASSWORD || '').trim();

  if (!email || !password) {
    console.warn('[ONEMAP] Missing ONEMAP_EMAIL/ONEMAP_PASSWORD in .env. Skipping token fetch.');
    return null;
  }

  // reuse cached token if valid
  if (_onemapTokenCache.token && _onemapTokenCache.expMs > _nowMs()) {
    return _onemapTokenCache.token;
  }

  try {
    const resp = await fetch('https://www.onemap.gov.sg/api/auth/post/getToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || !data || !data.access_token) {
      console.warn('[ONEMAP] Token fetch failed:', data);
      return null;
    }

    const token = data.access_token;

    // Best-effort expiry handling
    // Some payloads have expires_in, some have expiry_timestamp, etc.
    let expMs = _nowMs() + (50 * 60 * 1000); // default 50 min
    if (data.expires_in) expMs = _nowMs() + (Number(data.expires_in) * 1000) - 60_000;
    if (data.expiry_timestamp) {
      const t = Number(data.expiry_timestamp);
      if (Number.isFinite(t)) expMs = t - 60_000;
    }

    _onemapTokenCache = { token, expMs };
    return token;
  } catch (e) {
    console.warn('[ONEMAP] Token fetch exception:', e?.message || e);
    return null;
  }
}

async function onemapSearchLatLng(searchVal) {
  const q = (searchVal || '').trim();
  if (!q) return null;

  const token = await onemapGetToken();

  try {
    const url = new URL('https://www.onemap.gov.sg/api/common/elastic/search');
    url.searchParams.set('searchVal', q);
    url.searchParams.set('returnGeom', 'Y');
    url.searchParams.set('getAddrDetails', 'Y');
    url.searchParams.set('pageNum', '1');

    // Some OneMap endpoints accept token via query; some via Authorization.
    // We do both to be safe.
    if (token) url.searchParams.set('token', token);

    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data) {
      console.warn('[ONEMAP] Search failed:', data);
      return null;
    }

    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return null;

    const r0 = results[0];

    // OneMap typically returns strings like "1.3521"
    const lat = Number(r0.LATITUDE || r0.latitude);
    const lng = Number(r0.LONGITUDE || r0.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { lat, lng, raw: r0 };
  } catch (e) {
    console.warn('[ONEMAP] Search exception:', e?.message || e);
    return null;
  }
}


// -------------------------
// GET /sahm (Dashboard)
// -------------------------
// -------------------------
// GET /sahm (Dashboard)
// -------------------------
exports.getSahmDashboard = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;

  // 1) Load profile + default location coords
 const profileSql = `
  SELECT
    sp.sahm_user_id,
    sp.description,
    sp.service_radius_km,
    sp.default_location_id,
    sp.paypal_email,
    loc.label AS default_location_label,
    loc.latitude AS default_lat,
    loc.longitude AS default_lng
  FROM sahm_profiles sp
  LEFT JOIN locations loc ON sp.default_location_id = loc.location_id
  WHERE sp.sahm_user_id = ?
  LIMIT 1
`;
  db.query(profileSql, [sahmId], (errP, pRows) => {
    if (errP) {
      console.error('getSahmDashboard profile error:', errP);
      req.flash('error_msg', 'Error loading SAHM profile.');
      return res.redirect('/');
    }

    const profile = (pRows && pRows[0]) ? pRows[0] : null;

    // 2) Locations dropdown
    const locationsSql = `
      SELECT location_id, user_id, label, address_line, city, postal_code, latitude, longitude, created_at
      FROM locations
      WHERE user_id = ? OR user_id IS NULL
      ORDER BY created_at DESC
    `;

    db.query(locationsSql, [sahmId], (errL, locRows) => {
      if (errL) console.error('getSahmDashboard locations error:', errL);
      const locations = locRows || [];

      // 3) Availability list
      const availabilitySql = `
        SELECT availability_id, day_of_week, date_specific, start_time, end_time, created_at
        FROM sahm_availability
        WHERE sahm_user_id = ?
        ORDER BY
          CASE day_of_week
            WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3
            WHEN 'thu' THEN 4 WHEN 'fri' THEN 5 WHEN 'sat' THEN 6
            WHEN 'sun' THEN 7 ELSE 99
          END,
          date_specific DESC,
          start_time ASC
      `;

      db.query(availabilitySql, [sahmId], (errA, aRows) => {
        if (errA) console.error('getSahmDashboard availability error:', errA);
        const availability = aRows || [];

        // --- Filter readiness flags ---
        const radiusKm = profile && profile.service_radius_km != null ? Number(profile.service_radius_km) : null;
        const baseLat = profile && profile.default_lat != null ? Number(profile.default_lat) : null;
        const baseLng = profile && profile.default_lng != null ? Number(profile.default_lng) : null;

        const radiusReady = Number.isFinite(radiusKm) && radiusKm > 0 && baseLat != null && baseLng != null;
        const needsAvailability = !(availability && availability.length > 0);

        let missingPickupCoordsCount = 0;

        // 4) Available orders (ONLY orders that are locked + scheduled + paid decision made)
        // Show only ONE row per order (leg = 'u1_to_u2') so SAHM accepts once
        const availableJobsSql = `
          SELECT
            pdr.request_id,
            pdr.match_id,
            pdr.leg,
            pdr.status,
            pdr.delivery_fee,
            pdr.sahm_earning,
            pdr.created_at,

            sm.scheduled_time,

            (SELECT COALESCE(SUM(t.delivery_fee),0) FROM pickup_delivery_requests t WHERE t.match_id = pdr.match_id) AS total_delivery_fee,
            (SELECT COALESCE(SUM(t.sahm_earning),0) FROM pickup_delivery_requests t WHERE t.match_id = pdr.match_id) AS total_sahm_earning,

            lp.label AS pickup_label,
            lp.address_line AS pickup_address,
            lp.latitude AS pickup_lat,
            lp.longitude AS pickup_lng,

            ld.label AS drop_label,
            ld.address_line AS drop_address,

            u1.user_id AS user1_id,
            u1.username AS user1_username,
            u2.user_id AS user2_id,
            u2.username AS user2_username,

            ci1.item_id AS item1_id,
            ci1.title AS item1_title,
            ci1.image_url_1 AS item1_image,

            ci2.item_id AS item2_id,
            ci2.title AS item2_title,
            ci2.image_url_1 AS item2_image
          FROM pickup_delivery_requests pdr
          JOIN swap_matches sm ON pdr.match_id = sm.match_id
          JOIN users u1 ON sm.user1_id = u1.user_id
          JOIN users u2 ON sm.user2_id = u2.user_id
          JOIN clothing_items ci1 ON sm.item1_id = ci1.item_id
          JOIN clothing_items ci2 ON sm.item2_id = ci2.item_id
          JOIN locations lp ON pdr.pickup_location_id = lp.location_id
          JOIN locations ld ON pdr.dropoff_location_id = ld.location_id
          WHERE pdr.status = 'pending'
            AND pdr.sahm_user_id IS NULL
            AND pdr.leg = 'u1_to_u2'
            AND sm.swap_method = 'sahm'
            AND sm.status = 'agreed'
            AND sm.details_locked = 1
            AND sm.payment_split IS NOT NULL
            AND sm.scheduled_time IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM pickup_delivery_requests p2
              WHERE p2.match_id = pdr.match_id
                AND p2.sahm_user_id IS NOT NULL
            )
            AND EXISTS (
              SELECT 1
              FROM sahm_availability a
              WHERE a.sahm_user_id = ?
                AND (
                  (a.date_specific IS NOT NULL AND DATE(a.date_specific) = DATE(sm.scheduled_time))
                  OR
                  (a.day_of_week IS NOT NULL AND a.day_of_week = (
                    CASE DAYOFWEEK(sm.scheduled_time)
                      WHEN 1 THEN 'sun'
                      WHEN 2 THEN 'mon'
                      WHEN 3 THEN 'tue'
                      WHEN 4 THEN 'wed'
                      WHEN 5 THEN 'thu'
                      WHEN 6 THEN 'fri'
                      WHEN 7 THEN 'sat'
                    END
                  ))
                )
                AND (a.start_time IS NULL OR a.start_time <= TIME(sm.scheduled_time))
                AND (a.end_time   IS NULL OR a.end_time   >= TIME(sm.scheduled_time))

            )
            -- ✅ NEW: if SAHM is one of the swappers, hide their own orders
            AND sm.user1_id <> ?
            AND sm.user2_id <> ?
          ORDER BY sm.scheduled_time ASC, pdr.created_at DESC
          LIMIT 50
        `;

        const handleJobs = (availableJobs) => {
          // 5) Active jobs
          const activeJobsSql = `
            SELECT
              pdr.request_id,
              pdr.match_id,
              pdr.status,
              pdr.delivery_fee,
              pdr.sahm_earning,
              pdr.is_earning_paid,
              pdr.payout_id,
              pdr.created_at,
              pdr.updated_at,

              sm.scheduled_time,

              lp.label AS pickup_label,
              ld.label AS drop_label,

              u1.username AS user1_username,
              u2.username AS user2_username
            FROM pickup_delivery_requests pdr
            JOIN swap_matches sm ON pdr.match_id = sm.match_id
            JOIN users u1 ON sm.user1_id = u1.user_id
            JOIN users u2 ON sm.user2_id = u2.user_id
            JOIN locations lp ON pdr.pickup_location_id = lp.location_id
            JOIN locations ld ON pdr.dropoff_location_id = ld.location_id
            WHERE pdr.sahm_user_id = ?
              AND pdr.status IN ('accepted','in_progress')
            ORDER BY pdr.updated_at DESC
          `;

          db.query(activeJobsSql, [sahmId], (errAct, actRows) => {
            if (errAct) console.error('activeJobs error:', errAct);
            const activeJobs = actRows || [];

            // 6) Completed jobs
            const completedJobsSql = `
              SELECT
                pdr.request_id,
                pdr.match_id,
                pdr.status,
                pdr.delivery_fee,
                pdr.sahm_earning,
                pdr.is_earning_paid,
                pdr.payout_id,
                pdr.created_at,
                pdr.updated_at,
                sm.scheduled_time,
                lp.label AS pickup_label,
                ld.label AS drop_label
              FROM pickup_delivery_requests pdr
              JOIN swap_matches sm ON pdr.match_id = sm.match_id
              JOIN locations lp ON pdr.pickup_location_id = lp.location_id
              JOIN locations ld ON pdr.dropoff_location_id = ld.location_id
              WHERE pdr.sahm_user_id = ?
                AND pdr.status = 'completed'
              ORDER BY pdr.updated_at DESC
              LIMIT 50
            `;

            db.query(completedJobsSql, [sahmId], (errComp, compRows) => {
              if (errComp) console.error('completedJobs error:', errComp);
              const completedJobs = compRows || [];

              // 7) Earnings summary
              const earningsSql = `
                SELECT
                  COALESCE(SUM(CASE WHEN status = 'completed' THEN IFNULL(sahm_earning,0) ELSE 0 END),0) AS total_earned,
                  COALESCE(SUM(CASE WHEN status = 'completed' AND is_earning_paid = 0 THEN IFNULL(sahm_earning,0) ELSE 0 END),0) AS pending_payout,
                  COALESCE(SUM(CASE WHEN is_earning_paid = 1 THEN IFNULL(sahm_earning,0) ELSE 0 END),0) AS marked_paid
                FROM pickup_delivery_requests
                WHERE sahm_user_id = ?
              `;

              db.query(earningsSql, [sahmId], (errE, eRows) => {
                if (errE) console.error('earnings error:', errE);
                const earnings = (eRows && eRows[0]) ? eRows[0] : { total_earned: 0, pending_payout: 0, marked_paid: 0 };

                const ongoingSql = `
                  SELECT COUNT(*) AS ongoingCount
                  FROM pickup_delivery_requests
                  WHERE sahm_user_id = ?
                    AND status IN ('accepted','in_progress')
                `;

                db.query(ongoingSql, [sahmId], (errO, oRows) => {
                  if (errO) console.error('ongoing error:', errO);
                  const ongoingCount = (oRows && oRows[0]) ? Number(oRows[0].ongoingCount) : 0;

                  const payoutListSql = `
                    SELECT payout_id, total_amount, status, created_at, processed_at
                    FROM sahm_payout_requests
                    WHERE sahm_user_id = ?
                    ORDER BY created_at DESC
                    LIMIT 20
                  `;

                  db.query(payoutListSql, [sahmId], (errPL, prRows) => {
                    if (errPL) console.error('payout list error:', errPL);
                    const payoutRequests = prRows || [];

                    return res.render('sahmDashboard', {
                      user: req.session.user,
                      profile,
                      locations,
                      availability,
                      availableJobs,
                      activeJobs,
                      completedJobs,
                      earnings,
                      ongoingCount,
                      payoutRequests,
                      filters: {
                        radiusReady,
                        needsAvailability,
                        radiusKm,
                        baseLat,
                        baseLng,
                        missingPickupCoordsCount
                      }
                    });
                  });
                });
              });
            });
          });
        };

        // Strict: if SAHM hasn't configured BOTH radius+default coords OR has no availability, show no orders
        if (!radiusReady || needsAvailability) {
          return handleJobs([]);
        }

        // ✅ IMPORTANT: param order matches ? in SQL:
        // 1) availability a.sahm_user_id = ?
        // 2) sm.user1_id <> ?
        // 3) sm.user2_id <> ?
        db.query(availableJobsSql, [sahmId, sahmId, sahmId], (errJ, jRows) => {
          if (errJ) console.error('availableJobs error:', errJ);

          let availableJobs = jRows || [];

          // Radius filter (strict): hide orders with missing pickup coords, and hide orders outside radius.
          availableJobs = availableJobs
            .map((job) => {
              const pLat = job.pickup_lat != null ? Number(job.pickup_lat) : null;
              const pLng = job.pickup_lng != null ? Number(job.pickup_lng) : null;

              if (pLat == null || pLng == null) {
                missingPickupCoordsCount += 1;
                return null;
              }

              const d = haversineKm(baseLat, baseLng, pLat, pLng);
              if (!Number.isFinite(d) || d > radiusKm) return null;

              return { ...job, distance_km: d };
            })
            .filter(Boolean);

          return handleJobs(availableJobs);
        });
      });
    });
  });
};

// -------------------------
// POST /sahm/profile (update profile)
// -------------------------
// -------------------------
// POST /sahm/profile (update profile)
// Now includes paypal_email for payout
// -------------------------
exports.postUpdateSahmProfile = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;

  const description = (req.body.description || '').trim();
  const serviceRadius = req.body.service_radius_km ? Number(req.body.service_radius_km) : null;
  const defaultLocationId = req.body.default_location_id ? Number(req.body.default_location_id) : null;

  // NEW
  const paypalEmailRaw = (req.body.paypal_email || '').trim();
  const paypalEmail = paypalEmailRaw ? paypalEmailRaw.toLowerCase() : null;

  // Basic validation (keep it simple)
  if (paypalEmail) {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypalEmail);
    if (!emailOk) {
      req.flash('error_msg', 'Invalid PayPal email format.');
      return res.redirect('/sahm');
    }
  }

  const sql = `
    INSERT INTO sahm_profiles
      (sahm_user_id, description, service_radius_km, default_location_id, paypal_email)
    VALUES
      (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      description = VALUES(description),
      service_radius_km = VALUES(service_radius_km),
      default_location_id = VALUES(default_location_id),
      paypal_email = VALUES(paypal_email)
  `;

  db.query(
    sql,
    [
      sahmId,
      description || null,
      (Number.isFinite(serviceRadius) && serviceRadius > 0) ? serviceRadius : null,
      defaultLocationId || null,
      paypalEmail
    ],
    (err) => {
      if (err) {
        console.error('postUpdateSahmProfile error:', err);

        // If you made paypal_email UNIQUE, duplicate will throw ER_DUP_ENTRY
        if (err.code === 'ER_DUP_ENTRY') {
          req.flash('error_msg', 'This PayPal email is already used by another SAHM. Please use a different one.');
          return res.redirect('/sahm');
        }

        req.flash('error_msg', 'Failed to update profile.');
        return res.redirect('/sahm');
      }

      req.flash('success_msg', 'SAHM profile updated.');
      return res.redirect('/sahm');
    }
  );
};

// -------------------------
// POST /sahm/availability/add
// -------------------------
exports.postAddAvailability = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;

  const dayOfWeek = (req.body.day_of_week || '').trim() || null;      // mon..sun OR null
  const dateSpecific = (req.body.date_specific || '').trim() || null; // YYYY-MM-DD OR null
  const startTime = (req.body.start_time || '').trim();
  const endTime = (req.body.end_time || '').trim();

  if (!startTime || !endTime) {
    req.flash('error_msg', 'Start and end time are required.');
    return res.redirect('/sahm');
  }

  if (!dayOfWeek && !dateSpecific) {
    req.flash('error_msg', 'Pick a day of week OR a specific date.');
    return res.redirect('/sahm');
  }

  const sql = `
    INSERT INTO sahm_availability (sahm_user_id, day_of_week, date_specific, start_time, end_time)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.query(sql, [sahmId, dayOfWeek, dateSpecific, startTime, endTime], (err) => {
    if (err) {
      console.error('postAddAvailability error:', err);
      req.flash('error_msg', 'Failed to add availability.');
      return res.redirect('/sahm');
    }

    req.flash('success_msg', 'Availability added.');
    return res.redirect('/sahm');
  });
};

// -------------------------
// POST /sahm/availability/:id/delete
// -------------------------
exports.postDeleteAvailability = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;
  const availabilityId = Number(req.params.id);

  const sql = `
    DELETE FROM sahm_availability
    WHERE availability_id = ?
      AND sahm_user_id = ?
  `;

  db.query(sql, [availabilityId, sahmId], (err) => {
    if (err) {
      console.error('postDeleteAvailability error:', err);
      req.flash('error_msg', 'Failed to delete availability.');
      return res.redirect('/sahm');
    }

    req.flash('success_msg', 'Availability removed.');
    return res.redirect('/sahm');
  });
};

// -------------------------
// POST /sahm/jobs/:id/accept
// -------------------------
// -------------------------
// POST /sahm/jobs/:id/accept
// -------------------------
exports.postAcceptJob = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;
  const requestId = Number(req.params.id);

  if (!requestId) {
    req.flash('error_msg', 'Invalid request.');
    return res.redirect('/sahm');
  }

  // 1) Load SAHM radius + default location coords (must be set for validation)
  const profileSql = `
    SELECT sp.service_radius_km, loc.latitude AS base_lat, loc.longitude AS base_lng
    FROM sahm_profiles sp
    LEFT JOIN locations loc ON sp.default_location_id = loc.location_id
    WHERE sp.sahm_user_id = ?
    LIMIT 1
  `;

  db.query(profileSql, [sahmId], (pErr, pRows) => {
    if (pErr) {
      console.error('postAcceptJob profile error:', pErr);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/sahm');
    }

    const radiusKm = pRows && pRows[0] && pRows[0].service_radius_km != null ? Number(pRows[0].service_radius_km) : null;
    const baseLat = pRows && pRows[0] && pRows[0].base_lat != null ? Number(pRows[0].base_lat) : null;
    const baseLng = pRows && pRows[0] && pRows[0].base_lng != null ? Number(pRows[0].base_lng) : null;

    const radiusReady = Number.isFinite(radiusKm) && radiusKm > 0 && baseLat != null && baseLng != null;
    if (!radiusReady) {
      req.flash('error_msg', 'Set your default location (with lat/lng) and service radius before accepting orders.');
      return res.redirect('/sahm');
    }

    // 2) Validate job is still available AND matches SAHM availability AND is within radius
    const jobSql = `
      SELECT
        pdr.request_id,
        pdr.match_id,
        lp.latitude AS pickup_lat,
        lp.longitude AS pickup_lng,
        sm.scheduled_time
      FROM pickup_delivery_requests pdr
      JOIN swap_matches sm ON pdr.match_id = sm.match_id
      JOIN locations lp ON pdr.pickup_location_id = lp.location_id
      WHERE pdr.request_id = ?
        AND pdr.status = 'pending'
        AND pdr.sahm_user_id IS NULL
        AND sm.swap_method = 'sahm'
        AND sm.status = 'agreed'
        AND sm.details_locked = 1
        AND sm.payment_split IS NOT NULL
        AND sm.scheduled_time IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM sahm_availability a
          WHERE a.sahm_user_id = ?
            AND (
              (a.date_specific IS NOT NULL AND a.date_specific = DATE(sm.scheduled_time))
              OR
              (a.day_of_week IS NOT NULL AND a.day_of_week = (
                CASE DAYOFWEEK(sm.scheduled_time)
                  WHEN 1 THEN 'sun'
                  WHEN 2 THEN 'mon'
                  WHEN 3 THEN 'tue'
                  WHEN 4 THEN 'wed'
                  WHEN 5 THEN 'thu'
                  WHEN 6 THEN 'fri'
                  WHEN 7 THEN 'sat'
                END
              ))
            )
            AND a.start_time <= TIME(sm.scheduled_time)
            AND a.end_time >= TIME(sm.scheduled_time)
        )
        -- ✅ NEW: block SAHM from accepting own swap (if SAHM is one of the swappers)
        AND sm.user1_id <> ?
        AND sm.user2_id <> ?
      LIMIT 1
    `;

    // ✅ param order matches ?:
    // 1) requestId
    // 2) availability a.sahm_user_id (sahmId)
    // 3) sm.user1_id <> (sahmId)
    // 4) sm.user2_id <> (sahmId)
    db.query(jobSql, [requestId, sahmId, sahmId, sahmId], (jErr, jRows) => {
      if (jErr) {
        console.error('postAcceptJob jobSql error:', jErr);
        req.flash('error_msg', 'Server error.');
        return res.redirect('/sahm');
      }

      const job = (jRows && jRows[0]) ? jRows[0] : null;
      if (!job) {
        req.flash('error_msg', 'This order is no longer available.');
        return res.redirect('/sahm');
      }

      const pLat = job.pickup_lat != null ? Number(job.pickup_lat) : null;
      const pLng = job.pickup_lng != null ? Number(job.pickup_lng) : null;
      if (pLat == null || pLng == null) {
        req.flash('error_msg', 'This order cannot be accepted because the pickup location has no lat/lng.');
        return res.redirect('/sahm');
      }

      const dist = haversineKm(baseLat, baseLng, pLat, pLng);
      if (!Number.isFinite(dist) || dist > radiusKm) {
        req.flash('error_msg', `This order is outside your service radius (${radiusKm} km).`);
        return res.redirect('/sahm');
      }

      // 3) Accept the ENTIRE order (both legs):
      // - assign both pdr rows for that match
      // - only if nothing has been assigned yet (race protection)
      const acceptSql = `
        UPDATE pickup_delivery_requests p
        JOIN pickup_delivery_requests x ON x.request_id = ?
        JOIN swap_matches sm ON sm.match_id = x.match_id
        JOIN (
          SELECT match_id, SUM(CASE WHEN sahm_user_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned_count
          FROM pickup_delivery_requests
          GROUP BY match_id
        ) ac ON ac.match_id = x.match_id
        SET p.sahm_user_id = ?, p.status = 'accepted', p.updated_at = NOW()
        WHERE p.match_id = x.match_id
          AND p.status = 'pending'
          AND p.sahm_user_id IS NULL
          AND ac.assigned_count = 0
          AND sm.swap_method = 'sahm'
          AND sm.status = 'agreed'
          AND sm.details_locked = 1
          AND sm.payment_split IS NOT NULL
          AND sm.scheduled_time IS NOT NULL
          -- ✅ NEW: extra guard (even if someone bypasses UI)
          AND sm.user1_id <> ?
          AND sm.user2_id <> ?
      `;

      // ✅ param order matches ?:
      // 1) requestId (x.request_id)
      // 2) sahmId (SET p.sahm_user_id)
      // 3) sm.user1_id <> sahmId
      // 4) sm.user2_id <> sahmId
      db.query(acceptSql, [requestId, sahmId, sahmId, sahmId], (uErr, result) => {
        if (uErr) {
          console.error('postAcceptJob acceptSql error:', uErr);
          req.flash('error_msg', 'Failed to accept order.');
          return res.redirect('/sahm');
        }

        if (!result || result.affectedRows === 0) {
          req.flash('error_msg', 'This order is no longer available.');
          return res.redirect('/sahm');
        }

        req.flash('success_msg', 'Order accepted (both legs assigned to you).');
        return res.redirect('/sahm');
      });
    });
  });
};

// -------------------------
// POST /sahm/jobs/:id/pickup  (accepted -> in_progress)
// -------------------------
exports.postPickupJob = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;
  const requestId = Number(req.params.id);

  const sql = `
    UPDATE pickup_delivery_requests
    SET status = 'in_progress', updated_at = NOW()
    WHERE request_id = ?
      AND sahm_user_id = ?
      AND status = 'accepted'
  `;

  db.query(sql, [requestId, sahmId], (err, result) => {
    if (err) {
      console.error('postPickupJob error:', err);
      req.flash('error_msg', 'Failed to update job.');
      return res.redirect('/sahm');
    }

    if (!result || result.affectedRows === 0) {
      req.flash('error_msg', 'Job not found or not in accepted state.');
      return res.redirect('/sahm');
    }

    req.flash('success_msg', 'Status updated: On the way.');
    return res.redirect('/sahm');
  });
};

// -------------------------
// POST /sahm/jobs/:id/delivered (in_progress -> completed)
// -------------------------
// -------------------------
// POST /sahm/jobs/:id/delivered (in_progress -> completed)
// After BOTH legs completed -> swap_matches.status = 'completed'
// -------------------------
exports.postDeliveredJob = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;
  const requestId = Number(req.params.id);

  const sql = `
    UPDATE pickup_delivery_requests
    SET status = 'completed', updated_at = NOW()
    WHERE request_id = ?
      AND sahm_user_id = ?
      AND status = 'in_progress'
  `;

  db.query(sql, [requestId, sahmId], (err, result) => {
    if (err) {
      console.error('postDeliveredJob error:', err);
      req.flash('error_msg', 'Failed to complete job.');
      return res.redirect('/sahm');
    }

    if (!result || result.affectedRows === 0) {
      req.flash('error_msg', 'Job not found or not in progress.');
      return res.redirect('/sahm');
    }

    // 1) Find the match_id for this request
    const matchSql = `
      SELECT match_id
      FROM pickup_delivery_requests
      WHERE request_id = ?
        AND sahm_user_id = ?
      LIMIT 1
    `;

    db.query(matchSql, [requestId, sahmId], (err2, rows) => {
      if (err2) {
        console.error('postDeliveredJob matchSql error:', err2);
        req.flash('success_msg', 'Delivered. Job completed!');
        return res.redirect('/sahm');
      }

      if (!rows || rows.length === 0) {
        req.flash('success_msg', 'Delivered. Job completed!');
        return res.redirect('/sahm');
      }

      const matchId = rows[0].match_id;

      // 2) Check if BOTH legs for this match are completed
      const checkSql = `
        SELECT
          COUNT(*) AS totalLegs,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedLegs
        FROM pickup_delivery_requests
        WHERE match_id = ?
      `;

      db.query(checkSql, [matchId], (err3, rows3) => {
        if (err3) {
          console.error('postDeliveredJob checkSql error:', err3);
          req.flash('success_msg', 'Delivered. Job completed!');
          return res.redirect('/sahm');
        }

        const totalLegs = Number(rows3?.[0]?.totalLegs || 0);
        const completedLegs = Number(rows3?.[0]?.completedLegs || 0);

        // Your design: exactly 2 legs (u1_to_u2 + u2_to_u1)
        if (totalLegs === 2 && completedLegs === 2) {
          const updMatchSql = `
            UPDATE swap_matches
            SET status = 'completed', updated_at = NOW()
            WHERE match_id = ?
              AND swap_method = 'sahm'
              AND status NOT IN ('cancelled','completed')
          `;

          db.query(updMatchSql, [matchId], (err4) => {
            if (err4) {
              console.error('postDeliveredJob updMatchSql error:', err4);
              req.flash('success_msg', 'Delivered. Job completed!');
              return res.redirect('/sahm');
            }

            // ✅ NEW: mark BOTH clothing items in this match as completed
            const updItemsSql = `
              UPDATE clothing_items ci
              JOIN swap_matches sm
                ON ci.item_id IN (sm.item1_id, sm.item2_id)
              SET ci.status = 'swapped',
                  ci.updated_at = NOW()
              WHERE sm.match_id = ?
            `;

            db.query(updItemsSql, [matchId], (err5) => {
              if (err5) {
                console.error('postDeliveredJob updItemsSql error:', err5);
                // still consider the swap completed, just log item update failure
                req.flash('success_msg', 'Delivered. Job completed! Swap marked as completed. (Item status update failed)');
                return res.redirect('/sahm');
              }

              req.flash('success_msg', 'Delivered. Job completed! Swap marked as completed.');
              return res.redirect('/sahm');
            });
          });
        } else {
          req.flash('success_msg', 'Delivered. Job completed!');
          return res.redirect('/sahm');
        }
      });
    });
  });
};



// -------------------------
// POST /sahm/payout/request
// Rules:
// - cannot request if any accepted/in_progress
// - only include completed + is_earning_paid=0
// - create payout request, then tag the deliveries with payout_id + is_earning_paid=1
// -------------------------
exports.postRequestPayout = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;

  const ongoingSql = `
    SELECT COUNT(*) AS ongoingCount
    FROM pickup_delivery_requests
    WHERE sahm_user_id = ?
      AND status IN ('accepted','in_progress')
  `;

  db.query(ongoingSql, [sahmId], (errO, oRows) => {
    if (errO) {
      console.error('postRequestPayout ongoing error:', errO);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/sahm');
    }

    const ongoingCount = (oRows && oRows[0]) ? Number(oRows[0].ongoingCount) : 0;
    if (ongoingCount > 0) {
      req.flash('error_msg', 'You have ongoing jobs. Complete them before requesting payout.');
      return res.redirect('/sahm');
    }

    // Must have PayPal email saved
    const emailSql = `
      SELECT paypal_email
      FROM sahm_profiles
      WHERE sahm_user_id = ?
      LIMIT 1
    `;

    db.query(emailSql, [sahmId], (errE, eRows) => {
      if (errE) {
        console.error('postRequestPayout emailSql error:', errE);
        req.flash('error_msg', 'Server error.');
        return res.redirect('/sahm');
      }

      const paypalEmail = (eRows && eRows[0]) ? (eRows[0].paypal_email || '').trim() : '';
      if (!paypalEmail) {
        req.flash('error_msg', 'Please set your PayPal email in your SAHM profile before requesting payout.');
        return res.redirect('/sahm');
      }

      const sumSql = `
        SELECT COALESCE(SUM(IFNULL(sahm_earning,0)),0) AS total
        FROM pickup_delivery_requests
        WHERE sahm_user_id = ?
          AND status = 'completed'
          AND is_earning_paid = 0
          AND payout_id IS NULL
      `;

      db.query(sumSql, [sahmId], (errS, sRows) => {
        if (errS) {
          console.error('postRequestPayout sum error:', errS);
          req.flash('error_msg', 'Server error.');
          return res.redirect('/sahm');
        }

        const total = (sRows && sRows[0]) ? Number(sRows[0].total) : 0;
        if (!total || total <= 0) {
          req.flash('error_msg', 'No pending earnings to request payout.');
          return res.redirect('/sahm');
        }

        // Create payout request (admin approval required)
        const insertSql = `
          INSERT INTO sahm_payout_requests
            (sahm_user_id, total_amount, status, receiver_email, currency, payout_method)
          VALUES
            (?, ?, 'pending', ?, 'SGD', 'paypal')
        `;

        db.query(insertSql, [sahmId, total, paypalEmail], (errI, result) => {
          if (errI) {
            console.error('postRequestPayout insert error:', errI);
            req.flash('error_msg', 'Failed to create payout request.');
            return res.redirect('/sahm');
          }

          const payoutId = result && result.insertId ? Number(result.insertId) : null;
          if (!payoutId) {
            req.flash('error_msg', 'Payout created but missing payout id.');
            return res.redirect('/sahm');
          }

          // Lock earnings into this payout request (DO NOT mark is_earning_paid yet)
          const tagSql = `
            UPDATE pickup_delivery_requests
            SET payout_id = ?, updated_at = NOW()
            WHERE sahm_user_id = ?
              AND status = 'completed'
              AND is_earning_paid = 0
              AND payout_id IS NULL
          `;

          db.query(tagSql, [payoutId, sahmId], (errT) => {
            if (errT) console.error('postRequestPayout tag error:', errT);

            req.flash('success_msg', `Payout request submitted (#${payoutId}). Waiting for admin approval.`);
            return res.redirect('/sahm');
          });
        });
      });
    });
  });
};

exports.postUpdateAvailability = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;
  const availabilityId = Number(req.params.id);

  const dayOfWeek = (req.body.day_of_week || '').trim() || null;
  const dateSpecific = (req.body.date_specific || '').trim() || null; // YYYY-MM-DD or null
  const startTime = (req.body.start_time || '').trim();
  const endTime = (req.body.end_time || '').trim();

  if (!availabilityId) {
    req.flash('error_msg', 'Invalid availability update request.');
    return res.redirect('/sahm');
  }

  if (!startTime || !endTime) {
    req.flash('error_msg', 'Start and end time are required.');
    return res.redirect('/sahm');
  }

  if (!dayOfWeek && !dateSpecific) {
    req.flash('error_msg', 'Pick a day of week OR a specific date.');
    return res.redirect('/sahm');
  }

  const sql = `
    UPDATE sahm_availability
    SET
      day_of_week = ?,
      date_specific = ?,
      start_time = ?,
      end_time = ?
    WHERE availability_id = ?
      AND sahm_user_id = ?
    LIMIT 1
  `;

  db.query(
    sql,
    [dayOfWeek, dateSpecific, startTime, endTime, availabilityId, sahmId],
    (err, result) => {
      if (err) {
        console.error('postUpdateAvailability error:', err);
        req.flash('error_msg', 'Failed to update availability.');
        return res.redirect('/sahm');
      }

      if (!result || result.affectedRows === 0) {
        req.flash('error_msg', 'Availability not found or not yours.');
        return res.redirect('/sahm');
      }

      req.flash('success_msg', 'Availability updated.');
      return res.redirect('/sahm');
    }
  );
};


// POST /sahm/locations/add
// POST /sahm/locations/add
exports.postAddSahmLocation = async (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;

  const label = (req.body.label || '').trim();
  const addressLine = (req.body.address_line || '').trim();
  const city = (req.body.city || '').trim();
  const postalCode = (req.body.postal_code || '').trim();

  const latRaw = (req.body.latitude || '').trim();
  const lngRaw = (req.body.longitude || '').trim();

  if (!label) {
    req.flash('error_msg', 'Location label is required.');
    return res.redirect('/sahm');
  }

  let latitude = null;
  let longitude = null;

  // 1) If user provided lat/lng, validate and use them
  if (latRaw || lngRaw) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      req.flash('error_msg', 'Latitude/Longitude must be valid numbers (or leave both blank).');
      return res.redirect('/sahm');
    }

    latitude = lat;
    longitude = lng;
  }

  // 2) If lat/lng not provided, try OneMap
  if (latitude == null || longitude == null) {
    const searchQuery =
      (postalCode ? postalCode : '') ||
      [label, addressLine, city, postalCode].filter(Boolean).join(' ');

    const found = await onemapSearchLatLng(searchQuery);

    if (found && Number.isFinite(found.lat) && Number.isFinite(found.lng)) {
      latitude = found.lat;
      longitude = found.lng;
      console.log('[ONEMAP] Auto-filled lat/lng for SAHM location:', { q: searchQuery, lat: latitude, lng: longitude });
    } else {
      console.warn('[ONEMAP] No results for SAHM location auto-fill. Insert will proceed with NULL coords.', { q: searchQuery });
      // Keep nulls (still insert)
      latitude = null;
      longitude = null;
    }
  }

  const insertSql = `
    INSERT INTO locations (user_id, label, address_line, city, postal_code, latitude, longitude)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    insertSql,
    [sahmId, label, addressLine || null, city || null, postalCode || null, latitude, longitude],
    (err) => {
      if (err) {
        console.error('postAddSahmLocation error:', err);
        req.flash('error_msg', 'Failed to add location.');
        return res.redirect('/sahm');
      }

      if (latitude != null && longitude != null) {
        req.flash('success_msg', 'Location added (lat/lng auto-filled).');
      } else {
        req.flash('success_msg', 'Location added.');
      }

      return res.redirect('/sahm');
    }
  );
};



// POST /sahm/locations/:id/delete
exports.postDeleteSahmLocation = (req, res) => {
  if (!requireSAHM(req, res)) return;

  const sahmId = req.session.user.user_id;
  const locationId = Number(req.params.id);

  if (!locationId) {
    req.flash('error_msg', 'Invalid location.');
    return res.redirect('/sahm');
  }

  // pre-check usage to avoid ugly FK errors
  const usageSql = `
    SELECT
      (SELECT COUNT(*) FROM pickup_delivery_requests
        WHERE pickup_location_id = ? OR dropoff_location_id = ?) AS used_in_deliveries,
      (SELECT COUNT(*) FROM sahm_profiles
        WHERE sahm_user_id = ? AND default_location_id = ?) AS used_as_default
  `;

  db.query(usageSql, [locationId, locationId, sahmId, locationId], (uErr, uRows) => {
    if (uErr) {
      console.error('postDeleteSahmLocation usage error:', uErr);
      req.flash('error_msg', 'Server error.');
      return res.redirect('/sahm');
    }

    const usedDeliveries = Number(uRows?.[0]?.used_in_deliveries || 0);
    const usedDefault = Number(uRows?.[0]?.used_as_default || 0);

    if (usedDefault > 0) {
      req.flash('error_msg', 'Cannot delete. This location is your default location.');
      return res.redirect('/sahm');
    }

    if (usedDeliveries > 0) {
      req.flash('error_msg', 'Cannot delete. This location is used in delivery requests.');
      return res.redirect('/sahm');
    }

    const delSql = `
      DELETE FROM locations
      WHERE location_id = ?
        AND user_id = ?
      LIMIT 1
    `;

    db.query(delSql, [locationId, sahmId], (dErr, result) => {
      if (dErr) {
        console.error('postDeleteSahmLocation delete error:', dErr);
        req.flash('error_msg', 'Failed to delete location.');
        return res.redirect('/sahm');
      }

      if (!result || result.affectedRows === 0) {
        req.flash('error_msg', 'Location not found (or not yours).');
        return res.redirect('/sahm');
      }

      req.flash('success_msg', 'Location deleted.');
      return res.redirect('/sahm');
    });
  });
};
