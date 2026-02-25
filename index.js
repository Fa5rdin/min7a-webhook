const express = require("express");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== CONFIG =====
const CONFIG = {
  VERIFY_TOKEN: "min7a_webhook_token",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASS: process.env.EMAIL_PASS,
  EMAIL_TO: process.env.EMAIL_TO,
};

// ===== STOCKAGE MESSAGES EN MÉMOIRE =====
let messagesAujourdhui = [];

// ===== WEBHOOK META - VERIFICATION =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook vérifié");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ===== WEBHOOK META - RECEPTION MESSAGES =====
app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    body.entry?.forEach((entry) => {
      entry.changes?.forEach((change) => {
        const value = change.value;
        const messages = value.messages;
        const contacts = value.contacts;
        const metadata = value.metadata;

        if (messages) {
          messages.forEach((msg) => {
            const contact = contacts?.find((c) => c.wa_id === msg.from);
            const agentNumber = metadata?.display_phone_number;

            const msgData = {
              timestamp: new Date(parseInt(msg.timestamp) * 1000),
              from: msg.from,
              contactName: contact?.profile?.name || msg.from,
              agentNumber: agentNumber,
              type: msg.type,
              text: msg.text?.body || `[${msg.type}]`,
              direction: "ENTRANT",
            };

            messagesAujourdhui.push(msgData);
            console.log(`📩 Message reçu: ${msgData.contactName} → ${agentNumber}`);
          });
        }

        // Messages sortants (statuses)
        if (value.statuses) {
          value.statuses.forEach((status) => {
            if (status.status === "sent") {
              messagesAujourdhui.push({
                timestamp: new Date(parseInt(status.timestamp) * 1000),
                from: metadata?.display_phone_number,
                agentNumber: metadata?.display_phone_number,
                type: "text",
                text: "[Message envoyé]",
                direction: "SORTANT",
              });
            }
          });
        }
      });
    });
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// ===== HEALTHCHECK =====
app.get("/health", (req, res) => res.send("OK"));

// ===== GENERER RAPPORT =====
async function genererRapport() {
  console.log("📊 Génération du rapport...");

  if (messagesAujourdhui.length === 0) {
    console.log("Aucun message aujourd'hui");
    return;
  }

  // Organiser par agent
  const agentMap = {
    "+212645983495": "Hajar",
    "+212771810684": "Maha",
    // Ajoute les autres numéros ici
  };

  const parAgent = {};
  messagesAujourdhui.forEach((msg) => {
    const agentName = agentMap[msg.agentNumber] || msg.agentNumber;
    if (!parAgent[agentName]) parAgent[agentName] = [];
    parAgent[agentName].push(msg);
  });

  // Construire le prompt
  let data = "";
  Object.entries(parAgent).forEach(([agent, msgs]) => {
    data += `\n=== ${agent} (${msgs.length} messages) ===\n`;
    msgs.forEach((m) => {
      const heure = m.timestamp.toLocaleTimeString("fr-MA", { timeZone: "Africa/Casablanca" });
      data += `[${heure}] ${m.direction === "ENTRANT" ? "CLIENT" : "VENDEUR"}: ${m.text}\n`;
    });
  });

  const today = new Date().toLocaleDateString("fr-MA", { timeZone: "Africa/Casablanca" });

  const prompt = `Tu es l'assistant de gestion de Min7a, agence éducative marocaine (bourses pour étudier en Chine). Horaires vendeurs: 10h-18h Maroc.

Données du ${today}:
${data}

Rapport détaillé en français:
## 📊 RÉSUMÉ DE LA JOURNÉE
## 👤 PERFORMANCE PAR AGENT (note /10, heures travaillées, gaps, temps réponse)
## 😊 ANALYSE DE SENTIMENT (clients + vendeurs)
## 🚧 FREINS IDENTIFIÉS (classés par fréquence + suggestions)
## ❌ OPPORTUNITÉS MANQUÉES (leads non relancés, questions sans réponse)
## ✅ QUALITÉ DES RÉPONSES
## ❓ QUESTIONS FRÉQUENTES (possibilités d'automatisation)
## 🎯 ACTIONS POUR DEMAIN (3-5 concrètes)

Sois direct et critique. Pas de complaisance.`;

  // Appel Claude API
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-opus-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": CONFIG.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );

  const rapport = response.data.content[0].text;

  // Envoyer par email
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS },
  });

  await transporter.sendMail({
    from: CONFIG.EMAIL_USER,
    to: CONFIG.EMAIL_TO,
    subject: `📊 Rapport Min7a - ${today}`,
    text: rapport,
  });

  console.log("✅ Rapport envoyé!");
  messagesAujourdhui = []; // Reset pour le lendemain
}

// ===== CRON - 18h30 MAROC (17h30 UTC) =====
cron.schedule("30 17 * * *", genererRapport, { timezone: "UTC" });

// ===== DEMARRER SERVEUR =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur démarré sur port ${PORT}`));
