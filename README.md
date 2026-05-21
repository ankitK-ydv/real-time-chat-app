# 💬 Real-Time Chat Application

A modern, real-time chat application built with **Node.js**, **Express**, and **Socket.io**. Connect with friends, send messages, and share posts instantly!

---

## ✨ Features

- **Instant Messaging** - Send and receive messages in real-time
- **User Authentication** - Secure login with password encryption (bcrypt)
- **Connection Requests** - Send and accept connection requests from other users
- **Online Presence** - See who's online in real-time
- **Unread Messages** - Keep track of unread messages from each friend
- **User Avatars** - Upload and display profile pictures
- **Posts/Feed** - Share posts with your connections
- **Message History** - All messages are saved in database
- **Mark as Read** - Track which messages you've read
- **Responsive Design** - Works on desktop and mobile devices

---

## 🚀 Quick Start

### Prerequisites

Before you begin, make sure you have installed:

- **Node.js** (v14 or higher) - [Download here](https://nodejs.org/)
- **MongoDB** - [Download here](https://www.mongodb.com/try/download/community) or use MongoDB Atlas (cloud)
- **npm** or **yarn** - Usually comes with Node.js

### Installation Steps

1. **Clone or download the project**

   ```bash
   cd "real time chat"
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

   This will install all required packages from `package.json`

3. **Set up environment variables**

   Create a `.env` file in the root directory (copy from `.env.example` if available):

   ```
   PORT=3000
   MONGODB_URI=mongodb://127.0.0.1:27017/realtime_chat
   BCRYPT_ROUNDS=12
   ALLOW_LOCAL_MONGODB_FALLBACK=true
   ALLOW_IN_MEMORY_MONGODB_FALLBACK=true
   ```

4. **Start the server**

   ```bash
   npm start
   ```

   The server will run on `http://localhost:3000`

5. **Open in browser**
   - Navigate to `http://localhost:3000` in your web browser
   - Create an account or login
   - Start chatting! 🎉

---

## 📂 Project Structure

```
real-time-chat/
├── node.js                 # Main server file (backend)
├── package.json            # Project dependencies and scripts
├── .env                    # Environment variables (don't commit!)
├── .env.example            # Example environment variables
├── .gitignore              # Git ignore rules
├── public/                 # Frontend files (HTML, CSS, JavaScript)
│   ├── index.html          # Landing/Home page
│   ├── home.html           # Main dashboard page
│   ├── chat.html           # Chat interface page
│   └── style.css           # All styling
└── node_modules/           # Installed packages (not in GitHub)
```

---

## 💻 Technologies Used

| Technology    | Purpose                                  |
| ------------- | ---------------------------------------- |
| **Node.js**   | JavaScript runtime for server            |
| **Express**   | Web framework for routing                |
| **Socket.io** | Real-time communication                  |
| **MongoDB**   | Database to store users, messages, posts |
| **Mongoose**  | Database schema and queries              |
| **bcryptjs**  | Password encryption                      |
| **dotenv**    | Environment variables management         |
| **CORS**      | Cross-origin requests                    |
| **Axios**     | HTTP client (for API calls)              |

---

## 🔐 Important: .gitignore Setup

Your `.gitignore` file is already configured to prevent sensitive files from being uploaded to GitHub:

**Files that WON'T be uploaded to GitHub:**

- ❌ `node_modules/` - Too large, others can run `npm install`
- ❌ `.env` - Contains API keys and secrets
- ❌ `debug.log` - Temporary debug files
- ❌ IDE settings and OS files

**When you push to GitHub:**

```bash
git add .
git commit -m "Your message"
git push origin main
```

The listed files will automatically be ignored! ✅

---

## 📝 Available Scripts

Run these commands in the terminal:

```bash
# Start the server
npm start

# This runs the command in package.json: node node.js
```

---

## 🔌 How It Works

### Backend (node.js)

1. User logs in or registers
2. Express server handles HTTP requests
3. Socket.io creates real-time connection
4. MongoDB stores user data, messages, and posts
5. Server broadcasts events to all connected clients

### Frontend (HTML/CSS/JavaScript)

1. User interface in `public/` folder
2. JavaScript communicates with server via Socket.io
3. Messages appear instantly for both users
4. CSS provides beautiful, responsive design

---

## 🛠️ Database Schema

### User

- `username` - Unique username
- `password` - Encrypted password
- `avatar` - Profile picture (base64)
- `timestamps` - Created and updated dates

### Connection

- `members` - Two usernames [user1, user2]
- `status` - "pending" or "accepted"
- `requestedBy` - Who sent the request
- `pairKey` - Unique identifier for the pair

### Message

- `roomId` - Chat room ID
- `sender` - Who sent the message
- `original` - Message text
- `participants` - Both users involved
- `readBy` - List of users who read it
- `timestamps` - When sent and read

### Post

- `author` - Who wrote it
- `text` - Post content
- `media` - Image or video (base64)
- `likes` - Number of likes
- `shares` - Number of shares
- `timestamps` - When posted

---

## ⚙️ Environment Variables Explained

| Variable                           | Purpose                      | Default                   |
| ---------------------------------- | ---------------------------- | ------------------------- |
| `PORT`                             | Server port number           | 3000                      |
| `MONGODB_URI`                      | Remote MongoDB connection    | -                         |
| `LOCAL_MONGODB_URI`                | Local MongoDB connection     | mongodb://127.0.0.1:27017 |
| `BCRYPT_ROUNDS`                    | Password encryption strength | 12                        |
| `ALLOW_LOCAL_MONGODB_FALLBACK`     | Use local DB if remote fails | true                      |
| `ALLOW_IN_MEMORY_MONGODB_FALLBACK` | Use memory DB if all fail    | true                      |

---

## 🐛 Troubleshooting

### Server won't start?

```bash
# Make sure Node.js is installed
node --version

# Reinstall packages
rm -rf node_modules package-lock.json
npm install
npm start
```

### Can't connect to MongoDB?

- Check if MongoDB is running on your computer
- Or update `.env` with MongoDB Atlas cloud connection string
- MongoDB Atlas is free: https://www.mongodb.com/cloud/atlas

### Port 3000 already in use?

```bash
# Change PORT in .env file
PORT=3001
# Then restart the server
```

---

## 🚀 Deployment

To deploy on platforms like Render, Vercel, or Heroku:

1. Push code to GitHub (with .gitignore properly set)
2. Connect your GitHub repo to deployment platform
3. Add environment variables on the platform
4. Platform will run `npm start` automatically
5. Your app will be live! 🌍

---

## 📚 Learning Resources

- [Node.js Documentation](https://nodejs.org/en/docs/)
- [Express Guide](https://expressjs.com/)
- [Socket.io Tutorial](https://socket.io/docs/v4/server-installation/)
- [MongoDB Basics](https://docs.mongodb.com/manual/)
- [JavaScript Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide)

---

## 💡 Tips for Beginners

1. **Understanding the flow:**
   - User opens `index.html` → Logs in → Redirected to `home.html` → Clicks a user → Opens `chat.html`

2. **Real-time magic:**
   - All users connected via Socket.io on same server
   - When one user sends message, server broadcasts to other user instantly
   - No page refresh needed!

3. **Security:**
   - Never commit `.env` file (contains secrets)
   - Passwords are encrypted with bcrypt (not stored as plain text)
   - Always validate user input on server side

4. **Database:**
   - MongoDB stores everything permanently
   - Messages won't disappear after refresh
   - Can query old messages anytime

---

## 📄 License

This project is open source and available under the ISC License.

---

## 🤝 Contributing

Feel free to fork, modify, and improve this project! It's a great way to learn.

---

**Happy Coding! 🚀**

If you have questions, feel free to ask!
