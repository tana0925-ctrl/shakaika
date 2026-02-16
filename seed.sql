-- Default admin account (password: admin123)
-- Hash generated with Web Crypto API SHA-256
INSERT OR IGNORE INTO users (name, email, password_hash, role) 
VALUES ('管理者', 'admin@example.com', 'admin123_hashed', 'admin');
