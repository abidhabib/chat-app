require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const PAGE_SIZE_DEFAULT = 30;
const PAGE_SIZE_MAX = 60;
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'chat-app';
const CLOUDINARY_ENABLED = Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const userSockets = new Map();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getPartnerName(username) {
    return username.toLowerCase() === 'abid' ? 'sara' : 'abid';
}

function normalizeStoredJson(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch (error) {
            return [];
        }
    }
    return [];
}

function mapMediaType(mimeType = '') {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType === 'application/pdf') return 'pdf';
    return 'file';
}

function serializeMessage(row) {
    return {
        ...row,
        media_urls: normalizeStoredJson(row.media_urls),
        media_types: normalizeStoredJson(row.media_types),
        client_message_id: row.client_message_id || null
    };
}

function buildCloudinarySignature(params) {
    const serialized = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join('&');

    return crypto
        .createHash('sha1')
        .update(`${serialized}${process.env.CLOUDINARY_API_SECRET}`)
        .digest('hex');
}

async function emitPartnerStatus(username, statusPayload) {
    const partnerSocketIds = userSockets.get(getPartnerName(username).toLowerCase()) || new Set();
    partnerSocketIds.forEach((socketId) => {
        io.to(socketId).emit('userStatus', statusPayload);
    });
}

async function setUserPresence(username, isOnline) {
    await pool.query(
        'UPDATE users SET is_online = ?, last_seen = NOW() WHERE username = ?',
        [isOnline, username]
    );
}

async function ensureSchema() {
    const [columns] = await pool.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'messages'
          AND COLUMN_NAME = 'client_message_id'
    `);

    if (!columns.length) {
        await pool.query('ALTER TABLE messages ADD COLUMN client_message_id VARCHAR(64) NULL');
    }

    const [indexes] = await pool.query(`
        SELECT INDEX_NAME
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'messages'
          AND INDEX_NAME IN ('idx_messages_timestamp', 'idx_messages_sender_recipient', 'uq_client_message_id')
    `);

    const indexNames = new Set(indexes.map((row) => row.INDEX_NAME));

    if (!indexNames.has('idx_messages_timestamp')) {
        await pool.query('ALTER TABLE messages ADD INDEX idx_messages_timestamp (timestamp)');
    }

    if (!indexNames.has('idx_messages_sender_recipient')) {
        await pool.query('ALTER TABLE messages ADD INDEX idx_messages_sender_recipient (sender, recipient)');
    }

    if (!indexNames.has('uq_client_message_id')) {
        await pool.query('ALTER TABLE messages ADD UNIQUE INDEX uq_client_message_id (client_message_id)');
    }
}

async function authenticateRequest(token) {
    if (!token) {
        const error = new Error('No token provided');
        error.status = 401;
        throw error;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await pool.query(
        'SELECT id, username FROM users WHERE username = ? LIMIT 1',
        [decoded.username]
    );

    if (!rows.length) {
        const error = new Error('Invalid user');
        error.status = 403;
        throw error;
    }

    return rows[0];
}

async function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.split(' ')[1];
        req.user = await authenticateRequest(token);
        next();
    } catch (error) {
        res.status(error.status || 403).json({ error: error.message || 'Invalid token' });
    }
}

app.post('/register', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const [existing] = await pool.query(
            'SELECT username FROM users WHERE username = ? LIMIT 1',
            [username]
        );

        if (existing.length) {
            return res.status(409).json({ error: 'Username already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        );

        res.status(201).json({ message: 'User created successfully' });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const [users] = await pool.query(
            'SELECT id, username, password FROM users WHERE username = ? LIMIT 1',
            [username]
        );

        if (!users.length) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const isValid = await bcrypt.compare(password, users[0].password);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = jwt.sign(
            { username: users[0].username },
            process.env.JWT_SECRET,
            { expiresIn: '12h' }
        );

        await setUserPresence(users[0].username, true);

        res.json({
            token,
            username: users[0].username
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/validate-session', authenticateToken, (req, res) => {
    res.json({ valid: true, username: req.user.username });
});

app.get('/messages', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const partner = getPartnerName(username);
        const page = Math.max(0, Number.parseInt(req.query.page, 10) || 0);
        const limit = Math.min(
            PAGE_SIZE_MAX,
            Math.max(1, Number.parseInt(req.query.limit, 10) || PAGE_SIZE_DEFAULT)
        );
        const offset = page * limit;

        const [countRows] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM messages
             WHERE (LOWER(sender) = LOWER(?) AND LOWER(recipient) = LOWER(?))
                OR (LOWER(sender) = LOWER(?) AND LOWER(recipient) = LOWER(?))`,
            [username, partner, partner, username]
        );

        const [rows] = await pool.query(
            `SELECT id, sender, recipient, content, media_urls, media_types, status, timestamp, client_message_id
             FROM messages
             WHERE (LOWER(sender) = LOWER(?) AND LOWER(recipient) = LOWER(?))
                OR (LOWER(sender) = LOWER(?) AND LOWER(recipient) = LOWER(?))
             ORDER BY timestamp DESC, id DESC
             LIMIT ? OFFSET ?`,
            [username, partner, partner, username, limit, offset]
        );

        const messages = rows.reverse().map(serializeMessage);
        const total = countRows[0].total;

        res.json({
            messages,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: offset + rows.length < total
            }
        });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

