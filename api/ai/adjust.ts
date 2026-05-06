import type { VercelRequest, VercelResponse } from '@vercel/node';
import { VertexAI } from '@google-cloud/vertexai';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'alexgemini2035-vertex-20260411';
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const PRIMARY_MODEL = 'gemini-2.5-pro';
const FALLBACK_MODEL = 'gemini-2.5-flash';

function getVertex() {
  // On Vercel: credentials come as a JSON string env var
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credsJson) {
    const credentials = JSON.parse(credsJson);
    return new VertexAI({
      project: PROJECT,
      location: LOCATION,
      googleAuthOptions: { credentials },
    });
  }
  // Local dev fallback: use file-based credentials (GOOGLE_APPLICATION_CREDENTIALS)
  return new VertexAI({ project: PROJECT, location: LOCATION });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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

  const vertex = getVertex();

  for (const modelName of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const model = vertex.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nInstruction: ${instruction}` }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 },
      });
      const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      const parsed = JSON.parse(text);
      res.status(200).json({ model: modelName, ...parsed });
      return;
    } catch (err: any) {
      const is503 = err?.status === 503 || err?.message?.includes('overloaded');
      if (modelName === PRIMARY_MODEL && is503) continue;
      console.error(`[AI] ${modelName} error:`, err?.message);
      res.status(500).json({ error: 'AI service error', detail: err?.message });
      return;
    }
  }
}
