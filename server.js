require('dotenv').config();
const express = require('express');
const path = require('path');
const { CosmosClient } = require("@azure/cosmos");
const twilio = require('twilio');
const { v4: uuid } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// Read Cosmos config from env
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = process.env.COSMOS_DATABASE || "TwentyOneDB";
const gameContainerId = process.env.COSMOS_CONTAINER || "game";
const registeredContainerId = process.env.REGISTERED_CONTAINER || 'registeredPlayers';
const otpContainerId = process.env.OTP_CONTAINER || 'otps';

if (!endpoint || !key) {
  console.error("COSMOS_ENDPOINT and COSMOS_KEY must be set in environment.");
  process.exit(1);
}
if (!process.env.TWILIO_SID || !process.env.TWILIO_TOKEN) {
  console.warn('TWILIO_SID or TWILIO_TOKEN not set — SMS/WhatsApp will fail until configured.');
}

const client = new CosmosClient({ endpoint, key });
let container;
// initialize cosmos (create db/container if not exist)
async function initCosmos() {
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  const { container: gCont } = await database.containers.createIfNotExists({
    id: gameContainerId,
    partitionKey: { kind: 'Hash', paths: ['/id'] }
  });
  gameContainer = gCont;
  const { container: rCont } = await database.containers.createIfNotExists({
    id: registeredContainerId,
    partitionKey: { kind: 'Hash', paths: ['/id'] }
  });
  registeredContainer = rCont;
  const { container: oCont } = await database.containers.createIfNotExists({
    id: otpContainerId,
    partitionKey: { kind: 'Hash', paths: ['/id'] }
  });
  otpContainer = oCont;


}
initCosmos().catch(err => { console.error(err); process.exit(1); });

// Twilio client (server-side)
const twilioClient = twilio(process.env.TWILIO_SID || '',
  process.env.TWILIO_TOKEN || '');
const TWILIO_SMS_NUMBER = process.env.TWILIO_SMS_NUMBER; // e.g. +1XXXXXXXXXX
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g.  +1XXXXXXXXXX
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
// ------------- Helpers (reuse your existing helpers) -------------
async function readDocFromGame(id) {
  try {
    const { resource } = await gameContainer.item(id, id).read();
    return resource;
  } catch (e) { return null; }
}
async function upsertDocToGame(doc) {
  return (await gameContainer.items.upsert(doc)).resource;
}

async function deleteDoc(id) {
  try {
    await container.item(id, id).delete();
    return true;
  } catch (e) {
    return false;
  }
}
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
app.get("/api/otp", (req, res) => {
  const code = generateOTP();
  res.json({ code });
});

// API: players (single document id 'players')
app.get("/api/players", async (req, res) => {
  const doc = await readDocFromGame("players");
  res.json((doc && doc.players) ? doc.players : []);
});

// Agregar jugador
app.post("/api/players", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).send("Nombre requerido");
  let doc = await readDocFromGame("players");
  if (!doc) doc = { id: "players", players: [] };
  if (!doc.players.includes(name)) doc.players.push(name);
  await upsertDocToGame(doc);
  res.json(doc.players);

  // players.push(name);
  // res.json(players);
});
app.delete("/api/players/:name", async (req, res) => {
  const name = req.params.name;
  let doc = await readDocFromGame("players");
  if (!doc) return res.json([]);
  doc.players = doc.players.filter(p => p !== name);
  await upsertDocToGame(doc);
  res.json(doc.players);
});
// rounds document id 'rounds' stores array of rounds with playersAtRound
app.get("/api/rounds", async (req, res) => {
  const doc = await readDocFromGame("rounds");
  res.json((doc && doc.rounds) ? doc.rounds : []);
});

app.post("/api/rounds", async (req, res) => {
  const { amount, winner } = req.body;
  if (!amount || !winner) return res.status(400).send("amount and winner required");
  const playersDoc = await readDocFromGame("players");
  const players = (playersDoc && playersDoc.players) ? playersDoc.players : [];
  const round = { amount: Number(amount), winner, playersAtRound: players, timestamp: new Date().toISOString() };
  let doc = await readDocFromGame("rounds");
  if (!doc) doc = { id: "rounds", rounds: [] };
  doc.rounds.push(round);
  await upsertDocToGame(doc);
  res.json(doc.rounds);
});


