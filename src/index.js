import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import transcriptionRoutes from "./transcriptionRoutes.js";

dotenv.config();

const app = express();

// ===============================================
// ✅ CORS — Correct, strict, Render-safe
// ===============================================
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://minutes-8evpqetxk-paavans-projects-cea0dbfb.vercel.app" // Your Vercel frontend
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// (No wildcard OPTIONS, no duplicate cors(), no catch-all)

// ===============================================
// JSON Parser
// ===============================================
app.use(express.json());

// ===============================================
// Health Check
// ===============================================
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running 🚀" });
});

// Optional root route
app.get("/", (req, res) => {
  res.send("Minutes Backend is live on Render 🚀");
});

// ===============================================
// API Routes
// ===============================================
app.use("/api", transcriptionRoutes);

// ===============================================
// Start Server
// Render assigns PORT dynamically
// ===============================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
