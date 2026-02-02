// ============================================
// LOAD DEPENDENCIES
// ============================================
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
require('dotenv').config();

// DB + Controllers
const db = require('./db');
const rateLimiter = require('./middleware/rateLimiter'); // friend code (AI)
const userController = require('./controllers/userController');
const wardrobeController = require('./controllers/wardrobeController');
const ootdController = require('./controllers/OOTDController'); // ✅ use ONE controller import
const swapController = require('./controllers/swapController');
const sahmApplicationController = require('./controllers/sahmApplicationController');
const sahmController = require('./controllers/sahmController');
const aiChatbotController = require('./controllers/aiChatbotController'); // friend code (AI)

// ============================================
// APP INITIALIZATION
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// VIEW ENGINE SETUP
// ============================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ============================================
// STATIC FILES
// ============================================
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));

// ============================================
// BODY PARSER
// ============================================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ============================================
// SESSION + FLASH
// ============================================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false
  })
);

app.use(flash());

// ============================================
// MULTER SETUP (Uploads to public/images)
// ============================================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/images');
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueName + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// SAHM doc upload (PDF/ZIP/IMG)
const sahmDocStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/images');
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueName + path.extname(file.originalname).toLowerCase());
  }
});

function sahmDocFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowed = ['.pdf', '.zip', '.png', '.jpg', '.jpeg'];
  if (!allowed.includes(ext)) {
    return cb(new Error('Only PDF, ZIP, JPG, JPEG, PNG files are allowed for SAHM documents.'));
  }
  cb(null, true);
}

const uploadSahmDoc = multer({
  storage: sahmDocStorage,
  fileFilter: sahmDocFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ============================================
// GLOBAL MIDDLEWARE (Make session user available in EJS)
// ============================================
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  next();
});

// ============================================
// ROUTES
// ============================================

// Home feed
app.get('/', ootdController.getHomeFeed);

// Admin feed page (if you use it)
app.get('/adminpage', ootdController.getHomeFeedAdmin);

// Combined search (Users + OOTD)
// ✅ Use friend’s combined search instead of your old one
app.get('/search', ootdController.searchAll);

// Standalone OOTD search page (optional)
app.get('/search-ootd', ootdController.searchOotd);

// CREATE OOTD
app.get('/create-ootd', ootdController.getCreateOotdForm);
app.post(
  '/create-ootd',
  upload.fields([
    { name: 'image1', maxCount: 1 },
    { name: 'image2', maxCount: 1 },
    { name: 'image3', maxCount: 1 }
  ]),
  ootdController.createOotdPost
);

// EDIT OOTD
app.get('/ootd/:id/edit', ootdController.getEditOotdForm);
app.post('/ootd/:id/edit', ootdController.updateOotdPost);

// DELETE OOTD
app.post('/ootd/:id/delete', ootdController.deleteOotdPost);

// Like / Comment
app.post('/ootd/:id/like', ootdController.toggleLike);
app.post('/ootd/:id/comment', ootdController.addComment);
app.post('/ootd/comment/:commentId/delete', ootdController.deleteComment);

// View single post (Instagram style)
app.get('/ootd/:id', ootdController.viewPost);

// Inbox
app.get('/inbox', ootdController.getInbox);
app.post('/inbox/:id/read', ootdController.markNotificationRead);

// Signup
app.get('/signup', (req, res) => {
  res.render('signup', { message: null });
});
app.post('/signup', upload.single('profile_image'), userController.signup);

// AI Style Assistant page (friend code)
app.get('/ai-assistant', (req, res) => {
  res.render('aiStyleAssistant', { user: req.session.user || null });
});

// OTP
app.get('/verify-otp', userController.verifyOtpPage);
app.post('/verify-otp', userController.verifyOtp);

// Login/Logout/Profile
app.get('/login', (req, res) => {
  res.render('login', { message: null });
});
app.post('/login', userController.login);
app.get('/logout', userController.logout);
app.get('/profile', userController.profile);

