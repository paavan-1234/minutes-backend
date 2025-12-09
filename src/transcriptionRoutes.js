import express from "express";
import multer from "multer";
import fs from "fs";
import { File } from "node:buffer";
import { groq } from "./groqClient.js";
import { supabase } from "./supabase.js";

//
// ---------------------------------------------
// Router FIRST
// ---------------------------------------------
const router = express.Router();
console.log("📌 transcriptionRoutes.js LOADED");

//
// Ensure tmp directory exists (Render requires this)
//
if (!fs.existsSync("tmp")) fs.mkdirSync("tmp");

//
// Multer upload
//
const upload = multer({ dest: "tmp/" });


//
// =========================================================
//  /api/transcribe
// =========================================================
//
router.post("/transcribe", upload.single("audio"), async (req, res) => {
  console.log("🔥 API HIT: /api/transcribe");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  console.log("File received:", req.file);

  if (!req.file) {
    return res.status(400).json({ error: "No audio file uploaded" });
  }

  const fixedPath = req.file.path.replace(/\\/g, "/");

  try {
    //
    // 1️⃣ SEND FILE TO GROQ WHISPER
    //
    const buffer = fs.readFileSync(fixedPath);
    const fileForGroq = new File([buffer], req.file.originalname, {
      type: req.file.mimetype,
    });

    console.log("➡ Sending file to Groq Whisper:", req.file.originalname);

    const transcription = await groq.audio.transcriptions.create({
      model: "whisper-large-v3-turbo",
      file: fileForGroq,
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      temperature: 0,
    });

    console.log("✔ Whisper Success:", {
      duration: transcription.duration,
      textLength: transcription.text?.length,
      segments: transcription.segments?.length,
    });

    const transcriptText = transcription.text || "";
    const segments = Array.isArray(transcription.segments)
      ? transcription.segments
      : [];

    //
    // 2️⃣ LLM ANALYSIS — OVERALL EMOTION
    //
    let analysis = {
      moodScore: null,
      dominantEmotion: null,
      emotionBreakdown: null,
    };

    if (transcriptText.length > 0) {
      const overallPrompt = `
Analyze the emotional tone of the entire meeting transcript.

Return ONLY JSON:
{
  "overallMoodScore": number,
  "dominantEmotion": "happy" | "neutral" | "stressed" | "angry" | "confident",
  "emotionBreakdown": {
    "happy": number,
    "neutral": number,
    "stressed": number,
    "angry": number,
    "confident": number
  }
}`;

      const overall = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are an expert meeting emotion analyst." },
          { role: "user", content: overallPrompt + "\n\n" + transcriptText },
        ],
      });

      try {
        const parsed = JSON.parse(overall.choices[0]?.message?.content || "{}");
        analysis.moodScore = parsed.overallMoodScore ?? null;
        analysis.dominantEmotion = parsed.dominantEmotion ?? null;
        analysis.emotionBreakdown = parsed.emotionBreakdown ?? null;
      } catch (err) {
        console.error("❌ Failed to parse emotion JSON");
      }
    }

    //
    // 3️⃣ PER-SEGMENT EMOTION (8B)
    //
    let segmentEmotions = [];
    let segmentEmotionMap = new Map();

    if (segments.length > 0) {
      const payload = segments.map((s, i) => ({
        index: i,
        start: s.start,
        end: s.end,
        text: s.text,
      }));

      const segPrompt = `
Classify emotion for each segment.
Return ONLY JSON:
{
  "segments": [
    { "index": number, "emotion": "...", "score": 0.0 }
  ]
}

Segments:
${JSON.stringify(payload, null, 2)}
`;

      const seg = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Strictly output ONLY valid JSON." },
          { role: "user", content: segPrompt },
        ],
      });

      try {
        const parsed = JSON.parse(seg.choices[0]?.message?.content || "{}");
        const arr = parsed.segments || [];

        arr.forEach((s) => {
          const cleanEmotion = s.emotion || "neutral";
          const score = typeof s.score === "number" ? s.score : 0.5;

          segmentEmotionMap.set(s.index, { emotion: cleanEmotion, score });

          segmentEmotions.push({
            meeting_id: null, // added after meeting creation
            segment_index: s.index,
            start_time: payload[s.index]?.start ?? null,
            end_time: payload[s.index]?.end ?? null,
            emotion: cleanEmotion,
            score,
          });
        });
      } catch (err) {
        console.error("❌ Segment emotion JSON parse error:", err);
      }
    }

    //
    // 4️⃣ INSERT MEETING INTO SUPABASE
    //
    const { data: meetingRow, error: meetErr } = await supabase
      .from("meetings")
      .insert([
        {
          title: req.body.title || "Untitled Meeting",
          meeting_type: req.body.meeting_type || "generic",
          duration: transcription?.duration
            ? Math.round(transcription.duration)
            : 0,
          mood_score: analysis.moodScore != null ? Math.round(analysis.moodScore * 100) : null,
          dominant_emotion: analysis.dominantEmotion,
          emotion_breakdown: analysis.emotionBreakdown,
          transcript: transcriptText,
          cloud_path: null,
        },
      ])
      .select()
      .single();

    if (meetErr || !meetingRow) {
      console.error("❌ Supabase meeting insert failed:", meetErr);
      return res.status(500).json({ error: "Failed to create meeting record" });
    }

    const meetingId = meetingRow.id;
    console.log("✔ Meeting created:", meetingId);

    //
    // 5️⃣ INSERT TRANSCRIPT SEGMENTS → transcripts table
    //
    if (segments.length > 0) {
      const rows = segments.map((seg, i) => ({
        meeting_id: meetingId,
        start_time: String(seg.start),
        end_time: String(seg.end),
        transcript_text: seg.text,
        speaker: "Unknown",
        emotion: segmentEmotionMap.get(i)?.emotion || null,
        emotion_score: segmentEmotionMap.get(i)?.score || null,
      }));

      await supabase.from("transcripts").insert(rows);
    }

    //
    // 6️⃣ INSERT EMOTION SEGMENTS → emotion_segments table
    //
    if (segmentEmotions.length > 0) {
      const rows = segmentEmotions.map((row) => ({
        ...row,
        meeting_id: meetingId,
      }));

      await supabase.from("emotion_segments").insert(rows);
    }

    //
    // 7️⃣ CLEANUP + RESPONSE
    //
    fs.unlink(fixedPath, () => {});

    return res.json({
      meetingId,
      transcript: transcriptText,
      segments,
      words: transcription.words,
      emotion: {
        moodScore: analysis.moodScore,
        dominantEmotion: analysis.dominantEmotion,
        emotionBreakdown: analysis.emotionBreakdown,
        segmentEmotions,
      },
    });

  } catch (err) {
    console.error("🔥 Transcription pipeline error:", err);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(500).json({
      error: "Failed to process meeting",
      details: err?.message || String(err),
    });
  }
});

export default router;
