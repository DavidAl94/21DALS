require('dotenv').config();
const express = require('express');
const path = require('path');
const { CosmosClient } = require("@azure/cosmos");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));


// Read Cosmos config from env
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = process.env.COSMOS_DATABASE || "TwentyOneDB";
const containerId = process.env.COSMOS_CONTAINER || "game";

if (!endpoint || !key) {
  console.error("COSMOS_ENDPOINT and COSMOS_KEY must be set in environment.");
  process.exit(1);
}
const client = new CosmosClient({ endpoint, key });
let container;
// initialize cosmos (create db/container if not exist)
async function initCosmos() {
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  const { container: cont } = await database.containers.createIfNotExists({ id: containerId, partitionKey: { kind: "Hash", paths: ["/id"] } });
  container = cont;
}
initCosmos().catch(err => { console.error(err); process.exit(1); });
// // ---- ESTADO EN MEMORIA ----
// let players = [];
// let rounds = [];
// Helpers to get/set documents by id
async function readDoc(id) {
  try {
    const { resource } = await container.item(id, id).read();
    return resource;
  } catch (e) {
    return null;
  }
}
async function upsertDoc(doc) {
  return (await container.items.upsert(doc)).resource;
}
async function deleteDoc(id) {
  try {
    await container.item(id,id).delete();
    return true;
  } catch (e) {
    return false;
  }
}
// API: players (single document id 'players')
app.get("/api/players", async (req,res)=>{
  const doc = await readDoc("players");
  res.json((doc && doc.players) ? doc.players : []);
});

// Agregar jugador
app.post("/api/players",async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).send("Nombre requerido");
  let doc = await readDoc("players");
  if(!doc) doc = { id: "players", players: [] };
  if(!doc.players.includes(name)) doc.players.push(name);
  await upsertDoc(doc);
  res.json(doc.players);

  // players.push(name);
  // res.json(players);
});
app.delete("/api/players/:name", async (req,res)=>{
  const name = req.params.name;
  let doc = await readDoc("players");
  if(!doc) return res.json([]);
  doc.players = doc.players.filter(p=>p!==name);
  await upsertDoc(doc);
  res.json(doc.players);
});

// // Obtener jugadores
// app.get("/api/players", (req, res) => {
//   res.json(players);
// });
// rounds document id 'rounds' stores array of rounds with playersAtRound
app.get("/api/rounds", async (req,res)=>{
  const doc = await readDoc("rounds");
  res.json((doc && doc.rounds) ? doc.rounds : []);
});

// Registrar ronda
// app.post("/api/rounds", (req, res) => {
//   const { amount, winner } = req.body;

//   rounds.push({
//     amount,
//     winner,
//     playersAtRound: [...players]   // <<--- clave
//   });

//   res.json(rounds);
// });
app.post("/api/rounds", async (req,res)=>{
  const { amount, winner } = req.body;
  if(!amount || !winner) return res.status(400).send("amount and winner required");
  const playersDoc = await readDoc("players");
  const players = (playersDoc && playersDoc.players) ? playersDoc.players : [];
  const round = { amount: Number(amount), winner, playersAtRound: players, timestamp: new Date().toISOString() };
  let doc = await readDoc("rounds");
  if(!doc) doc = { id: "rounds", rounds: [] };
  doc.rounds.push(round);
  await upsertDoc(doc);
  res.json(doc.rounds);
});


// Calcular deudas
// resumen: calculate balances using playersAtRound preserved per round
app.get("/api/resumen", async (req,res)=>{
  const roundsDoc = await readDoc("rounds");
  const rounds = (roundsDoc && roundsDoc.rounds) ? roundsDoc.rounds : [];
  // gather all players ever
  const set = new Set();
  const playersDoc = await readDoc("players");
  if(playersDoc && playersDoc.players) playersDoc.players.forEach(p=>set.add(p));
  rounds.forEach(r=>{ if(r.playersAtRound) r.playersAtRound.forEach(p=>set.add(p)); if(r.winner) set.add(r.winner); });
  const allPlayers = Array.from(set);
  const balances = {};
  allPlayers.forEach(p=>balances[p]=0);
  rounds.forEach(r=>{
    const participants = r.playersAtRound && r.playersAtRound.length ? r.playersAtRound : allPlayers;
    participants.forEach(p=>{
      if(p !== r.winner) balances[p] -= r.amount;
    });
    balances[r.winner] = (balances[r.winner] || 0) + r.amount * (participants.length - 1);
  });
  res.json(balances);
});
// app.get("/api/deudas", (req, res) => {
//   const cuentas = {};

//   // Inicializar jugadores actuales
//   players.forEach(p => cuentas[p] = 0);

//   rounds.forEach(r => {
//     const jugadores = r.playersAtRound;

//     jugadores.forEach(p => {
//       if (p !== r.winner) cuentas[p] -= r.amount;
//     });

//     cuentas[r.winner] += r.amount * (jugadores.length - 1);
//   });

//   res.json(cuentas);
// });

// Calcular estado contable en vivo
// app.get("/api/resumen", (req, res) => {
//   const cuentas = {};

//   players.forEach(p => cuentas[p] = 0);

//   rounds.forEach(r => {
//     const jugadores = r.playersAtRound;

//     jugadores.forEach(p => {
//       if (p !== r.winner) cuentas[p] -= r.amount;
//     });

//     cuentas[r.winner] += r.amount * (jugadores.length - 1);
//   });

//   res.json(cuentas);
// });
// app.delete("/api/players/:name", (req, res) => {
//   const name = req.params.name;

//   // Eliminar solo de la lista actual
//   players = players.filter(p => p !== name);

//   res.json(players);
// });
// finalize: move to history and clear players+rounds
app.post("/api/finalize", async (req,res)=>{
  try {
      const roundsDoc = await readDoc("rounds");
      const playersDoc = await readDoc("players");
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
          id: historyId,
          createdAt: new Date().toISOString(),
          players,
          rounds,
          finalSummary: balances
      };

      await upsertDoc(historyDoc);

      // clear temp docs
      await upsertDoc({ id: "players", players: [] });
      await upsertDoc({ id: "rounds", rounds: [] });

      res.json({ ok: true, historyId, finalSummary: balances });

  } catch (err) {
      console.error("ERROR EN /api/finalize:", err);
      res.status(500).json({ error: "Internal server error" });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log("Server listening on", port));