// Users
app.get('/users', userController.viewAllUsers);
app.get('/users/:id', userController.viewPublicProfile);

// If you still need inline search (optional)
// app.get('/search-users', userController.searchUsersInline);

// Wardrobe
app.get('/wardrobe', wardrobeController.getWardrobePage);
app.get('/wardrobe/upload', wardrobeController.showUploadForm);
app.post(
  '/wardrobe/upload',
  upload.fields([
    { name: 'image1', maxCount: 1 },
    { name: 'image2', maxCount: 1 },
    { name: 'image3', maxCount: 1 }
  ]),
  wardrobeController.uploadItem
);
app.get('/wardrobe/delete/:id', wardrobeController.deleteItem);
app.get('/wardrobe/edit/:id', wardrobeController.editItemPage);
app.post(
  '/wardrobe/edit/:id',
  upload.fields([
    { name: 'image1', maxCount: 1 },
    { name: 'image2', maxCount: 1 },
    { name: 'image3', maxCount: 1 }
  ]),
  wardrobeController.updateItem
);

// Admin
app.get('/admin', userController.adminDashboard);
app.get('/admin/comments', ootdController.getAdminComments);
app.post('/admin/comments/:commentId/delete', ootdController.deleteCommentAsAdmin);
app.post('/admin/users/:id/edit', userController.postEditUser);
app.post('/admin/users/:id/delete', userController.postDeleteUser);

// Swap
app.get('/swap', swapController.getSwapFeed);
app.post('/swap/swipe', swapController.postSwipe);

app.get('/swap/incoming', swapController.getIncomingLikes);
app.get('/swap/incoming/:swipeId/choose', swapController.getChooseCounterItem);
app.post('/swap/incoming/:swipeId/accept', swapController.postAcceptLike);
app.post('/swap/incoming/:swipeId/reject', swapController.postRejectLike);

app.get('/swap/matches', swapController.getMyMatches);
app.get('/swap/matches/:matchId', swapController.getMatchDetails);
app.get('/chat/:matchId', swapController.getChatFromMatch);

app.get('/chats/:chatId', swapController.getChat);
app.post('/chats/:chatId/messages', swapController.postSendMessage);

// SAHM
app.get('/sahm/apply', sahmApplicationController.getApplySAHM);
app.post('/sahm/apply', uploadSahmDoc.single('document'), sahmApplicationController.postApplySAHM);
app.post('/admin/sahm-applications/:id/status', sahmApplicationController.adminUpdateApplicationStatus);

app.get('/sahm', sahmController.getSahmDashboard);

// SAHM Profile
app.post('/sahm/profile', sahmController.postUpdateSahmProfile);

// Availability
app.post('/sahm/availability/add', sahmController.postAddAvailability);
app.post('/sahm/availability/:id/update', sahmController.postUpdateAvailability);
app.post('/sahm/availability/:id/delete', sahmController.postDeleteAvailability);

// Jobs
app.post('/sahm/jobs/:id/accept', sahmController.postAcceptJob);
app.post('/sahm/jobs/:id/pickup', sahmController.postPickupJob);
app.post('/sahm/jobs/:id/delivered', sahmController.postDeliveredJob);

// Payout
app.post('/sahm/payout/request', sahmController.postRequestPayout);

// Locations
app.post('/admin/locations/add', userController.adminAddLocation);
app.post('/admin/locations/:id/delete', userController.adminDeleteLocation);

app.post('/sahm/locations/add', sahmController.postAddSahmLocation);
app.post('/sahm/locations/:id/delete', sahmController.postDeleteSahmLocation);

// Swap confirmations
app.post('/chats/:chatId/confirm/swap-method', swapController.postProposeSwapMethod);
app.post('/chats/:chatId/confirm/swap-method/respond', swapController.postRespondSwapMethod);
app.post('/chats/:chatId/confirm/swap-method/counter', swapController.postCounterSwapMethod);

// Locations confirm
app.post('/chats/:chatId/locations/add', swapController.postAddChatLocation);
app.post('/chats/:chatId/confirm/sahm-address', swapController.postSaveSahmAddress);

