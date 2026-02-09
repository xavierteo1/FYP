const db = require('../db');

/**
 * matches your real database structure:
 *
 * brands(brand_id, name)
 * tags(tag_id, name)
 * clothing_items(
 *   item_id, owner_user_id, brand_id,
 *   title, description, category,
 *   size_label, color, condition_grade,
 *   is_for_swap (tinyint), is_public (tinyint),
 *   image_url_1, image_url_2, image_url_3,
 *   created_at, updated_at
 * )
 * item_tags(item_id, tag_id)
 */

// ===========================
// LOAD WARDROBE
// ===========================
exports.getWardrobePage = (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const userId = req.session.user.user_id;

    const query = `
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
            ci.status,
            ci.image_url_1,
            ci.image_url_2,
            ci.image_url_3,
            b.name AS brand_name
        FROM clothing_items ci
        LEFT JOIN brands b ON ci.brand_id = b.brand_id
        WHERE ci.owner_user_id = ? AND NOT ci.status = 'swapped'
        ORDER BY ci.created_at DESC
    `;

    db.query(query, [userId], (err, items) => {
        if (err) {
            console.error("Wardrobe load error:", err);
            return res.render("wardrobe", {
                personalItems: [],
                swapItems: [],
                message: "Error loading wardrobe."
            });
        }

        const personalItems = items || [];
        const swapItems = personalItems.filter(i => i.is_for_swap === 1);

        res.render("wardrobe", {
            personalItems,
            swapItems,
            message: null
        });
    });
};


// ======================================
// SHOW UPLOAD FORM
// ======================================
exports.showUploadForm = (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const brandsQuery = `SELECT brand_id, name FROM brands ORDER BY name ASC LIMIT 50`;
    const tagsQuery   = `SELECT tag_id, name FROM tags ORDER BY name ASC LIMIT 50`;

    db.query(brandsQuery, (errBrands, brands) => {
        if (errBrands) {
            console.error("Error loading brands:", errBrands);
            return res.render("uploadClothing", {
                message: "Error loading brands.",
                brands: [],
                tags: []
            });
        }

        db.query(tagsQuery, (errTags, tags) => {
            if (errTags) {
                console.error("Error loading tags:", errTags);
                return res.render("uploadClothing", {
                    message: "Error loading tags.",
                    brands,
                    tags: []
                });
            }

            res.render("uploadClothing", {
                message: null,
                brands,
                tags
            });
        });
    });
};


// ======================================
// HELPERS: UPSERT BRAND/TAGS + LINK
// ======================================
function upsertBrand(brandName, callback) {
    if (!brandName || brandName.trim() === "") {
        return callback(new Error("Brand name is required."));
    }
    const clean = brandName.trim();

    const selectQuery = `SELECT brand_id FROM brands WHERE name = ?`;
    db.query(selectQuery, [clean], (err, rows) => {
        if (err) {
            console.error("Error checking brand:", err);
            return callback(err);
        }

        if (rows.length > 0) {
            return callback(null, rows[0].brand_id);
        }

        const insertQuery = `INSERT INTO brands (name) VALUES (?)`;
        db.query(insertQuery, [clean], (err2, result) => {
            if (err2) {
                console.error("Error inserting brand:", err2);
                return callback(err2);
            }
            return callback(null, result.insertId);
        });
    });
}

function upsertTags(tagNames, callback) {
    const tagIds = [];

    function next(i) {
        if (i === tagNames.length) return callback(null, tagIds);

        const clean = tagNames[i];

        db.query(`SELECT tag_id FROM tags WHERE name = ?`, [clean], (err, rows) => {
            if (err) {
                console.error("Error checking tag:", err);
                return callback(err);
            }

            if (rows.length > 0) {
                tagIds.push(rows[0].tag_id);
                return next(i + 1);
            }

            db.query(`INSERT INTO tags (name) VALUES (?)`, [clean], (err2, result) => {
                if (err2) {
                    console.error("Error inserting tag:", err2);
                    return callback(err2);
                }
                tagIds.push(result.insertId);
                return next(i + 1);
            });
        });
    }

    next(0);
}

function linkItemTags(itemId, tagIds, callback) {
    if (!tagIds || tagIds.length === 0) return callback(null);

    function next(i) {
        if (i === tagIds.length) return callback(null);

        db.query(
            `INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?)`,
            [itemId, tagIds[i]],
            (err) => {
                if (err) {
                    console.error("Error linking item-tags:", err);
                    return callback(err);
                }
                next(i + 1);
            }
        );
    }

    next(0);
}


