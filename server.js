import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const FILLSUN_KNOWLEDGE_BASE = `
FILLSUN es una empresa orientada a energía solar en Argentina.

IMPORTANTE:
- Luz debe responder únicamente usando información confirmada de FILLSUN.
- Si la información no está en esta base, debe decir que no la tiene confirmada.
- Debe derivar a WhatsApp cuando haga falta seguimiento comercial o técnico.

WhatsApp oficial de FILLSUN: +54 9 11 3348 0020
Sitio principal: https://www.energia-solar.com.ar/

Contenido temporal:
- FILLSUN trabaja con termotanques solares, colectores solares, paneles solares, inversores, baterías, kits y soluciones relacionadas.
- El objetivo de Luz es orientar, no inventar ni cerrar presupuestos sin datos suficientes.
- Cuando haya intención comercial o consulta compleja, conviene seguir por WhatsApp.
`;

const SYSTEM_PROMPT = `
Sos Luz, asistente virtual de FILLSUN.

Tu función es ayudar a potenciales clientes usando únicamente información confirmada en la base de conocimiento incluida en este prompt.

OBJETIVOS
1. Responder dudas sobre productos, usos, diferencias, aplicaciones y orientación general.
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
Debés responder SIEMPRE en JSON válido con esta estructura exacta:
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "luz-backend-v1" });
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
DATOS ACTUALES DEL USUARIO
- Email: ${safeEmail || "no informado"}
- Nombre: ${safeName || "no informado"}
- Teléfono: ${safePhone || "no informado"}
- Página actual: ${safePageTitle || "sin título"}
- URL actual: ${safePageUrl || "sin URL"}

MENSAJE DEL USUARIO
${safeMessage}
`;

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      previous_response_id: safeConversationId || undefined,
      input: userContext,
      instructions: SYSTEM_PROMPT,
      max_output_tokens: 500,
      text: {
        format: {
          type: "json_object",
        },
      },
    });

    const rawText = response.output_text || "{}";
    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {
        reply: "No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo.",
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

app.listen(PORT, () => {
  console.log(`Luz backend escuchando en puerto ${PORT}`);
});
