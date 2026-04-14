import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KNOWLEDGE_FILE_PATH = path.join(__dirname, "knowledge", "fillsun_base.md");
const sentLeadAlerts = new Set();

async function loadKnowledgeBase() {
  try {
    const content = await fs.readFile(KNOWLEDGE_FILE_PATH, "utf8");
    console.log("[LUZ] Base de conocimiento cargada correctamente.");
    return content;
  } catch (error) {
    console.error("[LUZ] No pude leer knowledge/fillsun_base.md:", error.message);
    return `FILLSUN trabaja con soluciones de energía solar en Argentina. Si falta información, derivar a WhatsApp.`;
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
5. Pedir teléfono solo cuando haya intención comercial real o cuando el usuario ya esté en una etapa útil para avanzar.
6. Llevar la conversación a WhatsApp cuando la consulta requiera cierre, presupuesto, confirmación técnica específica, disponibilidad o seguimiento humano.

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

REGLAS MUY IMPORTANTES SOBRE WHATSAPP
- NO muestres WhatsApp en cada respuesta.
- Para consultas informativas normales, show_whatsapp debe ser false.
- show_whatsapp solo debe ser true si el usuario pide precio, presupuesto, instalación, disponibilidad, stock, asesor, visita, compra, contacto humano, o si claramente ya corresponde pasar a un humano.
- Si la conversación sigue siendo orientativa o educativa, show_whatsapp debe seguir en false.

REGLAS MUY IMPORTANTES SOBRE ask_phone
- ask_phone debe ser true si el usuario ya dio email y nombre, y además:
  a) pide precio, presupuesto, instalación, stock, disponibilidad o asesor, o
  b) ya hizo varias preguntas útiles y parece interesado en avanzar.
- No hace falta esperar a que el usuario lo pida explícitamente.

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

BASE DE CONOCIMIENTO FILLSUN
${FILLSUN_KNOWLEDGE_BASE}
`;

app.get("/", (_req, res) => {
  res.send("Luz backend activo.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "luz-backend-v5",
    knowledge_loaded: Boolean(FILLSUN_KNOWLEDGE_BASE && FILLSUN_KNOWLEDGE_BASE.length > 50),
    email_alerts_enabled: isEmailAlertsConfigured(),
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
      sessionId = "",
      messagesCount = 0,
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
    const safeSessionId = String(sessionId || "").trim();
    const safeMessagesCount = Number(messagesCount || 0);

    const interestTag = detectInterestTag(safeMessage, safePageTitle, safePageUrl);
    const commercialIntent = detectCommercialIntent(safeMessage);

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
- Interés detectado: ${interestTag}
- Intención comercial detectada: ${commercialIntent ? "sí" : "no"}
- Cantidad de mensajes del usuario hasta ahora: ${safeMessagesCount}

MENSAJE DEL USUARIO
${safeMessage}
`;

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
        reply: "No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo.",
        ask_name: false,
        ask_phone: false,
        show_whatsapp: false,
        whatsapp_text: buildWhatsappText({ name: safeName, message: safeMessage }),
      };
    }

    const askPhoneFinal = shouldAskPhone({
      modelValue: Boolean(parsed.ask_phone),
      email: safeEmail,
      name: safeName,
      phone: safePhone,
      commercialIntent,
      safeMessagesCount,
    });

    const showWhatsappFinal = shouldShowWhatsapp({
      modelValue: Boolean(parsed.show_whatsapp),
      commercialIntent,
      safePhone,
      safeMessage,
      safeMessagesCount,
      askPhoneFinal,
    });

    const finalPayload = {
      reply:
        typeof parsed.reply === "string" && parsed.reply.trim()
          ? parsed.reply.trim()
          : "No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo.",
      ask_name: Boolean(parsed.ask_name),
      ask_phone: askPhoneFinal,
      show_whatsapp: showWhatsappFinal,
      whatsapp_text:
        typeof parsed.whatsapp_text === "string" && parsed.whatsapp_text.trim()
          ? parsed.whatsapp_text.trim()
          : buildWhatsappText({ name: safeName, message: safeMessage }),
      conversationId: response.id,
      interest_tag: interestTag,
    };

    const shouldSendLeadAlert = shouldSendAlert({
      email: safeEmail,
      phone: safePhone,
      commercialIntent,
      showWhatsapp: finalPayload.show_whatsapp,
      message: safeMessage,
    });

    if (shouldSendLeadAlert) {
      const alertKey = buildAlertKey({ sessionId: safeSessionId, email: safeEmail, interestTag });
      if (!sentLeadAlerts.has(alertKey)) {
        const sent = await sendLeadAlertEmail({
          email: safeEmail,
          name: safeName,
          phone: safePhone,
          pageTitle: safePageTitle,
          pageUrl: safePageUrl,
          message: safeMessage,
          interestTag,
          commercialIntent,
          assistantReply: finalPayload.reply,
        });
        if (sent) sentLeadAlerts.add(alertKey);
      }
    }

    return res.json(finalPayload);
  } catch (error) {
    console.error("[LUZ_BACKEND_ERROR]", error);
    return res.status(500).json({
      reply: "Ahora mismo no pude procesar bien tu consulta. Para seguirlo sin demoras, te conviene continuar por WhatsApp con el equipo de FILLSUN.",
      ask_name: false,
      ask_phone: false,
      show_whatsapp: true,
      whatsapp_text: buildWhatsappText({ message: "Consulta desde Luz" }),
      conversationId: "",
    });
  }
});

