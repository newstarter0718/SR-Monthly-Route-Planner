import express from 'express';
import cors from 'cors';
import { VertexAI } from '@google-cloud/vertexai';

const app = express();
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '2mb' }));

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'alexgemini2035-vertex-20260411';
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const PRIMARY_MODEL = 'gemini-2.5-pro';
const FALLBACK_MODEL = 'gemini-2.5-flash';

const vertex = new VertexAI({ project: PROJECT, location: LOCATION });

function getModel(name: string) {
  return vertex.getGenerativeModel({ model: name });
}

app.post('/api/ai/adjust', async (req, res) => {
  const { instruction, planSummary, settings } = req.body as {
    instruction: string;
    planSummary: Record<string, { visits: number; distance: string; day: string }>;
    settings: { workDays: number; dailyVisitLimit: number };
  };

  if (!instruction?.trim()) {
    res.status(400).json({ error: 'instruction is required' });
    return;
  }

  const systemPrompt = `You are an expert route planning assistant for a field sales team.
You receive a monthly route plan summary and a natural-language instruction from the manager.
Your job is to analyze the plan and return a JSON response describing:
1. A clear human-readable explanation of what you found or recommend
2. If the instruction asks for a change, structured change directives the application can apply

Current plan settings: ${settings.workDays} work days/week, max ${settings.dailyVisitLimit} visits/day.

Plan summary by date (format W{week}-{day}):
${JSON.stringify(planSummary, null, 2)}

Rules for your JSON response:
- Always include a "message" field (string) with a clear, concise explanation
- If changes are needed, include a "changes" array with objects: { type: "move_day", customerId?: string, fromDay: string, toDay: string, filter?: { frequency?: number, day?: string } }
- If only analysis is needed (no changes), omit "changes" or set it to []
- Be specific about which customers/days are affected
- Respond ONLY with valid JSON, no markdown fences`;

  const userContent = `Instruction: ${instruction}`;

  for (const modelName of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const model = getModel(modelName);
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 },
      });
      const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      const parsed = JSON.parse(text);
      res.json({ model: modelName, ...parsed });
      return;
    } catch (err: any) {
      const is503 = err?.status === 503 || err?.message?.includes('overloaded');
      if (modelName === PRIMARY_MODEL && is503) continue;
      console.error(`[AI] ${modelName} error:`, err?.message);
      res.status(500).json({ error: 'AI service error', detail: err?.message });
      return;
    }
  }
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = Number(process.env.AI_SERVER_PORT) || 3001;
app.listen(PORT, () => console.log(`[AI server] http://localhost:${PORT}`));
