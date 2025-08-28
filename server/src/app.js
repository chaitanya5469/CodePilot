import express from "express";
import axios from "axios";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";

const app = express();
app.use(cors());
app.use(express.json());




const HF_TOKEN = process.env.HF_API_KEY ;
const HF_CHAT_API = "https://router.huggingface.co/v1/chat/completions";
const MODEL_URL = "https://api-inference.huggingface.co/models/distilgpt2";

const PORT = process.env.PORT || 5000;

// Create a single HTTP server
const server = http.createServer(app);

// Attach Socket.IO to the same server
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for debugging
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Store live session data
const sessions = new Map(); // sessionId -> { code, users: Map, textOwnership: Map }
const colors = ["#f94144", "#43aa8b", "#577590", "#f9c74f", "#90be6d"];

io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  socket.on("joinSession", (sessionId) => {
    console.log(`👤 User ${socket.id} joining session: ${sessionId}`);
    
    // Leave any previous rooms
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });
    
    // Join the new session room
    socket.join(sessionId);
    
    // Initialize session if it doesn't exist
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        code: "",
        users: new Map(), // userId -> { color, name, socketId }
        textOwnership: new Map() // rangeKey -> userId
      });
      console.log(`🆕 Created new session: ${sessionId}`);
    }
    
    const session = sessions.get(sessionId);
    
    // Assign color based on current user count
    const userIndex = session.users.size;
    const userColor = colors[userIndex % colors.length];
    const userName = `User ${socket.id.slice(-4)}`;
    
    // Add user to session
    session.users.set(socket.id, {
      color: userColor,
      name: userName,
      socketId: socket.id
    });
    
    console.log(`🎨 Assigned color ${userColor} to user ${socket.id}`);
    
    // Send color assignment to the user
    socket.emit("assignColor", { userId: socket.id, color: userColor });
    
    // Send current user list to everyone in the session
    const userList = Array.from(session.users.entries()).map(([userId, userData]) => ({
      userId,
      color: userData.color,
      name: userData.name
    }));
    
    io.to(sessionId).emit("userListUpdate", userList);
    console.log(`📤 Sent user list update:`, userList);
    
    // Send existing text ownership data to the new user
    if (session.textOwnership.size > 0) {
      socket.emit("textOwnership", Array.from(session.textOwnership.entries()));
    }
    
    // Only send existing code if session has content
    if (session.code && session.code.trim()) {
      console.log(`📤 Sending existing code to ${socket.id}:`, session.code.substring(0, 50) + "...");
      socket.emit("codeUpdate", session.code);
    }
    
    console.log(`📊 Session ${sessionId} now has ${session.users.size} users`);
  });

  socket.on("textChange", ({ sessionId, userId, range, text }) => {
    console.log(`📝 Text change from ${userId} in session ${sessionId}:`, text);
    
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const rangeKey = `${range.startLineNumber}-${range.startColumn}-${range.endLineNumber}-${range.endColumn}`;
    session.textOwnership.set(rangeKey, userId);
    
    console.log(`💾 Stored ownership: ${rangeKey} -> ${userId}`);
    
    // Broadcast ownership update to ALL users in the session
    io.to(sessionId).emit("textOwnership", Array.from(session.textOwnership.entries()));
  });

  socket.on("codeChange", ({ sessionId, code }) => {
    console.log(`✏️ Code change in session ${sessionId} from ${socket.id}`);
    console.log(`📝 New code (${code.length} chars):`, code.substring(0, 100) + "...");
    
    const session = sessions.get(sessionId);
    if (!session) {
      console.error(`❌ Session ${sessionId} not found`);
      return;
    }
    
    // Update session code
    session.code = code;
    
    // Broadcast to ALL OTHER users in the session (excluding sender)
    socket.to(sessionId).emit("codeUpdate", code);
    console.log(`📡 Broadcasted code change to other users in session ${sessionId}`);
  });

  socket.on("cursorMove", ({ sessionId, cursor }) => {
    console.log(`👆 Cursor move from ${socket.id} in session ${sessionId}:`, cursor);
    
    const session = sessions.get(sessionId);
    if (!session) {
      console.error(`❌ Session ${sessionId} not found for cursor move`);
      return;
    }
    
    const user = session.users.get(socket.id);
    if (!user) {
      console.error(`❌ User ${socket.id} not found in session ${sessionId}`);
      return;
    }
    
    // Broadcast cursor position to other users (excluding sender)
    socket.to(sessionId).emit("cursorUpdate", { 
      userId: socket.id, 
      cursor,
      userName: user.name,
      userColor: user.color
    });
    
    console.log(`📡 Broadcasted cursor update for ${user.name} to session ${sessionId}`);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 User disconnected: ${socket.id}`);
    
    for (const [sessionId, session] of sessions.entries()) {
      if (session.users.has(socket.id)) {
        session.users.delete(socket.id);
        console.log(`👋 Removed ${socket.id} from session ${sessionId}`);
        
        // Clean up text ownership for this user
        const keysToDelete = [];
        for (const [rangeKey, userId] of session.textOwnership.entries()) {
          if (userId === socket.id) {
            keysToDelete.push(rangeKey);
          }
        }
        keysToDelete.forEach(key => session.textOwnership.delete(key));
        
        // Send updated user list to remaining users
        const userList = Array.from(session.users.entries()).map(([userId, userData]) => ({
          userId,
          color: userData.color,
          name: userData.name
        }));
        
        io.to(sessionId).emit("userListUpdate", userList);
        io.to(sessionId).emit("textOwnership", Array.from(session.textOwnership.entries()));
        
        if (session.users.size === 0) {
          sessions.delete(sessionId);
          console.log(`🧹 Cleaned up empty session: ${sessionId}`);
        }
      }
    }
  });

  // Debug event to check if socket is receiving events
  socket.on("ping", (data) => {
    console.log(`🏓 Ping from ${socket.id}:`, data);
    socket.emit("pong", { message: "Server received ping", timestamp: Date.now() });
  });
});

// Example endpoint
app.get("/", (req, res) => {
  res.send("Code Review Server is running");
});

// Debug endpoint to check sessions
app.get("/sessions", (req, res) => {
  const sessionInfo = {};
  for (const [sessionId, session] of sessions.entries()) {
    sessionInfo[sessionId] = {
      userCount: session.users.size,
      users: Array.from(session.users.entries()).map(([id, data]) => ({ id, ...data })),
      codeLength: session.code.length,
      ownershipCount: session.textOwnership.size
    };
  }
  res.json(sessionInfo);
});

// Review API
app.post("/review", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "No code provided" });

  try {
    const prompt = `You are a code reviewer. Analyze the following code and provide suggestions in JSON format as an array of objects with "category" and "message" fields. Categories should be "Bug", "Optimization", or "Best Practice". Here's the code:

${code}`;

    const response = await fetch(HF_CHAT_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B:novita",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const result = await response.json();
    let suggestions = [];
    
    try {
      let raw = result?.choices?.[0]?.message?.content?.trim() || "[]";
      // Remove any thinking tags
      raw = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      
      // Try to extract JSON from the response
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        suggestions = JSON.parse(jsonMatch[0]);
      } else {
        suggestions = JSON.parse(raw);
      }
    } catch (e) {
      console.error("Failed to parse JSON:", e);
      console.error("Raw response:", result?.choices?.[0]?.message?.content);
      suggestions = [{ 
        category: "General", 
        message: "Code analysis completed, but response format needs adjustment." 
      }];
    }

    res.json({ suggestions });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Failed to review code" });
  }
});

// Start everything on one port
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔄 Socket.IO server ready for connections`);
  console.log(`📊 Debug endpoint: http://localhost:${PORT}/sessions`);
});
