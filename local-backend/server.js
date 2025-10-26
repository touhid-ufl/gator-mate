import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

// === Allow multiple origins ===
const allowList = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowList.includes(origin)) return callback(null, true);
      console.warn('❌ Blocked by CORS:', origin);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

// Universal OPTIONS handler
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin && allowList.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-backend-secret');
    return res.status(204).end();
  }
  next();
});

// === Load and manage config.json ===
const CONFIG_PATH = path.join(__dirname, 'config.json');
let CURRENT_COURSE = 'default';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      CURRENT_COURSE = cfg.CURRENT_COURSE || 'default';
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ CURRENT_COURSE }, null, 2));
    }
  } catch (err) {
    console.error('⚠️ Could not load config.json:', err);
  }
}

function updateConfig(newCourse) {
  try {
    CURRENT_COURSE = newCourse;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ CURRENT_COURSE }, null, 2));
    console.log(`📝 Updated config.json -> CURRENT_COURSE="${newCourse}"`);
  } catch (err) {
    console.error('⚠️ Failed to update config.json:', err);
  }
}

loadConfig();

// === Track dummy.py status ===
let dummyStatus = { done: false, lastOutput: null };

// === Endpoint to save questionnaire answers ===
app.post('/api/saveAnswers', async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.responses) {
      return res.status(400).json({ ok: false, error: 'Invalid data format' });
    }

    const courseId = data.course || CURRENT_COURSE;
    updateConfig(courseId); // auto-update CURRENT_COURSE

    const courseDir = path.join(__dirname, 'courses', courseId);
    fs.mkdirSync(courseDir, { recursive: true });

    // Save as answer.json (overwrite)
    const filePath = path.join(courseDir, 'answer.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`💾 Saved ${filePath}`);

    // === Run dummy.py ===
    dummyStatus = { done: false, lastOutput: null };
    const dummy = spawn('python', ['dummy.py'], { cwd: __dirname });

    let output = '';
    dummy.stdout.on('data', d => (output += d.toString()));
    dummy.stderr.on('data', d => console.error('dummy.py error:', d.toString()));

    dummy.on('close', code => {
      dummyStatus = { done: true, lastOutput: output.trim() };
      console.log(`🐍 dummy.py finished (exit ${code})`);
      console.log(output.trim());
    });

    // Respond immediately; frontend will poll /api/check-status
    res.json({ ok: true, running: true });
  } catch (err) {
    console.error('❌ Error saving answers', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === Check dummy.py status ===
app.get('/api/check-status', (req, res) => {
  res.json({ ok: true, done: dummyStatus.done, output: dummyStatus.lastOutput });
});


// === Chat endpoint ===
const REQUIRE_SECRET = (process.env.BACKEND_SECRET || '').trim();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/chat', async (req, res) => {
  try {
    if (REQUIRE_SECRET && req.get('x-backend-secret') !== REQUIRE_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { messages = [], atSeconds } = req.body || {};

    // --- Step 1: Read CURRENT_COURSE from config.json ---
    let currentCourse = 'unknown';
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      currentCourse = cfg.CURRENT_COURSE || 'unknown';
    } catch (err) {
      console.warn('⚠️ Could not read config.json:', err);
    }

    // --- Step 2: Load transcript.json for this course ---
    let transcriptContext = '';
    try {
      const transcriptPath = path.join(__dirname, 'courses', currentCourse, 'transcript.json');
      if (fs.existsSync(transcriptPath)) {
        const transcriptData = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
        // Convert JSON into readable text for context
        transcriptContext = JSON.stringify(transcriptData, null, 2);
        console.log(`📖 Loaded transcript for ${currentCourse}`);
      } else {
        console.log(`⚠️ No transcript.json found for ${currentCourse}`);
      }
    } catch (err) {
      console.error('⚠️ Failed to load transcript.json:', err);
    }

    // --- Step 3: Create system context ---
    const systemPrompt = `
You are a helpful teaching assistant for the course "${currentCourse}".
Use the following transcript as context when answering the student’s question.
If the transcript doesn’t cover the topic, provide a general educational answer.

Transcript:
${transcriptContext || '(Transcript not available)'}
`;

    // --- Step 4: Send combined context + conversation to OpenAI ---
    const response = await client.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content
        }))
      ],
    });

    res.json({ ok: true, reply: response.output_text });
  } catch (err) {
    console.error('[api/chat] error:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});



// === Endpoint to serve relevant_video.json dynamically from final_merged_output.json ===
app.get('/api/relevant-video', async (req, res) => {
  try {
    // Read current course ID from config.json
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const currentCourse = cfg.CURRENT_COURSE || 'unknown';

    const mergedPath = path.join(__dirname, 'final_merged_output.json');
    if (!fs.existsSync(mergedPath)) {
      return res.status(404).json({ ok: false, error: 'final_merged_output.json not found.' });
    }

    const mergedData = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));

    // Validate structure
    if (!mergedData.slides || !Array.isArray(mergedData.slides)) {
      return res.status(400).json({ ok: false, error: 'Invalid structure in final_merged_output.json (missing slides array).' });
    }

    // Extract only slides that contain YouTube clip info
    const relevantSlides = mergedData.slides
      .map(slide => ({
        video_title: slide.yt_video_title,
        yt_start_time: slide.yt_clip_start,
        yt_end_time: slide.yt_clip_end,
        video_start: slide.init,
        yt_video_link_start: slide.yt_clip_link,
      }));


    res.json({
      ok: true,
      course: currentCourse,
      video_info: mergedData.video_info || {},
      data: relevantSlides,
    });
  } catch (err) {
    console.error('Error reading final_merged_output.json:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// === Endpoint to serve video_info (YouTube video URL, etc.) ===
app.get('/api/video-info', async (req, res) => {
  try {
    const mergedPath = path.join(__dirname, 'final_merged_output.json');

    if (!fs.existsSync(mergedPath)) {
      return res.status(404).json({ ok: false, error: 'final_merged_output.json not found.' });
    }

    const mergedData = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));

    // Extract the video_info section
    const videoInfo = mergedData.video_info || {};

    res.json({
      ok: true,
      video_info: videoInfo,
      youtube_video_url: videoInfo.youtube_video_url || null,
    });
  } catch (err) {
    console.error('Error reading video_info:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === Health check ===
app.get('/health', (req, res) => {
  res.json({ ok: true, CURRENT_COURSE, allowList });
});



// === Endpoint to serve final_merged_output.json dynamically ===
app.get('/api/final-merged', async (req, res) => {
  try {
    // construct absolute path to root/final_merged_output.json
    const mergedPath = path.join(__dirname, 'root', 'final_merged_output.json');

    if (!fs.existsSync(mergedPath)) {
      return res.status(404).json({ ok: false, error: 'final_merged_output.json not found in root directory' });
    }

    const data = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
    res.json({ ok: true, file: 'final_merged_output.json', data });
  } catch (err) {
    console.error('Error reading final_merged_output.json:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// === Start server ===
const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`✅ Local backend running on http://localhost:${port}`);
});
