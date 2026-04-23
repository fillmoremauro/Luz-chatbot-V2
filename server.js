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
const WIKI_FILE_PATH = path.join(__dirname, "knowledge", "fillsun_wiki.md");
const sentLeadAlerts = new Set();

async function loadTextFile(filePath, label, fallback = "") {
  try {
    const content = await fs.readFile(filePath, "utf8");
    console.log(`[LUZ] ${label} cargado correctamente.`);
    return content;
  } catch (error) {
    console.error(`[LUZ] No pude leer ${filePath}:`, error.message);
    return fallback;
  }
}

const FILLSUN_KNOWLEDGE_BASE = await loadTextFile(
  KNOWLEDGE_FILE_PATH,
  "fillsun_base.md",
  `FILLSUN trabaja con soluciones de energía solar en Argentina. Si falta información, derivar a WhatsApp.`
);

const FILLSUN_WIKI_BASE = await loadTextFile(
  WIKI_FILE_PATH,
  "fillsun_wiki.md",
  ``
);

const BASE_SYSTEM_PROMPT = `
Sos Luz, asistente virtual de FILLSUN.

OBJETIVO
- Ayudar con dudas generales sobre soluciones solares de FILLSUN.
- Responder breve, claro y útil.
- No sonar enciclopédica.
- No inventar información.
- Orientar primero. Derivar después.

REGLAS
- Respondé solo con información confirmada en la base incluida.
- No prometas stock, precio final, plazos, instalación, disponibilidad ni compatibilidades exactas.
- No recomiendes modelos exactos sin derivación.
- Si falta certeza, decilo con honestidad.
- Si la consulta es comercial, WhatsApp puede mostrarse.
- Si el usuario ya está listo para avanzar, WhatsApp puede mostrarse aunque también se pida teléfono.
- No metas en el "reply" pedidos de teléfono largos o repetidos.
- Si está en una calculadora y la consulta encaja, priorizá invitar a usar esa calculadora.
- El tono debe ser profesional, cercano y natural, en español neutro de Argentina.

SALIDA
Respondé SIEMPRE en JSON válido y nada más:
{
  "reply": "texto para el usuario",
  "ask_name": false,
  "ask_phone": false,
  "show_whatsapp": false,
  "whatsapp_text": "mensaje corto para WhatsApp"
}
`;

