-- phpMyAdmin SQL Dump
-- version 5.2.3
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1:3306
-- Generation Time: Mar 13, 2026 at 07:25 AM
-- Server version: 8.4.7
-- PHP Version: 8.3.28

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `talkflix`
--

-- --------------------------------------------------------

--
-- Table structure for table `email_verifications`
--

DROP TABLE IF EXISTS `email_verifications`;
CREATE TABLE IF NOT EXISTS `email_verifications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `code_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `verified_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_email_verifications_email` (`email`)
,
  KEY `idx_email_verifications_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `password_resets`
--

DROP TABLE IF EXISTS `password_resets`;
CREATE TABLE IF NOT EXISTS `password_resets` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_password_resets_email` (`email`)
,
  KEY `idx_password_resets_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `from_country` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `first_language` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `learn_language` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `dob` date NOT NULL,
  `gender` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `profile_photo_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `city` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `region` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country_code` varchar(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `lat` decimal(10,7) DEFAULT NULL,
  `lon` decimal(10,7) DEFAULT NULL,
  `location_source` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `location_updated_at` timestamp NULL DEFAULT NULL,
  `membership` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'free',
  `membership_expires_at` datetime DEFAULT NULL,
  `role` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'user',
  `plan` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'free',
  `trial_ends_at` datetime DEFAULT NULL,
  `pro_ends_at` datetime DEFAULT NULL,
  `trial_used` tinyint(1) NOT NULL DEFAULT '0',
  `trial_started_at` datetime DEFAULT NULL,
  `meet_languages_json` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_username` (`username`),
  KEY `idx_users_plan` (`plan`),
  KEY `idx_users_role` (`role`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



-- --------------------------------------------------------

--
-- Table structure for table `direct_messages`
--

DROP TABLE IF EXISTS `direct_messages`;
CREATE TABLE IF NOT EXISTS `direct_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `thread_id` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sender_id` int NOT NULL,
  `receiver_id` int NOT NULL,
  `message_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text',
  `message_text` longtext COLLATE utf8mb4_unicode_ci,
  `image_url` longtext COLLATE utf8mb4_unicode_ci,
  `audio_url` longtext COLLATE utf8mb4_unicode_ci,
  `audio_duration` int DEFAULT NULL,
  `mime_type` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `message_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'sent',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dm_thread_created` (`thread_id`,`created_at`),
  KEY `idx_dm_sender` (`sender_id`),
  KEY `idx_dm_receiver` (`receiver_id`),
  CONSTRAINT `fk_dm_sender` FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dm_receiver` FOREIGN KEY (`receiver_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- --------------------------------------------------------

--
-- Table structure for table `follows`
--

DROP TABLE IF EXISTS `follows`;
CREATE TABLE IF NOT EXISTS `follows` (
  `follower_id` int NOT NULL,
  `following_id` int NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`follower_id`,`following_id`),
  KEY `idx_follows_following_id` (`following_id`),
  CONSTRAINT `fk_follows_follower` FOREIGN KEY (`follower_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_follows_following` FOREIGN KEY (`following_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Seed data for 4 pro test users
-- Password for all users below: 1111111111
--

INSERT INTO `users` (`id`,`email`,`password_hash`,`display_name`,`username`,`from_country`,`first_language`,`learn_language`,`dob`,`gender`,`profile_photo_url`,`city`,`region`,`country`,`country_code`,`location_source`,`location_updated_at`,`membership`,`role`,`plan`,`trial_used`,`meet_languages_json`) VALUES
(101,'amira.pro@talkflix.test','$2b$10$TEB69Y3g1AavFGcckKyNNu7Y0EnGG94/ovNPxurvdWJQIpQmKM3nK','Amira Noor','amira101','AE','Arabic','English','1997-04-15','female',NULL,'Doha',NULL,'Qatar','QA','seed',NOW(),'pro','user','pro',1,'["English","Arabic","French"]'),
(102,'daniel.pro@talkflix.test','$2b$10$TEB69Y3g1AavFGcckKyNNu7Y0EnGG94/ovNPxurvdWJQIpQmKM3nK','Daniel Reed','daniel102','US','English','Arabic','1994-08-23','male',NULL,'Doha',NULL,'Qatar','QA','seed',NOW(),'pro','user','pro',1,'["English","Arabic","Spanish"]'),
(103,'leyla.pro@talkflix.test','$2b$10$TEB69Y3g1AavFGcckKyNNu7Y0EnGG94/ovNPxurvdWJQIpQmKM3nK','Leyla Demir','leyla103','TR','Turkish','English','1996-01-11','female',NULL,'Istanbul',NULL,'Turkey','TR','seed',NOW(),'pro','user','pro',1,'["English","Arabic","Turkish"]'),
(104,'omar.pro@talkflix.test','$2b$10$TEB69Y3g1AavFGcckKyNNu7Y0EnGG94/ovNPxurvdWJQIpQmKM3nK','Omar Haddad','omar104','EG','Arabic','English','1993-11-05','male',NULL,'Cairo',NULL,'Egypt','EG','seed',NOW(),'pro','user','pro',1,'["English","Arabic","Hindi"]')
ON DUPLICATE KEY UPDATE
`email`=VALUES(`email`),
`password_hash`=VALUES(`password_hash`),
`display_name`=VALUES(`display_name`),
`username`=VALUES(`username`),
`from_country`=VALUES(`from_country`),
`first_language`=VALUES(`first_language`),
`learn_language`=VALUES(`learn_language`),
`dob`=VALUES(`dob`),
`gender`=VALUES(`gender`),
`city`=VALUES(`city`),
`country`=VALUES(`country`),
`country_code`=VALUES(`country_code`),
`location_source`=VALUES(`location_source`),
`location_updated_at`=VALUES(`location_updated_at`),
`membership`='pro',
`role`='user',
`plan`='pro',
`trial_used`=1,
`meet_languages_json`=VALUES(`meet_languages_json`);

COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
