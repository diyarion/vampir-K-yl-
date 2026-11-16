const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const MAX_PLAYERS = 50;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROLES = {
  vampire: "Vampir",
  villager: "Köylü",
  detective: "Dedektif",
  doctor: "Doktor",
  hunter: "Avcı"
};
const rooms = new Map();

const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_request, response) => response.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  pingInterval: 25000,
  pingTimeout: 20000
});

function cleanName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 20) : "";
}

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function makeRoom(code, player, socket) {
  const room = {
    code,
    hostToken: player.token,
    players: new Map([[player.token, player]]),
    phase: "lobby",
    day: 0,
    deadline: null,
    timer: null,
    nightActions: new Map(),
    votes: new Map(),
    publicChat: [],
    vampireChat: []
  };
  player.socketId = socket.id;
  socket.join(code);
  socket.data.roomCode = code;
  socket.data.playerToken = player.token;
  rooms.set(code, room);
  return room;
}

function newPlayer(name) {
  return { token: crypto.randomUUID(), name, role: null, alive: true, socketId: null };
}

function playerFor(socket) {
  const room = rooms.get(socket.data.roomCode);
  const player = room && room.players.get(socket.data.playerToken);
  if (!room || !player || player.socketId !== socket.id) {
    throw new Error("Önce bir odaya katılmalısın.");
  }
  return { room, player };
}

function setTimer(room, duration, callback) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + duration;
  room.timer = setTimeout(callback, duration);
  if (room.timer.unref) room.timer.unref();
}

function clearTimer(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
}

function getState(room, player) {
  const isOver = room.phase === "over";
  const isVampire = player.role === "vampire" && player.alive;
  return {
    code: room.code,
    phase: room.phase,
    day: room.day,
    isHost: player.token === room.hostToken,
    self: { token: player.token, role: player.role, alive: player.alive },
    players: [...room.players.values()].map((other) => ({
      token: other.token,
      name: other.name,
      alive: other.alive,
      role: isOver || other.token === player.token || (isVampire && other.role === "vampire") ? other.role : null
    })),
    ready: room.phase === "day"
      ? { mine: room.votes.has(player.token), total: room.votes.size, needed: [...room.players.values()].filter((p) => p.alive).length }
      : { mine: room.nightActions.has(player.token), total: room.nightActions.size, needed: requiredNightActions(room).length },
    deadline: room.deadline,
    publicChat: room.publicChat,
    privateChat: isVampire && room.phase === "night" ? room.vampireChat : [],
    roleNames: ROLES
  };
}

function publish(room) {
  for (const player of room.players.values()) {
    if (player.socketId) {
      io.to(player.socketId).emit("state", getState(room, player));
    }
  }
}

function addPublicMessage(room, text, system) {
  room.publicChat.push({
    name: system ? "Sistem" : text.name,
    text: system ? text : text.text,
    system: Boolean(system),
    time: Date.now()
  });
  room.publicChat = room.publicChat.slice(-50);
}

function endGame(room, winner) {
  clearTimer(room);
  room.phase = "over";
  addPublicMessage(room, winner === "vampires" ? "Vampirler köyü ele geçirdi!" : "Köy vampirlerden kurtuldu!", true);
  publish(room);
}

function checkWinner(room) {
  const living = [...room.players.values()].filter((player) => player.alive);
  const vampires = living.filter((player) => player.role === "vampire").length;
  const villagers = living.length - vampires;
  if (vampires === 0) {
    endGame(room, "villagers");
    return true;
  }
  if (vampires >= villagers) {
    endGame(room, "vampires");
    return true;
  }
  return false;
}

function aliveByRole(room, role) {
  return [...room.players.values()].filter((player) => player.alive && player.role === role);
}

function requiredNightActions(room) {
  return ["vampire", "doctor", "detective"].flatMap((role) => aliveByRole(room, role));
}

function startNight(room) {
  if (checkWinner(room)) return;
  clearTimer(room);
  room.phase = "night";
  room.day += 1;
  room.nightActions.clear();
  room.votes.clear();
  addPublicMessage(room, `${room.day}. gece başladı. Köy uykuya daldı.`, true);
  setTimer(room, 60000, () => resolveNight(room));
  publish(room);
  if (requiredNightActions(room).length === 0) resolveNight(room);
}

function startDay(room) {
  clearTimer(room);
  room.phase = "day";
  room.votes.clear();
  addPublicMessage(room, `${room.day}. gün başladı. Köylüler konuşup oy verebilir.`, true);
  setTimer(room, 90000, () => resolveDay(room));
  publish(room);
}

