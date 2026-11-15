// Суфлёр-рекордер 9:16 Studio Pro
const $ = (id) => document.getElementById(id);
const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.speech);
const native = (name, msg) => { try { window.webkit.messageHandlers[name].postMessage(msg); } catch {} };
const store = {
  get(k, d) { try { const v = localStorage.getItem("suf_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("suf_" + k, JSON.stringify(v)); } catch {} },
};
const logRemote = (msg) => { try { fetch("/api/log", { method: "POST", body: String(msg) }); } catch {} };
window.addEventListener("error", (e) => logRemote(`${e.message} @${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logRemote("promise: " + (e.reason && e.reason.message || e.reason)));

// ---------- Настройки ----------
const S = {
  mode: store.get("mode", "classic"), wps: store.get("wps", 2.5), sens: store.get("sens", 50),
  fs: store.get("fs", 40), pw: store.get("pw", 520), ph: store.get("ph", 34), rl: store.get("rl", 22), cd: store.get("cd", 3),
  mirror: store.get("mirror", true), grid: store.get("grid", false), safe: store.get("safe", false), flip: store.get("flip", false),
  voiceCmd: store.get("voiceCmd", NATIVE), noise: store.get("noise", true), cam: store.get("cam", ""), mic: store.get("mic", ""), script: store.get("script", ""),
};
const MODE_HINT = {
  classic: "Текст едет с постоянной скоростью.",
  voice: "Говоришь — текст едет. Замолчал — ждёт тебя.",
  words: NATIVE
    ? "Текст идёт за твоим голосом слово в слово. Распознавание встроено в macOS."
    : "Текст идёт за голосом слово в слово. В Chrome распознавание работает через серверы Google.",
};
const root = document.documentElement.style;
function applySettings() {
  root.setProperty("--fs", S.fs + "px");
  root.setProperty("--pw", S.pw + "px");
  root.setProperty("--ph", S.ph + "vh");
  $("vSpeed").textContent = S.wps.toFixed(2).replace(/0$/, "") + " сл/с"; $("rSpeed").value = S.wps;
  $("vSens").textContent = S.sens + "%"; $("rSens").value = S.sens;
  $("vFs").textContent = S.fs + " px"; $("rFs").value = S.fs;
  $("vPw").textContent = S.pw + " px"; $("rPw").value = S.pw;
  $("vPh").textContent = S.ph + "%"; $("rPh").value = S.ph;
  $("vRl").textContent = S.rl + "%"; $("rRl").value = S.rl;
  $("vCd").textContent = S.cd ? S.cd + " с" : "нет"; $("rCd").value = S.cd;
  $("chkMirror").checked = S.mirror; $("stage").classList.toggle("mirror", S.mirror);
  $("chkGrid").checked = S.grid; $("stage").classList.toggle("showgrid", S.grid);
  $("stage").classList.toggle("showsafe", S.safe);
  if ($("btnToggleSafe")) $("btnToggleSafe").classList.toggle("primary", S.safe);
  $("chkFlip").checked = S.flip; $("prompter").classList.toggle("flip", S.flip);
  $("chkNoise").checked = S.noise;
  $("chkCmd").checked = S.voiceCmd;
  document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("on", b.dataset.m === S.mode));
  $("modeHint").textContent = MODE_HINT[S.mode];
  $("sensBox").style.display = S.mode === "voice" ? "" : "none";
  $("rSpeed").disabled = S.mode === "words";
  $("voice").textContent = S.mode === "voice" ? "голос" : S.mode === "words" ? "слова" : "";
  $("voice").style.display = S.mode === "classic" ? "none" : "";
  placeReadLine();
  for (const k of Object.keys(S)) store.set(k, S[k]);
}
const bind = (id, key, num = true) => $(id) && $(id).addEventListener("input", (e) => {
  S[key] = num ? +e.target.value : e.target.checked; applySettings();
});
bind("rSpeed", "wps"); bind("rSens", "sens"); bind("rFs", "fs"); bind("rPw", "pw"); bind("rPh", "ph"); bind("rRl", "rl"); bind("rCd", "cd");
bind("chkMirror", "mirror", false); bind("chkGrid", "grid", false); bind("chkFlip", "flip", false);
if ($("chkNoise")) $("chkNoise").addEventListener("change", (e) => { S.noise = e.target.checked; applySettings(); startMedia(); });
if ($("chkCmd")) $("chkCmd").addEventListener("change", (e) => { S.voiceCmd = e.target.checked; applySettings(); Speech.sync(); });
document.querySelectorAll("#modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.m)));

function setMode(m) {
  if (!MODE_HINT[m] || m === S.mode) return;
  const wasWords = S.mode === "words";
  S.mode = m; applySettings();
  if (wasWords) offset = wordMid(cur);
  if (m === "words") { cur = indexAtOffset(offset); Speech.restart(); }
  Speech.sync();
  toast("Режим: " + { classic: "скорость", voice: "голос", words: "слова" }[m]);
}

// ---------- Текст ----------
let scripts = [], current = null;
let words = [], pauses = [];
let offset = 0, cur = 0, running = false, pauseUntil = 0, lastT = 0, hl = -1;
const scroller = $("scroller");
const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");

function readLineY() { return $("prompter").clientHeight * S.rl / 100; }
function placeReadLine() { $("readline").style.top = readLineY() + "px"; render(); }
function wordMid(i) {
  const w = words[Math.max(0, Math.min(i, words.length - 1))];
  return w ? w.el.offsetTop + w.el.offsetHeight / 2 : 0;
}
function maxOffset() { return Math.max(0, scroller.scrollHeight - 20); }
function render() {
  offset = Math.min(Math.max(offset, 0), maxOffset());
  scroller.style.transform = `translateY(${readLineY() - offset}px)`;
}
function indexAtOffset(y) {
  let lo = 0, hi = words.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (wordMid(m) < y - 4) lo = m + 1; else hi = m; }
  return lo;
}
function pxPerWord() {
  return words.length > 1 ? (wordMid(words.length - 1) - wordMid(0)) / (words.length - 1) : 30;
}

function setText(text) {
  scroller.innerHTML = ""; words = []; pauses = []; hl = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#") || /^```/.test(line)) continue;
    const p = document.createElement("p");
    if (!line) p.className = "gap";
    else if (/^\[.*\]$/.test(line)) {
      p.className = "note"; p.textContent = line;
      if (/^\[\s*пауза/i.test(line)) { p.dataset.pause = "1"; pauses.push(p); }
    } else {
      for (const tok of line.split(/(\s+)/)) {
        if (!tok) continue;
        const n = norm(tok);
        if (!n) { p.appendChild(document.createTextNode(tok)); continue; }
        const span = document.createElement("span");
        span.className = "w"; span.textContent = tok; span.dataset.i = words.length;
        words.push({ el: span, n });
        p.appendChild(span);
      }
    }
    scroller.appendChild(p);
  }
  const end = document.createElement("div");
  end.className = "end"; end.textContent = "— конец —";
  scroller.appendChild(end);
  goHome();
}
function goHome() {
  cur = 0; offset = wordMid(0); pauseUntil = 0;
  pauses.forEach((p) => (p.done = false));
  render(); updateHighlight();
  if (S.mode === "words") Speech.restart();
}
function jumpTo(i) {
  i = Math.max(0, Math.min(i, words.length));
  cur = i;
  if (S.mode !== "words") offset = wordMid(i);
  pauses.forEach((p) => (p.done = p.offsetTop < wordMid(i)));
  render(); updateHighlight();
  if (S.mode === "words") Speech.restart();
}
function nudge(dir) {
  if (S.mode === "words") jumpTo(cur + dir * 5);
  else { offset += dir * S.fs * 1.4; render(); }
}
scroller.addEventListener("click", (e) => {
  const i = e.target.dataset && e.target.dataset.i;
  if (i != null) jumpTo(+i);
});
$("prompter").addEventListener("wheel", (e) => {
  e.preventDefault();
  if (S.mode === "words") { offset += e.deltaY; render(); cur = indexAtOffset(offset); updateHighlight(); clearTimeout(wheelT); wheelT = setTimeout(() => Speech.restart(), 300); }
  else { offset += e.deltaY; render(); }
}, { passive: false });
let wheelT;
window.addEventListener("resize", placeReadLine);

function currentIndex() { return S.mode === "words" ? cur : indexAtOffset(offset); }
function updateHighlight() {
  const t = Math.min(currentIndex(), words.length);
  if (t === hl) return;
  if (hl < 0) { words.forEach((w, i) => w.el.classList.toggle("read", i < t)); }
  else if (t > hl) for (let i = hl; i < t; i++) words[i].el.classList.add("read");
  else for (let i = t; i < hl; i++) words[i].el.classList.remove("read");
  if (words[hl]) words[hl].el.classList.remove("cur");
  if (words[t]) words[t].el.classList.add("cur");
  hl = t;
  $("progress").style.width = (words.length ? (t / words.length) * 100 : 0) + "%";
}

// ---------- Прокрутка ----------
function tick(t) {
  const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
  lastT = t;
  if (S.mode === "words") {
    if (words.length) {
      const target = wordMid(Math.min(cur, words.length - 1));
      offset += (target - offset) * Math.min(1, dt * 5);
      render();
    }
  } else if (running && (S.mode === "classic" || speaking) && performance.now() > pauseUntil) {
    offset += S.wps * pxPerWord() * dt;
    for (const p of pauses) {
      if (!p.done && offset >= p.offsetTop + p.offsetHeight / 2) { p.done = true; pauseUntil = performance.now() + 2000; }
    }
    if (offset >= maxOffset()) { offset = maxOffset(); setRunning(false); }
    render();
  }
  updateHighlight();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function setRunning(v) {
  running = v;
  if (S.mode === "words" && v) Speech.restart();
  Speech.sync();
}

// ---------- Слежение за словами ----------
function editDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}
function fuzzy(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter <= 2) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  let shared = 0; while (shared < shorter && a[shared] === b[shared]) shared++;
  if (shared >= Math.max(3, Math.floor(shorter * 3 / 5))) return true;
  const d = editDistance(a, b);
  if (shorter <= 4) return d <= 1;
  if (shorter <= 8) return d <= 2;
  return d <= Math.floor(Math.max(a.length, b.length) / 3);
}

const Speech = {
  active: false, sessionStart: 0, recent: [], rec: null, seen: 0, cmdCooldown: 0,
  wanted() { return (S.mode === "words" && running) || S.voiceCmd; },
  sync() { this.wanted() ? this.start() : this.stop(); },
  start() {
    if (this.active) return;
    this.active = true; this.onReset();
    if (NATIVE) native("speech", { cmd: "start", lang: "ru-RU", context: this.context() });
    else this.chromeStart();
    $("ear").classList.add("on");
  },
  stop() {
    if (!this.active) return;
    this.active = false;
    if (NATIVE) native("speech", { cmd: "stop" });
    else if (this.rec) try { this.rec.abort(); } catch {}
    $("ear").classList.remove("on");
  },
  restart() {
    if (!this.active) return;
    this.onReset();
    if (NATIVE) native("speech", { cmd: "restart", context: this.context() });
    else if (this.rec) try { this.rec.abort(); } catch {}
  },
  context() {
    return VoiceCmd.vocabulary().concat(
      words.slice(cur, cur + 150).map((w) => w.el.textContent.replace(/[^\p{L}\p{N}-]/gu, "")).filter((w) => w.length >= 4));
  },
  onReset() { this.sessionStart = cur; this.recent = []; this.seen = 0; },
  chromeStart() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) { toast("Этот браузер не умеет распознавать речь"); this.active = false; return; }
    const rec = this.rec = new R();
    rec.lang = "ru-RU"; rec.continuous = true; rec.interimResults = true;
    rec.onstart = () => this.onReset();
    rec.onresult = (e) => { let t = ""; for (const r of e.results) t += r[0].transcript + " "; this.onText(t); };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { toast("Нет доступа к распознаванию речи"); this.active = false; }
      else if (e.error === "network") toast("Распознавание в Chrome требует интернет");
    };
    rec.onend = () => { if (this.active && rec === this.rec) setTimeout(() => { try { rec.start(); } catch {} }, 120); };
    try { rec.start(); } catch {}
  },
  onText(text) {
    const spoken = text.split(/\s+/).map(norm).filter(Boolean);
    if (S.voiceCmd && spoken.length > this.seen) {
      const fresh = spoken.slice(Math.max(0, this.seen - 1));
      this.seen = spoken.length;
      if (VoiceCmd.check(fresh)) return;
    }
    if (!(S.mode === "words" && running)) return;
    let si = this.sessionStart, ri = 0;
    while (si < words.length && ri < spoken.length) {
      const s = words[si].n, k = spoken[ri];
      if (fuzzy(s, k)) { si++; ri++; continue; }
      let found = false;
      for (let j = 1; j <= 5 && ri + j < spoken.length; j++) if (fuzzy(s, spoken[ri + j])) { ri += j; found = true; break; }
      if (found) continue;
      for (let j = 1; j <= 5 && si + j < words.length; j++) if (fuzzy(words[si + j].n, k)) { si += j; found = true; break; }
      if (found) continue;
      ri++;
    }
    const cand = si;
    if (cand <= cur) return;
    this.recent.push(cand); if (this.recent.length > 3) this.recent.shift();
    const prev = this.recent.length >= 2 ? this.recent[this.recent.length - 2] : -1;
    if (cand - cur <= 4 || prev > cur) cur = cand;
    if (cur >= words.length) setRunning(false);
  },
};
window.suflyorSpeech = (m) => {
  if (m.log) { logRemote(m.log); return; }
  if (m.error) { toast(m.error); logRemote("speech: " + m.error); if (m.fatal) { Speech.active = false; $("ear").classList.remove("on"); } return; }
  if (m.reset) { Speech.onReset(); if (m.onDevice === false && !Speech.warned) { Speech.warned = true; toast("Русский распознаётся через серверы Apple"); } }
  if (typeof m.text === "string" && Speech.active) Speech.onText(m.text);
};

