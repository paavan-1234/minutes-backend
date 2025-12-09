import express from "express";
import multer from "multer";
import fs from "fs";
import { File } from "node:buffer";
import { groq } from "./groqClient.js";
import { supabase } from "./supabase.js";

//
// 🔥 Correct order: router FIRST
//
const router = express.Router();
console.log("📌 transcriptionRoutes.js LOADED");

//
// 🔥 Ensure /tmp exists (Render requires this)
//
if (!fs.existsSync("tmp")) fs.mkdirSync("tmp");

//
// 🔥 Multer upload middleware
//
const upload = multer({ dest: "tmp/" });


//
// =========================================================
//  🔥   TRANSCRIBE ENDPOINT
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
    // 1️⃣ CREATE FILE BUFFER FOR GROQ
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
      segments: transcription.segments?.length
    });

    const transcriptText = transcription.text || "";
    const segments = Array.isArray(transcription.segments) ? transcription.segments : [];

    //
    // 2️⃣ OVERALL EMOTION ANALYSIS (70B)
    //
    let moodScore = null;
    let dominantEmotion = null;
    let emotionBreakdown = null;

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
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are an expert meeting emotion analyst." },
          { role: "user", content: overallPrompt + "\n\n" + transcriptText },
        ],
      });

      try {
        const parsed = JSON.parse(overall.choices[0]?.message?.content || "{}");
        moodScore = parsed.overallMoodScore ?? null;
        dominantEmotion = parsed.dominantEmotion ?? null;
        emotionBreakdown = parsed.emotionBreakdown ?? null;
      } catch (err) {
        console.error("❌ Failed to parse emotion JSON");
      }
    }

    //
    // 3️⃣ PER-SEGMENT EMOTION ANALYSIS (8B)
    //
    let segmentEmotionMap = new Map();
    let segmentEmotionsForDB = [];

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
    { "index": number, "emotion": "...", "score": 0.0–1.0 }
  ]
}

Segments:
${JSON.stringify(payload, null, 2)}
`;

      const seg = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Strictly output JSON only." },
          { role: "user", content: segPrompt },
        ],
      });

      try {
        const parsed = JSON.parse(seg.choices[0]?.message?.content || "{}");
        const result = parsed.segments || [];

        result.forEach((s) => {
          segmentEmotionMap.set(s.index, {
            emotion: s.emotion || "neutral",
            score: typeof s.score === "number" ? s.score : 0.5,
          });

          segmentEmotionsForDB.push({
            segment_index: s.index,
            start: payload[s.index]?.start ?? null,
            end: payload[s.index]?.end ?? null,
            emotion: s.emotion || "neutral",
            score: typeof s.score === "number" ? s.score : 0.5,
          });
        });
      } catch (err) {
        console.error("❌ Failed to parse segment emotion JSON");
      }
    }

    //
    // 4️⃣ CREATE MEETING RECORD
    //
    // 1) Insert meeting row
    const { data: meetingRow, error: meetErr } = await supabase
    .from("meetings")
    .insert([
        {
        title: req.body.title || "Untitled Meeting",
        meeting_type: req.body.meeting_type || "generic",
        duration: whisper.duration ? Math.round(whisper.duration) : 0,
        mood_score: analysis.moodScore,
        dominant_emotion: analysis.dominantEmotion,
        emotion_breakdown: analysis.emotionBreakdown,
        transcript: whisper.text,
        cloud_path: null
        }
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
    // 5️⃣ INSERT TRANSCRIPT SEGMENTS
    //
    if (segments.length > 0) {
      const rows = segments.map((seg, i) => ({
        meeting_id: meetingId,
        start: String(seg.start),
        end: String(seg.end),
        text: seg.text,
        emotion: segmentEmotionMap.get(i)?.emotion || null,
        emotion_score: segmentEmotionMap.get(i)?.score || null,
      }));

      await supabase.from("transcripts").insert(rows);
    }

    //
    // 6️⃣ INSERT EMOTION ROWS
    //
    if (segmentEmotionsForDB.length > 0) {
      await supabase.from("emotions").insert(segmentEmotionsForDB);
    }

    //
    // 7️⃣ FINAL RESPONSE
    //
    fs.unlink(fixedPath, () => {});

    return res.json({
      meetingId,
      transcript: transcriptText,
      segments,
      words: transcription.words,
      emotion: {
        moodScore,
        dominantEmotion,
        emotionBreakdown,
        segmentEmotions: segmentEmotionsForDB,
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
