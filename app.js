const els = {};
let foods = [];
let parsedItems = [];
let recognition = null;

const STORAGE_KEY = "bju-mvp-v1";

document.addEventListener("DOMContentLoaded", init);

async function init() {
  Object.assign(els, {
    todayLabel: document.querySelector("#todayLabel"),
    targetProtein: document.querySelector("#targetProtein"),
    targetFat: document.querySelector("#targetFat"),
    targetCarbs: document.querySelector("#targetCarbs"),
    saveTargetsBtn: document.querySelector("#saveTargetsBtn"),
    micBtn: document.querySelector("#micBtn"),
    speechStatus: document.querySelector("#speechStatus"),
    foodText: document.querySelector("#foodText"),
    parseBtn: document.querySelector("#parseBtn"),
    parseMessage: document.querySelector("#parseMessage"),
    parsedList: document.querySelector("#parsedList"),
    confirmBar: document.querySelector("#confirmBar"),
    addParsedBtn: document.querySelector("#addParsedBtn"),
    clearParsedBtn: document.querySelector("#clearParsedBtn"),
    macroSummary: document.querySelector("#macroSummary"),
    diaryList: document.querySelector("#diaryList"),
    resetDayBtn: document.querySelector("#resetDayBtn"),
  });

  els.todayLabel.textContent = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric", month: "long"
  }).format(new Date());

  try {
    const response = await fetch("./foods.json");
    if (!response.ok) throw new Error("foods.json не загрузился");
    foods = await response.json();
  } catch (error) {
    setMessage("Не удалось загрузить foods.json. Проверьте, что файл лежит рядом с index.html.", true);
    console.error(error);
  }

  loadTargetsIntoInputs();
  setupSpeech();
  bindEvents();
  renderAll();
}

function bindEvents() {
  els.saveTargetsBtn.addEventListener("click", saveTargets);
  els.parseBtn.addEventListener("click", parseCurrentText);
  els.addParsedBtn.addEventListener("click", addParsedToDiary);
  els.clearParsedBtn.addEventListener("click", clearParsed);
  els.resetDayBtn.addEventListener("click", resetToday);
}

function setupSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    els.micBtn.disabled = true;
    els.speechStatus.textContent = "Голосовой ввод не поддерживается этим браузером";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "ru-RU";
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  els.micBtn.addEventListener("click", () => {
    try {
      recognition.start();
    } catch (_) {
      // Некоторые браузеры бросают ошибку при повторном start().
    }
  });

  recognition.onstart = () => {
    els.micBtn.classList.add("listening");
    els.micBtn.textContent = "⏹ Слушаю…";
    els.speechStatus.textContent = "Говорите продукты и граммы";
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    els.foodText.value = transcript;
    els.speechStatus.textContent = `Распознано: ${transcript}`;
    parseCurrentText();
  };

  recognition.onerror = (event) => {
    const labels = {
      "not-allowed": "Нет доступа к микрофону. Разрешите микрофон для сайта.",
      "no-speech": "Речь не обнаружена. Попробуйте ещё раз.",
      "audio-capture": "Микрофон недоступен.",
      "network": "Ошибка сервиса распознавания речи."
    };
    els.speechStatus.textContent = labels[event.error] || `Ошибка распознавания: ${event.error}`;
  };

  recognition.onend = () => {
    els.micBtn.classList.remove("listening");
    els.micBtn.textContent = "🎤 Говорить";
  };
}

function parseCurrentText() {
  const text = els.foodText.value.trim();
  if (!text) {
    setMessage("Введите или произнесите продукты.", true);
    clearParsed();
    return;
  }

  parsedItems = parseFoodText(text);
  renderParsed();

  if (!parsedItems.length) {
    setMessage("Не удалось найти продукт с количеством в граммах. Пример: «творог 200 грамм».", true);
  } else {
    setMessage(`Найдено позиций: ${parsedItems.length}. Проверьте их перед добавлением.`);
  }
}