function resolveNight(room) {
  if (room.phase !== "night") return;
  clearTimer(room);
  const vampireTargets = [...room.nightActions.values()]
    .filter((action) => action.kind === "vampire")
    .map((action) => action.target);
  const doctorTargets = [...room.nightActions.values()]
    .filter((action) => action.kind === "doctor")
    .map((action) => action.target);
  const tally = new Map();
  for (const target of vampireTargets) tally.set(target, (tally.get(target) || 0) + 1);
  const maxVotes = Math.max(0, ...tally.values());
  const leaders = [...tally.entries()].filter(([, count]) => count === maxVotes).map(([target]) => target);
  const targetToken = leaders.length ? leaders[crypto.randomInt(leaders.length)] : null;
  const protectedToken = doctorTargets[doctorTargets.length - 1];
  const victim = targetToken && targetToken !== protectedToken ? room.players.get(targetToken) : null;
  if (victim && victim.alive) {
    victim.alive = false;
    addPublicMessage(room, `Sabah ${victim.name} köy meydanında ölü bulundu.`, true);
  } else {
    addPublicMessage(room, "Sabah herkes sağ salim uyandı. Bu gece kimse ölmedi.", true);
  }

  const detective = aliveByRole(room, "detective")[0];
  const investigation = detective && room.nightActions.get(detective.token);
  if (investigation && investigation.kind === "detective") {
    const inspected = room.players.get(investigation.target);
    if (inspected && detective.socketId) {
      io.to(detective.socketId).emit("private-message", {
        text: `${inspected.name} ${inspected.role === "vampire" ? "bir vampir" : "vampir değil"}.`
      });
    }
  }
  room.nightActions.clear();
  if (!checkWinner(room)) startDay(room);
}

function resolveDay(room) {
  if (room.phase !== "day") return;
  clearTimer(room);
  const tally = new Map();
  for (const target of room.votes.values()) tally.set(target, (tally.get(target) || 0) + 1);
  const maxVotes = Math.max(0, ...tally.values());
  const leaders = [...tally.entries()].filter(([, count]) => count === maxVotes).map(([target]) => target);
  if (leaders.length === 1 && maxVotes > 0) {
    const expelled = room.players.get(leaders[0]);
    if (expelled && expelled.alive) {
      expelled.alive = false;
      addPublicMessage(room, `Köy oylamasıyla ${expelled.name} köyden atıldı. Rolü: ${ROLES[expelled.role]}.`, true);
    }
  } else {
    addPublicMessage(room, "Oylama berabere kaldı; bu gün kimse köyden atılmadı.", true);
  }
  room.votes.clear();
  if (!checkWinner(room)) startNight(room);
}

function assignRoles(room) {
  const players = [...room.players.values()];
  const vampireCount = Math.max(1, Math.floor(players.length / 5));
  const roles = [
    ...Array(vampireCount).fill("vampire"),
    "doctor",
    "detective",
    ...(players.length >= 8 ? ["hunter"] : []),
    ...Array(players.length - vampireCount - 2 - (players.length >= 8 ? 1 : 0)).fill("villager")
  ];
  for (let index = roles.length - 1; index > 0; index -= 1) {
    const other = crypto.randomInt(index + 1);
    [roles[index], roles[other]] = [roles[other], roles[index]];
  }
  players.forEach((player, index) => {
    player.role = roles[index];
    player.alive = true;
  });
  room.publicChat = [];
  room.vampireChat = [];
  room.day = 0;
  startNight(room);
}

function acknowledge(socket, event, handler) {
  socket.on(event, (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    try {
      reply({ ok: true, ...handler(payload || {}) });
    } catch (error) {
      reply({ ok: false, error: error.message || "İşlem tamamlanamadı." });
    }
  });
}

