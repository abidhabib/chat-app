# Rose Chat - 2 Person Private Chat Application

A beautiful, real-time chat application designed exclusively for two users ("Abid" and "Sara"). Built with Node.js, Express, Socket.IO, MySQL, and vanilla JavaScript with a rose-themed UI.

## Features

### Core Functionality
- 🔐 **User Authentication** - JWT-based login/register system
- 💬 **Real-time Messaging** - Instant message delivery via Socket.IO
- 📱 **Responsive Design** - Mobile-first design with safe-area support
- 🎨 **Dark/Light Theme** - Toggle between beautiful rose-themed color schemes
- 📎 **Media Sharing** - Support for images, videos, and PDF files
- ☁️ **Cloudinary Integration** - Optional cloud storage for media files
- ⌨️ **Typing Indicators** - See when your partner is typing
- 🟢 **Online Status** - Real-time presence indicators
- 📜 **Message History** - Paginated message loading
- 🔊 **Notification Sounds** - Audio alerts for new messages (optional)
- ✉️ **Message Status** - Delivery confirmation with checkmarks

### Security
- Password hashing with bcryptjs
- JWT token authentication
- CORS protection
- Input sanitization and HTML escaping
- Duplicate message prevention with client message IDs

## Architecture

This is a **2-person only** chat application. The system is designed for exactly two users:
- User 1: `abid`
- User 2: `sara`

When one user logs in, they can only chat with their partner (the other user).

## Tech Stack

### Backend
- **Node.js** - Runtime environment
- **Express** - Web framework
- **Socket.IO** - Real-time bidirectional communication
- **MySQL** - Database with mysql2/promise
- **bcryptjs** - Password hashing
- **jsonwebtoken** - JWT authentication
- **cors** - Cross-origin resource sharing

### Frontend
- **Vanilla JavaScript** - No frameworks, pure JS
- **HTML5/CSS3** - Modern styling with CSS variables
- **Socket.IO Client** - Real-time communication
- **Cloudinary** - Optional media upload service

## Installation

### Prerequisites
- Node.js (v14 or higher)
- MySQL database
- npm or yarn

### Setup Steps

1. **Clone the repository**
   ```bash
   cd /workspace
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up the database**
   ```bash
   # Create your MySQL database first
   mysql -u root -p < sql/schema.sql
   ```

4. **Configure environment variables**
   
   Create a `.env` file in the root directory:
   ```env
   # Server Configuration
   PORT=3000
   CORS_ORIGIN=*
   
   # Database Configuration
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=your_password
   DB_NAME=chat_app
   
   # JWT Secret (generate a strong secret)
   JWT_SECRET=your_super_secret_jwt_key_change_this
   
   # Cloudinary (Optional - for media uploads)
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret
   CLOUDINARY_FOLDER=chat-app
   ```

5. **Start the server**
   ```bash
   node server.js
   ```

6. **Access the application**
   Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Database Schema

The application uses a MySQL database with the following tables:

### Users Table
- `id` - Primary key
- `username` - Unique username (abid or sara)
- `password` - Hashed password
- `is_online` - Current online status
- `last_seen` - Last activity timestamp

### Messages Table
- `id` - Primary key
- `sender` - Sender's username
- `recipient` - Recipient's username
- `content` - Message text
- `media_urls` - JSON array of media URLs
- `media_types` - JSON array of media MIME types
- `status` - Message status (sent, delivered, etc.)
- `timestamp` - Message creation time
- `client_message_id` - Optional client-generated ID for deduplication

## API Endpoints

### Authentication
- `POST /register` - Register a new user
- `POST /login` - Login and receive JWT token
- `GET /validate-session` - Validate current session

### Messages
- `GET /messages` - Fetch paginated messages between users
  - Query params: `page`, `limit`

### Cloudinary
- `GET /cloudinary/signature` - Get signed parameters for direct upload

## Socket.IO Events

### Client → Server
- `typing` - Send typing indicator
- `sendMessage` - Send a new message
- `requestUserStatus` - Request partner's online status
- `logout` - Logout and disconnect

### Server → Client
- `newMessage` - Receive a new message
- `userTyping` - Partner typing status
- `userStatus` - Partner online/offline status
- `initialStatus` - Initial partner status on connect

## File Structure

```
/workspace
├── server.js           # Main server file with all backend logic
├── package.json        # Node.js dependencies
├── .env               # Environment variables (create this)
├── public/
│   ├── index.html     # Frontend HTML/CSS
│   └── js/
│       └── script.js  # Frontend JavaScript logic
└── sql/
    └── schema.sql     # Database schema
```

## Usage

### First Time Setup
1. Register both users (`abid` and `sara`) through the login screen
2. Each user should remember their credentials
3. Login with either account to start chatting

### Daily Use
1. Open the app in your browser
2. Login with your username and password
3. Start chatting in real-time!
4. Use the theme toggle (top-right) to switch between light/dark modes
5. Attach media using the paperclip icon
6. Logout using the door icon when done

### Supported Media Types
- Images: JPEG, PNG, GIF, WebP
- Videos: MP4, WebM, OGG
- Documents: PDF

## Customization

### Theme Colors
Edit CSS variables in `public/index.html` to customize colors:
```css
:root {
    --bg-gradient-start: #fff0f3;
    --bg-gradient-end: #ffe4e9;
    --accent: #e11d48;
    /* ... more variables */
}
```

### Add More Users
To support different usernames, modify the `getPartnerName()` function in `server.js`:
```javascript
function getPartnerName(username) {
    return username.toLowerCase() === 'abid' ? 'sara' : 'abid';
}
```

## Production Deployment

### Environment Variables for Production
- Set `CORS_ORIGIN` to your specific domain
- Use a strong, unique `JWT_SECRET`
- Configure production database credentials
- Set up Cloudinary for media storage (recommended)

### Recommended Services
- **Hosting**: Heroku, Railway, Render, or VPS
- **Database**: MySQL on cloud provider or managed service
- **Media Storage**: Cloudinary (free tier available)
- **SSL**: Use HTTPS in production

## Troubleshooting

### Common Issues

**Cannot connect to database:**
- Verify MySQL is running
- Check database credentials in `.env`
- Ensure database exists and schema is loaded

**Media uploads not working:**
- Check Cloudinary credentials
- Verify `CLOUDINARY_ENABLED` configuration
- Check file size limits (32MB max)

**Socket.IO connection issues:**
- Ensure CORS settings allow your frontend origin
- Check firewall/proxy settings
- Verify server is running on correct port

## License

This project is private and intended for personal use between two individuals.

## Credits

Built with ❤️ using:
- [Socket.IO](https://socket.io/)
- [Express.js](https://expressjs.com/)
- [MySQL](https://www.mysql.com/)
- [Cloudinary](https://cloudinary.com/)

---

**Note:** This application is specifically designed for 2 users only. It creates an intimate, private messaging space with a beautiful rose-themed interface.