// ======================================
// UPLOAD ITEM (CREATE)
// ======================================
exports.uploadItem = (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const userId = req.session.user.user_id;

    const {
        title,
        description,
        brand,
        category,
        size_label,
        color,
        condition_grade,
        tags,
        is_for_swap,
        is_public
    } = req.body;

    const img1 = req.files?.image1 ? req.files.image1[0].path : null;
    const img2 = req.files?.image2 ? req.files.image2[0].path : null;
    const img3 = req.files?.image3 ? req.files.image3[0].path : null;

    if (!title || !brand || !category || !tags) {
        return res.send("Missing required fields.");
    }

    const swapVal   = is_for_swap === 'yes' ? 1 : 0;
    const publicVal = swapVal === 1 ? 1 : (is_public === 'yes' ? 1 : 0);

    const tagList = tags
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0);

    // 1. Upsert brand
    upsertBrand(brand, (brandErr, brandId) => {
        if (brandErr) {
            console.error("Error processing brand:", brandErr);
            return res.send("Error processing brand.");
        }

        // 2. Insert item
        const insertItemQuery = `
            INSERT INTO clothing_items
            (owner_user_id, brand_id, title, description, category, 
             size_label, color, condition_grade, is_for_swap, is_public,
             image_url_1, image_url_2, image_url_3)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(
            insertItemQuery,
            [
                userId,
                brandId,
                title,
                description || null,
                category,
                size_label || null,
                color || null,
                condition_grade || 'good',
                swapVal,
                publicVal,
                img1,
                img2,
                img3
            ],
            (err, result) => {
                if (err) {
                    console.error("Error inserting item:", err);
                    return res.send("Error inserting item.");
                }

                const newItemId = result.insertId;

                // 3. Upsert tags
                upsertTags(tagList, (tagErr, tagIds) => {
                    if (tagErr) {
                        console.error("Error processing tags:", tagErr);
                        return res.send("Item created, but tags failed.");
                    }

                    // 4. Link tags
                    linkItemTags(newItemId, tagIds, (linkErr) => {
                        if (linkErr) {
                            console.error("Error linking tags:", linkErr);
                            return res.send("Item created, but linking tags failed.");
                        }

                        req.flash("success_msg", "Item added!");
                        res.redirect("/wardrobe");
                    });
                });
            }
        );
    });
};


// ======================================
// EDIT ITEM PAGE (GET)
// ======================================
exports.editItemPage = (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const userId = req.session.user.user_id;
    const itemId = req.params.id;

    // 1. Load the item (ensure it belongs to user)
    const itemQuery = `
        SELECT 
            ci.*,
            b.name AS brand_name
        FROM clothing_items ci
        LEFT JOIN brands b ON ci.brand_id = b.brand_id
        WHERE ci.item_id = ? AND ci.owner_user_id = ?
    `;

    db.query(itemQuery, [itemId, userId], (errItem, itemRows) => {
        if (errItem) {
            console.error("Error loading item for edit:", errItem);
            req.flash("error_msg", "Error loading item.");
            return res.redirect('/wardrobe');
        }

        if (itemRows.length === 0) {
            req.flash("error_msg", "Item not found.");
            return res.redirect('/wardrobe');
        }

        const item = itemRows[0];

        // 2. Load item tags
        const itemTagsQuery = `
            SELECT t.name
            FROM item_tags it
            JOIN tags t ON it.tag_id = t.tag_id
            WHERE it.item_id = ?
        `;

        db.query(itemTagsQuery, [itemId], (errTags, tagRows) => {
            if (errTags) {
                console.error("Error loading item tags:", errTags);
                req.flash("error_msg", "Error loading item tags.");
                return res.redirect('/wardrobe');
            }

            const itemTagsString = tagRows.map(r => r.name).join(', ');

            // 3. Load suggestions for brands + tags (like upload form)
            const brandsQuery = `SELECT brand_id, name FROM brands ORDER BY name ASC LIMIT 50`;
            const tagsQuery   = `SELECT tag_id, name FROM tags ORDER BY name ASC LIMIT 50`;

            db.query(brandsQuery, (errBrands, brands) => {
                if (errBrands) {
                    console.error("Error loading brands for edit:", errBrands);
                    return res.render('editClothing', {
                        message: "Error loading brands.",
                        item,
                        brands: [],
                        tags: [],
                        itemTagsString
                    });
                }

                db.query(tagsQuery, (errAllTags, allTags) => {
                    if (errAllTags) {
                        console.error("Error loading tags for edit:", errAllTags);
                        return res.render('editClothing', {
                            message: "Error loading tags.",
                            item,
                            brands,
                            tags: [],
                            itemTagsString
                        });
                    }

                    res.render('editClothing', {
                        message: null,
                        item,
                        brands,
                        tags: allTags,
                        itemTagsString
                    });
                });
            });
        });
    });
};


// ======================================
// UPDATE ITEM (POST)
// ======================================
// ======================================
// UPDATE ITEM (POST)
// ======================================
exports.updateItem = (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const userId = req.session.user.user_id;
    const itemId = req.params.id;

    const {
        title,
        description,
        brand,
        category,
        size_label,
        color,
        condition_grade,
        tags,
        is_for_swap,
        is_public,

        // NEW: remove flags (from editClothing.ejs)
        remove_image2,
        remove_image3
    } = req.body;

    if (!title || !brand || !category || !tags) {
        req.flash("error_msg", "Please fill in all required fields.");
        return res.redirect(`/wardrobe/edit/${itemId}`);
    }

    // 1. Load existing item (for current image URLs)
    const existingQuery = `
        SELECT image_url_1, image_url_2, image_url_3
        FROM clothing_items
        WHERE item_id = ? AND owner_user_id = ?
    `;

    db.query(existingQuery, [itemId, userId], (errExisting, rows) => {
        if (errExisting) {
            console.error("Error loading existing item:", errExisting);
            req.flash("error_msg", "Error loading item.");
            return res.redirect('/wardrobe');
        }

        if (rows.length === 0) {
            req.flash("error_msg", "Item not found.");
            return res.redirect('/wardrobe');
        }

        const existing = rows[0];

        const wantsRemove2 = String(remove_image2 || '') === '1';
        const wantsRemove3 = String(remove_image3 || '') === '1';

        // handle images:
        // - image1: keep old if no new upload (no delete checkbox)
        // - image2/3: if new upload exists => use it
        //            else if remove ticked => NULL
        //            else keep existing
        const img1 = req.files?.image1
            ? req.files.image1[0].path
            : existing.image_url_1;

        const newImg2 = req.files?.image2 ? req.files.image2[0].path : null;
        const newImg3 = req.files?.image3 ? req.files.image3[0].path : null;

        const img2 = newImg2 ? newImg2 : (wantsRemove2 ? null : existing.image_url_2);
        const img3 = newImg3 ? newImg3 : (wantsRemove3 ? null : existing.image_url_3);

        const swapVal   = is_for_swap === 'yes' ? 1 : 0;
        const publicVal = swapVal === 1 ? 1 : (is_public === 'yes' ? 1 : 0);

        const tagList = tags
            .split(',')
            .map(t => t.trim().toLowerCase())
            .filter(t => t.length > 0);

        // 2. Upsert brand
        upsertBrand(brand, (brandErr, brandId) => {
            if (brandErr) {
                console.error("Error processing brand on update:", brandErr);
                req.flash("error_msg", "Error processing brand.");
                return res.redirect(`/wardrobe/edit/${itemId}`);
            }

            // 3. Update clothing item
            const updateQuery = `
                UPDATE clothing_items
                SET
                    brand_id = ?,
                    title = ?,
                    description = ?,
                    category = ?,
                    size_label = ?,
                    color = ?,
                    condition_grade = ?,
                    is_for_swap = ?,
                    is_public = ?,
                    image_url_1 = ?,
                    image_url_2 = ?,
                    image_url_3 = ?,
                    updated_at = NOW()
                WHERE item_id = ? AND owner_user_id = ?
            `;

            db.query(
                updateQuery,
                [
                    brandId,
                    title,
                    description || null,
                    category,
                    size_label || null,
                    color || null,
                    condition_grade || 'good',
                    swapVal,
                    publicVal,
                    img1,
                    img2,
                    img3,
                    itemId,
                    userId
                ],
                (errUpdate) => {
                    if (errUpdate) {
                        console.error("Error updating item:", errUpdate);
                        req.flash("error_msg", "Error updating item.");
                        return res.redirect(`/wardrobe/edit/${itemId}`);
                    }

                    // 4. Rebuild tags: delete old + insert new
                    const deleteItemTagsQuery = `DELETE FROM item_tags WHERE item_id = ?`;
                    db.query(deleteItemTagsQuery, [itemId], (errDelTags) => {
                        if (errDelTags) {
                            console.error("Error clearing old tags:", errDelTags);
                            req.flash("error_msg", "Item updated, but tags not refreshed.");
                            return res.redirect('/wardrobe');
                        }

                        upsertTags(tagList, (tagErr, tagIds) => {
                            if (tagErr) {
                                console.error("Error processing tags on update:", tagErr);
                                req.flash("error_msg", "Item updated, but tags failed.");
                                return res.redirect('/wardrobe');
                            }

                            linkItemTags(itemId, tagIds, (linkErr) => {
                                if (linkErr) {
                                    console.error("Error linking tags on update:", linkErr);
                                    req.flash("error_msg", "Item updated, but linking tags failed.");
                                    return res.redirect('/wardrobe');
                                }

                                req.flash("success_msg", "Item updated successfully!");
                                res.redirect('/wardrobe');
                            });
                        });
                    });
                }
            );
        });
    });
};


// ======================================
// DELETE ITEM
// ======================================
exports.deleteItem = (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const itemId = req.params.id;
    const userId = req.session.user.user_id;

    db.query(
        `DELETE FROM clothing_items WHERE item_id = ? AND owner_user_id = ?`,
        [itemId, userId],
        (err) => {
            if (err) {
                console.log(err);
                req.flash("error_msg", "Could not delete item.");
            } else {
                req.flash("success_msg", "Item deleted.");
            }
            res.redirect("/wardrobe");
        }
    );
};