// ---------- Голосовые команды ----------
const VoiceCmd = {
  START: [["мотор"], ["начали"], ["поехали"], ["старт"], ["запуск"]],
  SAVE_NOW: [["снято"]],
  STOP: [["стоп"], ["хватит"]],
  AGAIN: [["заново"], ["еще", "дубль"], ["другой", "дубль"]],
  SAVE: [["сохранить"], ["сохрани"], ["сохраняй"], ["сохраняем"], ["да"]],
  TRASH: [["в", "корзину"], ["корзина"], ["удалить"], ["удали"], ["удаляй"], ["не", "сохранять"], ["нет"]],
  cool: 0,
  vocabulary() { return ["мотор", "начали", "поехали", "снято", "стоп", "заново", "сохранить", "в корзину"]; },
  find(fresh, phrases) {
    for (const p of phrases)
      for (let i = 0; i + p.length <= fresh.length; i++)
        if (p.every((w, j) => fresh[i + j] === w)) return p;
    return null;
  },
  inScript(p) {
    if (!running && !recorder) return false;
    const i = currentIndex();
    for (let k = Math.max(0, i - 4); k < Math.min(words.length, i + 12); k++) if (words[k].n === p[0]) return true;
    return false;
  },
  check(fresh) {
    if (performance.now() < this.cool) return false;
    const fire = (label, fn) => { this.cool = performance.now() + 1500; toast("🎙 " + label); fn(); Speech.restart(); return true; };
    let p;
    if (pendingTake) {
      if (this.find(fresh, this.SAVE)) return fire("Сохраняю", () => resolvePending(true));
      if (this.find(fresh, this.AGAIN)) return fire("Заново", () => { resolvePending(false); goHome(); startRecording(); });
      if (this.find(fresh, this.TRASH)) return fire("В корзину", () => resolvePending(false));
      if (this.find(fresh, this.START)) return fire("Сохраняю. Мотор!", () => { resolvePending(true); goHome(); startRecording(); });
      return false;
    }
    if (recorder) {
      if ((p = this.find(fresh, this.SAVE_NOW)) && !this.inScript(p)) return fire("Снято!", () => stopRecording(true));
      if ((p = this.find(fresh, this.AGAIN)) && !this.inScript(p)) return fire("Заново", () => { restartAfter = true; stopRecording(false); });
      if ((p = this.find(fresh, this.STOP)) && !this.inScript(p)) return fire("Стоп", () => stopRecording("ask"));
      return false;
    }
    if (!counting && !saving && (p = this.find(fresh, this.START)) && !this.inScript(p)) {
      return fire("Мотор!", () => { setRunning(false); if (currentIndex() > words.length * 0.9) goHome(); startRecording(); });
    }
    return false;
  },
};