function parseFoodText(input) {
  const normalized = normalizeText(input);
  const candidates = [];

  for (const food of foods) {
    const aliases = [...food.aliases].sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      let startAt = 0;
      const normalizedAlias = normalizeText(alias);

      while (true) {
        const index = normalized.indexOf(normalizedAlias, startAt);
        if (index === -1) break;

        const before = normalized[index - 1];
        const after = normalized[index + normalizedAlias.length];
        const leftBoundary = !before || /[\s,.;:]/.test(before);
        const rightBoundary = !after || /[\s,.;:]/.test(after);

        if (leftBoundary && rightBoundary) {
          const amount = findNearestGramAmount(normalized, index, index + normalizedAlias.length);
          if (amount) {
            candidates.push({
              food,
              grams: amount.value,
              foodStart: index,
              amountStart: amount.start,
              distance: amount.distance
            });
          }
        }
        startAt = index + normalizedAlias.length;
      }
    }
  }

  // Оставляем лучший матч для каждого найденного числового количества.
  candidates.sort((a, b) => a.distance - b.distance || a.foodStart - b.foodStart);
  const usedAmounts = new Set();
  const chosen = [];

  for (const candidate of candidates) {
    if (usedAmounts.has(candidate.amountStart)) continue;
    usedAmounts.add(candidate.amountStart);
    chosen.push(candidate);
  }

  return chosen
    .sort((a, b) => Math.min(a.foodStart, a.amountStart) - Math.min(b.foodStart, b.amountStart))
    .map(({ food, grams }) => ({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      foodId: food.id,
      name: food.name,
      grams,
      protein: round1(food.protein * grams / 100),
      fat: round1(food.fat * grams / 100),
      carbs: round1(food.carbs * grams / 100)
    }));
}

function findNearestGramAmount(text, foodStart, foodEnd) {
  // Поддерживает "200 грамм", "200 г", а также фразы с числом словами,
  // которые normalizeText предварительно преобразует в цифры.
  const regex = /(\d+(?:[.,]\d+)?)\s*(?:грамм(?:а|ов)?|гр\b|г\b)/g;
  const matches = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const value = Number(match[1].replace(",", "."));
    if (!Number.isFinite(value) || value <= 0 || value > 5000) continue;

    const amountStart = match.index;
    const amountEnd = match.index + match[0].length;
    let distance = 0;

    if (amountEnd <= foodStart) distance = foodStart - amountEnd;
    else if (amountStart >= foodEnd) distance = amountStart - foodEnd;

    // Не связываем слишком далёкие числа с продуктом.
    if (distance <= 35) {
      matches.push({ value, start: amountStart, distance });
    }
  }

  matches.sort((a, b) => a.distance - b.distance);
  return matches[0] || null;
}

function normalizeText(text) {
  let s = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  s = replaceRussianNumberWords(s);
  return s;
}

function replaceRussianNumberWords(text) {
  const units = {
    "ноль":0,"один":1,"одна":1,"одно":1,"два":2,"две":2,"три":3,"четыре":4,
    "пять":5,"шесть":6,"семь":7,"восемь":8,"девять":9
  };
  const teens = {
    "десять":10,"одиннадцать":11,"двенадцать":12,"тринадцать":13,"четырнадцать":14,
    "пятнадцать":15,"шестнадцать":16,"семнадцать":17,"восемнадцать":18,"девятнадцать":19
  };
  const tens = {
    "двадцать":20,"тридцать":30,"сорок":40,"пятьдесят":50,
    "шестьдесят":60,"семьдесят":70,"восемьдесят":80,"девяносто":90
  };
  const hundreds = {
    "сто":100,"двести":200,"триста":300,"четыреста":400,"пятьсот":500,
    "шестьсот":600,"семьсот":700,"восемьсот":800,"девятьсот":900
  };

  const dict = {...units, ...teens, ...tens, ...hundreds};
  const words = text.split(" ");
  const result = [];

  for (let i = 0; i < words.length; i++) {
    const clean = words[i].replace(/[,.]/g, "");
    if (!(clean in dict)) {
      result.push(words[i]);
      continue;
    }

    let total = 0;
    let j = i;
    while (j < words.length) {
      const w = words[j].replace(/[,.]/g, "");
      if (!(w in dict)) break;
      total += dict[w];
      j++;
    }

    result.push(String(total));
    i = j - 1;
  }

  return result.join(" ");
}

function saveTargets() {
  const state = getState();
  state.targets = {
    protein: nonNegativeNumber(els.targetProtein.value),
    fat: nonNegativeNumber(els.targetFat.value),
    carbs: nonNegativeNumber(els.targetCarbs.value)
  };
  saveState(state);
  renderSummary();
  setMessage("Дневная цель сохранена.");
}

function loadTargetsIntoInputs() {
  const targets = getState().targets || {};
  els.targetProtein.value = targets.protein ?? "";
  els.targetFat.value = targets.fat ?? "";
  els.targetCarbs.value = targets.carbs ?? "";
}