function detectInterestTag(message = "", pageTitle = "", pageUrl = "") {
  const text = `${message} ${pageTitle} ${pageUrl}`.toLowerCase();
  if (/termotanque|termo|agua caliente|heat pipe|presurizado/.test(text)) return "termotanques";
  if (/colector|epdm|pileta|piscina|climatiz/.test(text)) return "colectores";
  if (/panel|fotovolta|inversor|bater[ií]a|kit solar|kites?/.test(text)) return "paneles";
  if (/showroom/.test(text)) return "showroom";
  if (/contacto|direccion|direcci[oó]n|ubicaci[oó]n|telefono|tel[eé]fono|mail|correo/.test(text)) return "contacto";
  return "general";
}

function detectCommercialIntent(message = "") {
  const text = message.toLowerCase();
  return /precio|presupuesto|cotiza|cotizaci[oó]n|instalaci[oó]n|compra|comprar|asesor|hablar|whatsapp|visita|stock|disponibilidad|link/.test(text);
}

function shouldAskPhone({ modelValue = false, email = "", name = "", phone = "", commercialIntent = false, safeMessagesCount = 0 }) {
  if (phone) return false;
  if (!email) return false;
  if (!name) return false;
  if (commercialIntent) return true;
  if (modelValue && safeMessagesCount >= 4) return true;
  return false;
}

function shouldShowWhatsapp({ modelValue = false, commercialIntent = false, safePhone = "", safeMessage = "", safeMessagesCount = 0, askPhoneFinal = false }) {
  if (/pasame el link|pasame whatsapp|dame el whatsapp|quiero hablar con alguien|asesor|hablar con una persona/.test(safeMessage.toLowerCase())) return true;
  if (commercialIntent && !askPhoneFinal) return true;
  if (safePhone && safeMessagesCount >= 4) return true;
  if (modelValue && safeMessagesCount >= 5 && !askPhoneFinal) return true;
  return false;
}

function shouldSendAlert({ email = "", phone = "", commercialIntent = false, showWhatsapp = false, message = "" }) {
  const hasEmail = Boolean(email);
  const hasPhone = Boolean(phone);
  const hasRealQuestion = String(message || "").trim().length >= 8;
  return hasRealQuestion && ((hasEmail && hasPhone) || (hasEmail && commercialIntent) || (hasEmail && showWhatsapp && commercialIntent));
}

function buildAlertKey({ sessionId = "", email = "", interestTag = "general" }) {
  return `${sessionId || "sin_sesion"}__${email || "sin_email"}__${interestTag}`;
}

function isEmailAlertsConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.LEAD_ALERT_TO);
}

async function sendLeadAlertEmail({ email = "", name = "", phone = "", pageTitle = "", pageUrl = "", message = "", interestTag = "general", commercialIntent = false, assistantReply = "" }) {
  if (!isEmailAlertsConfigured()) return false;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const subject = `Nuevo lead desde Luz — ${interestTag}`;
    const now = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.LEAD_ALERT_TO,
      replyTo: email || undefined,
      subject,
      text: `Fecha: ${now}\nInterés: ${interestTag}\nIntención comercial: ${commercialIntent ? "sí" : "no"}\nNombre: ${name || "no informado"}\nEmail: ${email || "no informado"}\nTeléfono: ${phone || "no informado"}\nPágina: ${pageTitle || "sin título"}\nURL: ${pageUrl || "sin URL"}\nConsulta: ${message || "sin mensaje"}\nRespuesta de Luz: ${assistantReply || "sin respuesta"}`,
    });
    return true;
  } catch (error) {
    console.error("[LUZ_EMAIL_ERROR]", error);
    return false;
  }
}

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
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      return null;
    } catch {
      return null;
    }
  }
}

app.listen(PORT, () => {
  console.log(`Luz backend escuchando en puerto ${PORT}`);
});