// ---------- Сценарии и Инлайн-редактор ----------
async function loadScripts(select) {
  try { const r = await fetch("/api/scripts"); scripts = (await r.json()).scripts; } catch { scripts = []; }
  if ($("scriptsCountBadge")) $("scriptsCountBadge").textContent = String(scripts.length);
  renderScriptsList(select);
}

function renderScriptsList(select) {
  const list = $("scripts"); list.innerHTML = "";
  const query = ($("searchScripts") ? $("searchScripts").value : "").toLowerCase().trim();
  const filtered = scripts.filter(s => {
    if (!query) return true;
    return s.file.toLowerCase().includes(query) || (s.text || "").toLowerCase().includes(query);
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="hint" style="padding:8px 4px;">Ничего не найдено</div>';
    return;
  }

  filtered.forEach((s) => {
    const d = document.createElement("div");
    d.className = "item";
    d.dataset.file = s.file;
    const title = document.createElement("span");
    title.className = "item-title";
    title.textContent = s.file.replace(/\.(txt|md)$/i, "");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "item-del";
    del.title = "Удалить сценарий";
    del.textContent = "✕";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить сценарий «${title.textContent}»?`)) return;
      await fetch("/api/delete-script", { method: "POST", body: JSON.stringify({ file: s.file }) });
      if (current && current.file === s.file) { current = null; S.script = ""; }
      toast("Сценарий удалён");
      await loadScripts();
    };
    d.append(title, del);
    d.onclick = () => pickScript(s.file);
    list.appendChild(d);
  });

  const want = select || S.script;
  pickScript(scripts.find((s) => s.file === want) ? want : scripts[0] && scripts[0].file);
}

if ($("searchScripts")) {
  $("searchScripts").addEventListener("input", () => renderScriptsList(current && current.file));
}

function pickScript(file) {
  if (recorder) return toast("Во время записи сценарий не меняем");
  setRunning(false);
  current = scripts.find((s) => s.file === file) || null;
  S.script = file || ""; store.set("script", S.script);
  document.querySelectorAll("#scripts .item").forEach((el) => el.classList.toggle("active", el.dataset.file === file));

  if (current) {
    if ($("edInlineName")) $("edInlineName").value = current.file.replace(/\.(txt|md)$/i, "");
    const cleanPrompterText = (current.text || "").trim();
    if ($("edInlineText")) $("edInlineText").value = cleanPrompterText;
    setText(cleanPrompterText);
  } else {
    setText("Создай сценарий слева: «+ Новый».");
  }
}

// In-line Editor Live Sync
if ($("edInlineText")) {
  $("edInlineText").addEventListener("input", (e) => {
    setText(e.target.value);
  });
}

// Save Inline Script
if ($("btnSaveInline")) {
  $("btnSaveInline").addEventListener("click", async () => {
    const name = ($("edInlineName").value.trim() || "script").replace(/\.(txt|md)$/i, "");
    const text = $("edInlineText").value.trim();
    const r = await fetch("/api/scripts", { method: "POST", body: JSON.stringify({ name, text }) });
    const j = await r.json();
    toast("Сохранено: " + j.file);
    await loadScripts(j.file);
  });
}

// New Inline Script
if ($("btnNewInline")) {
  $("btnNewInline").addEventListener("click", () => {
    current = null;
    S.script = "";
    if ($("edInlineName")) $("edInlineName").value = "";
    if ($("edInlineText")) $("edInlineText").value = "";
    setText("Готов к новому тексту. Напиши текст слева или перетащи файл.");
    document.querySelectorAll("#scripts .item").forEach(el => el.classList.remove("active"));
    if ($("edInlineName")) $("edInlineName").focus();
    toast("Поля очищены для нового текста");
  });
}

// Auto-Chunk text into 3-5 word rhythmic lines
function autoChunk(raw) {
  const sentences = raw.replace(/\n+/g, " ").split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    const words = s.split(/\s+/).filter(Boolean);
    let curLine = [];
    for (const w of words) {
      curLine.push(w);
      if (curLine.length >= 4 || (curLine.length >= 3 && w.endsWith(","))) {
        out.push(curLine.join(" "));
        curLine = [];
      }
    }
    if (curLine.length) out.push(curLine.join(" "));
    out.push("");
  }
  return out.join("\n");
}

if ($("btnAutoChunk")) {
  $("btnAutoChunk").addEventListener("click", () => {
    const curVal = $("edInlineText").value.trim();
    if (!curVal) return toast("Введи текст перед разбивкой");
    const chunked = autoChunk(curVal);
    $("edInlineText").value = chunked;
    setText(chunked);
    toast("Текст разбит на ритмичные строки!");
  });
}

// Drag & Drop File Zone
const dropZone = $("dropZone");
const fileInput = $("fileInput");
if (dropZone && fileInput) {
  dropZone.addEventListener("click", () => fileInput.click());
  ["dragenter", "dragover"].forEach(name => {
    dropZone.addEventListener(name, (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach(name => {
    dropZone.addEventListener(name, (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); });
  });
  dropZone.addEventListener("drop", (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length) handleFile(files[0]);
  });
  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) {
      handleFile(e.target.files[0]);
      fileInput.value = "";
    }
  });
}

function handleFile(file) {
  const name = file.name.replace(/\.[^/.]+$/, "");
  const reader = new FileReader();
  reader.onload = async (e) => {
    const content = String(e.target.result || "");
    let prompterText = content;
    const lines = content.split("\n");
    if (content.length / Math.max(1, lines.length) > 55) {
      prompterText = autoChunk(content);
    }
    if ($("edInlineName")) $("edInlineName").value = name;
    if ($("edInlineText")) $("edInlineText").value = prompterText;
    setText(prompterText);

    // Save automatically
    const r = await fetch("/api/scripts", { method: "POST", body: JSON.stringify({ name, text: prompterText.trim() }) });
    const j = await r.json();
    toast(`Файл ${file.name} загружен и сохранён!`);
    await loadScripts(j.file);
  };
  reader.readAsText(file, "utf-8");
}

// Presets
const PRESETS = {
  normal: { wps: 2.5, fs: 40, pw: 520, ph: 34, rl: 22, flip: false },
  slow: { wps: 1.75, fs: 48, pw: 560, ph: 38, rl: 24, flip: false },
  glass: { wps: 2.25, fs: 52, pw: 640, ph: 42, rl: 25, flip: true },
};
document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    Object.assign(S, p);
    applySettings();
    toast("Пресет: " + btn.textContent.trim());
  });
});

// Open Finder Folder Action
function openRecordingsFolder() {
  fetch("/api/open-folder", { method: "POST" })
    .then(r => r.json())
    .then(d => toast("Папка открыта в Finder"))
    .catch(() => toast("Не удалось открыть папку"));
}
if ($("btnOpenFolder")) $("btnOpenFolder").addEventListener("click", openRecordingsFolder);
if ($("btnOpenFinderRight")) $("btnOpenFinderRight").addEventListener("click", openRecordingsFolder);
if ($("dirPill")) $("dirPill").addEventListener("click", openRecordingsFolder);

// Toggle TikTok/Reels Safe Zones
function toggleSafeZone() {
  S.safe = !S.safe;
  $("stage").classList.toggle("showsafe", S.safe);
  if ($("btnToggleSafe")) $("btnToggleSafe").classList.toggle("primary", S.safe);
  store.set("safe", S.safe);
  toast(S.safe ? "Зоны Reels/TikTok ВКЛ" : "Зоны Reels/TikTok ВЫКЛ");
}
if ($("btnToggleSafe")) $("btnToggleSafe").addEventListener("click", toggleSafeZone);

// ---------- Камера, микрофон, детектор голоса ----------
let stream = null, audioCtx = null, analyser = null, srcNode = null;
async function listDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, saved) => {
    if (!sel) return;
    sel.innerHTML = "";
    devs.filter((d) => d.kind === kind).forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId; o.textContent = d.label || `${kind} ${i + 1}`;
      if (d.deviceId === saved) o.selected = true;
      sel.appendChild(o);
    });
  };
  fill($("selCam"), "videoinput", S.cam);
  fill($("selMic"), "audioinput", S.mic);
}
async function startMedia(relaxed = false) {
  if (recorder) return;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  $("camerr").style.display = "none";
  const videoCfg = relaxed
    ? (S.cam ? { deviceId: { exact: S.cam } } : true)
    : { deviceId: S.cam ? { exact: S.cam } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  const audioCfg = relaxed
    ? (S.mic ? { deviceId: { exact: S.mic } } : true)
    : { deviceId: S.mic ? { exact: S.mic } : undefined, echoCancellation: false, autoGainControl: false, noiseSuppression: S.noise, channelCount: 1, sampleRate: 48000 };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoCfg, audio: audioCfg });
  } catch (e) {
    if (!relaxed && (e.name === "OverconstrainedError" || e.name === "ConstraintNotSatisfiedError")) {
      return startMedia(true);
    }
    if (S.cam || S.mic) { S.cam = S.mic = ""; applySettings(); return startMedia(false); }
    $("camerr").style.display = "flex";
    $("camerr").textContent = "Нет доступа к камере/микрофону. Включи Суфлёр в Системных настройках macOS (" + e.name + ")";
    logRemote("getUserMedia: " + e.name + " " + e.message);
    return;
  }
  $("video").srcObject = stream;
  const vt = stream.getVideoTracks()[0];
  const vs = vt.getSettings();
  const camLabel = (vt.label || "Камера").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "");
  if ($("outInfo")) $("outInfo").textContent = `${camLabel} · ${vs.width || "?"}×${vs.height || "?"} → 1080×1920 9:16`;
  await listDevices();
  setupAudio();
}
if ($("selCam")) $("selCam").onchange = (e) => { S.cam = e.target.value; applySettings(); startMedia(); };
if ($("selMic")) $("selMic").onchange = (e) => { S.mic = e.target.value; applySettings(); startMedia(); };
if ($("btnRefreshDevs")) {
  $("btnRefreshDevs").onclick = async () => {
    await listDevices();
    const cams = $("selCam") ? $("selCam").options.length : 0;
    toast(`Список обновлён (камер: ${cams})`);
  };
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", async () => {
    const prevCount = $("selCam") ? $("selCam").options.length : 0;
    await listDevices();
    const nextCount = $("selCam") ? $("selCam").options.length : 0;
    if (nextCount > prevCount) toast("Подключена новая камера — выбери её справа");
  });
}

function setupAudio() {
  audioCtx = audioCtx || new AudioContext();
  if (srcNode) try { srcNode.disconnect(); } catch {}
  srcNode = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.3;
  srcNode.connect(analyser);
}
document.addEventListener("click", () => audioCtx && audioCtx.resume(), { once: false });

const timeBuf = new Float32Array(2048), freqBuf = new Float32Array(1024);
let speaking = false, voiceFrames = 0, silenceT = null;
function setVoice(on) { $("voice").classList.toggle("on", on); }

setInterval(() => {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(timeBuf);
  let sum = 0, peak = 0;
  for (const v of timeBuf) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
  const rms = Math.sqrt(sum / timeBuf.length);
  const db = 20 * Math.log10(peak || 1e-5);
  $("meter").firstElementChild.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
  if (S.mode !== "voice") return;

  const threshold = 0.003 + (100 - S.sens) / 100 * 0.035;
  analyser.getFloatFrequencyData(freqBuf);
  const binHz = audioCtx.sampleRate / analyser.fftSize;
  const band = (lo, hi) => { let e = 0, n = 0; for (let i = Math.floor(lo / binHz); i < Math.ceil(hi / binHz) && i < freqBuf.length; i++) { e += Math.pow(10, freqBuf[i] / 20); n++; } return n ? e / n : 0; };
  const voice = band(85, 3400), high = band(4000, 8000);
  const voiceLike = rms > threshold && (high <= 0 || voice / high > 2.5);
  voiceFrames = voiceLike ? Math.min(voiceFrames + 1, 8) : Math.max(voiceFrames - 2, 0);
  if (voiceFrames >= 8) {
    clearTimeout(silenceT); silenceT = null;
    if (!speaking) { speaking = true; setVoice(true); }
  } else if (speaking && !silenceT) {
    silenceT = setTimeout(() => { speaking = false; silenceT = null; setVoice(false); }, 450);
  }
}, 16);

// ---------- Запись ----------
let recorder = null, chunks = [], recStart = 0, discard = false, counting = false, saving = false, mime = "";
function pickMime() {
  const opts = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a", "video/mp4",
                "video/webm;codecs=h264,opus", "video/webm;codecs=vp9,opus", "video/webm"];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}
function countdown(n) {
  return new Promise((res) => {
    if (!n) return res();
    counting = true;
    const el = $("count"); el.style.display = "flex";
    let i = n; el.textContent = i;
    const t = setInterval(() => {
      i--; if (i > 0) el.textContent = i;
      else { clearInterval(t); el.style.display = "none"; counting = false; res(); }
    }, 1000);
  });
}
async function startRecording() {
  if (recorder || counting) return;
  if (!stream) return toast("Камера не подключена");
  if (audioCtx) audioCtx.resume();
  setRunning(false);
  await countdown(S.cd);
  mime = pickMime(); chunks = []; discard = false;
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
  } catch (e) { logRemote("MediaRecorder: " + e.message); return toast("Не получилось начать запись: " + e.message); }
  mime = recorder.mimeType || mime;
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = onRecStop;
  recorder.start(1000);
  recStart = performance.now();
  document.body.classList.add("recording");
  native("native", { cmd: "rec", on: true });
  $("btnRec").textContent = "⏸ Пауза текста (Пробел)";
  setRunning(true);
}

let pendingTake = null, pendingTimer = null, askAfter = false, restartAfter = false;
function stopRecording(save = true) {
  if (!recorder) { if (pendingTake && save !== "ask") resolvePending(save === true); return; }
  discard = save === false; askAfter = save === "ask"; setRunning(false);
  recorder.stop();
}
async function onRecStop() {
  const blob = new Blob(chunks, { type: mime });
  const secs = (performance.now() - recStart) / 1000;
  recorder = null; chunks = [];
  document.body.classList.remove("recording");
  native("native", { cmd: "rec", on: false });
  $("btnRec").textContent = "● Начать (Пробел)";
  if (discard) {
    toast("Дубль выброшен");
    if (restartAfter) { restartAfter = false; goHome(); startRecording(); }
    return;
  }
  const name = ((current && current.file) || "take").replace(/\.(txt|md)$/i, "");
  const ext = mime.includes("mp4") ? "mp4" : "webm";
  if (askAfter) {
    pendingTake = { blob, secs, name, ext };
    let left = 20;
    $("askLeft").textContent = left; $("ask").style.display = "flex";
    pendingTimer = setInterval(() => { left--; $("askLeft").textContent = left; if (left <= 0) resolvePending(true); }, 1000);
    return;
  }
  uploadTake(blob, secs, name, ext);
}
function resolvePending(save) {
  clearInterval(pendingTimer); $("ask").style.display = "none";
  const p = pendingTake; pendingTake = null;
  if (!p) return;
  if (save) uploadTake(p.blob, p.secs, p.name, p.ext); else toast("Дубль выброшен");
}
if ($("askSave")) $("askSave").onclick = () => resolvePending(true);
if ($("askTrash")) $("askTrash").onclick = () => resolvePending(false);

async function uploadTake(blob, secs, name, ext) {
  const card = addTake(`${name} · ${fmt(secs)} · сохраняю и режу в 9:16…`);
  saving = true;
  try {
    const r = await fetch(`/api/upload?ext=${ext}&name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "ошибка ffmpeg");
    fillTake(card, j.file, secs);
    toast("Готово: " + j.file.split("/").pop());
  } catch (e) {
    card.classList.add("err");
    card.querySelector(".n").textContent = "Не удалось сохранить: " + e.message + " (исходник в папке «исходники»)";
  }
  saving = false;
}
function addTake(text) {
  const nt = $("noTakes"); if (nt) nt.remove();
  const d = document.createElement("div");
  d.className = "take"; d.innerHTML = '<div class="n"></div>';
  d.querySelector(".n").textContent = text;
  $("takes").prepend(d);
  return d;
}
function fillTake(card, file, secs) {
  card.querySelector(".n").textContent = file.split("/").pop() + (secs ? " · " + fmt(secs) : "");
  const row = document.createElement("div"); row.className = "row";
  const b1 = document.createElement("button"); b1.textContent = "Открыть";
  const b2 = document.createElement("button"); b2.textContent = "В Finder";
  b1.onclick = () => fetch("/api/open", { method: "POST", body: JSON.stringify({ file }) });
  b2.onclick = () => fetch("/api/reveal", { method: "POST", body: JSON.stringify({ file }) });
  row.append(b1, b2); card.appendChild(row);
}
async function loadTakes() {
  try {
    const r = await fetch("/api/takes");
    const j = await r.json();
    const box = $("takes");
    if (!box || !j.takes || !j.takes.length) return;
    box.innerHTML = "";
    j.takes.forEach((t) => {
      const card = document.createElement("div");
      card.className = "take";
      card.innerHTML = '<div class="n"></div>';
      fillTake(card, t.file, 0);
      box.appendChild(card);
    });
  } catch {}
}
async function checkEnv() {
  try {
    const r = await fetch("/api/info");
    const info = await r.json();
    if (info && info.out && $("dirPill")) $("dirPill").textContent = info.out.replace(/^\/Users\/[^/]+/, "~");
    if (info && info.ffmpeg === false) {
      toast("⚠ ffmpeg не найден: видео сохранится без авто-кропа 9:16");
    }
  } catch {}
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
setInterval(() => {
  $("timer").textContent = recorder ? fmt((performance.now() - recStart) / 1000) : "00:00";
  const left = Math.max(0, words.length - currentIndex());
  $("left-time").textContent = words.length ? "осталось ~" + fmt(left / S.wps) : "";
}, 250);

let toastT;
function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.style.display = "block";
  clearTimeout(toastT); toastT = setTimeout(() => (el.style.display = "none"), 3000);
}

function mainAction() {
  if (pendingTake) { resolvePending(true); goHome(); startRecording(); return; }
  if (recorder) { setRunning(!running); return; }
  setRunning(false); goHome(); startRecording();
}
function rehearse() {
  if (recorder) return toast("Сначала останови запись");
  setRunning(!running);
}
$("btnRec").onclick = () => (recorder ? setRunning(!running) : mainAction());
if ($("btnStopSave")) $("btnStopSave").onclick = () => stopRecording(true);
if ($("btnStopDiscard")) $("btnStopDiscard").onclick = () => stopRecording(false);
if ($("btnStop")) $("btnStop").onclick = () => stopRecording(true);
if ($("btnRehearse")) $("btnRehearse").onclick = rehearse;

function changeSpeed(delta) {
  S.wps = Math.max(0.5, Math.min(6, +(S.wps + delta).toFixed(2)));
  applySettings(); toast("Скорость: " + S.wps + " сл/с");
}
function cycleMode() {
  const order = ["classic", "voice", "words"];
  setMode(order[(order.indexOf(S.mode) + 1) % order.length]);
}
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
}