app.get("/", (_req, res) => {
  res.send("Luz backend activo.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "luz-backend-v7",
    knowledge_loaded: Boolean(FILLSUN_KNOWLEDGE_BASE && FILLSUN_KNOWLEDGE_BASE.length > 50),
    wiki_loaded: Boolean(FILLSUN_WIKI_BASE && FILLSUN_WIKI_BASE.length > 50),
    email_alerts_enabled: isEmailAlertsConfigured(),
    brevo_enabled: isBrevoConfigured(),
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
    const calculatorPage = isCalculatorPage(safePageTitle, safePageUrl);
    const calculatorIntent = detectCalculatorIntent(safeMessage);

    let finalPayload;

    if (calculatorPage && calculatorIntent && !commercialIntent) {
      finalPayload = {
        reply: buildCalculatorReply({ message: safeMessage, interestTag }),
        ask_name: false,
        ask_phone: false,
        show_whatsapp: false,
        whatsapp_text: buildWhatsappText({ name: safeName, message: safeMessage }),
        conversationId: safeConversationId || "",
        interest_tag: interestTag,
      };
    } else {
      const selectedWiki = pickRelevantWikiSections(FILLSUN_WIKI_BASE, interestTag);

      const instructions = `
${BASE_SYSTEM_PROMPT}

BASE OPERATIVA FILLSUN
${FILLSUN_KNOWLEDGE_BASE}

WIKI COMPLEMENTARIA RELEVANTE
${selectedWiki}
`;

      const userContext = `
IMPORTANTE: devolvé la respuesta en formato json válido.
Usá exactamente estas claves:
reply, ask_name, ask_phone, show_whatsapp, whatsapp_text.

CONTEXTO DEL USUARIO
- Email: ${safeEmail || "no informado"}
- Nombre: ${safeName || "no informado"}
- Teléfono: ${safePhone || "no informado"}
- Página actual: ${safePageTitle || "sin título"}
- URL actual: ${safePageUrl || "sin URL"}
- Interés detectado: ${interestTag}
- Intención comercial: ${commercialIntent ? "sí" : "no"}
- Está en calculadoras: ${calculatorPage ? "sí" : "no"}
- Cantidad de mensajes previos: ${safeMessagesCount}

MENSAJE DEL USUARIO
${safeMessage}
`;

      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
        previous_response_id: safeConversationId || undefined,
        input: userContext,
        instructions,
        max_output_tokens: 260,
      });

      const rawText = response.output_text || "{}";
      let parsed = safeParseJson(rawText);

      if (!parsed) {
        parsed = {
          reply:
            "No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo.",
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
      });

      finalPayload = {
        reply: sanitizeReply(
          typeof parsed.reply === "string" && parsed.reply.trim()
            ? parsed.reply.trim()
            : "No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo."
        ),
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
    }

    const shouldSyncBrevo =
      Boolean(safeEmail) &&
      (
        commercialIntent ||
        Boolean(safePhone) ||
        safeMessagesCount >= 2
      );

    if (shouldSyncBrevo) {
      await upsertBrevoContact({
        email: safeEmail,
        name: safeName,
        phone: safePhone,
        interestTag,
        pageTitle: safePageTitle,
        pageUrl: safePageUrl,
      });
    }

    const shouldSendLeadAlert = shouldSendAlert({
      email: safeEmail,
      phone: safePhone,
      commercialIntent,
      showWhatsapp: finalPayload.show_whatsapp,
      message: safeMessage,
    });

    if (shouldSendLeadAlert) {
      const alertKey = buildAlertKey({
        sessionId: safeSessionId,
        email: safeEmail,
        interestTag,
      });

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
      reply:
        "Ahora mismo no pude procesar bien tu consulta. Para seguirlo sin demoras, te conviene continuar por WhatsApp con el equipo de FILLSUN.",
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
  const text = String(message || "").toLowerCase();
  return /precio|presupuesto|cotiza|cotizaci[oó]n|instalaci[oó]n|compra|comprar|quiero comprar|asesor|hablar|whatsapp|visita|stock|disponibilidad|link|pasame/.test(
    text
  );
}

function isCalculatorPage(pageTitle = "", pageUrl = "") {
  const text = `${pageTitle} ${pageUrl}`.toLowerCase();
  return /calculadora|calculadoras|calcular|dimensionamiento|ahorro/.test(text);
}

function detectCalculatorIntent(message = "") {
  const text = String(message || "").toLowerCase();
  return /cu[aá]ntos|cu[aá]nto|cu[aá]l necesito|me conviene|dimensionar|consumo|ahorro|paneles necesito|termotanque necesito|sirve para mi casa|para mi casa/.test(
    text
  );
}

function buildCalculatorReply({ message = "", interestTag = "general" }) {
  const text = String(message || "").toLowerCase();

  if (interestTag === "paneles") {
    return "Eso depende del consumo que quieras cubrir y del tipo de sistema. En esta misma página podés usar la calculadora para estimarlo. Si querés, después te ayudo a interpretar el resultado.";
  }

  if (interestTag === "termotanques") {
    return "Para estimar qué equipo puede servirte, conviene mirar cantidad de personas y nivel de uso de agua caliente. Si estás en la calculadora, podés usarla como referencia inicial y después te ayudo a seguir.";
  }

  if (interestTag === "colectores") {
    return "Para orientarlo bien hay que mirar medidas de la pileta y objetivo de uso. Si estás en la calculadora, usala como referencia inicial y después seguimos con lo que te dé.";
  }

  if (/ahorro/.test(text)) {
    return "El ahorro depende del consumo y del sistema que quieras evaluar. En esta misma página podés usar la calculadora para hacer una estimación inicial.";
  }

  return "En esta página podés usar la calculadora para hacer una estimación inicial. Si querés, después te ayudo a interpretar el resultado.";
}

function shouldAskPhone({
  modelValue = false,
  email = "",
  name = "",
  phone = "",
  commercialIntent = false,
  safeMessagesCount = 0,
}) {
  if (phone) return false;
  if (!email) return false;
  if (!name) return false;
  if (commercialIntent) return true;
  if (modelValue && safeMessagesCount >= 4) return true;
  return false;
}

function shouldShowWhatsapp({
  modelValue = false,
  commercialIntent = false,
  safePhone = "",
  safeMessage = "",
  safeMessagesCount = 0,
}) {
  const text = String(safeMessage || "").toLowerCase();

  if (/pasame el link|pasame whatsapp|dame el whatsapp|quiero hablar con alguien|quiero hablar con una persona|asesor|hablar con una persona|hablar con alguien/.test(text)) {
    return true;
  }

  if (commercialIntent) return true;
  if (safePhone && safeMessagesCount >= 3) return true;
  if (modelValue && safeMessagesCount >= 5) return true;

  return false;
}

function shouldSendAlert({
  email = "",
  phone = "",
  commercialIntent = false,
  showWhatsapp = false,
  message = "",
}) {
  const hasEmail = Boolean(email);
  const hasPhone = Boolean(phone);
  const hasRealQuestion = String(message || "").trim().length >= 8;

  return (
    hasRealQuestion &&
    (
      (hasEmail && hasPhone) ||
      (hasEmail && commercialIntent) ||
      (hasEmail && showWhatsapp && commercialIntent)
    )
  );
}

function buildAlertKey({ sessionId = "", email = "", interestTag = "general" }) {
  return `${sessionId || "sin_sesion"}__${email || "sin_email"}__${interestTag}`;
}

function isEmailAlertsConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.LEAD_ALERT_TO
  );
}

function isBrevoConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_LIST_ID);
}

function normalizePhoneForBrevo(phone = "") {
  const raw = String(phone || "").trim();
  if (!raw) return "";

  let cleaned = raw.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("00")) cleaned = `+${cleaned.slice(2)}`;
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("54")) return `+${cleaned}`;

  if (cleaned.startsWith("0")) cleaned = cleaned.slice(1);
  if (cleaned.startsWith("11")) return `+549${cleaned}`;

  return `+54${cleaned}`;
}

async function upsertBrevoContact({
  email = "",
  name = "",
  phone = "",
  interestTag = "general",
  pageTitle = "",
  pageUrl = "",
}) {
  if (!isBrevoConfigured()) return false;
  if (!email) return false;

  try {
    const attributes = {
      INTERES: interestTag || "general",
      ORIGEN: "Luz",
      ULTIMA_PAGINA: pageTitle || pageUrl || "",
    };

    if (name) attributes.FNAME = name;

    const normalizedPhone = normalizePhoneForBrevo(phone);
    if (normalizedPhone) attributes.SMS = normalizedPhone;

    const payload = {
      email,
      attributes,
      listIds: [Number(process.env.BREVO_LIST_ID)],
      updateEnabled: true,
    };

    const response = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[LUZ_BREVO_ERROR]", response.status, errorText);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[LUZ_BREVO_ERROR]", error);
    return false;
  }
}

async function sendLeadAlertEmail({
  email = "",
  name = "",
  phone = "",
  pageTitle = "",
  pageUrl = "",
  message = "",
  interestTag = "general",
  commercialIntent = false,
  assistantReply = "",
}) {
  if (!isEmailAlertsConfigured()) return false;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const subject = `Nuevo lead desde Luz — ${interestTag}`;
    const now = new Date().toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.LEAD_ALERT_TO,
      replyTo: email || undefined,
      subject,
      text:
        `Fecha: ${now}\n` +
        `Interés: ${interestTag}\n` +
        `Intención comercial: ${commercialIntent ? "sí" : "no"}\n` +
        `Nombre: ${name || "no informado"}\n` +
        `Email: ${email || "no informado"}\n` +
        `Teléfono: ${phone || "no informado"}\n` +
        `Página: ${pageTitle || "sin título"}\n` +
        `URL: ${pageUrl || "sin URL"}\n` +
        `Consulta: ${message || "sin mensaje"}\n` +
        `Respuesta de Luz: ${assistantReply || "sin respuesta"}`,
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

function sanitizeReply(text = "") {
  let clean = String(text || "").trim();

  clean = clean.replace(
    /si quer[eé]s,?\s*(tambi[eé]n\s*)?pod[eé]s dejarme un tel[eé]fono[^.?!]*[.?!]?/gi,
    ""
  );

  clean = clean.replace(
    /dejame tu tel[eé]fono[^.?!]*[.?!]?/gi,
    ""
  );

  clean = clean.replace(/\n{3,}/g, "\n\n").trim();

  if (!clean) {
    return "No tengo esa información confirmada dentro de FILLSUN. Para verificarlo bien, lo mejor es seguir por WhatsApp con el equipo.";
  }

  return clean;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      }
      return null;
    } catch {
      return null;
    }
  }
}

function pickRelevantWikiSections(markdown = "", interestTag = "general") {
  if (!markdown) return "";

  const sections = splitMarkdownSections(markdown);

  const keywordMap = {
    termotanques: ["termotanque", "heat pipe", "presurizado", "agua caliente"],
    colectores: ["colector", "epdm", "piscina", "pileta", "climatización"],
    paneles: ["panel", "fotovolta", "inversor", "batería", "on grid", "off grid", "híbrido"],
    showroom: ["showroom"],
    contacto: ["contacto", "buenos aires", "argentina"],
    general: ["energía solar", "argentina", "buenos aires", "mantenimiento"],
  };

  const keywords = keywordMap[interestTag] || keywordMap.general;

  const matches = sections.filter((section) => {
    const text = section.toLowerCase();
    return keywords.some((kw) => text.includes(kw));
  });

  const selected = matches.slice(0, 3);
  return selected.length ? selected.join("\n\n") : sections.slice(0, 2).join("\n\n");
}

function splitMarkdownSections(markdown = "") {
  const normalized = String(markdown || "").trim();
  if (!normalized) return [];

  const parts = normalized.split(/\n(?=##\s)/g).map((part) => part.trim()).filter(Boolean);
  return parts;
}

app.listen(PORT, () => {
  console.log(`Luz backend escuchando en puerto ${PORT}`);
});
