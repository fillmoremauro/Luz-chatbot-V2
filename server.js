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
const CALCULATORS_URL = "https://energia-solar.com.ar/calculadoras/";
const WHATSAPP_NUMBER = "5491133480020";
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
  "FILLSUN trabaja con soluciones de energía solar en Argentina. Si falta información, decirlo con honestidad y orientar sin inventar."
);

const FILLSUN_WIKI_BASE = await loadTextFile(WIKI_FILE_PATH, "fillsun_wiki.md", "");

const BASE_SYSTEM_PROMPT = `
Sos Luz, asistente virtual de FILLSUN.

FORMA DE RESPONDER
- Español natural de Argentina.
- Respuestas cortas: normalmente entre 1 y 4 frases.
- Útil de verdad, cero tono robótico.
- No sonar enciclopédica ni recitar texto largo.
- No decir solo “depende”; si depende, explicá de qué depende y cuál sería el siguiente paso lógico.

ROL REAL
- Primero despejar la duda.
- Después orientar.
- Solo llevar a calculadora si realmente ayuda.
- Solo llevar a WhatsApp si ya tiene sentido comercial o de cierre.

NO HACER
- No inventar datos no confirmados.
- No prometer stock, precio final, plazos, instalación, compatibilidades exactas ni disponibilidad.
- No mandar a WhatsApp porque sí.
- No mencionar botones, links o WhatsApp dentro del reply salvo que sea muy necesario.
- No pedir teléfono de forma torpe ni insistente.
- No responder como folleto de ventas.

CUÁNDO PRIORIZAR CADA COSA
- Consulta general/informativa: responder bien y listo.
- Consulta de orientación o dimensionamiento: ayudar y dejar abierta la opción de calculadora.
- Consulta comercial o de cierre: responder breve y dejar lista la derivación comercial.

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
    service: "luz-backend-v8",
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

    const routing = analyzeRouting({
      message: safeMessage,
      pageTitle: safePageTitle,
      pageUrl: safePageUrl,
      messagesCount: safeMessagesCount,
      hasPhone: Boolean(safePhone),
      hasEmail: Boolean(safeEmail),
      hasName: Boolean(safeName),
    });

    const selectedWiki = pickRelevantWikiSections(FILLSUN_WIKI_BASE, routing.interestTag);

    const instructions = `
${BASE_SYSTEM_PROMPT}

BASE OPERATIVA FILLSUN
${FILLSUN_KNOWLEDGE_BASE}

WIKI COMPLEMENTARIA RELEVANTE
${selectedWiki}
`;

    const userContext = `
IMPORTANTE: devolvé la respuesta en formato JSON válido con estas claves exactas:
reply, ask_name, ask_phone, show_whatsapp, whatsapp_text.

CONTEXTO DEL USUARIO
- Email: ${safeEmail || "no informado"}
- Nombre: ${safeName || "no informado"}
- Teléfono: ${safePhone || "no informado"}
- Página actual: ${safePageTitle || "sin título"}
- URL actual: ${safePageUrl || "sin URL"}
- Interés detectado: ${routing.interestTag}
- Etapa detectada: ${routing.stage}
- Intención comercial: ${routing.commercialIntent ? "sí" : "no"}
- Necesidad de calculadora: ${routing.calculatorIntent ? "sí" : "no"}
- Está en página de calculadoras: ${routing.calculatorPage ? "sí" : "no"}
- Cantidad de mensajes previos: ${safeMessagesCount}