// ---------- Клавиатура ----------
window.addEventListener("keydown", (e) => {
  const inInput = ["INPUT", "TEXTAREA"].includes(document.activeElement && document.activeElement.tagName);
  if (inInput) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      if ($("btnSaveInline")) $("btnSaveInline").click();
    }
    return;
  }
  const k = e.key, c = e.code;
  if (k === " ") { e.preventDefault(); (recorder ? setRunning(!running) : rehearse()); }
  else if (k === "Enter") { e.preventDefault(); if (recorder) stopRecording(true); else mainAction(); }
  else if (k === "Escape") { e.preventDefault(); if (recorder) stopRecording(false); }
  else if (k === "ArrowUp") { e.preventDefault(); changeSpeed(0.25); }
  else if (k === "ArrowDown") { e.preventDefault(); changeSpeed(-0.25); }
  else if (k === "ArrowLeft") nudge(-1);
  else if (k === "ArrowRight") nudge(1);
  else if (k === "Home") goHome();
  else if (k === "+" || k === "=") { S.fs = Math.min(90, S.fs + 2); applySettings(); }
  else if (k === "-" || k === "_") { S.fs = Math.max(22, S.fs - 2); applySettings(); }
  else if (c === "KeyP") rehearse();
  else if (c === "KeyM") cycleMode();
  else if (c === "KeyG") toggleSafeZone();
  else if (c === "KeyH") document.body.classList.toggle("hideui");
  else if (c === "KeyF") toggleFullscreen();
});
window.addEventListener("beforeunload", (e) => { if (recorder) { e.preventDefault(); e.returnValue = ""; } });

