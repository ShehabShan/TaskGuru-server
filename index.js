const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const dotenv = require("dotenv");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

const allowedOrigins = [
  "http://localhost:5173",
  "https://taskguru-b25e4.web.app",
  "https://taskguru-b25e4.firebaseapp.com",
  "https://*.railway.app",
  "https://taskguru-server-production.up.railway.app",
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);
app.use(express.json());

// const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.d6z2i.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
// const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.d6z2i.mongodb.net/?retryWrites=true&w=majority&authSource=admin`;

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.d6z2i.mongodb.net/taskManagementApp?retryWrites=true&w=majority&authSource=admin`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  maxPoolSize: 10, // Connection pooling optimized for Railway
  minPoolSize: 2,
  tls: true,
  tlsAllowInvalidCertificates: false,
});

const httpServer = createServer(app);

// WebSocket configuration for production
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  },
  path: "/socket.io",
  transports: ["websocket", "polling"], // Railway-compatible transports
  pingTimeout: 60000,
  pingInterval: 25000,
  connectionStateRecovery: {}, // Added for better WS recovery
});

let db;
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await client.connect();

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged deployment. Successfully connected to MongoDB!");

    db = client.db("taskManagementApp");
    isConnected = true;
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
}

// WebSocket authentication middleware
io.use((socket, next) => {
  const email = socket.handshake.auth.email;
  if (email) {
    socket.userEmail = email;
    next();
  } else {
    next(new Error("Unauthorized"));
  }
});

async function initializeServer() {
  try {
    await connectDB();

    // API Endpoints
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        const usersCollection = db.collection("users");
        const result = await usersCollection.insertOne(user);
        res.status(201).json(result);
      } catch (error) {
        res.status(500).json({ error: "User creation failed" });
      }
    });

    app.get("/tasks", async (req, res) => {
      try {
        const userEmail = req.query.email;
        if (!userEmail)
          return res.status(400).json({ error: "Email required" });

        const tasksCollection = db.collection("tasks");
        const tasks = await tasksCollection.find({ userEmail }).toArray();
        res.json(tasks);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch tasks" });
      }
    });

    app.post("/tasks", async (req, res) => {
      try {
        const task = req.body;
        const tasksCollection = db.collection("tasks");
        const result = await tasksCollection.insertOne(task);

        if (result.insertedId) {
          const insertedTask = { _id: result.insertedId, ...task };
          io.emit("taskAdded", insertedTask);
          res.status(201).json(insertedTask);
        } else {
          res.status(500).json({ error: "Task creation failed" });
        }
      } catch (error) {
        res.status(500).json({ error: "Internal server error" });
      }
    });

    app.put("/tasks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updatedTask = req.body;
        delete updatedTask._id;

        const tasksCollection = db.collection("tasks");
        const result = await tasksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedTask }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).json({ error: "Task not found" });
        }

        const fullUpdatedTask = await tasksCollection.findOne({
          _id: new ObjectId(id),
        });
        io.emit("taskUpdated", fullUpdatedTask);
        res.json(fullUpdatedTask);
      } catch (error) {
        res.status(500).json({ error: "Task update failed" });
      }
    });

    app.delete("/tasks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const tasksCollection = db.collection("tasks");
        const result = await tasksCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: "Task not found" });
        }

        io.emit("taskDeleted", id);
        res.json({ message: "Task deleted successfully" });
      } catch (error) {
        res.status(500).json({ error: "Task deletion failed" });
      }
    });

    // WebSocket connections
    io.on("connection", (socket) => {
      console.log(`User connected: ${socket.userEmail}`);

      socket.on("disconnect", () => {
        console.log(`User disconnected: ${socket.userEmail}`);
      });
    });

    // Health check endpoint
    app.get("/", (req, res) => {
      const mongoStatus = client.topology.isConnected()
        ? "connected"
        : "disconnected";
      res.json({
        status: "ok",
        mongo: mongoStatus,
        websockets: io.engine.clientsCount,
      });
    });

    // Server lifecycle handlers
    httpServer.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`WebSocket path: /socket.io`);
    });
  } catch (error) {
    console.error("Server initialization failed:", error);
    process.exit(1);
  }
}

initializeServer();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nClosing server...");
  await client.close();
  httpServer.close();
  process.exit(0);
});