// Calcular deudas
// resumen: calculate balances using playersAtRound preserved per round
app.get("/api/resumen", async (req, res) => {
  const roundsDoc = await readDocFromGame("rounds");
  const rounds = (roundsDoc && roundsDoc.rounds) ? roundsDoc.rounds : [];
  // gather all players ever
  const set = new Set();
  const playersDoc = await readDocFromGame("players");
  if (playersDoc && playersDoc.players) playersDoc.players.forEach(p => set.add(p));
  rounds.forEach(r => { if (r.playersAtRound) r.playersAtRound.forEach(p => set.add(p)); if (r.winner) set.add(r.winner); });
  const allPlayers = Array.from(set);
  const balances = {};
  allPlayers.forEach(p => balances[p] = 0);
  rounds.forEach(r => {
    const participants = r.playersAtRound && r.playersAtRound.length ? r.playersAtRound : allPlayers;
    participants.forEach(p => {
      if (p !== r.winner) balances[p] -= r.amount;
    });
    balances[r.winner] = (balances[r.winner] || 0) + r.amount * (participants.length - 1);
  });
  res.json(balances);
});
app.post("/api/finalize", async (req, res) => {
  try {
    const roundsDoc = await readDocFromGame("rounds");
    const playersDoc = await readDocFromGame("players");
    const rounds = (roundsDoc && roundsDoc.rounds) ? roundsDoc.rounds : [];
    const players = (playersDoc && playersDoc.players) ? playersDoc.players : [];

    // compute final summary
    const balances = {};
    const set = new Set();

    players.forEach(p => set.add(p));
    rounds.forEach(r => {
      if (r.playersAtRound) r.playersAtRound.forEach(p => set.add(p));
      if (r.winner) set.add(r.winner);
    });

    Array.from(set).forEach(p => balances[p] = 0);

    rounds.forEach(r => {
      const participants = r.playersAtRound && r.playersAtRound.length
        ? r.playersAtRound
        : Array.from(set);

      participants.forEach(p => {
        if (p !== r.winner) balances[p] -= r.amount;
      });

      balances[r.winner] += r.amount * (participants.length - 1);
    });

    const historyId = "history_" + new Date().toISOString();
    const historyDoc = {
      id: historyId, createdAt: new Date().toISOString(),
      players, rounds, finalSummary: balances
    };
    await upsertDocToGame(historyDoc);
    await upsertDocToGame({ id: 'players', players: [] });
    await upsertDocToGame({ id: 'rounds', rounds: [] });
    // ---- Enriquecer salida con datos registrados ----
    const enriched = {};

    for (const player of Object.keys(balances)) {
      let registered = null;
      try {
        const { resources } = await registeredContainer.items
          .query({
            query: "SELECT * FROM c WHERE c.name = @name",
            parameters: [{ name: "@name", value: player }]
          })
          .fetchAll();

        if (resources.length > 0) {
          registered = resources[0];
        }
      } catch (e) {
        console.error("Error buscando jugador registrado:", e);
      }


      enriched[player] = {
        balance: balances[player],
        name: registered?.name || player,
        keyText: registered?.keyText || null,
        imageUrl: registered?.imageUrl || null
      };
    }



    res.json({ ok: true, historyId, finalSummary: enriched });

  } catch (err) {
    console.error("ERROR EN /api/finalize:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------- Registered players API -------------
app.get('/api/registered', async (req, res) => {
  const { resources } = await registeredContainer.items.query('SELECT * FROM c').fetchAll();
  res.json(resources);
});
app.get("/api/registered/:code", async (req, res) => {
  const code = req.params.code;

  try {
    const { resource } = await registeredContainer.item(code, code).read();
    res.json(resource);
  } catch (e) {
    res.status(404).json({ error: "Jugador no existe" });
  }
});
app.post("/api/register-player", async (req, res) => {
  const { code, name, keyText, imageUrl } = req.body;

  if (!code || !name) return res.status(400).send("Código y nombre son requeridos");

  // ¿Existe ya?
  try {
    const { resource } = await registeredContainer.item(code, code).read();
    return res.json({ ok: true, exists: true, player: resource });
  } catch { }

  // Crear nuevo jugador
  const doc = {
    id: code,
    name,
    keyText: keyText || "",
    imageUrl: imageUrl || "",
    createdAt: new Date().toISOString()
  };

  await registeredContainer.items.upsert(doc);
  res.json({ ok: true, exists: false, player: doc });
});
// ------------- OTP (Twilio) endpoints -------------
app.post('/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();

    // Guardar OTP
    try {
      await otpContainer.items.upsert({ id: phone, otp, expiresAt });
    } catch (e) {
      console.error('OTP upsert error', e);
    }

    // SOLO WhatsApp - Twilio Sandbox
    if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_WHATSAPP_NUMBER) {
      await twilioClient.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${phone}`,
        body: `Tu código de verificación es: ${otp}`
      });
    }

    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error('send-otp error', err);
    res.status(500).json({ error: 'send failure' });
  }
});


app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'phone and otprequired' });
    const { resource } = await otpContainer.item(phone, phone).read().catch(() => ({ resource: null }));
    const saved = resource;
    if (!saved) return res.status(400).json({ error: 'OTP no encontrado' });
    if (saved.otp !== otp) return res.status(400).json({ error: 'OTPincorrecto' });
    if (new Date(saved.expiresAt) < new Date()) return res.status(400).json({
      error: 'OTP expirado'
    });
    // buscar por phone en registeredContainer
    const q = {
      query: 'SELECT * FROM c WHERE c.phone = @phone', parameters: [{
        name: '@phone', value: phone
      }]
    };
    const { resources } = await registeredContainer.items.query(q).fetchAll();
    let player;
    if (resources.length === 0) {
      // crear registro en registeredContainer con código = phone (puedescambiar a otro code)
      player = {
        id: phone, name: name || phone, phone, keyText: '', imageUrl:
          '', createdAt: new Date().toISOString()
      };
      await registeredContainer.items.create(player);
    } else {
      player = resources[0];
    }
    // opcional: borrar OTP
    try { await otpContainer.item(phone, phone).delete(); } catch (_) { }
    res.json({ ok: true, player });
  } catch (err) {
    console.error('verify-otp error', err);
    res.status(500).json({ error: 'verify failure' });
  }
});
app.put('/api/registeredPlayers', async (req, res) => {
  try {
    const item = req.body;

    await registeredContainer.items.upsert(item, {
      partitionKey: item.id
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("update player error", err);
    res.status(500).json({ error: "update error" });
  }
});
app.get('/api/registeredPlayers', async (req, res) => {
  try {
    const { resources } = await registeredContainer.items
      .query("SELECT * FROM c")
      .fetchAll();

    res.json(resources);
  } catch (err) {
    console.error("list registeredPlayers error", err);
    res.status(500).json({ error: "error listing registered players" });
  }
});



// Serve a small health route
app.get('/health', (req, res) => res.json({ ok: true }));


const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server listening on", port));