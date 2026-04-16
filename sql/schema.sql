CREATE DATABASE IF NOT EXISTS chat_app;
USE chat_app;

CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(100) NOT NULL,
    is_online BOOLEAN DEFAULT false,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    sender VARCHAR(50) NOT NULL,
    recipient VARCHAR(50) NOT NULL,
    content TEXT,
    media_urls JSON,
    media_types JSON,
    client_message_id VARCHAR(64) UNIQUE,
    status ENUM('sent', 'delivered', 'read') DEFAULT 'sent',
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_messages_timestamp (timestamp),
    INDEX idx_messages_sender_recipient (sender, recipient),
    FOREIGN KEY (sender) REFERENCES users(username),
    FOREIGN KEY (recipient) REFERENCES users(username)
);

-- Clear existing users
DELETE FROM users;

-- Insert users with correct password hash for 'password123'
-- This hash was generated using bcrypt with 10 rounds
INSERT INTO users (username, password) VALUES
('abid', '$2b$10$s6pKNXxnrQrTJfVXqOUkuOZwjEtXcIRPWRaG3DMbHtAG9pKXgmQyG'),
('sara', '$2b$10$s6pKNXxnrQrTJfVXqOUkuOZwjEtXcIRPWRaG3DMbHtAG9pKXgmQyG');
