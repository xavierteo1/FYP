-- MySQL dump 10.13  Distrib 8.0.34, for Win64 (x86_64)
-- Complete database schema for clothes_swap application
--

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

-- =====================================================
-- TABLE: users
-- =====================================================
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `user_id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(50) NOT NULL,
  `email` varchar(150) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `full_name` varchar(100) DEFAULT NULL,
  `bio` text,
  `profile_image_url` varchar(255) DEFAULT NULL,
  `location` varchar(100) DEFAULT NULL,
  `is_sahm` tinyint(1) NOT NULL DEFAULT '0',
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `gender` enum('male','female','other') DEFAULT NULL,
  `role` varchar(50) DEFAULT 'user',
  `is_email_verified` tinyint(1) DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_users_email` (`email`)
) ENGINE=InnoDB AUTO_INCREMENT=21 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: brands
-- =====================================================
DROP TABLE IF EXISTS `brands`;
CREATE TABLE `brands` (
  `brand_id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`brand_id`),
  UNIQUE KEY `uq_brand_name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: tags
-- =====================================================
DROP TABLE IF EXISTS `tags`;
CREATE TABLE `tags` (
  `tag_id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`tag_id`),
  UNIQUE KEY `uq_tags_name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=14 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: clothing_items
-- =====================================================
DROP TABLE IF EXISTS `clothing_items`;
CREATE TABLE `clothing_items` (
  `item_id` int NOT NULL AUTO_INCREMENT,
  `owner_user_id` int NOT NULL,
  `brand_id` int DEFAULT NULL,
  `title` varchar(150) NOT NULL,
  `description` text,
  `category` enum('top','bottom','blouse','jeans','dress','outerwear','accessory','other') NOT NULL,
  `size_label` varchar(50) DEFAULT NULL,
  `color` varchar(50) DEFAULT NULL,
  `condition_grade` enum('new','like_new','good','fair','worn') DEFAULT 'good',
  `is_for_swap` tinyint(1) NOT NULL DEFAULT '1',
  `is_public` tinyint(1) NOT NULL DEFAULT '1',
  `status` enum('available','reserved','swapped','hidden') DEFAULT 'available',
  `image_url_1` varchar(255) DEFAULT NULL,
  `image_url_2` varchar(255) DEFAULT NULL,
  `image_url_3` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`item_id`),
  KEY `ci_owner_fk` (`owner_user_id`),
  KEY `ci_brand_fk` (`brand_id`),
  CONSTRAINT `ci_brand_fk` FOREIGN KEY (`brand_id`) REFERENCES `brands` (`brand_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `ci_owner_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: item_tags
-- =====================================================
DROP TABLE IF EXISTS `item_tags`;
CREATE TABLE `item_tags` (
  `item_id` int NOT NULL,
  `tag_id` int NOT NULL,
  PRIMARY KEY (`item_id`,`tag_id`),
  KEY `it_tag_fk` (`tag_id`),
  CONSTRAINT `it_item_fk` FOREIGN KEY (`item_id`) REFERENCES `clothing_items` (`item_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `it_tag_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags` (`tag_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: ootd_posts
-- =====================================================
DROP TABLE IF EXISTS `ootd_posts`;
CREATE TABLE `ootd_posts` (
  `post_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `caption` varchar(255) DEFAULT NULL,
  `visibility` enum('public','private') NOT NULL DEFAULT 'public',
  `image_url_1` varchar(255) DEFAULT NULL,
  `image_url_2` varchar(255) DEFAULT NULL,
  `image_url_3` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`post_id`),
  KEY `op_user_fk` (`user_id`),
  CONSTRAINT `op_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: ootd_likes
-- =====================================================
DROP TABLE IF EXISTS `ootd_likes`;
CREATE TABLE `ootd_likes` (
  `like_id` int NOT NULL AUTO_INCREMENT,
  `post_id` int NOT NULL,
  `user_id` int NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`like_id`),
  UNIQUE KEY `uq_like_user_post` (`user_id`,`post_id`),
  KEY `idx_like_post` (`post_id`),
  CONSTRAINT `fk_like_post` FOREIGN KEY (`post_id`) REFERENCES `ootd_posts` (`post_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_like_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: ootd_comments
-- =====================================================
DROP TABLE IF EXISTS `ootd_comments`;
CREATE TABLE `ootd_comments` (
  `comment_id` int NOT NULL AUTO_INCREMENT,
  `post_id` int NOT NULL,
  `user_id` int NOT NULL,
  `content` varchar(500) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`comment_id`),
  KEY `idx_comment_post` (`post_id`),
  KEY `idx_comment_user` (`user_id`),
  CONSTRAINT `fk_comment_post` FOREIGN KEY (`post_id`) REFERENCES `ootd_posts` (`post_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_comment_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: ootd_notifications
-- =====================================================
DROP TABLE IF EXISTS `ootd_notifications`;
CREATE TABLE `ootd_notifications` (
  `notification_id` int NOT NULL AUTO_INCREMENT,
  `recipient_user_id` int NOT NULL,
  `actor_user_id` int NOT NULL,
  `post_id` int NOT NULL,
  `type` enum('like','comment') NOT NULL,
  `comment_preview` varchar(255) DEFAULT NULL,
  `is_read` tinyint(1) DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`notification_id`),
  KEY `ootd_notifications_ibfk_1` (`recipient_user_id`),
  KEY `ootd_notifications_ibfk_2` (`actor_user_id`),
  KEY `ootd_notifications_ibfk_3` (`post_id`),
  CONSTRAINT `ootd_notifications_ibfk_1` FOREIGN KEY (`recipient_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ootd_notifications_ibfk_2` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ootd_notifications_ibfk_3` FOREIGN KEY (`post_id`) REFERENCES `ootd_posts` (`post_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: email_otps
-- =====================================================
DROP TABLE IF EXISTS `email_otps`;
CREATE TABLE `email_otps` (
  `otp_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `email` varchar(150) NOT NULL,
  `otp_code` varchar(10) NOT NULL,
  `purpose` enum('registration','forgot_password') NOT NULL,
  `expires_at` datetime NOT NULL,
  `is_used` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`otp_id`),
  KEY `eo_user_fk` (`user_id`),
  CONSTRAINT `eo_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: swap_swipes
-- =====================================================
DROP TABLE IF EXISTS `swap_swipes`;
CREATE TABLE `swap_swipes` (
  `swipe_id` int NOT NULL AUTO_INCREMENT,
  `item_id` int NOT NULL,
  `swiper_user_id` int NOT NULL,
  `is_like` tinyint(1) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`swipe_id`),
  KEY `swipe_item_fk` (`item_id`),
  KEY `swipe_user_fk` (`swiper_user_id`),
  CONSTRAINT `swipe_item_fk` FOREIGN KEY (`item_id`) REFERENCES `clothing_items` (`item_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `swipe_user_fk` FOREIGN KEY (`swiper_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: swap_matches
-- =====================================================
DROP TABLE IF EXISTS `swap_matches`;
CREATE TABLE `swap_matches` (
  `match_id` int NOT NULL AUTO_INCREMENT,
  `user1_id` int NOT NULL,
  `item1_id` int NOT NULL,
  `user2_id` int NOT NULL,
  `item2_id` int NOT NULL,
  `status` enum('pending','accepted','completed','cancelled') DEFAULT 'pending',
  `user1_confirmed` tinyint(1) DEFAULT '0',
  `user2_confirmed` tinyint(1) DEFAULT '0',
  `swap_method` varchar(50) DEFAULT NULL,
  `payment_split` varchar(50) DEFAULT NULL,
  `meetup_location_id` int DEFAULT NULL,
  `scheduled_time` datetime DEFAULT NULL,
  `details_locked` tinyint(1) DEFAULT '0',
  `match_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`match_id`),
  KEY `sm_u1_fk` (`user1_id`),
  KEY `sm_u2_fk` (`user2_id`),
  KEY `sm_i1_fk` (`item1_id`),
  KEY `sm_i2_fk` (`item2_id`),
  KEY `sm_loc_fk` (`meetup_location_id`),
  CONSTRAINT `sm_u1_fk` FOREIGN KEY (`user1_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sm_u2_fk` FOREIGN KEY (`user2_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sm_i1_fk` FOREIGN KEY (`item1_id`) REFERENCES `clothing_items` (`item_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sm_i2_fk` FOREIGN KEY (`item2_id`) REFERENCES `clothing_items` (`item_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sm_loc_fk` FOREIGN KEY (`meetup_location_id`) REFERENCES `locations` (`location_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: chats
-- =====================================================
DROP TABLE IF EXISTS `chats`;
CREATE TABLE `chats` (
  `chat_id` int NOT NULL AUTO_INCREMENT,
  `match_id` int NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`chat_id`),
  UNIQUE KEY `uq_chat_match` (`match_id`),
  CONSTRAINT `chat_match_fk` FOREIGN KEY (`match_id`) REFERENCES `swap_matches` (`match_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: chat_messages
-- =====================================================
DROP TABLE IF EXISTS `chat_messages`;
CREATE TABLE `chat_messages` (
  `message_id` int NOT NULL AUTO_INCREMENT,
  `chat_id` int NOT NULL,
  `sender_user_id` int NOT NULL,
  `message_text` text NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`message_id`),
  KEY `cm_chat_fk` (`chat_id`),
  KEY `cm_sender_fk` (`sender_user_id`),
  CONSTRAINT `cm_chat_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats` (`chat_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `cm_sender_fk` FOREIGN KEY (`sender_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=28 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: locations
-- =====================================================
DROP TABLE IF EXISTS `locations`;
CREATE TABLE `locations` (
  `location_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `label` varchar(100) NOT NULL,
  `address_line` varchar(255) DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `postal_code` varchar(20) DEFAULT NULL,
  `latitude` decimal(10,7) DEFAULT NULL,
  `longitude` decimal(10,7) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`location_id`),
  KEY `loc_user_fk` (`user_id`),
  CONSTRAINT `loc_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: swap_payments
-- =====================================================
DROP TABLE IF EXISTS `swap_payments`;
CREATE TABLE `swap_payments` (
  `payment_id` int NOT NULL AUTO_INCREMENT,
  `match_id` int NOT NULL,
  `payer_user_id` int NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `status` enum('pending','completed','failed','refunded') DEFAULT 'pending',
  `paypal_transaction_id` varchar(255) DEFAULT NULL,
  `provider_order_id` varchar(255) DEFAULT NULL,
  `provider_capture_id` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`payment_id`),
  KEY `sp_match_fk` (`match_id`),
  KEY `sp_payer_fk` (`payer_user_id`),
  CONSTRAINT `sp_match_fk` FOREIGN KEY (`match_id`) REFERENCES `swap_matches` (`match_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sp_payer_fk` FOREIGN KEY (`payer_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: swap_payment_stepups
-- =====================================================
DROP TABLE IF EXISTS `swap_payment_stepups`;
CREATE TABLE `swap_payment_stepups` (
  `stepup_id` int NOT NULL AUTO_INCREMENT,
  `match_id` int NOT NULL,
  `payer_user_id` int NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `status` enum('pending','completed','failed','refunded') DEFAULT 'pending',
  `paypal_transaction_id` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`stepup_id`),
  KEY `fk_stepups_match` (`match_id`),
  KEY `fk_stepups_payer` (`payer_user_id`),
  CONSTRAINT `fk_stepups_match` FOREIGN KEY (`match_id`) REFERENCES `swap_matches` (`match_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_stepups_payer` FOREIGN KEY (`payer_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: swap_refunds
-- =====================================================
DROP TABLE IF EXISTS `swap_refunds`;
CREATE TABLE `swap_refunds` (
  `refund_id` int NOT NULL AUTO_INCREMENT,
  `payment_id` int NOT NULL,
  `initiator_user_id` int NOT NULL,
  `reason` text,
  `status` enum('pending','approved','rejected','completed') DEFAULT 'pending',
  `refund_amount` decimal(10,2) DEFAULT NULL,
  `processed_at` datetime DEFAULT NULL,
  `paypal_refund_id` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`refund_id`),
  KEY `fk_refunds_initiator` (`initiator_user_id`),
  KEY `fk_refunds_payment` (`payment_id`),
  CONSTRAINT `fk_refunds_initiator` FOREIGN KEY (`initiator_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_refunds_payment` FOREIGN KEY (`payment_id`) REFERENCES `swap_payments` (`payment_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: swap_confirmations
-- =====================================================
DROP TABLE IF EXISTS `swap_confirmations`;
CREATE TABLE `swap_confirmations` (
  `confirmation_id` int NOT NULL AUTO_INCREMENT,
  `match_id` int NOT NULL,
  `respondent_user_id` int NOT NULL,
  `proposed_by_user_id` int DEFAULT NULL,
  `type` varchar(50) DEFAULT NULL,
  `offer_round` int DEFAULT '1',
  `confirmation_status` enum('pending','accepted','rejected') DEFAULT 'pending',
  `response_date` datetime DEFAULT NULL,
  `pickup_date` date DEFAULT NULL,
  `pickup_time_slot` varchar(50) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`confirmation_id`),
  KEY `sc_match_fk` (`match_id`),
  KEY `sc_respondent_fk` (`respondent_user_id`),
  KEY `sc_proposed_by_fk` (`proposed_by_user_id`),
  CONSTRAINT `sc_match_fk` FOREIGN KEY (`match_id`) REFERENCES `swap_matches` (`match_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sc_respondent_fk` FOREIGN KEY (`respondent_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sc_proposed_by_fk` FOREIGN KEY (`proposed_by_user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: swap_cases
-- =====================================================
DROP TABLE IF EXISTS `swap_cases`;
CREATE TABLE `swap_cases` (
  `case_id` int NOT NULL AUTO_INCREMENT,
  `match_id` int NOT NULL,
  `opened_by_user_id` int NOT NULL,
  `admin_user_id` int DEFAULT NULL,
  `case_type` varchar(50) DEFAULT NULL,
  `title` varchar(200) NOT NULL,
  `description` text,
  `reason` text,
  `status` enum('open','in_review','resolved','closed') DEFAULT 'open',
  `admin_notes` text,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`case_id`),
  KEY `fk_swap_cases_match` (`match_id`),
  KEY `fk_swap_cases_opened_by` (`opened_by_user_id`),
  KEY `fk_swap_cases_admin` (`admin_user_id`),
  CONSTRAINT `fk_swap_cases_match` FOREIGN KEY (`match_id`) REFERENCES `swap_matches` (`match_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_swap_cases_opened_by` FOREIGN KEY (`opened_by_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_swap_cases_admin` FOREIGN KEY (`admin_user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: swap_delivery_addresses
-- =====================================================
DROP TABLE IF EXISTS `swap_delivery_addresses`;
CREATE TABLE `swap_delivery_addresses` (
  `match_id` int NOT NULL,
  `user_id` int NOT NULL,
  `address` varchar(255) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`match_id`,`user_id`),
  KEY `sda_user_fk` (`user_id`),
  CONSTRAINT `sda_match_fk` FOREIGN KEY (`match_id`) REFERENCES `swap_matches` (`match_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sda_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: sahm_applications
-- =====================================================
DROP TABLE IF EXISTS `sahm_applications`;
CREATE TABLE `sahm_applications` (
  `application_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `document_url` varchar(255) DEFAULT NULL,
  `status` enum('submitted','under_review','approved','rejected') DEFAULT 'submitted',
  `admin_id` int DEFAULT NULL,
  `admin_comment` text,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`application_id`),
  KEY `sa_user_fk` (`user_id`),
  KEY `sa_admin_fk` (`admin_id`),
  CONSTRAINT `sa_admin_fk` FOREIGN KEY (`admin_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `sa_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: sahm_profiles
-- =====================================================
DROP TABLE IF EXISTS `sahm_profiles`;
CREATE TABLE `sahm_profiles` (
  `sahm_user_id` int NOT NULL,
  `service_radius_km` int DEFAULT '10',
  `hourly_rate` decimal(10,2) DEFAULT '25.00',
  `bio` text,
  `profile_image_url` varchar(255) DEFAULT NULL,
  `rating` decimal(3,2) DEFAULT '5.00',
  `total_reviews` int DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`sahm_user_id`),
  CONSTRAINT `sp_user_fk` FOREIGN KEY (`sahm_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: sahm_availability
-- =====================================================
DROP TABLE IF EXISTS `sahm_availability`;
CREATE TABLE `sahm_availability` (
  `availability_id` int NOT NULL AUTO_INCREMENT,
  `sahm_user_id` int NOT NULL,
  `day_of_week` enum('mon','tue','wed','thu','fri','sat','sun') DEFAULT NULL,
  `date_specific` date DEFAULT NULL,
  `start_time` time NOT NULL,
  `end_time` time NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`availability_id`),
  KEY `sa_user_fk2` (`sahm_user_id`),
  CONSTRAINT `sa_user_fk2` FOREIGN KEY (`sahm_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: pickup_delivery_requests
-- =====================================================
DROP TABLE IF EXISTS `pickup_delivery_requests`;
CREATE TABLE `pickup_delivery_requests` (
  `request_id` int NOT NULL AUTO_INCREMENT,
  `match_id` int NOT NULL,
  `leg` enum('u1_to_u2','u2_to_u1') NOT NULL DEFAULT 'u1_to_u2',
  `sahm_user_id` int DEFAULT NULL,
  `pickup_location_id` int NOT NULL,
  `dropoff_location_id` int NOT NULL,
  `status` enum('pending','accepted','in_progress','completed','cancelled') DEFAULT 'pending',
  `delivery_fee` decimal(10,2) DEFAULT NULL,
  `sahm_earning` decimal(10,2) DEFAULT NULL,
  `is_earning_paid` tinyint(1) NOT NULL DEFAULT '0',
  `payout_id` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`request_id`),
  UNIQUE KEY `uq_match_leg` (`match_id`,`leg`),
  KEY `pd_match_fk` (`match_id`),
  KEY `pd_sahm_fk` (`sahm_user_id`),
  KEY `pd_pick_fk` (`pickup_location_id`),
  KEY `pd_drop_fk` (`dropoff_location_id`),
  KEY `pd_payout_fk` (`payout_id`),
  CONSTRAINT `pd_drop_fk` FOREIGN KEY (`dropoff_location_id`) REFERENCES `locations` (`location_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `pd_match_fk` FOREIGN KEY (`match_id`) REFERENCES `swap_matches` (`match_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `pd_pick_fk` FOREIGN KEY (`pickup_location_id`) REFERENCES `locations` (`location_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `pd_sahm_fk` FOREIGN KEY (`sahm_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: sahm_payout_requests
-- =====================================================
DROP TABLE IF EXISTS `sahm_payout_requests`;
CREATE TABLE `sahm_payout_requests` (
  `payout_id` int NOT NULL AUTO_INCREMENT,
  `sahm_user_id` int NOT NULL,
  `total_amount` decimal(10,2) NOT NULL,
  `payout_method` enum('paypal') NOT NULL DEFAULT 'paypal',
  `status` enum('pending','processing','completed','failed') DEFAULT 'pending',
  `paypal_transaction_id` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`payout_id`),
  KEY `spr_sahm_fk` (`sahm_user_id`),
  CONSTRAINT `spr_sahm_fk` FOREIGN KEY (`sahm_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: user_reviews
-- =====================================================
DROP TABLE IF EXISTS `user_reviews`;
CREATE TABLE `user_reviews` (
  `review_id` int NOT NULL AUTO_INCREMENT,
  `reviewed_user_id` int NOT NULL,
  `reviewer_user_id` int NOT NULL,
  `rating` int NOT NULL,
  `comment` text,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`review_id`),
  KEY `ur_reviewed_fk` (`reviewed_user_id`),
  KEY `ur_reviewer_fk` (`reviewer_user_id`),
  CONSTRAINT `ur_reviewed_fk` FOREIGN KEY (`reviewed_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ur_reviewer_fk` FOREIGN KEY (`reviewer_user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: review_tags_master
-- =====================================================
DROP TABLE IF EXISTS `review_tags_master`;
CREATE TABLE `review_tags_master` (
  `review_tag_id` int NOT NULL AUTO_INCREMENT,
  `label` varchar(100) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`review_tag_id`),
  UNIQUE KEY `uq_review_tag_label` (`label`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: user_review_tags
-- =====================================================
DROP TABLE IF EXISTS `user_review_tags`;
CREATE TABLE `user_review_tags` (
  `review_id` int NOT NULL,
  `review_tag_id` int NOT NULL,
  PRIMARY KEY (`review_id`,`review_tag_id`),
  KEY `urt_tag_fk` (`review_tag_id`),
  CONSTRAINT `urt_review_fk` FOREIGN KEY (`review_id`) REFERENCES `user_reviews` (`review_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `urt_tag_fk` FOREIGN KEY (`review_tag_id`) REFERENCES `review_tags_master` (`review_tag_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: user_interests
-- =====================================================
DROP TABLE IF EXISTS `user_interests`;
CREATE TABLE `user_interests` (
  `interest_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `category` varchar(100) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`interest_id`),
  KEY `ui_user_fk` (`user_id`),
  CONSTRAINT `ui_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================
-- TABLE: style_recommendations
-- =====================================================
DROP TABLE IF EXISTS `style_recommendations`;
CREATE TABLE `style_recommendations` (
  `recommendation_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `recommendation_text` text,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`recommendation_id`),
  KEY `sr_user_fk` (`user_id`),
  CONSTRAINT `sr_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;
/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40101 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;

-- Dump completed