app.get('/cloudinary/signature', authenticateToken, (req, res) => {
    if (!CLOUDINARY_ENABLED) {
        return res.status(503).json({ error: 'Cloudinary is not configured on the server' });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const params = {
        folder: CLOUDINARY_FOLDER,
        timestamp
    };

    res.json({
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        folder: CLOUDINARY_FOLDER,
        timestamp,
        signature: buildCloudinarySignature(params)
    });
});

app.use((error, req, res, next) => {
    console.error('Unhandled request error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST']
    }
});

io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        socket.user = await authenticateRequest(token);
        next();
    } catch (error) {
        next(new Error(error.message || 'Authentication failed'));
    }
});

io.on('connection', async (socket) => {
    const username = socket.user.username;
    const normalizedUsername = username.toLowerCase();
    const partner = getPartnerName(username);

    if (!userSockets.has(normalizedUsername)) {
        userSockets.set(normalizedUsername, new Set());
    }
    userSockets.get(normalizedUsername).add(socket.id);

    await setUserPresence(username, true);

    const [partnerRows] = await pool.query(
        'SELECT username, is_online, last_seen FROM users WHERE username = ? LIMIT 1',
        [partner]
    );

    if (partnerRows.length) {
        socket.emit('initialStatus', [partnerRows[0]]);
    }

    await emitPartnerStatus(username, {
        username,
        status: 'online'
    });

    socket.on('typing', (data = {}) => {
        const partnerSocketIds = userSockets.get(partner.toLowerCase()) || new Set();
        partnerSocketIds.forEach((socketId) => {
            io.to(socketId).emit('userTyping', {
                username,
                isTyping: Boolean(data.isTyping)
            });
        });
    });

    socket.on('requestUserStatus', async () => {
        try {
            const [rows] = await pool.query(
                'SELECT username, is_online, last_seen FROM users WHERE username = ? LIMIT 1',
                [partner]
            );
            if (rows.length) {
                socket.emit('userStatus', {
                    username: rows[0].username,
                    status: rows[0].is_online ? 'online' : 'offline',
                    lastSeen: rows[0].last_seen
                });
            }
        } catch (error) {
            console.error('Status request error:', error);
        }
    });

    socket.on('sendMessage', async (payload = {}, callback) => {
        try {
            const recipient = String(payload.recipient || '').trim();
            const clientMessageId = String(payload.clientMessageId || '').trim() || null;
            const content = String(payload.content || '').trim();
            const mediaUrls = Array.isArray(payload.mediaUrls) ? payload.mediaUrls.filter(Boolean) : [];
            const mediaTypes = Array.isArray(payload.mediaTypes) ? payload.mediaTypes : [];

            if (!recipient) {
                throw new Error('Recipient is required');
            }

            if (!content && mediaUrls.length === 0) {
                throw new Error('Message content or media is required');
            }

            if (mediaUrls.length !== mediaTypes.length) {
                throw new Error('Media payload is invalid');
            }

            const [recipientRows] = await pool.query(
                'SELECT username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
                [recipient]
            );

            if (!recipientRows.length) {
                throw new Error('Recipient does not exist');
            }

            if (clientMessageId) {
                const [existingRows] = await pool.query(
                    `SELECT id, sender, recipient, content, media_urls, media_types, status, timestamp, client_message_id
                     FROM messages
                     WHERE client_message_id = ? LIMIT 1`,
                    [clientMessageId]
                );

                if (existingRows.length) {
                    const existingMessage = serializeMessage(existingRows[0]);
                    if (typeof callback === 'function') {
                        callback({ status: 'sent', message: existingMessage, duplicate: true });
                    }
                    return;
                }
            }

            const [result] = await pool.query(
                `INSERT INTO messages
                    (sender, recipient, content, media_urls, media_types, status, timestamp, client_message_id)
                 VALUES (?, ?, ?, ?, ?, 'sent', NOW(), ?)`,
                [
                    username,
                    recipientRows[0].username,
                    content,
                    mediaUrls.length ? JSON.stringify(mediaUrls) : null,
                    mediaTypes.length ? JSON.stringify(mediaTypes) : null,
                    clientMessageId
                ]
            );

            const [rows] = await pool.query(
                `SELECT id, sender, recipient, content, media_urls, media_types, status, timestamp, client_message_id
                 FROM messages
                 WHERE id = ? LIMIT 1`,
                [result.insertId]
            );

            const message = serializeMessage(rows[0]);
            const recipientSocketIds = userSockets.get(recipientRows[0].username.toLowerCase()) || new Set();
            recipientSocketIds.forEach((socketId) => {
                io.to(socketId).emit('newMessage', message);
            });

            if (typeof callback === 'function') {
                callback({ status: 'sent', message });
            }
        } catch (error) {
            console.error('Error sending message:', error);
            if (typeof callback === 'function') {
                callback({ status: 'error', error: error.message || 'Failed to send message' });
            }
        }
    });

    socket.on('logout', async () => {
        try {
            await setUserPresence(username, false);
            await emitPartnerStatus(username, {
                username,
                status: 'offline',
                lastSeen: new Date()
            });
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            socket.disconnect(true);
        }
    });

    socket.on('disconnect', async () => {
        const socketIds = userSockets.get(normalizedUsername);
        if (socketIds) {
            socketIds.delete(socket.id);
            if (socketIds.size === 0) {
                userSockets.delete(normalizedUsername);
                try {
                    await setUserPresence(username, false);
                    await emitPartnerStatus(username, {
                        username,
                        status: 'offline',
                        lastSeen: new Date()
                    });
                } catch (error) {
                    console.error('Disconnect cleanup error:', error);
                }
            }
        }
    });
});

ensureSchema()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error('Failed to prepare database schema:', error);
        process.exit(1);
    });
