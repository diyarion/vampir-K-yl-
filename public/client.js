(() => {
  const socket = io();
  const screens = {
    home: document.getElementById("home-screen"),
    lobby: document.getElementById("lobby-screen"),
    game: document.getElementById("game-screen")
  };
  const errorIds = ["home-error", "lobby-error", "game-error"];
  let current = null;
  let toastTimer;

  const roleInfo = {
    vampire: { icon: "🧛", name: "Vampir", description: "Geceleri bir kurban seç. Vampirler sayıca köylülere eşit olduğunda kazanırsınız.", night: "Bu gece kimi avlayacaksın?" },
    villager: { icon: "🧑‍🌾", name: "Köylü", description: "İpuçlarını takip et, gündüz konuş ve vampirleri oylamayla köyden gönder.", night: "Köy uyuyor. Güneş doğunca konuşmaya hazır ol." },
    detective: { icon: "🕵️", name: "Dedektif", description: "Her gece bir oyuncuyu araştır. Sonucu yalnızca sen görebilirsin.", night: "Bu gece kimi araştıracaksın?" },
    doctor: { icon: "🩺", name: "Doktor", description: "Her gece bir oyuncuyu koru. Vampirlerin hedefiyle eşleşirse onu kurtarırsın.", night: "Bu gece kimi koruyacaksın?" },
    hunter: { icon: "🏹", name: "Avcı", description: "Özel yeteneğin yok; gündüz tartışmasına katıl ve vampirleri bul.", night: "Köy uyuyor. Güneş doğunca dikkatli ol." }
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([key, element]) => element.classList.toggle("hidden", key !== name));
  }

  function showError(id, message) {
    errorIds.forEach((errorId) => { document.getElementById(errorId).textContent = ""; });
    document.getElementById(id).textContent = message || "";
  }

  function notify(message) {
    const element = document.getElementById("toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2200);
  }

  function request(event, payload) {
    return new Promise((resolve, reject) => {
      socket.timeout(8000).emit(event, payload, (timeoutError, response) => {
        if (timeoutError) return reject(new Error("Sunucudan yanıt alınamadı. Bağlantını kontrol et."));
        if (!response || !response.ok) return reject(new Error(response && response.error || "İşlem tamamlanamadı."));
        resolve(response);
      });
    });
  }

  function saveSession(code, token, name) {
    localStorage.setItem("gece-koyu-session", JSON.stringify({ code, token, name }));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function renderLobby(state) {
    showScreen("lobby");
    document.getElementById("lobby-code").textContent = state.code;
    document.getElementById("lobby-count").textContent = `${state.players.length} / 50`;
    document.getElementById("lobby-players").innerHTML = state.players.map((player) => `
      <div class="lobby-player">
        <span class="avatar">${escapeHtml(player.name.slice(0, 1).toLocaleUpperCase("tr"))}</span>
        <span class="player-name">${escapeHtml(player.name)}</span>
        ${player.token === current.token ? '<span class="host-tag">SEN</span>' : ""}
        ${state.isHost && player.token === current.token ? '<span class="host-tag">KURUCU</span>' : ""}
      </div>`).join("");
    const start = document.getElementById("start-game");
    start.classList.toggle("hidden", !state.isHost);
    start.disabled = state.players.length < 4;
    document.getElementById("start-hint").textContent = state.players.length < 4
      ? `Başlamak için ${4 - state.players.length} oyuncu daha gerekli.`
      : state.isHost ? "Herkes hazırsa oyunu başlat." : "Oda kurucusu oyunu başlatabilir.";
  }

  function targetButtons(state, role, actionDone) {
    const players = state.players.filter((player) => player.alive
      && player.token !== state.self.token
      && !(role === "vampire" && player.role === "vampire"));
    if (actionDone) return '<p class="action-wait">Eylemin kaydedildi. Diğer oyuncular bekleniyor…</p>';
    if (!players.length) return '<p class="action-wait">Seçilebilecek oyuncu yok.</p>';
    return `<div class="target-grid">${players.map((player) => `
      <button class="target-button" data-target="${escapeHtml(player.token)}" type="button">${escapeHtml(player.name)}</button>`).join("")}</div>`;
  }

  function renderAction(state) {
    const panel = document.getElementById("action-panel");
    const info = roleInfo[state.self.role] || roleInfo.villager;
    const alive = state.self.alive;
    const canNightAct = state.phase === "night" && alive && ["vampire", "doctor", "detective"].includes(state.self.role);
    const canVote = state.phase === "day" && alive;
    const done = state.ready.mine;
    const title = state.phase === "night" ? "Gece eylemi" : state.phase === "day" ? "Gündüz oylaması" : "Oyun tamamlandı";
    let content = "";
    if (state.phase === "over") {
      const vampires = state.players.filter((player) => player.role === "vampire" && player.alive).length;
      const winner = vampires === 0 || state.players.filter((player) => player.alive).length <= vampires ? "Vampirler kazandı" : "Köylüler kazandı";
      content = `<p>${winner}.</p>${state.isHost ? '<button id="restart-game" class="button button-primary" type="button">Yeni oyun başlat <span>↻</span></button>' : '<p>Yeni oyun için oda kurucusunu bekleyin.</p>'}`;
    } else if (canNightAct) {
      const prompts = { vampire: "Bir oyuncuyu gece hedefi seç.", doctor: "Bir oyuncuyu korumak için seç.", detective: "Bir oyuncuyu araştırmak için seç." };
      content = `<p>${prompts[state.self.role]}</p>${targetButtons(state, state.self.role, done)}`;
    } else if (canVote) {
      content = `<p>${done ? "Oyunuz kaydedildi; diğer oyuncuların oyları bekleniyor." : "Şüphelendiğin kişiyi seç. Oylama tamamlanınca sonuç açıklanır."}</p>${done ? "" : targetButtons(state, "vote", false)}`;
    } else if (!alive) {
      content = '<p class="action-wait">Elendin. Oyunu izleyebilirsin; artık eylem yapamazsın.</p>';
    } else {
      content = `<p class="action-wait">${info.night}</p>`;
    }
    panel.innerHTML = `<div class="action-heading"><div><span class="panel-kicker">${state.phase === "night" ? "GÜNEŞ BATTI" : state.phase === "day" ? "GÜNEŞ DOĞDU" : "SONUÇ"}</span><h2>${title}</h2></div><span class="count-pill">${state.ready.total}/${state.ready.needed} hazır</span></div>${content}`;
    panel.querySelectorAll("[data-target]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await request(state.phase === "night" ? "night-action" : "day-vote", { target: button.dataset.target });
        } catch (error) {
          showError("game-error", error.message);
        }
      });
    });
    const restart = panel.querySelector("#restart-game");
    if (restart) {
      restart.addEventListener("click", async () => {
        try {
          await request("start-game", {});
        } catch (error) {
          showError("game-error", error.message);
        }
      });
    }
  }

  function renderPlayers(state) {
    document.getElementById("game-player-count").textContent = `${state.players.filter((player) => player.alive).length} / ${state.players.length} hayatta`;
    document.getElementById("game-players").innerHTML = state.players.map((player) => `
      <div class="game-player ${player.alive ? "" : "dead"} ${player.token === state.self.token ? "me" : ""}">
        <span class="avatar">${player.alive ? escapeHtml(player.name.slice(0, 1).toLocaleUpperCase("tr")) : "†"}</span>
        <span class="player-name">${escapeHtml(player.name)}${player.token === state.self.token ? " (sen)" : ""}</span>
        ${player.role ? `<span class="role-tag">${escapeHtml(state.roleNames[player.role])}</span>` : ""}
        ${!player.alive ? '<span class="dead-tag">ELENDİ</span>' : ""}
      </div>`).join("");
  }

  function renderChat(state) {
    const isVampireNight = state.phase === "night" && state.self.role === "vampire" && state.self.alive;
    const messages = [...state.publicChat, ...state.privateChat].sort((a, b) => a.time - b.time);
    document.getElementById("chat-title").textContent = isVampireNight ? "Vampir sohbeti" : "Sohbet";
    document.getElementById("chat-status").textContent = isVampireNight ? "GİZLİ" : "CANLI";
    document.getElementById("chat-hint").textContent = state.phase === "night"
      ? isVampireNight ? "Gece sohbeti yalnızca vampirlere görünür." : "Gündüz sohbeti güneş doğunca açılır."
      : state.self.alive ? "Mesajların köy meydanında görünür." : "İzleyici olarak sohbet edemezsin.";
    document.getElementById("chat-input").disabled = !state.self.alive || state.phase === "over" || state.phase === "lobby" || (state.phase === "night" && !isVampireNight);
    const box = document.getElementById("chat-messages");
    box.innerHTML = messages.map((message) => message.system
      ? `<div class="chat-message system">${escapeHtml(message.text)}<time>${new Date(message.time).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</time></div>`
      : `<div class="chat-message"><strong>${escapeHtml(message.name)}</strong>${escapeHtml(message.text)}<time>${new Date(message.time).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</time></div>`
    ).join("");
    box.scrollTop = box.scrollHeight;
  }

  function renderGame(state) {
    showScreen("game");
    document.getElementById("game-code").textContent = `ODA ${state.code}`;
    document.getElementById("day-count").textContent = state.phase === "over" ? "OYUN SONU" : `${state.day}. GÜN`;
    document.getElementById("phase-title").textContent = state.phase === "night" ? "Gece çöktü" : state.phase === "day" ? "Köy uyandı" : "Oyun sona erdi";
    const info = roleInfo[state.self.role] || roleInfo.villager;
    document.getElementById("role-icon").textContent = info.icon;
    document.getElementById("role-name").textContent = info.name;
    document.getElementById("role-description").textContent = info.description;
    document.getElementById("role-kicker").textContent = state.self.alive ? "SENİN GİZLİ ROLÜN" : "ELENDİN";
    renderAction(state);
    renderPlayers(state);
    renderChat(state);
  }

  socket.on("state", (state) => {
    const ownPlayer = state.players.find((player) => player.token === state.self.token);
    current = { ...current, code: state.code, token: state.self.token, name: current && current.name || ownPlayer.name };
    if (current.token && current.name) saveSession(state.code, current.token, current.name);
    showError("game-error", "");
    if (state.phase === "lobby") renderLobby(state);
    else renderGame(state);
  });

  socket.on("private-message", ({ text }) => notify(text));
  socket.on("connect", () => {
    const raw = localStorage.getItem("gece-koyu-session");
    if (!raw) return;
    try {
      const session = JSON.parse(raw);
      current = session;
      request("join-room", session).catch(() => {
        localStorage.removeItem("gece-koyu-session");
        current = null;
      });
    } catch {
      localStorage.removeItem("gece-koyu-session");
    }
  });

  document.getElementById("create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("create-name").value.trim();
    try {
      const result = await request("create-room", { name });
      current = { ...result, name };
      saveSession(result.code, result.token, name);
      showError("home-error", "");
    } catch (error) {
      showError("home-error", error.message);
    }
  });

  document.getElementById("join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("join-name").value.trim();
    const code = document.getElementById("room-code").value.trim().toUpperCase();
    try {
      const result = await request("join-room", { name, code });
      current = { ...result, name };
      saveSession(result.code, result.token, name);
      showError("home-error", "");
    } catch (error) {
      showError("home-error", error.message);
    }
  });

  document.getElementById("room-code").addEventListener("input", (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  document.getElementById("copy-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById("lobby-code").textContent);
      notify("Oda kodu kopyalandı.");
    } catch {
      notify("Kodu seçip elle kopyalayabilirsin.");
    }
  });

  document.getElementById("start-game").addEventListener("click", async () => {
    try {
      await request("start-game", {});
      showError("lobby-error", "");
    } catch (error) {
      showError("lobby-error", error.message);
    }
  });

  document.getElementById("chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    try {
      await request("chat", { text });
      input.value = "";
    } catch (error) {
      showError("game-error", error.message);
    }
  });
})();