io.on("connection", (socket) => {
  acknowledge(socket, "create-room", ({ name }) => {
    const playerName = cleanName(name);
    if (!playerName) throw new Error("Bir oyuncu adı yaz.");
    const code = makeCode();
    const player = newPlayer(playerName);
    const room = makeRoom(code, player, socket);
    publish(room);
    return { code, token: player.token };
  });

  acknowledge(socket, "join-room", ({ code: rawCode, name, token }) => {
    const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
    const playerName = cleanName(name);
    if (!playerName) throw new Error("Bir oyuncu adı yaz.");
    const room = rooms.get(code);
    if (!room) throw new Error("Bu kodla açık bir oda bulunamadı.");
    if (room.phase !== "lobby" && !(typeof token === "string" && room.players.has(token))) {
      throw new Error("Oyun başladı; yeni oyuncu alınmıyor.");
    }
    let player = typeof token === "string" ? room.players.get(token) : null;
    if (!player) {
      if (room.players.size >= MAX_PLAYERS) throw new Error("Oda 50 oyuncu sınırına ulaştı.");
      if ([...room.players.values()].some((candidate) => candidate.name.toLocaleLowerCase("tr") === playerName.toLocaleLowerCase("tr"))) {
        throw new Error("Bu isim odada kullanılıyor.");
      }
      player = newPlayer(playerName);
      room.players.set(player.token, player);
    } else {
      player.name = playerName;
    }
    player.socketId = socket.id;
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerToken = player.token;
    publish(room);
    return { code, token: player.token };
  });

  acknowledge(socket, "start-game", () => {
    const { room, player } = playerFor(socket);
    if (player.token !== room.hostToken) throw new Error("Oyunu yalnızca oda kurucusu başlatabilir.");
    if (room.phase !== "lobby" && room.phase !== "over") throw new Error("Oyun zaten devam ediyor.");
    if (room.players.size < 4) throw new Error("Oyunu başlatmak için en az 4 oyuncu gerekli.");
    assignRoles(room);
    return {};
  });

  acknowledge(socket, "night-action", ({ target }) => {
    const { room, player } = playerFor(socket);
    if (room.phase !== "night" || !player.alive) throw new Error("Şu anda gece eylemi yapamazsın.");
    const kind = player.role;
    if (!["vampire", "doctor", "detective"].includes(kind)) throw new Error("Rolünün gece eylemi yok.");
    if (room.nightActions.has(player.token)) throw new Error("Gece eylemini zaten kullandın.");
    const targetPlayer = room.players.get(target);
    if (!targetPlayer || !targetPlayer.alive) throw new Error("Geçerli ve hayatta bir oyuncu seç.");
    if (kind === "vampire" && targetPlayer.role === "vampire") throw new Error("Vampirler birbirini hedefleyemez.");
    if (kind === "vampire" && targetPlayer.token === player.token) throw new Error("Kendini hedefleyemezsin.");
    if (kind === "detective" && targetPlayer.token === player.token) throw new Error("Kendini araştırama­zsın.");
    room.nightActions.set(player.token, { kind, target: targetPlayer.token });
    publish(room);
    if (requiredNightActions(room).every((actor) => room.nightActions.has(actor.token))) resolveNight(room);
    return {};
  });

  acknowledge(socket, "day-vote", ({ target }) => {
    const { room, player } = playerFor(socket);
    if (room.phase !== "day" || !player.alive) throw new Error("Şu anda oy kullanamazsın.");
    if (room.votes.has(player.token)) throw new Error("Oyunu zaten kullandın.");
    const targetPlayer = room.players.get(target);
    if (!targetPlayer || !targetPlayer.alive || targetPlayer.token === player.token) {
      throw new Error("Kendin dışında hayatta olan bir oyuncu seç.");
    }
    room.votes.set(player.token, targetPlayer.token);
    publish(room);
    if ([...room.players.values()].filter((candidate) => candidate.alive).every((candidate) => room.votes.has(candidate.token))) {
      resolveDay(room);
    }
    return {};
  });

  acknowledge(socket, "chat", ({ text }) => {
    const { room, player } = playerFor(socket);
    const message = typeof text === "string" ? text.trim().slice(0, 240) : "";
    if (!message) throw new Error("Boş mesaj gönderemezsin.");
    if (!player.alive || room.phase === "lobby" || room.phase === "over") {
      throw new Error("Sohbete yalnızca oyun sırasında hayatta olanlar yazabilir.");
    }
    if (room.phase === "night" && player.role !== "vampire") {
      throw new Error("Gece sohbeti yalnızca vampirlere açıktır.");
    }
    const chat = room.phase === "night" ? room.vampireChat : room.publicChat;
    chat.push({ name: player.name, text: message, system: false, time: Date.now() });
    if (chat.length > 50) chat.shift();
    publish(room);
    return {};
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && room.players.get(socket.data.playerToken);
    if (player && player.socketId === socket.id) {
      player.socketId = null;
      publish(room);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Gece Köyü sunucusu ${PORT} portunda çalışıyor.`);
});

module.exports = { app, io, server, rooms, MAX_PLAYERS };
