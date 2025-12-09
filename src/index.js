import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { supabase } from "./supabase.js"; // if you already created this
import transcriptionRoutes from "./transcriptionRoutes.js";

dotenv.config();

const app = express();

app.use(cors({
  origin: "http://localhost:5173",   // your Vite frontend
  methods: ["GET", "POST"],
}));

app.use(express.json());

// optional: test supabase connection here if you want
// ...

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running 🚀" });
});

// Mount transcription routes under /api
app.use("/api", transcriptionRoutes);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