app.post('/chats/:chatId/confirm/meetup-location', swapController.postProposeMeetupLocation);
app.post('/chats/:chatId/confirm/meetup-location/respond', swapController.postRespondMeetupLocation);
app.post('/chats/:chatId/confirm/meetup-location/counter', swapController.postCounterMeetupLocation);

app.post('/chats/:chatId/confirm/payment-split', swapController.postProposePaymentSplit);
app.post('/chats/:chatId/confirm/payment-split/respond', swapController.postRespondPaymentSplit);
app.post('/chats/:chatId/confirm/payment-split/counter', swapController.postCounterPaymentSplit);

app.post('/chats/:chatId/confirm/time', swapController.postProposeTime);
app.post('/chats/:chatId/confirm/time/respond', swapController.postRespondTime);
app.post('/chats/:chatId/confirm/time/counter', swapController.postCounterTime);

// PayPal
app.use(express.json());
app.post('/chats/:chatId/paypal/create-order', swapController.postPayPalCreateOrder);
app.post('/chats/:chatId/paypal/capture-order', swapController.postPayPalCaptureOrder);
app.get('/chats/:chatId/payment-otp/status', swapController.getPaymentOtpStatus);
app.post('/chats/:chatId/payment-otp/send', swapController.postPaymentOtpSend);
app.post('/chats/:chatId/payment-otp/verify', swapController.postPaymentOtpVerify);

// Admin payouts + cases
app.post('/admin/payouts/:id/approve', userController.adminApprovePayout);
app.post('/admin/payouts/:id/reject', userController.adminRejectPayout);
app.post('/admin/payouts/:id/sync', userController.adminSyncPayoutStatus);

app.post('/chats/:chatId/help/create', swapController.postHelpCreateCase);
app.post('/admin/swap-cases/:id/review', userController.adminMarkSwapCaseUnderReview);
app.post('/admin/swap-cases/:id/resolve', userController.adminResolveSwapCase);
app.get('/admin/chats/:chatId', userController.adminViewChat);

app.post('/admin/swap-refunds/sync', userController.adminSyncSwapRefunds);

app.get('/admin/users/:id/content', userController.adminViewUserContent);

// NEW: wardrobe moderation
app.post('/admin/users/:id/wardrobe/:itemId/hide', userController.adminHideUserWardrobeItem);
app.post('/admin/users/:id/wardrobe/:itemId/delete', userController.adminDeleteUserWardrobeItem);

// NEW: ootd moderation
app.post('/admin/users/:id/ootd/:postId/delete', userController.adminDeleteUserOotdPost);
// ============================================
// REVIEW ROUTES
// ============================================
app.post('/reviews/submit', userController.postSubmitReview);
app.get('/api/users/:userId/reviews', userController.getUserReviews);
app.get('/profile/edit', userController.getEditProfile);
app.post('/profile/edit', upload.single('profile_image'), userController.postEditProfile);
app.post('/profile/delete', userController.postDeleteProfile);

// ============================================
// AI AUTH MIDDLEWARE (friend code)
// ============================================
const requireAuth = (req, res, next) => {
  if (!req.session.user || !req.session.user.user_id) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated',
      message: 'Please log in to use the AI assistant'
    });
  }
  next();
};

// ============================================
// AI CHATBOT ROUTES (friend code)
// ============================================
app.get('/api/ai/recommendations', requireAuth, rateLimiter, aiChatbotController.getRecommendations);
app.post('/api/ai/chat', requireAuth, rateLimiter, aiChatbotController.chat);
app.post('/api/ai/suggest-tags', requireAuth, rateLimiter, aiChatbotController.suggestTags);
app.get('/api/ai/style-analysis', requireAuth, rateLimiter, aiChatbotController.getStyleAnalysis);
app.get('/api/ai/recommendations-history', requireAuth, rateLimiter, aiChatbotController.getRecommendationHistory);

// ============================================
// SERVER START
// ============================================
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
