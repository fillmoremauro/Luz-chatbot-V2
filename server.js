import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KNOWLEDGE_FILE_PATH = path.join(__dirname, "knowledge", "fillsun_base.md");

async function loadKnowledgeBase() {
  try {
    const content = await fs.readFile(KNOWLEDGE_FILE_PATH, "utf8");
    console.log("[LUZ] Base de conocimiento cargada correctamente.");
    return content;
  } catch (error) {
    console.error("[LUZ] No pude leer knowledge/fillsun_base.md:", error.message);
    return `
# FILLSUN Knowledge Base — fallback mínimo

FILLSUN trabaja con soluciones de energía solar en Argentina.

WhatsApp principal: +54 9 11 3348 0020

Reglas:
- Responder solo con información confirmada.
- No inventar.
- Si falta información, derivar a WhatsApp.
`;
  }
}

const FILLSUN_KNOWLEDGE_BASE = await loadKnowledgeBase();

const SYSTEM_PROMPT = `
Sos Luz, asistente virtual de FILLSUN.

Tu función es ayudar a potenciales clientes usando únicamente información confirmada en la base de conocimiento incluida más abajo.

OBJETIVOS
1. Responder dudas generales sobre soluciones solares de FILLSUN.
2. Mantener respuestas breves, claras, profesionales y naturales, con tono argentino neutro.
3. No inventar información.
4. Pedir nombre de forma sutil más adelante si todavía no lo tenés.
5. Pedir teléfono solo cuando haya intención comercial real o convenga derivar a un asesor.
6. Llevar la conversación a WhatsApp cuando la consulta requiera cierre, presupuesto, confirmación técnica, disponibilidad o seguimiento humano.

REGLAS OBLIGATORIAS
- Nunca inventes datos.
- Nunca respondas usando conocimiento general si no está confirmado abajo.
- Nunca ofrezcas productos no publicados o no confirmados.
- Si no encontrás una respuesta confiable, decilo con honestidad.
- No seas invasiva al pedir datos.
- No hagas preguntas innecesarias.
- No des respuestas largas.
- No uses tono exageradamente vendedor.
- Priorizá ayudar, orientar y ordenar la consulta.

RESPUESTA CUANDO LA BASE NO ALCANZA
"No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo."

FORMATO DE SALIDA
Debés responder SIEMPRE en JSON válido.
No agregues texto antes ni después del JSON.
Usá exactamente esta estructura:

{
  "reply": "texto breve para el usuario",
  "ask_name": false,
  "ask_phone": false,
  "show_whatsapp": false,
  "whatsapp_text": "mensaje corto para WhatsApp"
}

REGLAS PARA ask_name
- true solo si ya existe email, todavía no existe nombre, y la conversación ya avanzó un poco.
- false en cualquier otro caso.

REGLAS PARA ask_phone
- true solo si detectás intención comercial, presupuesto, instalación, compra, visita, asesor o confirmación técnica.
- false en cualquier otro caso.

REGLAS PARA show_whatsapp
- true cuando convenga derivar a WhatsApp.
- false cuando todavía no haga falta.

BASE DE CONOCIMIENTO FILLSUN
${FILLSUN_KNOWLEDGE_BASE}
`;

app.get("/", (_req, res) => {
  res.send("Luz backend activo.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "luz-backend-v2",
    knowledge_loaded: Boolean(FILLSUN_KNOWLEDGE_BASE && FILLSUN_KNOWLEDGE_BASE.length > 50),
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const {
      message = "",
      email = "",
      name = "",
      phone = "",
      pageUrl = "",
      pageTitle = "",
      conversationId = "",
    } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Mensaje inválido" });
    }

    const safeEmail = String(email || "").trim();
    const safeName = String(name || "").trim();
    const safePhone = String(phone || "").trim();
    const safeMessage = String(message || "").trim();
    const safePageUrl = String(pageUrl || "").trim();
    const safePageTitle = String(pageTitle || "").trim();
    const safeConversationId = String(conversationId || "").trim();

    const userContext = `
IMPORTANTE: devolvé la respuesta en formato json válido.
Usá exactamente estas claves:
reply, ask_name, ask_phone, show_whatsapp, whatsapp_text.

DATOS ACTUALES DEL USUARIO
- Email: ${safeEmail || "no informado"}
- Nombre: ${safeName || "no informado"}
- Teléfono: ${safePhone || "no informado"}
- Página actual: ${safePageTitle || "sin título"}
- URL actual: ${safePageUrl || "sin URL"}

MENSAJE DEL USUARIO
${safeMessage}
`;

    console.log("[LUZ_CHAT] Nuevo mensaje:", {
      email: safeEmail || "sin email",
      name: safeName || "sin nombre",
      phone: safePhone || "sin telefono",
      pageTitle: safePageTitle || "sin titulo",
      message: safeMessage,
    });

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      previous_response_id: safeConversationId || undefined,
      input: userContext,
      instructions: SYSTEM_PROMPT,
      max_output_tokens: 500,
    });

    const rawText = response.output_text || "{}";
    let parsed = safeParseJson(rawText);

    if (!parsed) {
      parsed = {
        reply:
          "No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo.",
        ask_name: false,
        ask_phone: true,
        show_whatsapp: true,
        whatsapp_text: buildWhatsappText({ name: safeName, message: safeMessage }),
      };
    }

    const finalPayload = {
      reply:
        typeof parsed.reply === "string" && parsed.reply.trim()
          ? parsed.reply.trim()
          : "No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo.",
      ask_name: Boolean(parsed.ask_name),
      ask_phone: Boolean(parsed.ask_phone),
      show_whatsapp: Boolean(parsed.show_whatsapp),
      whatsapp_text:
        typeof parsed.whatsapp_text === "string" && parsed.whatsapp_text.trim()
          ? parsed.whatsapp_text.trim()
          : buildWhatsappText({ name: safeName, message: safeMessage }),
      conversationId: response.id,
    };

    return res.json(finalPayload);
  } catch (error) {
    console.error("[LUZ_BACKEND_ERROR]", error);

    return res.status(500).json({
      reply:
        "Ahora mismo no pude procesar bien tu consulta. Para seguirlo sin demoras, te conviene continuar por WhatsApp con el equipo de FILLSUN.",
      ask_name: false,
      ask_phone: true,
      show_whatsapp: true,
      whatsapp_text: buildWhatsappText({ message: "Consulta desde Luz" }),
      conversationId: "",
    });
  }
});

function buildWhatsappText({ name = "", message = "" }) {
  const introName = name ? `Me llamo ${name} y ` : "";
  const topic = message ? ` Tema: ${message}` : "";
  return `Hola FILLSUN, ${introName}ya hablé con Luz y quiero seguir mi consulta.${topic}`.trim();
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const candidate = text.slice(firstBrace, lastBrace + 1);
        return JSON.parse(candidate);
      }
      return null;
    } catch {
      return null;
    }
  }
}

app.listen(PORT, () => {
  console.log(`Luz backend escuchando en puerto ${PORT}`);
});
