const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const questionRoutes = require('./routes/questions');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use('/api/questions', questionRoutes);


// Test route
app.get('/', (req, res) => {
  res.send('Football discussion backend is running!');
});

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
});

// Start server
const PORT = process.env.PORT || 3000;
console.log("About to start server...");
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


