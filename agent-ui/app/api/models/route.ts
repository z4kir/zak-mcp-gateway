import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

/** Gemini models this key can use for chat with tools (each has its own free-tier quota). */
export async function POST(req: Request) {
  try {
    const { apiKey } = await req.json();
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) return NextResponse.json({ error: "Missing Gemini API key" }, { status: 400 });

    const ai = new GoogleGenAI({ apiKey: key });
    const models: { id: string; label: string }[] = [];
    for await (const m of await ai.models.list()) {
      const id = (m.name ?? "").replace(/^models\//, "");
      const actions = m.supportedActions ?? [];
      if (!id.startsWith("gemini") || !actions.includes("generateContent")) continue;
      if (/embedding|image|tts|audio|live|vision|transcribe|robotics|computer-use|^gemini-2.5-/i.test(id)) continue;
      models.push({ id, label: m.displayName ?? id });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return NextResponse.json({ models });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