function addParsedToDiary() {
  if (!parsedItems.length) return;
  const state = getState();
  const today = getTodayKey();

  state.days[today] ||= [];
  for (const item of parsedItems) {
    state.days[today].push({
      ...item,
      addedAt: new Date().toISOString()
    });
  }

  saveState(state);
  clearParsed();
  els.foodText.value = "";
  renderAll();
}

function clearParsed() {
  parsedItems = [];
  renderParsed();
}

function deleteDiaryItem(id) {
  const state = getState();
  const today = getTodayKey();
  state.days[today] = (state.days[today] || []).filter(item => item.id !== id);
  saveState(state);
  renderAll();
}

function resetToday() {
  if (!confirm("Удалить все записи за сегодня?")) return;
  const state = getState();
  state.days[getTodayKey()] = [];
  saveState(state);
  renderAll();
}

function renderAll() {
  renderSummary();
  renderDiary();
  renderParsed();
}

function renderParsed() {
  els.parsedList.innerHTML = "";
  els.confirmBar.classList.toggle("hidden", parsedItems.length === 0);

  for (const item of parsedItems) {
    const div = document.createElement("div");
    div.className = "parsed-item";
    div.innerHTML = `
      <div>
        <div class="item-title">${escapeHtml(item.name)} — ${format(item.grams)} г</div>
        <div class="item-meta">Б ${format(item.protein)} · Ж ${format(item.fat)} · У ${format(item.carbs)}</div>
      </div>
      <button class="small-delete" type="button">Убрать</button>
    `;
    div.querySelector("button").addEventListener("click", () => {
      parsedItems = parsedItems.filter(x => x.id !== item.id);
      renderParsed();
    });
    els.parsedList.appendChild(div);
  }
}

function renderDiary() {
  const items = getTodayItems();
  els.diaryList.innerHTML = "";

  if (!items.length) {
    els.diaryList.innerHTML = `<div class="empty">Пока ничего не добавлено.</div>`;
    return;
  }

  for (const item of [...items].reverse()) {
    const div = document.createElement("div");
    div.className = "diary-item";
    div.innerHTML = `
      <div>
        <div class="item-title">${escapeHtml(item.name)} — ${format(item.grams)} г</div>
        <div class="item-meta">Б ${format(item.protein)} · Ж ${format(item.fat)} · У ${format(item.carbs)}</div>
      </div>
      <div class="diary-actions">
        <button class="small-delete" type="button">Удалить</button>
      </div>
    `;
    div.querySelector("button").addEventListener("click", () => deleteDiaryItem(item.id));
    els.diaryList.appendChild(div);
  }
}

function renderSummary() {
  const state = getState();
  const targets = state.targets || { protein: 0, fat: 0, carbs: 0 };
  const totals = getTodayItems().reduce((sum, item) => ({
    protein: sum.protein + Number(item.protein || 0),
    fat: sum.fat + Number(item.fat || 0),
    carbs: sum.carbs + Number(item.carbs || 0)
  }), { protein: 0, fat: 0, carbs: 0 });

  const macros = [
    ["Белки", "protein"],
    ["Жиры", "fat"],
    ["Углеводы", "carbs"]
  ];

  els.macroSummary.innerHTML = "";

  for (const [label, key] of macros) {
    const eaten = round1(totals[key]);
    const target = Number(targets[key] || 0);
    const remaining = round1(target - eaten);
    const percent = target > 0 ? Math.min(100, Math.max(0, eaten / target * 100)) : 0;
    const over = target > 0 && remaining < 0;

    const div = document.createElement("div");
    div.className = "macro-row";
    div.innerHTML = `
      <div class="macro-name">${label}</div>
      <div>
        <div class="macro-value">${format(eaten)} / ${target ? format(target) : "—"} г</div>
        <div class="progress" aria-hidden="true"><div style="width:${percent}%"></div></div>
      </div>
      <div class="remaining ${over ? "over" : "ok"}">
        ${target ? (over ? `${format(remaining)} г` : `осталось ${format(remaining)} г`) : "задайте цель"}
      </div>
    `;
    els.macroSummary.appendChild(div);
  }
}

function getTodayItems() {
  return getState().days[getTodayKey()] || [];
}

function getState() {
  const fallback = {
    targets: { protein: 0, fat: 0, carbs: 0 },
    days: {}
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      targets: parsed.targets || fallback.targets,
      days: parsed.days || {}
    };
  } catch (_) {
    return fallback;
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function setMessage(text, isError = false) {
  els.parseMessage.textContent = text;
  els.parseMessage.classList.toggle("error", isError);
}

function nonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function round1(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
}

function format(n) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(Number(n));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
