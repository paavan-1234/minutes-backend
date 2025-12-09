import express from "express";
import multer from "multer";
import fs from "fs";
import { File } from "node:buffer";
import { groq } from "./groqClient.js";
import { supabase } from "./supabase.js";

const router = express.Router();
console.log("📌 transcriptionRoutes.js LOADED");

// ensure tmp directory
if (!fs.existsSync("tmp")) fs.mkdirSync("tmp");

const upload = multer({ dest: "tmp/" });

router.post("/transcribe", upload.single("audio"), async (req, res) => {
  console.log(">>> FILE RECEIVED BY SERVER:", req.file);

  if (!req.file) {
    return res.status(400).json({ error: "No audio file uploaded" });
  }

  const fixedPath = req.file.path.replace(/\\/g, "/");

  try {
    // 1) TRANSCRIBE WITH WHISPER
    const fileBuffer = fs.readFileSync(fixedPath);
    const fileForGroq = new File([fileBuffer], req.file.originalname, {
      type: req.file.mimetype,
    });

    console.log("Sending file to Groq Whisper:", req.file.originalname);

    const transcription = await groq.audio.transcriptions.create({
      model: "whisper-large-v3-turbo",
      file: fileForGroq,
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      temperature: 0,
    });

    console.log("Groq Whisper Response (summary):", {
      duration: transcription.duration,
      textLength: transcription.text?.length,
      segmentCount: transcription.segments?.length,
    });

    const transcriptText = transcription.text || "";
    const segments = Array.isArray(transcription.segments)
      ? transcription.segments
      : [];

    // 2) OVERALL EMOTION ANALYSIS (70B on full transcript)
    let moodScore = null;
    let dominantEmotion = null;
    let emotionBreakdown = null;

    if (transcriptText.length > 0) {
      const overallPrompt = `
You are an expert emotion analyst for meetings.

Given the full transcript below, analyze the overall emotional tone.
Use these emotion categories:
- happy
- neutral
- stressed
- angry
- confident

Return ONLY valid JSON with this structure:

{
  "overallMoodScore": number,   // 0 to 100, where 0 = very negative, 100 = very positive/confident
  "dominantEmotion": "happy" | "neutral" | "stressed" | "angry" | "confident",
  "emotionBreakdown": {
    "happy": number,   // 0-100 percentage
    "neutral": number,
    "stressed": number,
    "angry": number,
    "confident": number
  }
}
`;

      const overallCompletion = await groq.chat.completions.create({
        model: "llama-3.1-70b-versatile", // high-quality model
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are an expert meeting emotion analyst." },
          {
            role: "user",
            content: overallPrompt + "\n\nFull transcript:\n" + transcriptText,
          },
        ],
      });

      try {
        const overallJson = JSON.parse(
          overallCompletion.choices[0]?.message?.content || "{}"
        );

        moodScore = overallJson.overallMoodScore ?? null;
        dominantEmotion = overallJson.dominantEmotion ?? null;
        emotionBreakdown = overallJson.emotionBreakdown ?? null;
      } catch (e) {
        console.error("❌ Failed to parse overall emotion JSON");
      }
    }

    // 3) PER-SEGMENT EMOTION ANALYSIS (8B on segments)
    let segmentEmotionMap = new Map(); // index -> { emotion, score }
    let segmentEmotionsForDB = [];

    if (segments.length > 0) {
      const segmentPayload = segments.map((seg, index) => ({
        index,
        start: seg.start,
        end: seg.end,
        text: seg.text,
      }));

      const segPrompt = `
You are an assistant that classifies the emotion of each segment in a meeting transcript.

You will receive a JSON array "segments". For each item, analyze the emotional tone
and respond ONLY with valid JSON in this format:

{
  "segments": [
    {
      "index": number,
      "emotion": "happy" | "neutral" | "stressed" | "angry" | "confident",
      "score": number   // 0.0 to 1.0, confidence of this label
    }
  ]
}

Here is the segments JSON:
${JSON.stringify(segmentPayload, null, 2)}
`;

      const segCompletion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant", // cheaper per-segment analysis
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a precise emotion classifier for meeting segments. Output strictly valid JSON.",
          },
          {
            role: "user",
            content: segPrompt,
          },
        ],
      });

      try {
        const segJson = JSON.parse(
          segCompletion.choices[0]?.message?.content || "{}"
        );

        const segResults = Array.isArray(segJson.segments)
          ? segJson.segments
          : [];

        segResults.forEach((s) => {
          segmentEmotionMap.set(s.index, {
            emotion: s.emotion || "neutral",
            score:
              typeof s.score === "number" && s.score >= 0 && s.score <= 1
                ? s.score
                : 0.5,
          });

          segmentEmotionsForDB.push({
            segment_index: s.index,
            start: segmentPayload[s.index]?.start ?? null,
            end: segmentPayload[s.index]?.end ?? null,
            emotion: s.emotion || "neutral",
            score:
              typeof s.score === "number" && s.score >= 0 && s.score <= 1
                ? s.score
                : 0.5,
          });
        });
      } catch (e) {
        console.error("❌ Failed to parse segment emotion JSON");
      }
    }

    // 4) CREATE MEETING IN SUPABASE (includes mood)
    const meetingTitle =
      req.file.originalname || "Uploaded meeting " + new Date().toISOString();

    const { data: meetingRow, error: meetingError } = await supabase
      .from("meetings")
      .insert({
        title: meetingTitle,
        meeting_type: "generic",
        duration: Math.round(transcription.duration || 0),
        mood_score: moodScore,
        dominant_emotion: dominantEmotion,
        emotion_breakdown: emotionBreakdown,
      })
      .select()
      .single();

    if (meetingError) {
      console.error("Supabase meeting insert error:", meetingError);
      throw new Error("Failed to create meeting");
    }

    const meetingId = meetingRow.id;
    console.log("✅ Created meeting:", meetingId);

    // 5) SAVE TRANSCRIPT SEGMENTS (with emotion)
    if (segments.length) {
      const transcriptRows = segments.map((seg, index) => {
        const emo = segmentEmotionMap.get(index) || {
          emotion: null,
          score: null,
        };

        return {
          meeting_id: meetingId,
          start: String(seg.start),
          end: String(seg.end),
          text: seg.text,
          speaker: null,
          emotion: emo.emotion,
          emotion_score: emo.score,
        };
      });

      const { error: transcriptError } = await supabase
        .from("transcripts")
        .insert(transcriptRows);

      if (transcriptError) {
        console.error("Supabase transcript insert error:", transcriptError);
      } else {
        console.log(`✅ Inserted ${transcriptRows.length} transcript segments`);
      }
    }

    // 6) SAVE PER-SEGMENT EMOTIONS INTO emotions TABLE (optional)
    if (segmentEmotionsForDB.length) {
      const emotionRows = segmentEmotionsForDB.map((e) => ({
        meeting_id: meetingId,
        segment_index: e.segment_index,
        start: e.start,
        end: e.end,
        emotion: e.emotion,
        score: e.score,
      }));

      const { error: emotionsError } = await supabase
        .from("emotions")
        .insert(emotionRows);

      if (emotionsError) {
        console.error("Supabase emotions insert error:", emotionsError);
      } else {
        console.log(`✅ Inserted ${emotionRows.length} emotion rows`);
      }
    }

    // 7) CALL LLM FOR SUMMARY + TASKS
    const llmPrompt = `
You are an AI assistant that analyzes meeting transcripts.

Given the following meeting transcript, generate:

1) A concise summary as bullet points.
2) Key decisions.
3) Main risks or concerns.
4) Follow-up questions.
5) Action items (tasks) with:
   - title
   - description
   - owner (short name, can be "Someone" if unclear)
   - dueDate (ISO string or empty string if not known)
   - priority: "low" | "medium" | "high"
   - status: "todo" | "in_progress" | "done"

Respond ONLY in valid JSON with this structure:

{
  "summary": {
    "bullets": string[],
    "decisions": string[],
    "risks": string[],
    "followUpQuestions": string[]
  },
  "tasks": {
    "items": {
      "title": string,
      "description": string,
      "owner": string,
      "dueDate": string,
      "priority": "low" | "medium" | "high",
      "status": "todo" | "in_progress" | "done"
    }[]
  }
}
`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-70b-versatile",
      temperature: 0.4,
      messages: [
        { role: "system", content: "You are an expert meeting analysis assistant." },
        {
          role: "user",
          content: llmPrompt + "\n\nMeeting transcript:\n" + transcriptText,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content || "{}";
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (e) {
      console.error("Failed to parse LLM JSON for summary/tasks:", content);
      analysis = {
        summary: { bullets: [], decisions: [], risks: [], followUpQuestions: [] },
        tasks: { items: [] },
      };
    }

    const summary = analysis.summary || {
      bullets: [],
      decisions: [],
      risks: [],
      followUpQuestions: [],
    };

    const tasks = analysis.tasks?.items || [];

    // 8) SAVE SUMMARY TO SUPABASE
    const { error: summaryError } = await supabase.from("summaries").insert({
      meeting_id: meetingId,
      bullets: summary.bullets || [],
      decisions: summary.decisions || [],
      risks: summary.risks || [],
      follow_up_questions: summary.followUpQuestions || [],
    });

    if (summaryError) {
      console.error("Supabase summary insert error:", summaryError);
    } else {
      console.log("✅ Summary saved");
    }

    // 9) SAVE TASKS TO SUPABASE
    if (tasks.length) {
      const taskRows = tasks.map((t) => ({
        meeting_id: meetingId,
        title: t.title,
        description: t.description,
        owner: t.owner,
        due_date: t.dueDate || "",
        priority: t.priority,
        status: t.status,
        notion_sync_status: null,
      }));

      const { error: taskError } = await supabase
        .from("tasks")
        .insert(taskRows);

      if (taskError) {
        console.error("Supabase tasks insert error:", taskError);
      } else {
        console.log(`✅ Inserted ${taskRows.length} tasks`);
      }
    }

    // clean up file
    fs.unlink(fixedPath, () => {});

    // 10) RETURN EVERYTHING TO FRONTEND (now includes mood + emotions)
    return res.json({
      meetingId,
      transcript: transcriptText,
      segments,
      words: transcription.words,
      summary,
      tasks,
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