// ---------- Пульт с телефона ----------
if ($("btnQr")) {
  $("btnQr").onclick = async () => {
    const box = $("qr");
    if (box.style.display === "block") { box.style.display = "none"; $("qrUrl").textContent = ""; return; }
    const { url } = await (await fetch("/api/remote-info")).json();
    const q = qrcode(0, "M"); q.addData(url); q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    box.style.display = "block";
    $("qrUrl").textContent = url + " · телефон должен быть в той же Wi-Fi сети";
  };
}
function handleCmd(c) {
  switch (c.cmd) {
    case "toggle": mainAction(); break;
    case "rehearse": rehearse(); break;
    case "save": stopRecording(true); break;
    case "discard": stopRecording(false); break;
    case "faster": changeSpeed(0.25); break;
    case "slower": changeSpeed(-0.25); break;
    case "back": nudge(-1); break;
    case "fwd": nudge(1); break;
    case "home": goHome(); break;
    case "mode": setMode(c.mode); break;
    case "script": pickScript(c.file); break;
  }
}
(function connectEvents() {
  try {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => { try { handleCmd(JSON.parse(e.data)); } catch {} };
    es.onerror = () => { es.close(); setTimeout(connectEvents, 2000); };
  } catch {}
})();
setInterval(() => {
  const state = {
    rec: !!recorder, counting, saving, running, mode: S.mode, wps: S.wps, pending: !!pendingTake, voiceCmd: S.voiceCmd,
    secs: recorder ? (performance.now() - recStart) / 1000 : 0,
    progress: words.length ? currentIndex() / words.length : 0,
    left: Math.max(0, words.length - currentIndex()) / S.wps,
    script: S.script, scripts: scripts.map((s) => s.file),
  };
  fetch("/api/state", { method: "POST", body: JSON.stringify(state) }).catch(() => {});
}, 500);