MENSAJE DEL USUARIO
${safeMessage}
`;

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      previous_response_id: safeConversationId || undefined,
      input: userContext,
      instructions,
      max_output_tokens: 220,
    });

    const rawText = response.output_text || "{}";
    const parsed = safeParseJson(rawText) || {};

    const reply = finalizeReply({
      rawReply: parsed.reply,
      routing,
      safeMessage,
    });

    const askPhoneFinal = shouldAskPhone({
      routing,
      safeEmail,
      safeName,
      safePhone,
      modelValue: Boolean(parsed.ask_phone),
    });

    const cta = buildCTA({
      routing,
      safeName,
      safeMessage,
      modelWhatsappText: parsed.whatsapp_text,
    });

    const finalPayload = {
      reply,
      ask_name: false,
      ask_phone: askPhoneFinal,
      show_whatsapp: cta.type === "whatsapp",
      whatsapp_text:
        typeof parsed.whatsapp_text === "string" && parsed.whatsapp_text.trim()
          ? parsed.whatsapp_text.trim()
          : buildWhatsappText({ name: safeName, message: safeMessage }),
      cta_type: cta.type,
      cta_label: cta.label,
      cta_url: cta.url,
      calculator_url: CALCULATORS_URL,
      interest_tag: routing.interestTag,
      stage: routing.stage,
      conversationId: response.id,
    };

    const shouldSyncBrevo =
      Boolean(safeEmail) &&
      (routing.commercialIntent || Boolean(safePhone) || safeMessagesCount >= 2);

    if (shouldSyncBrevo) {
      await upsertBrevoContact({
        email: safeEmail,
        name: safeName,
        phone: safePhone,
        interestTag: routing.interestTag,
        pageTitle: safePageTitle,
        pageUrl: safePageUrl,
      });
    }

    const shouldSendLeadAlert = shouldSendAlert({
      email: safeEmail,
      phone: safePhone,
      commercialIntent: routing.commercialIntent,
      ctaType: cta.type,
      message: safeMessage,
    });

    if (shouldSendLeadAlert) {
      const alertKey = buildAlertKey({
        sessionId: safeSessionId,
        email: safeEmail,
        interestTag: routing.interestTag,
      });

      if (!sentLeadAlerts.has(alertKey)) {
        const sent = await sendLeadAlertEmail({
          email: safeEmail,
          name: safeName,
          phone: safePhone,
          pageTitle: safePageTitle,
          pageUrl: safePageUrl,
          message: safeMessage,
          interestTag: routing.interestTag,
          commercialIntent: routing.commercialIntent,
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
        "Ahora mismo no pude procesar bien tu consulta. Si querés seguir sin vueltas, podés escribirnos por WhatsApp.",
      ask_name: false,
      ask_phone: false,
      show_whatsapp: true,
      whatsapp_text: buildWhatsappText({ message: "Consulta desde Luz" }),
      cta_type: "whatsapp",
      cta_label: "Seguir por WhatsApp",
      cta_url: buildWhatsappUrl(buildWhatsappText({ message: "Consulta desde Luz" })),
      calculator_url: CALCULATORS_URL,
      interest_tag: "general",
      stage: "fallback",
      conversationId: "",
    });
  }
});

function analyzeRouting({
  message = "",
  pageTitle = "",
  pageUrl = "",
  messagesCount = 0,
  hasPhone = false,
  hasEmail = false,
  hasName = false,
}) {
  const joined = `${message} ${pageTitle} ${pageUrl}`.toLowerCase();

  const interestTag = detectInterestTag(message, pageTitle, pageUrl);
  const calculatorPage = isCalculatorPage(pageTitle, pageUrl);
  const calculatorIntent = detectCalculatorIntent(message);
  const commercialIntent = detectCommercialIntent(message);
  const explicitWhatsappIntent = /whatsapp|asesor|persona|humano|hablar con alguien|hablar con una persona|contacto directo|pasame tu n[uú]mero|n[uú]mero de contacto/i.test(joined);
  const infoIntent = detectInformationalIntent(message);
  const closingIntent = /quiero comprar|quiero instalar|quiero cotizar|necesito presupuesto|presupuesto|cotizaci[oó]n|visita|coordinar|hablar con ventas|comprar/i.test(joined);

  let stage = "inform";

  if (closingIntent || explicitWhatsappIntent) {
    stage = "close";
  } else if (commercialIntent || (hasPhone && messagesCount >= 2)) {
    stage = "commercial";
  } else if (calculatorIntent) {
    stage = "calculator";
  } else if (!infoIntent && messagesCount >= 2) {
    stage = "orient";
  }

  if (calculatorPage && stage === "calculator") {
    stage = "calculator_on_page";
  }

  return {
    interestTag,
    calculatorPage,
    calculatorIntent,
    commercialIntent,
    explicitWhatsappIntent,
    infoIntent,
    closingIntent,
    stage,
    messagesCount,
    hasPhone,
    hasEmail,
    hasName,
  };
}

function detectInterestTag(message = "", pageTitle = "", pageUrl = "") {
  const text = `${message} ${pageTitle} ${pageUrl}`.toLowerCase();

  if (/termotanque|termo\b|agua caliente|heat pipe|presurizado|tubos al vac[ií]o/.test(text)) return "termotanques";
  if (/colector|epdm|pileta|piscina|climatiz/.test(text)) return "colectores";
  if (/panel|fotovolta|inversor|bater[ií]a|kit solar|on grid|off grid|h[ií]brido/.test(text)) return "paneles";
  if (/showroom/.test(text)) return "showroom";
  if (/contacto|direccion|direcci[oó]n|ubicaci[oó]n|telefono|tel[eé]fono|mail|correo/.test(text)) return "contacto";

  return "general";
}

function detectInformationalIntent(message = "") {
  const text = String(message || "").toLowerCase();
  return /(que es|qué es|como funciona|cómo funciona|sirve|conviene|diferencia|ventaja|beneficio|para qué|para que|funciona en invierno|mantenimiento|duraci[oó]n|cu[aá]l es la diferencia|explicame|explicame|informaci[oó]n)/.test(text);
}

function detectCommercialIntent(message = "") {
  const text = String(message || "").toLowerCase();
  return /(precio|presupuesto|cotiza|cotizaci[oó]n|instalaci[oó]n|compra|comprar|quiero comprar|asesor|visita|stock|disponibilidad|promo|oferta|financiaci[oó]n|env[ií]o|envio|pagar|se puede pedir)/.test(text);
}

function isCalculatorPage(pageTitle = "", pageUrl = "") {
  const text = `${pageTitle} ${pageUrl}`.toLowerCase();
  return /calculadora|calculadoras|calcular|dimensionamiento|ahorro/.test(text);
}

function detectCalculatorIntent(message = "") {
  const text = String(message || "").toLowerCase();
  return /(cu[aá]ntos|cu[aá]nto|cu[aá]l necesito|me conviene para mi casa|para cu[aá]ntas personas|para cuantas personas|dimensionar|dimensionamiento|consumo|ahorro|paneles necesito|termotanque necesito|sirve para mi casa|para mi casa|qué equipo me conviene|que equipo me conviene|qué capacidad|que capacidad|cuánta superficie|cuanta superficie)/.test(text);
}

function finalizeReply({ rawReply = "", routing, safeMessage = "" }) {
  let clean = sanitizeReply(rawReply);

  if (!clean || clean.length < 8) {
    clean = fallbackReplyForStage(routing, safeMessage);
  }

  if (routing.stage === "calculator" && !routing.calculatorPage) {
    clean = softenIntoCalculator(clean, routing.interestTag);
  }

  if (routing.stage === "calculator_on_page") {
    clean = replyForCalculatorPage(routing.interestTag, clean);
  }

  if (routing.stage === "commercial" || routing.stage === "close") {
    clean = keepCommercialReplyTight(clean);
  }

  return clean;
}

function fallbackReplyForStage(routing, message = "") {
  if (routing.stage === "calculator_on_page") {
    return replyForCalculatorPage(routing.interestTag, "");
  }

  if (routing.stage === "calculator") {
    return softenIntoCalculator("Para orientarlo bien conviene estimarlo con una referencia inicial.", routing.interestTag);
  }

  if (routing.stage === "commercial" || routing.stage === "close") {
    return "Puedo orientarte por acá, pero en este punto ya conviene seguirlo directo con el equipo para verlo bien según tu caso.";
  }

  return "Te ayudo con eso. Contame un poco más del uso que querés darle y te oriento con una respuesta más concreta.";
}

function softenIntoCalculator(text = "", interestTag = "general") {
  const baseByTag = {
    paneles:
      "Para orientarlo bien hay que mirar consumo y objetivo del sistema. La calculadora te sirve como primer paso y después, si querés, seguís con una recomendación más fina.",
    termotanques:
      "Para acercarte bien hay que mirar cuántas personas usan el agua caliente y el nivel de uso. La calculadora te sirve como referencia inicial y después seguís con el equipo más adecuado.",
    colectores:
      "Para orientarlo bien hay que mirar tamaño de la pileta y objetivo de uso. La calculadora te da una referencia inicial bastante útil para arrancar.",
    general:
      "Para orientarlo mejor conviene hacer primero una estimación inicial con la calculadora y después seguir según el resultado.",
  };

  const clean = String(text || "").trim();
  if (!clean) return baseByTag[interestTag] || baseByTag.general;

  return `${stripCtaMentions(clean)} ${baseByTag[interestTag] || baseByTag.general}`.trim();
}

function replyForCalculatorPage(interestTag = "general", current = "") {
  const map = {
    paneles:
      "Eso depende del consumo que quieras cubrir y del tipo de sistema. Usá la calculadora como referencia inicial y, si querés, después seguís con una orientación más puntual.",
    termotanques:
      "Para estimarlo bien hay que mirar cantidad de personas y uso de agua caliente. Usá la calculadora como primer paso y después afinás la decisión.",
    colectores:
      "Para orientarlo bien hay que mirar medidas de la pileta y objetivo de uso. La calculadora te da una base bastante útil para arrancar.",
    general:
      "La calculadora te sirve como referencia inicial. Después, con ese resultado, es más fácil orientarte mejor.",
  };

  if (!current) return map[interestTag] || map.general;

  const clean = stripCtaMentions(current);
  if (/calculadora/i.test(clean)) return clean;
  return `${clean} ${map[interestTag] || map.general}`.trim();
}

function keepCommercialReplyTight(text = "") {
  let clean = stripCtaMentions(text);
  clean = clean.replace(/\s{2,}/g, " ").trim();

  if (clean.length > 280) {
    clean = `${clean.slice(0, 277).trim()}...`;
  }

  return clean || "En este punto ya conviene seguirlo directo con el equipo para verlo bien según tu caso.";
}

function buildCTA({ routing, safeName = "", safeMessage = "", modelWhatsappText = "" }) {
  if (routing.stage === "calculator" && !routing.calculatorPage) {
    return {
      type: "calculator",
      label: "Ir a calculadoras",
      url: CALCULATORS_URL,
    };
  }

  if (routing.stage === "close" || routing.explicitWhatsappIntent) {
    const text = modelWhatsappText?.trim() || buildWhatsappText({ name: safeName, message: safeMessage });
    return {
      type: "whatsapp",
      label: "Seguir por WhatsApp",
      url: buildWhatsappUrl(text),
    };
  }

  if (routing.stage === "commercial" && routing.messagesCount >= 1) {
    const text = modelWhatsappText?.trim() || buildWhatsappText({ name: safeName, message: safeMessage });
    return {
      type: "whatsapp",
      label: "Consultar por WhatsApp",
      url: buildWhatsappUrl(text),
    };
  }

  return { type: "none", label: "", url: "" };
}

function shouldAskPhone({ routing, safeEmail = "", safeName = "", safePhone = "", modelValue = false }) {
  if (safePhone) return false;
  if (!safeEmail || !safeName) return false;

  if (routing.stage === "close") return true;
  if (routing.stage === "commercial" && routing.messagesCount >= 2) return true;
  if (modelValue && routing.messagesCount >= 4) return true;

  return false;
}

function shouldSendAlert({ email = "", phone = "", commercialIntent = false, ctaType = "none", message = "" }) {
  const hasEmail = Boolean(email);
  const hasPhone = Boolean(phone);
  const hasRealQuestion = String(message || "").trim().length >= 8;

  return hasRealQuestion && ((hasEmail && hasPhone) || (hasEmail && commercialIntent) || (hasEmail && ctaType === "whatsapp"));
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

async function upsertBrevoContact({ email = "", name = "", phone = "", interestTag = "general", pageTitle = "", pageUrl = "" }) {
  if (!isBrevoConfigured() || !email) return false;

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

function buildWhatsappUrl(text = "") {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text || "Hola FILLSUN")}`;
}

function stripCtaMentions(text = "") {
  return String(text || "")
    .replace(/whatsapp/gi, "")
    .replace(/seguir por el equipo comercial/gi, "")
    .replace(/seguimos por /gi, "")
    .replace(/pod[eé]s escribirnos/gi, "")
    .replace(/contactanos/gi, "")
    .replace(/consultanos/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeReply(text = "") {
  let clean = String(text || "").trim();

  clean = clean.replace(/si quer[eé]s,?\s*(tambi[eé]n\s*)?pod[eé]s dejarme un tel[eé]fono[^.?!]*[.?!]?/gi, "");
  clean = clean.replace(/dejame tu tel[eé]fono[^.?!]*[.?!]?/gi, "");
  clean = clean.replace(/escribinos por whatsapp[^.?!]*[.?!]?/gi, "");
  clean = clean.replace(/te paso el whatsapp[^.?!]*[.?!]?/gi, "");
  clean = clean.replace(/si quer[eé]s seguirlo por whatsapp[^.?!]*[.?!]?/gi, "");
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();

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

  return normalized.split(/\n(?=##\s)/g).map((part) => part.trim()).filter(Boolean);
}

app.listen(PORT, () => {
  console.log(`Luz backend escuchando en puerto ${PORT}`);
});
