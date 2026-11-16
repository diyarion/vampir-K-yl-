const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { io: connect } = require("socket.io-client");

process.env.PORT = "0";
const { server } = require("../server");
let baseUrl;
let sockets = [];

before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  sockets.forEach((socket) => socket.disconnect());
  await new Promise((resolve) => server.close(resolve));
});

function connectPlayer() {
  const socket = connect(baseUrl, { reconnection: false, forceNew: true });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else if (!response.ok) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

function waitFor(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 3000);
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(value);
    };
    socket.on(event, listener);
  });
}

test("room codes support multiplayer join, roles stay private, and invalid start is rejected", async () => {
  const host = await connectPlayer();
  const created = await emit(host, "create-room", { name: "Kurucu" });
  assert.match(created.code, /^[A-Z0-9]{5}$/);

  await assert.rejects(emit(host, "start-game", {}), /en az 4 oyuncu/);

  const joiners = await Promise.all(["Ada", "Bora", "Can"].map(async (name) => {
    const socket = await connectPlayer();
    const state = waitFor(socket, "state", (value) => value.players.length === 4);
    await emit(socket, "join-room", { code: created.code, name });
    return { socket, state: await state };
  }));
  assert.equal(joiners[0].state.players.length, 4);

  const participants = [{ socket: host }, ...joiners];
  const nightStates = participants.map(({ socket }) => waitFor(socket, "state", (value) => value.phase === "night"));
  await emit(host, "start-game", {});
  const states = await Promise.all(nightStates);
  participants.forEach((participant, index) => { participant.state = states[index]; });
  const state = states[0];
  assert.equal(state.players.length, 4);
  assert.ok(["vampire", "villager", "doctor", "detective"].includes(state.self.role));
  assert.ok(state.players.every((player) => player.token === state.self.token
    ? player.role === state.self.role
    : player.role === null || (state.self.role === "vampire" && player.role === "vampire")));
  assert.equal(state.phase, "night");

  const vampire = states.find((value) => value.self.role === "vampire");
  const doctor = states.find((value) => value.self.role === "doctor");
  const detective = states.find((value) => value.self.role === "detective");
  const vampireToken = vampire.self.token;
  const safeTarget = vampire.players.find((player) => player.alive && player.role !== "vampire").token;
  const dayState = waitFor(host, "state", (value) => value.phase === "day");
  await Promise.all([
    emit(participants.find((entry) => entry.state.self.token === vampireToken).socket, "night-action", { target: safeTarget }),
    emit(participants.find((entry) => entry.state.self.role === "doctor").socket, "night-action", { target: safeTarget }),
    emit(participants.find((entry) => entry.state.self.role === "detective").socket, "night-action", { target: vampireToken })
  ]);
  const daytime = await dayState;
  assert.equal(daytime.phase, "day");
  assert.ok(daytime.players.every((player) => player.alive));

  const endState = waitFor(host, "state", (value) => value.phase === "over");
  await Promise.all(states.map((playerState) => {
    const voter = participants.find((entry) => entry.state.self.token === playerState.self.token);
    const target = playerState.self.role === "vampire"
      ? playerState.players.find((player) => player.token !== vampireToken).token
      : vampireToken;
    return emit(voter.socket, "day-vote", { target });
  }));
  const finished = await endState;
  assert.equal(finished.phase, "over");
  assert.equal(finished.players.find((player) => player.token === vampireToken).alive, false);

  const lateJoiner = await connectPlayer();
  await assert.rejects(emit(lateJoiner, "join-room", { code: created.code, name: "SonradanGelen" }), /Oyun başladı/);
});

test("room refuses duplicate names", async () => {
  const host = await connectPlayer();
  const { code } = await emit(host, "create-room", { name: "Host" });
  const duplicate = await connectPlayer();
  await assert.rejects(emit(duplicate, "join-room", { code, name: "hOsT" }), /kullanılıyor/);
});

test("room accepts exactly 50 players and rejects the 51st", async () => {
  const host = await connectPlayer();
  const { code } = await emit(host, "create-room", { name: "Host" });
  const players = await Promise.all(Array.from({ length: 49 }, (_, index) => connectPlayer().then((socket) => ({ socket, name: `Oyuncu${index}` }))));
  await Promise.all(players.map(({ socket, name }) => emit(socket, "join-room", { code, name })));

  const lateJoiner = await connectPlayer();
  await assert.rejects(emit(lateJoiner, "join-room", { code, name: "Ellibir" }), /50 oyuncu sınırına/);
});