// ---------- Обучение (Onboarding) ----------
const DEMO_SCRIPT = `Привет! Это тестовый текст для проверки суфлёра.
Смотри прямо в точку над экраном — там объектив камеры.

[пауза]

Если включить режим «Голос»,
текст будет ждать, пока ты молчишь.

Нажми «Стоп и сохранить» внизу,
чтобы получить готовый ролик 9:16!`;

function openOnboarding() {
  if ($("onboarding")) $("onboarding").style.display = "flex";
}
function closeOnboarding() {
  if ($("onboarding")) $("onboarding").style.display = "none";
  store.set("onboarded", true);
}
if ($("btnHelp")) $("btnHelp").onclick = openOnboarding;
if ($("obClose")) $("obClose").onclick = closeOnboarding;
if ($("obDone")) $("obDone").onclick = closeOnboarding;
if ($("onboarding")) {
  $("onboarding").addEventListener("click", (e) => { if (e.target === $("onboarding")) closeOnboarding(); });
}
if ($("obTryDemo")) {
  $("obTryDemo").onclick = () => {
    current = null; S.script = "";
    if ($("edInlineName")) $("edInlineName").value = "Тест суфлёра";
    if ($("edInlineText")) $("edInlineText").value = DEMO_SCRIPT;
    setText(DEMO_SCRIPT);
    closeOnboarding();
    toast("Учебный текст загружен — нажми «Репетиция» или «Начать»");
  };
}

// ---------- Старт ----------
applySettings();
checkEnv();
loadTakes();
loadScripts().then(() => Speech.sync());
startMedia();
if (!store.get("onboarded", false)) openOnboarding();
