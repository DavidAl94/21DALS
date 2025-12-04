const express = require("express");
const app = express();
const path = require("path");

app.use(express.json());
app.use(express.static("public"));

// ---- ESTADO EN MEMORIA ----
let players = [];
let rounds = [];

// Agregar jugador
app.post("/api/players", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).send("Nombre requerido");

  players.push(name);
  res.json(players);
});

// Obtener jugadores
app.get("/api/players", (req, res) => {
  res.json(players);
});

// Registrar ronda
app.post("/api/rounds", (req, res) => {
  const { amount, winner } = req.body;

  rounds.push({
    amount,
    winner,
    playersAtRound: [...players]   // <<--- clave
  });

  res.json(rounds);
});


// Calcular deudas
app.get("/api/deudas", (req, res) => {
  const cuentas = {};

  // Inicializar jugadores actuales
  players.forEach(p => cuentas[p] = 0);

  rounds.forEach(r => {
    const jugadores = r.playersAtRound;

    jugadores.forEach(p => {
      if (p !== r.winner) cuentas[p] -= r.amount;
    });

    cuentas[r.winner] += r.amount * (jugadores.length - 1);
  });

  res.json(cuentas);
});

// Calcular estado contable en vivo
app.get("/api/resumen", (req, res) => {
  const cuentas = {};

  players.forEach(p => cuentas[p] = 0);

  rounds.forEach(r => {
    const jugadores = r.playersAtRound;

    jugadores.forEach(p => {
      if (p !== r.winner) cuentas[p] -= r.amount;
    });

    cuentas[r.winner] += r.amount * (jugadores.length - 1);
  });

  res.json(cuentas);
});
app.delete("/api/players/:name", (req, res) => {
  const name = req.params.name;

  // Eliminar solo de la lista actual
  players = players.filter(p => p !== name);

  res.json(players);
});


app.listen(3000, () => console.log("Servidor en http://localhost:3000"));
