import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { supabase } from "./supabase.js";
import transcriptionRoutes from "./transcriptionRoutes.js";

dotenv.config();

const app = express();


// ✅ Replace your old CORS block with THIS
app.use(
  cors({
    origin: [
      "http://localhost:5173",                                      // Local dev
      "https://minutes-8evpqetxk-paavans-projects-cea0dbfb.vercel.app"  // Your Vercel URL
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Required for preflight OPTIONS requests
app.options("*", cors());


app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running 🚀" });
});

// Root check (optional but helpful)
app.get("/", (req, res) => {
  res.send("Minutes Backend is live on Render 🚀");
});

// Routes
app.use("/api", transcriptionRoutes);

// Render dynamic OR local port
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
