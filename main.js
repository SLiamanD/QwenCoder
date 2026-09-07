/*
 * Pult — личный таск-менеджер для Obsidian (v0.5.0).
 * ------------------------------------------------------------------
 * В духе TickTick Premium: умные экраны (Сегодня, Неделя, Входящие,
 * Все, Списки, Календарь, Статистика, Привычки), навигация экранами
 * с «домашнего» списка, manual-порядок, списки-теги, подзадачи,
 * таймер со статистикой. Mobile-first: шторки, тап-зоны >= 44px.
 *
 * Панель открывается в ПРАВОМ сайдбаре (рядом со структурой документа
 * и метками Obsidian).
 *
 * Каждая задача = отдельный .md файл с YAML frontmatter в одной папке
 * (по умолчанию "Pult/"). Подзадача — файл с parent: "[[Имя]]".
 * Списки — теги (tags: [работа]) + файлы-списки (type: pult_list).
 *
 * Чистый JavaScript (CommonJS), без сборки: main.js, styles.css и
 * manifest.json кладутся в .obsidian/plugins/pult/.
 * Запись frontmatter — только app.fileManager.processFrontMatter.
 */
"use strict";

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  Menu,
  Modal,
  TFile,
} = require("obsidian");

const VIEW_TYPE = "pult-view";
const DEFAULT_FOLDER = "Pult";
const DEBOUNCE_MS = 150;

const STATUS = Object.freeze({ INBOX: "inbox", ACTIVE: "active", DONE: "done" });
const PRIORITY_LABEL = Object.freeze({ low: "низкий", medium: "средний", high: "высокий" });
const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

const VIEW_TITLES = {
  home: "Pult",
  today: "Сегодня",
  week: "Неделя",
  inbox: "Входящие",
  all: "Все задачи",
  lists: "Списки",
  calendar: "Календарь",
  stats: "Статистика",
  habits: "Привычки",
  timeline: "Таймлайн",
};

const SORT_LABEL = {
  manual: "Вручную",
  alpha: "По алфавиту",
  priority: "По приоритету",
  date: "По дате",
};

const LIST_ICONS = ["📋", "💼", "🏠", "🎯", "📚", "❤️", "🛒", "✈️", "💡", "🎨"];
const LIST_COLORS = ["mint", "amber", "coral", "ice"];
const KANBAN_COLS = Object.freeze([
  { id: "todo", label: "К делу" },
  { id: "doing", label: "В работе" },
  { id: "done", label: "Готово" },
]);
const HABIT_ICONS = ["⭐", "💧", "🏃", "📖", "🧘", "💪", "✍️", "🌙", "💊", "🥗"];

function weekOfMonth(m) {
  const start = m.clone().startOf("month").startOf("isoWeek");
  const diff = m.clone().startOf("isoWeek").diff(start, "weeks");
  return Math.min(5, Math.max(1, diff + 1));
}

function weeksInMonth(m) {
  const start = m.clone().startOf("month").startOf("isoWeek");
  const end = m.clone().endOf("month").endOf("isoWeek");
  return Math.ceil(end.diff(start, "weeks", true));
}

function parseHabitValues(fm) {
  const raw = fm && fm.values;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const d = toDayStr(k);
    const n = parseFloat(v);
    if (d && Number.isFinite(n)) out[d] = n;
  }
  return out;
}

function bindKeyboardAvoidance(input) {
  if (!input || input.dataset.pultKb) return;
  input.dataset.pultKb = "1";
  input.addEventListener("focus", () => {
    window.setTimeout(() => {
      input.scrollIntoView({ block: "center", behavior: "smooth" });
      const vv = window.visualViewport;
      if (!vv) return;
      const rect = input.getBoundingClientRect();
      const overlap = rect.bottom - vv.height + 16;
      if (overlap > 0) {
        const parent = input.closest(".pult-sheet-body") || input.closest(".pult-body");
        if (parent) parent.scrollTop += overlap;
      }
    }, 320);
  });
}

function installSheetKeyboard(modal) {
  const body = modal.contentEl;
  if (!body) return () => {};
  body.querySelectorAll("input, textarea").forEach(bindKeyboardAvoidance);
  const onResize = () => {
    const active = document.activeElement;
    if (active && body.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      active.dispatchEvent(new Event("focus"));
    }
  };
  if (window.visualViewport) window.visualViewport.addEventListener("resize", onResize);
  return () => {
    if (window.visualViewport) window.visualViewport.removeEventListener("resize", onResize);
  };
}

/* ================================================================
 * Утилиты
 * ================================================================ */

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svgIcon(name, size) {
  const s = size || 18;
  const paths = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    "calendar-days":
      '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
    inbox:
      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    tag: '<path d="M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8Z"/><circle cx="7" cy="7" r="1.5"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15v-4M12 15V7M17 15v-6"/>',
    flame: '<path d="M12 2s5 4.6 5 9.6a5 5 0 0 1-10 0c0-2 .9-3.7 2-5 0 2 .9 3 2 3.6C11.2 8 11 4.6 12 2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    dots: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
    sort: '<path d="m3 16 4 4 4-4M7 20V4m14 0-4-4-4 4m4-4v16"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    next: '<path d="m9 6 6 6-6 6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    caret: '<path d="m9 6 6 6-6 6"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1"/>',
  };
  return (
    '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s +
    '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    (paths[name] || "") + "</svg>"
  );
}

const todayStr = () => window.moment().format("YYYY-MM-DD");

function toDayStr(v) {
  if (v == null || v === "") return null;
  let m;
  if (v instanceof Date) {
    m = window.moment(v);
  } else {
    const s = String(v).trim();
    m = window.moment(s, "YYYY-MM-DD", true);
    if (!m.isValid()) m = window.moment(s, "DD.MM.YYYY", true);
    if (!m.isValid()) m = window.moment(s);
  }
  return m.isValid() ? m.format("YYYY-MM-DD") : null;
}

function parseLink(v) {
  if (!v) return null;
  let s = String(v).trim();
  const m = s.match(/^\[\[(.+?)\]\]$/);
  if (m) s = m[1];
  s = s.split("#")[0].split("|")[0].trim();
  return s || null;
}

function parseTags(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => parseLink(x)).filter(Boolean);
  return String(v)
    .split(/[,;]/)
    .map((x) => parseLink(x))
    .filter(Boolean);
}

function toOrder(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtDuration(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return min + " м";
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  return mm ? hh + " ч " + mm + " м" : hh + " ч";
}

function fmtDurationShort(ms) {
  if (ms <= 0) return "";
  if (ms < 3600000) return Math.round(ms / 60000) + " м";
  const hrs = Math.round((ms / 3600000) * 10) / 10;
  return String(hrs).replace(".", ",") + " ч";
}

function fmtDate(s) {
  if (!s) return "";
  if (s === todayStr()) return "сегодня";
  if (s === window.moment().add(1, "day").format("YYYY-MM-DD")) return "завтра";
  return window.moment(s).format("D MMM");
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function last7() {
  const out = [];
  for (let i = 6; i >= 0; i--) out.push(window.moment().subtract(i, "days").format("YYYY-MM-DD"));
  return out;
}

/* ================================================================
 * Шторки (модальные окна; на мобильном прижаты к низу)
 * ================================================================ */

class Sheet extends Modal {
  onOpen() {
    if (this.modalEl) this.modalEl.addClass("pult-sheet");
    this.contentEl.addClass("pult-sheet-body");
    this.titleEl.addClass("pult-sheet-title");
    this.contentEl.prepend(h("div", "pult-sheet-grip"));
    this._kbCleanup = installSheetKeyboard(this);
  }
  onClose() {
    if (this._kbCleanup) this._kbCleanup();
    this.contentEl.empty();
  }
  btnRow() {
    const row = h("div", "pult-sheet-btns");
    this.contentEl.appendChild(row);
    return row;
  }
  footerRow() {
    const row = h("div", "pult-sheet-footer");
    this.contentEl.appendChild(row);
    return row;
  }
  chipRow(label) {
    if (label) this.contentEl.appendChild(h("div", "pult-sheet-label", label));
    const row = h("div", "pult-chip-row");
    this.contentEl.appendChild(row);
    return row;
  }
  chip(row, text, onPick, isOn) {
    const c = h("button", "pult-chip" + (isOn ? " is-on" : ""), text);
    c.addEventListener("click", () => onPick(c));
    row.appendChild(c);
    return c;
  }
}

class QuickAddSheet extends Sheet {
  constructor(app, opts, onOk) {
    super(app);
    this.opts = opts || {};
    this.onOk = onOk;
    this.date = opts.date || null;
    this.priority = "medium";
    this.tags = (opts.tags || []).slice();
  }

  onOpen() {
    super.onOpen();
    this.titleEl.setText("Новая задача");
    const { contentEl } = this;

    this.input = contentEl.createEl("input", {
      type: "text",
      placeholder: "Название задачи…",
      cls: "pult-big-input",
    });

    const dateRow = this.chipRow("Когда");
    const setDate = (d, btn) => {
      this.date = d;
      dateRow.querySelectorAll(".pult-chip").forEach((x) => x.removeClass("is-on"));
      btn.addClass("is-on");
    };
    this.chip(dateRow, "Без даты", (b) => setDate(null, b), !this.date);
    this.chip(dateRow, "Сегодня", (b) => setDate(todayStr(), b), this.date === todayStr());
    this.chip(
      dateRow,
      "Завтра",
      (b) => setDate(window.moment().add(1, "day").format("YYYY-MM-DD"), b),
      this.date === window.moment().add(1, "day").format("YYYY-MM-DD")
    );
    this.chip(
      dateRow,
      "Неделя",
      (b) => setDate(window.moment().isoWeekday(7).format("YYYY-MM-DD"), b),
      this.date === window.moment().isoWeekday(7).format("YYYY-MM-DD")
    );

    const prRow = this.chipRow("Приоритет");
    const setPr = (p, btn) => {
      this.priority = p;
      prRow.querySelectorAll(".pult-chip").forEach((x) => x.removeClass("is-on"));
      btn.addClass("is-on");
    };
    for (const p of ["low", "medium", "high"]) {
      this.chip(prRow, PRIORITY_LABEL[p], (b) => setPr(p, b), p === this.priority);
    }

    this.tagsInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "Списки (теги) через запятую: работа, дом",
      cls: "pult-big-input pult-tags-input",
      value: this.tags.join(", "),
    });
    contentEl.appendChild(h("div", "pult-sheet-hint", "Теги делают задачу частью списков — как в TickTick."));

    const btns = this.btnRow();
    btns.createEl("button", { text: "Отмена", cls: "pult-btn" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Добавить", cls: "pult-btn is-primary" }).addEventListener("click", () => this.submit());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submit();
    });
    this.input.focus();
    bindKeyboardAvoidance(this.input);
    bindKeyboardAvoidance(this.tagsInput);
  }

  submit() {
    const name = (this.input.value || "").trim();
    if (!name) {
      this.input.addClass("pult-invalid");
      window.setTimeout(() => this.input.removeClass("pult-invalid"), 450);
      return;
    }
    const tags = (this.tagsInput.value || "")
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean);
    this.onOk({ name, date: this.date, priority: this.priority, tags });
    this.close();
  }
}

class TaskSheet extends Sheet {
  constructor(app, view, task, data) {
    super(app);
    this.view = view;
    this.task = task;
    this.data = data;
  }

  onOpen() {
    super.onOpen();
    const { view, task } = this;
    const plugin = view.plugin;
    this.titleEl.setText(task.name);
    const contentEl = this.contentEl;

    const main = h("div", "pult-sheet-actions");
    const done = task.status === STATUS.DONE;
    const running = !!(plugin.timer && plugin.timer.path === task.file.path);

    const mk = (icon, label, cls, fn) => {
      const b = h("button", "pult-act-card " + (cls || ""));
      b.innerHTML = svgIcon(icon, 18);
      b.appendChild(h("span", null, label));
      b.addEventListener("click", () => {
        this.close();
        fn();
      });
      main.appendChild(b);
    };

    mk("check", done ? "Вернуть" : "Готово", done ? "" : "is-accent", () =>
      plugin.setStatus(task.file, done ? STATUS.ACTIVE : STATUS.DONE)
    );
    mk("timer", running ? "Стоп" : "Таймер", running ? "is-danger" : "", () => plugin.startTimer(task.file));
    mk("tag", "Файл", "", () => view.openFile(task.file));
    mk("trash", "Удалить", "is-danger", () => view.confirmDelete(task, this.data.byParent));
    contentEl.appendChild(main);

    const dateRow = this.chipRow("Запланировать");
    const setDate = (d) => {
      plugin.setScheduled(task.file, d);
      this.close();
    };
    const dd = task.scheduled;
    this.chip(dateRow, "Сегодня", () => setDate(todayStr()), dd === todayStr());
    this.chip(
      dateRow,
      "Завтра",
      () => setDate(window.moment().add(1, "day").format("YYYY-MM-DD")),
      dd === window.moment().add(1, "day").format("YYYY-MM-DD")
    );
    this.chip(
      dateRow,
      "Конец недели",
      () => setDate(window.moment().isoWeekday(7).format("YYYY-MM-DD")),
      dd === window.moment().isoWeekday(7).format("YYYY-MM-DD")
    );
    this.chip(dateRow, "Дата…", () => {
      this.close();
      new DateModal(this.app, (d) => setDate(d)).open();
    }, false);
    if (dd) this.chip(dateRow, "Снять ✕", () => setDate(null), false);

    const prRow = this.chipRow("Приоритет");
    for (const p of ["low", "medium", "high"]) {
      this.chip(prRow, PRIORITY_LABEL[p], () => {
        plugin.setPriority(task.file, p);
        this.close();
      }, task.priority === p);
    }

    contentEl.appendChild(h("div", "pult-sheet-label", "Списки (теги)"));
    this.tagsInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "работа, дом…",
      cls: "pult-big-input pult-tags-input",
      value: task.tags.join(", "),
    });
    const btns = this.btnRow();
    btns.createEl("button", { text: "Сохранить списки", cls: "pult-btn is-primary" }).addEventListener("click", async () => {
      const tags = (this.tagsInput.value || "")
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean);
      await plugin.patchFrontMatter(task.file, (fm) => {
        if (tags.length) fm.tags = tags;
        else delete fm.tags;
      });
      this.close();
    });

    contentEl.appendChild(h("div", "pult-sheet-label", "Длительность (дни, для таймлайна)"));
    const durRow = h("div", "pult-inline-add");
    this.durInput = durRow.createEl("input", {
      type: "number",
      min: "1",
      max: "365",
      placeholder: "1",
      value: task.duration ? String(task.duration) : "",
    });
    durRow.createEl("span", null, "дн.");
    contentEl.appendChild(durRow);
    bindKeyboardAvoidance(this.durInput);

    const kids = view.childrenOf(task.name, this.data.byParent);
    if (kids.length) {
      contentEl.appendChild(h("div", "pult-sheet-label", "Канбан подзадач"));
      const kanban = h("div", "pult-kanban");
      for (const col of KANBAN_COLS) {
        const colEl = h("div", "pult-kanban-col");
        colEl.appendChild(h("div", "pult-kanban-col-title", col.label));
        const items = kids.filter((k) => {
          const st = k.kanbanStatus || (k.status === STATUS.DONE ? "done" : "todo");
          return st === col.id;
        });
        for (const k of items) {
          const card = h("div", "pult-kanban-card" + (k.status === STATUS.DONE ? " is-done" : ""), k.name);
          card.addEventListener("click", () => {
            const next = col.id === "todo" ? "doing" : col.id === "doing" ? "done" : "todo";
            plugin.setKanbanStatus(k.file, next);
            if (next === "done") plugin.setStatus(k.file, STATUS.DONE);
            else if (k.status === STATUS.DONE) plugin.setStatus(k.file, STATUS.ACTIVE);
            this.close();
            view.render();
          });
          colEl.appendChild(card);
        }
        kanban.appendChild(colEl);
      }
      contentEl.appendChild(kanban);
      contentEl.appendChild(h("div", "pult-sheet-hint", "Тап по карточке — сменить колонку. Полный канбан — в будущих версиях."));
    }

    contentEl.appendChild(h("div", "pult-sheet-label", "Подзадача"));
    const subRow = h("div", "pult-inline-add");
    this.subInput = subRow.createEl("input", { type: "text", placeholder: "Название подзадачи…" });
    const subBtn = subRow.createEl("button", { text: "+", cls: "pult-btn is-primary" });
    const addSub = async () => {
      const v = (this.subInput.value || "").trim();
      if (!v) return;
      await plugin.createTask(v, task.name, null, task.tags);
      new Notice("Подзадача добавлена");
      this.close();
    };
    subBtn.addEventListener("click", addSub);
    this.subInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addSub();
    });
    contentEl.appendChild(subRow);
    bindKeyboardAvoidance(this.subInput);
    bindKeyboardAvoidance(this.tagsInput);

    const saveDur = this.btnRow();
    saveDur.createEl("button", { text: "Сохранить длительность", cls: "pult-btn" }).addEventListener("click", async () => {
      const n = parseInt(this.durInput.value, 10);
      await plugin.patchFrontMatter(task.file, (fm) => {
        if (Number.isFinite(n) && n > 0) fm.duration = n;
        else delete fm.duration;
      });
      new Notice("Длительность сохранена");
    });

    const footer = this.footerRow();
    footer.createEl("button", { text: "Удалить задачу", cls: "pult-btn is-danger is-full" }).addEventListener("click", () => {
      this.close();
      view.confirmDelete(task, this.data.byParent);
    });
  }
}

class DateModal extends Sheet {
  constructor(app, onOk) {
    super(app);
    this.onOk = onOk;
  }
  onOpen() {
    super.onOpen();
    this.titleEl.setText("Дата задачи");
    const { contentEl } = this;
    this.input = contentEl.createEl("input", {
      type: "text",
      placeholder: "2026-09-05  или  05.09.2026",
      cls: "pult-big-input",
    });
    contentEl.appendChild(h("div", "pult-sheet-hint", "Форматы: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ. Enter — подтвердить."));
    const btns = this.btnRow();
    btns.createEl("button", { text: "Отмена", cls: "pult-btn" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Поставить", cls: "pult-btn is-primary" }).addEventListener("click", () => this.submit());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submit();
    });
    this.input.focus();
  }
  submit() {
    const raw = (this.input.value || "").trim();
    const m = window.moment(raw, ["YYYY-MM-DD", "DD.MM.YYYY"], true);
    if (!raw || !m.isValid()) {
      this.input.addClass("pult-invalid");
      window.setTimeout(() => this.input.removeClass("pult-invalid"), 450);
      return;
    }
    this.onOk(m.format("YYYY-MM-DD"));
    this.close();
  }
}

class ConfirmModal extends Sheet {
  constructor(app, text, onYes) {
    super(app);
    this.text = text;
    this.onYes = onYes;
  }
  onOpen() {
    super.onOpen();
    this.titleEl.setText("Подтверждение");
    this.contentEl.appendChild(h("p", "pult-confirm-text", this.text));
    const btns = this.btnRow();
    btns.createEl("button", { text: "Отмена", cls: "pult-btn" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Удалить", cls: "pult-btn is-danger" }).addEventListener("click", async () => {
      this.close();
      await this.onYes();
    });
  }
}

class ListModal extends Sheet {
  constructor(app, onOk) {
    super(app);
    this.onOk = onOk;
    this.icon = LIST_ICONS[0];
    this.color = LIST_COLORS[0];
  }
  onOpen() {
    super.onOpen();
    this.titleEl.setText("Новый список");
    const { contentEl } = this;
    this.input = contentEl.createEl("input", { type: "text", placeholder: "Например: Работа", cls: "pult-big-input" });

    contentEl.appendChild(h("div", "pult-sheet-label", "Значок"));
    const iconRow = h("div", "pult-chip-row");
    for (const ic of LIST_ICONS) {
      this.chip(iconRow, ic, (b) => {
        this.icon = ic;
        iconRow.querySelectorAll(".pult-chip").forEach((x) => x.removeClass("is-on"));
        b.addClass("is-on");
      }, ic === this.icon);
    }
    contentEl.appendChild(iconRow);

    contentEl.appendChild(h("div", "pult-sheet-label", "Цвет"));
    const colorRow = h("div", "pult-chip-row");
    for (const c of LIST_COLORS) {
      const b = h("button", "pult-chip pult-swatch c-" + c + (c === this.color ? " is-on" : ""));
      b.addEventListener("click", () => {
        this.color = c;
        colorRow.querySelectorAll(".pult-chip").forEach((x) => x.removeClass("is-on"));
        b.addClass("is-on");
      });
      colorRow.appendChild(b);
    }
    contentEl.appendChild(colorRow);
    contentEl.appendChild(h("div", "pult-sheet-hint", "Список = тег. Задачи попадают в него через поле «Списки»."));

    const btns = this.btnRow();
    btns.createEl("button", { text: "Отмена", cls: "pult-btn" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Создать", cls: "pult-btn is-primary" }).addEventListener("click", () => {
      const name = (this.input.value || "").trim();
      if (!name) {
        this.input.addClass("pult-invalid");
        window.setTimeout(() => this.input.removeClass("pult-invalid"), 450);
        return;
      }
      this.onOk(name, this.icon, this.color);
      this.close();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.contentEl.querySelector(".is-primary").click();
    });
    this.input.focus();
  }
}

class HabitModal extends Sheet {
  constructor(app, onOk) {
    super(app);
    this.onOk = onOk;
    this.icon = HABIT_ICONS[0];
    this.color = LIST_COLORS[0];
    this.habitType = "check";
    this.unit = "";
    this.target = "";
  }
  onOpen() {
    super.onOpen();
    this.titleEl.setText("Новая привычка");
    const { contentEl } = this;
    this.input = contentEl.createEl("input", { type: "text", placeholder: "Например: Пить воду", cls: "pult-big-input" });
    bindKeyboardAvoidance(this.input);

    const typeRow = this.chipRow("Тип");
    const setType = (t, btn) => {
      this.habitType = t;
      typeRow.querySelectorAll(".pult-chip").forEach((x) => x.removeClass("is-on"));
      btn.addClass("is-on");
      this.unitWrap.style.display = t === "numeric" ? "" : "none";
    };
    this.chip(typeRow, "Галочка", (b) => setType("check", b), true);
    this.chip(typeRow, "Число", (b) => setType("numeric", b), false);

    this.unitWrap = h("div");
    contentEl.appendChild(this.unitWrap);
    this.unitWrap.appendChild(h("div", "pult-sheet-label", "Единица / цель"));
    const unitRow = h("div", "pult-inline-add");
    this.unitInput = unitRow.createEl("input", { type: "text", placeholder: "л, раз, км…", cls: "pult-big-input" });
    this.targetInput = unitRow.createEl("input", { type: "number", min: "1", placeholder: "цель", cls: "pult-big-input" });
    this.unitWrap.appendChild(unitRow);
    this.unitWrap.style.display = "none";
    bindKeyboardAvoidance(this.unitInput);
    bindKeyboardAvoidance(this.targetInput);

    contentEl.appendChild(h("div", "pult-sheet-label", "Значок"));
    const iconRow = h("div", "pult-chip-row");
    for (const ic of HABIT_ICONS) {
      this.chip(iconRow, ic, (b) => {
        this.icon = ic;
        iconRow.querySelectorAll(".pult-chip").forEach((x) => x.removeClass("is-on"));
        b.addClass("is-on");
      }, ic === this.icon);
    }
    contentEl.appendChild(iconRow);
    contentEl.appendChild(h("div", "pult-sheet-label", "Цвет отметок"));
    const colorRow = h("div", "pult-chip-row");
    for (const c of LIST_COLORS) {
      const b = h("button", "pult-chip pult-swatch c-" + c + (c === this.color ? " is-on" : ""));
      b.addEventListener("click", () => {
        this.color = c;
        colorRow.querySelectorAll(".pult-chip").forEach((x) => x.removeClass("is-on"));
        b.addClass("is-on");
      });
      colorRow.appendChild(b);
    }
    contentEl.appendChild(colorRow);
    const btns = this.btnRow();
    btns.createEl("button", { text: "Отмена", cls: "pult-btn" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Создать", cls: "pult-btn is-primary" }).addEventListener("click", () => {
      const name = (this.input.value || "").trim();
      if (!name) {
        this.input.addClass("pult-invalid");
        window.setTimeout(() => this.input.removeClass("pult-invalid"), 450);
        return;
      }
      this.onOk(name, this.icon, this.color, this.habitType, this.unitInput.value.trim(), this.targetInput.value);
      this.close();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.contentEl.querySelector(".is-primary").click();
    });
    this.input.focus();
  }
}

class HabitValueSheet extends Sheet {
  constructor(app, habit, day, current, onOk) {
    super(app);
    this.habit = habit;
    this.day = day;
    this.current = current;
    this.onOk = onOk;
  }
  onOpen() {
    super.onOpen();
    this.titleEl.setText(this.habit.name);
    const { contentEl } = this;
    contentEl.appendChild(h("div", "pult-sheet-hint", window.moment(this.day).format("D MMMM YYYY")));
    this.input = contentEl.createEl("input", {
      type: "number",
      min: "0",
      step: "any",
      cls: "pult-big-input",
      value: this.current != null ? String(this.current) : "",
    });
    bindKeyboardAvoidance(this.input);
    const btns = this.btnRow();
    btns.createEl("button", { text: "Отмена", cls: "pult-btn" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Сохранить", cls: "pult-btn is-primary" }).addEventListener("click", () => {
      const n = parseFloat(this.input.value);
      this.onOk(Number.isFinite(n) ? n : 0);
      this.close();
    });
    if (this.current != null) {
      btns.createEl("button", { text: "Сбросить", cls: "pult-btn is-danger" }).addEventListener("click", () => {
        this.onOk(null);
        this.close();
      });
    }
    this.input.focus();
  }
}

/* ================================================================
 * Плагин
 * ================================================================ */

class PultPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Состояние интерфейса — в памяти плагина.
    this.expanded = new Set();
    this.viewMode = "home"; // навигация экранами
    this.listFilter = null; // null | "tag:<имя>"
    this.sortModes = {
      today: "manual",
      week: "manual",
      inbox: "manual",
      all: "manual",
      lists: "manual",
      calendar: "manual",
    };
    this.sortModeOn = false; // режим «изменить порядок» (стрелки)
    this.weekCursor = window.moment().startOf("isoWeek");
    this.weekCollapsed = new Set();
    this.calCursor = window.moment().startOf("month");
    this.calSelected = todayStr();
    this.calExpanded = false;
    this.calWeekCursor = window.moment().startOf("isoWeek");
    this.statsDay = todayStr();
    this.statsCursor = window.moment().startOf("month");
    this.habitsTab = "list";
    this.timer = null;
    this.dragPath = null;
    this.dragSortPath = null;

    this.registerView(VIEW_TYPE, (leaf) => new PultView(leaf, this));
    this.addRibbonIcon("check-check", "Pult — задачи", () => this.activateView());

    this.addCommand({ id: "open-pult", name: "Открыть панель", callback: () => this.activateView() });
    this.addCommand({ id: "quick-task", name: "Создать задачу", callback: () => this.openQuickAdd() });
    this.addCommand({
      id: "stop-timer",
      name: "Остановить таймер",
      checkCallback: (checking) => {
        if (!this.timer) return false;
        if (!checking) this.stopTimer();
        return true;
      },
    });

    this.addSettingTab(new PultSettingTab(this.app, this));

    const refresh = this.debounce(() => this.refreshView(), DEBOUNCE_MS);
    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultEvent(f, null, refresh)));
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultEvent(f, null, refresh)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultEvent(f, null, refresh)));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => this.onVaultEvent(f, oldPath, refresh)));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => this.onVaultEvent(f, null, refresh)));

    this.registerInterval(window.setInterval(() => this.tickTimer(), 1000));
  }

  async loadSettings() {
    this.settings = Object.assign({ folder: DEFAULT_FOLDER }, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  folderPath() {
    const f = String(this.settings.folder || DEFAULT_FOLDER).trim().replace(/^\/+|\/+$/g, "");
    return f || DEFAULT_FOLDER;
  }

  openQuickAdd(opts) {
    const preset = Object.assign({}, opts || {});
    const f = this.listFilter;
    if (this.viewMode === "lists" && f && f.startsWith("tag:") && !preset.tags) {
      preset.tags = [f.slice(4)];
    }
    if (this.viewMode === "today" && !preset.date) preset.date = todayStr();
    new QuickAddSheet(this.app, preset, async (r) => {
      await this.createTask(r.name, null, r.date, r.tags, r.priority);
    }).open();
  }

  /* ---------------- события ---------------- */

  inFolder(path) {
    const folder = this.folderPath();
    return path === folder || path.startsWith(folder + "/");
  }

  onVaultEvent(file, oldPath, refresh) {
    const path = file && file.path ? file.path : "";
    const isMd = (p) => p.endsWith(".md");
    const touched =
      (isMd(path) && this.inFolder(path)) ||
      (oldPath != null && isMd(oldPath) && this.inFolder(oldPath));
    if (!touched) return;

    if (oldPath && oldPath !== path) {
      if (this.expanded.has(oldPath)) {
        this.expanded.delete(oldPath);
        if (isMd(path)) this.expanded.add(path);
      }
      if (this.timer && this.timer.path === oldPath) this.timer.path = path;
      if (isMd(path)) {
        const oldName = oldPath.split("/").pop().replace(/\.md$/, "");
        this.relinkChildren(oldName, file.basename);
      }
    }
    if (this.timer && !this.app.vault.getAbstractFileByPath(this.timer.path)) {
      this.timer = null;
    }
    refresh();
  }

  debounce(fn, ms) {
    let t = null;
    this.register(() => {
      if (t) window.clearTimeout(t);
    });
    return (...args) => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => fn(...args), ms);
    };
  }

  getView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    return leaves.length ? leaves[0].view : null;
  }

  refreshView() {
    const v = this.getView();
    if (v) v.render();
  }

  tickTimer() {
    const v = this.getView();
    if (v) v.updateTimerLabel(this.timer);
  }

  /** Панель открывается в ПРАВОМ сайдбаре Obsidian */
  async activateView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    ws.revealLeaf(leaf);
  }

  /* ---------------- файлы ---------------- */

  async ensureFolder() {
    const path = this.folderPath();
    if (!this.app.vault.getAbstractFileByPath(path)) {
      try {
        await this.app.vault.createFolder(path);
      } catch (e) {
        console.error("Pult: не удалось создать папку", e);
        new Notice("Pult: не удалось создать папку " + path);
      }
    }
  }

  sanitizeName(raw) {
    let s = String(raw || "")
      .replace(/[\\/:*?"<>|#^\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!s) s = "задача";
    return s.length > 80 ? s.slice(0, 80).trim() : s;
  }

  uniquePath(name) {
    const folder = this.folderPath();
    let candidate = name;
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(folder + "/" + candidate + ".md")) {
      candidate = name + " " + i++;
    }
    return folder + "/" + candidate + ".md";
  }

  nextOrder(tasks) {
    let max = 0;
    for (const t of tasks) if (t.order > max) max = t.order;
    return max + 1;
  }

  async createTask(title, parentName, scheduled, tags, priority) {
    await this.ensureFolder();
    const path = this.uniquePath(this.sanitizeName(title));
    const file = await this.app.vault.create(path, "");
    const view = this.getView();
    const order = this.nextOrder(view ? view.collect().tasks : []);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.type = "pult_task";
      fm.status = STATUS.INBOX;
      fm.priority = priority || "medium";
      fm.created = todayStr();
      fm.order = order;
      if (parentName) fm.parent = "[[" + parentName + "]]";
      if (scheduled) fm.scheduled = scheduled;
      if (tags && tags.length) fm.tags = tags;
    });
    return file;
  }

  async createList(name, icon, color) {
    await this.ensureFolder();
    const path = this.uniquePath(this.sanitizeName(name));
    const file = await this.app.vault.create(path, "# " + this.sanitizeName(name) + "\n");
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.type = "pult_list";
      fm.icon = icon;
      fm.color = color;
      fm.created = todayStr();
    });
    return file;
  }

  async createHabit(name, icon, color, habitType, unit, target) {
    await this.ensureFolder();
    const path = this.uniquePath(this.sanitizeName(name));
    const body = "# " + this.sanitizeName(name) + "\n\nПривычка Pult. Отмечай дни на экране «Привычки».\n";
    const file = await this.app.vault.create(path, body);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.type = "pult_habit";
      fm.icon = icon;
      fm.color = color;
      fm.created = todayStr();
      fm.habitType = habitType || "check";
      if (habitType === "numeric") {
        fm.values = {};
        if (unit) fm.unit = unit;
        const t = parseFloat(target);
        if (Number.isFinite(t) && t > 0) fm.target = t;
      } else {
        fm.done = [];
      }
    });
    return file;
  }

  async patchFrontMatter(file, patcher) {
    try {
      await this.app.fileManager.processFrontMatter(file, patcher);
    } catch (e) {
      console.error("Pult: ошибка записи frontmatter", e);
      new Notice("Pult: не удалось сохранить «" + file.basename + "»");
    }
  }

  async setStatus(file, status) {
    await this.patchFrontMatter(file, (fm) => {
      fm.status = status;
      if (status === STATUS.DONE) fm.completed = todayStr();
      else delete fm.completed;
    });
    if (status === STATUS.DONE && this.timer && this.timer.path === file.path) {
      await this.stopTimer(true);
    }
  }

  async setScheduled(file, dateStr) {
    await this.patchFrontMatter(file, (fm) => {
      if (dateStr) fm.scheduled = dateStr;
      else delete fm.scheduled;
    });
  }

  async setPriority(file, p) {
    await this.patchFrontMatter(file, (fm) => {
      fm.priority = p;
    });
  }

  async setKanbanStatus(file, status) {
    await this.patchFrontMatter(file, (fm) => {
      if (status) fm.kanbanStatus = status;
      else delete fm.kanbanStatus;
    });
  }

  async setParent(file, parentName) {
    await this.patchFrontMatter(file, (fm) => {
      if (parentName) fm.parent = "[[" + parentName + "]]";
      else delete fm.parent;
    });
  }

  async relinkChildren(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    const folder = this.folderPath();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.parent && f.parent.path === folder);
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = (cache && cache.frontmatter) || {};
      if (fm.type === "pult_task" && parseLink(fm.parent) === oldName) {
        await this.patchFrontMatter(file, (f) => {
          f.parent = "[[" + newName + "]]";
        });
      }
    }
  }

  /* ---------------- таймер ---------------- */

  async startTimer(file) {
    if (this.timer && this.timer.path === file.path) {
      await this.stopTimer();
      return;
    }
    if (this.timer) await this.stopTimer(true);
    this.timer = {
      path: file.path,
      startedAt: window.moment().format("YYYY-MM-DDTHH:mm:ss"),
    };
    new Notice("Таймер запущен: " + file.basename);
    this.refreshView();
  }

  async stopTimer(silent) {
    if (!this.timer) return;
    const { path, startedAt } = this.timer;
    this.timer = null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const entry = {
        start: window.moment(startedAt, "YYYY-MM-DDTHH:mm:ss").format("YYYY-MM-DDTHH:mm"),
        end: window.moment().format("YYYY-MM-DDTHH:mm"),
      };
      await this.patchFrontMatter(file, (fm) => {
        if (!Array.isArray(fm.timeEntries)) fm.timeEntries = [];
        fm.timeEntries.push(entry);
      });
    }
    if (!silent) new Notice("Таймер остановлен");
    this.refreshView();
  }
}

/* ================================================================
 * Панель (правый сайдбар)
 * ================================================================ */

class PultView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.timerRefs = new Map();
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Pult";
  }
  getIcon() {
    return "check-check";
  }
  async onOpen() {
    this.render();
  }
  async onClose() {
    this.contentEl.empty();
  }

  /* ---------------- данные ---------------- */

  collect() {
    const folder = this.plugin.folderPath();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.parent && f.parent.path === folder);

    const tasks = [];
    const lists = [];
    const habits = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = (cache && cache.frontmatter) || {};
      if (fm.type === "pult_task") {
        tasks.push({
          file,
          name: file.basename,
          status: fm.status || STATUS.INBOX,
          parent: parseLink(fm.parent),
          scheduled: toDayStr(fm.scheduled),
          due: toDayStr(fm.due),
          priority: fm.priority || "medium",
          tags: parseTags(fm.tags),
          timeEntries: Array.isArray(fm.timeEntries) ? fm.timeEntries : [],
          completed: toDayStr(fm.completed),
          order: toOrder(fm.order),
          duration: parseInt(fm.duration, 10) || 0,
          kanbanStatus: fm.kanbanStatus || null,
        });
      } else if (fm.type === "pult_list") {
        lists.push({
          file,
          name: file.basename,
          icon: String(fm.icon || "📋"),
          color: LIST_COLORS.includes(fm.color) ? fm.color : "mint",
        });
      } else if (fm.type === "pult_habit") {
        habits.push({
          file,
          name: file.basename,
          icon: String(fm.icon || "⭐"),
          color: LIST_COLORS.includes(fm.color) ? fm.color : "mint",
          habitType: fm.habitType === "numeric" ? "numeric" : "check",
          unit: String(fm.unit || ""),
          target: parseFloat(fm.target) || 0,
          done: Array.isArray(fm.done) ? fm.done.map(toDayStr).filter(Boolean) : [],
          values: parseHabitValues(fm),
        });
      }
    }

    const byParent = new Map();
    for (const t of tasks) {
      if (!t.parent) continue;
      if (!byParent.has(t.parent)) byParent.set(t.parent, []);
      byParent.get(t.parent).push(t);
    }
    return { tasks, lists, habits, byParent };
  }

  childrenOf(name, byParent) {
    return (byParent.get(name) || [])
      .slice()
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ru"));
  }

  progressOf(task, byParent, visited) {
    visited = visited || new Set();
    if (visited.has(task.name)) return { done: 0, total: 0 };
    visited.add(task.name);
    let done = 0;
    let total = 0;
    for (const child of this.childrenOf(task.name, byParent)) {
      total += 1;
      if (child.status === STATUS.DONE) done += 1;
      const sub = this.progressOf(child, byParent, visited);
      done += sub.done;
      total += sub.total;
    }
    return { done, total };
  }

  totalMs(task) {
    let ms = 0;
    for (const e of task.timeEntries) {
      const s = window.moment(e && e.start);
      const en = window.moment(e && e.end);
      if (s.isValid() && en.isValid() && en.isAfter(s)) ms += en.diff(s);
    }
    const t = this.plugin.timer;
    if (t && t.path === task.file.path) {
      const s = window.moment(t.startedAt, "YYYY-MM-DDTHH:mm:ss");
      if (s.isValid()) ms += Math.max(0, Date.now() - s.valueOf());
    }
    return ms;
  }

  /** manual уважает order; остальные — правило + закрытые вниз */
  sortedFor(list, mode) {
    const sortFn =
      mode === "alpha"
        ? (a, b) => a.name.localeCompare(b.name, "ru")
        : mode === "priority"
        ? (a, b) =>
            (PRIORITY_RANK[a.priority] || 1) - (PRIORITY_RANK[b.priority] || 1) ||
            a.name.localeCompare(b.name, "ru")
        : mode === "date"
        ? (a, b) => {
            const ad = a.scheduled || a.due || "9999-99-99";
            const bd = b.scheduled || b.due || "9999-99-99";
            return ad < bd ? -1 : ad > bd ? 1 : a.name.localeCompare(b.name, "ru");
          }
        : (a, b) => a.order - b.order || a.name.localeCompare(b.name, "ru");

    if (mode === "manual") return list.slice().sort(sortFn);
    const open = list.filter((t) => t.status !== STATUS.DONE).sort(sortFn);
    const closed = list.filter((t) => t.status === STATUS.DONE).sort(sortFn);
    return open.concat(closed);
  }

  async moveTask(sectionList, task, dir) {
    const items = this.sortedFor(sectionList, "manual");
    const i = items.findIndex((t) => t.file.path === task.file.path);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
    for (let k = 0; k < items.length; k++) {
      if (items[k].order !== k + 1) {
        const file = items[k].file;
        const order = k + 1;
        await this.plugin.patchFrontMatter(file, (fm) => {
          fm.order = order;
        });
      }
    }
  }

  openFile(file) {
    const leaf = this.app.workspace.getLeaf(false);
    if (leaf) leaf.openFile(file);
  }

  goBack() {
    const p = this.plugin;
    if (p.viewMode === "lists" && p.listFilter) p.listFilter = null;
    else p.viewMode = "home";
    this.render();
  }

  /* ---------------- каркас ---------------- */

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("pult-root");
    this.timerRefs.clear();

    const data = this.collect();
    root.appendChild(this.header(data));

    const body = h("div", "pult-body");
    switch (this.plugin.viewMode) {
      case "today":
        this.renderToday(body, data);
        break;
      case "week":
        this.renderWeek(body, data);
        break;
      case "inbox":
        this.renderInbox(body, data);
        break;
      case "all":
        this.renderAll(body, data);
        break;
      case "lists":
        this.renderLists(body, data);
        break;
      case "calendar":
        this.renderCalendar(body, data);
        break;
      case "stats":
        this.renderStats(body, data);
        break;
      case "habits":
        this.renderHabits(body, data);
        break;
      case "timeline":
        this.renderTimeline(body, data);
        break;
      default:
        this.renderHome(body, data);
    }
    root.appendChild(body);
  }

  header(data) {
    const p = this.plugin;
    const mode = p.viewMode;
    const head = h("div", "pult-head");

    if (mode !== "home") {
      const back = h("button", "pult-icon-btn");
      back.innerHTML = svgIcon("back", 18);
      back.setAttribute("aria-label", "Назад");
      back.addEventListener("click", () => this.goBack());
      head.appendChild(back);
    } else {
      const logo = h("div", "pult-logo");
      logo.appendChild(h("span", "pult-logo-dot"));
      head.appendChild(logo);
    }

    const titleWrap = h("div", "pult-head-title-wrap");
    let title = VIEW_TITLES[mode] || "Pult";
    if (mode === "lists" && p.listFilter) title = p.listFilter.slice(4);
    titleWrap.appendChild(h("div", "pult-head-title", title));

    const open = data.tasks.filter((t) => t.status !== STATUS.DONE);
    const today = todayStr();
    let sub = "";
    if (mode === "home") {
      const overdue = open.filter((t) => t.scheduled && t.scheduled < today).length;
      sub = cap(window.moment().format("dddd, D MMMM")) + " · открытых: " + open.length +
        (overdue ? " · просрочено: " + overdue : "");
    } else if (mode === "today") {
      const due = open.filter((t) => t.scheduled === today).length;
      sub = "на сегодня: " + due;
    } else if (mode === "week") {
      const wom = weekOfMonth(p.weekCursor);
      const wim = weeksInMonth(p.weekCursor);
      sub = p.weekCursor.format("D MMM") + " — " + p.weekCursor.clone().add(6, "days").format("D MMM") +
        " · нед. " + wom + "/" + wim;
    } else if (mode === "inbox") {
      sub = "без списков и родителя: " + open.filter((t) => !t.tags.length && !t.parent).length;
    } else if (mode === "all") {
      sub = "открытых: " + open.length;
    } else if (mode === "lists") {
      sub = p.listFilter ? "список-тег" : "мои списки: " + data.lists.length;
    } else if (mode === "calendar") {
      sub = cap(p.calCursor.format("MMMM YYYY"));
    } else if (mode === "habits") {
      sub = "привычек: " + data.habits.length;
    } else if (mode === "stats") {
      sub = cap(window.moment(p.statsDay).format("D MMMM YYYY"));
    } else if (mode === "timeline") {
      sub = cap(p.calCursor.format("MMMM YYYY")) + " · диаграмма Ганта";
    }
    titleWrap.appendChild(h("div", "pult-head-sub", sub));
    head.appendChild(titleWrap);

    // Кнопки справа — зависят от экрана
    const isTaskScreen = ["today", "week", "inbox", "all"].includes(mode) || (mode === "lists" && !!p.listFilter);

    if (isTaskScreen || mode === "calendar") {
      const add = h("button", "pult-icon-btn is-accent");
      add.innerHTML = svgIcon("plus", 17);
      add.title = "Новая задача";
      add.addEventListener("click", () => {
        this.plugin.openQuickAdd(mode === "calendar" ? { date: p.calSelected } : {});
      });
      head.appendChild(add);

      const sortBtn = h("button", "pult-icon-btn" + (p.sortModeOn ? " is-on" : ""));
      sortBtn.innerHTML = svgIcon("sort", 16);
      sortBtn.title = "Сортировка";
      sortBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = mode === "lists" ? "lists" : mode;
        const m = new Menu();
        for (const k of ["manual", "alpha", "priority", "date"]) {
          m.addItem((i) => {
            i.setTitle(SORT_LABEL[k]);
            if (p.sortModes[key] === k) i.setIcon("check");
            i.onClick(() => {
              p.sortModes[key] = k;
              this.render();
            });
          });
        }
        if (p.sortModes[key] === "manual") {
          m.addSeparator();
          m.addItem((i) =>
            i
              .setTitle(p.sortModeOn ? "Готово — скрыть стрелки" : "Изменить порядок")
              .onClick(() => {
                p.sortModeOn = !p.sortModeOn;
                this.render();
              })
          );
        }
        m.showAtMouseEvent(e);
      });
      head.appendChild(sortBtn);
    }

    if (mode === "lists" && !p.listFilter) {
      const add = h("button", "pult-icon-btn is-accent");
      add.innerHTML = svgIcon("plus", 17);
      add.title = "Новый список";
      add.addEventListener("click", () =>
        new ListModal(this.app, async (name, icon, color) => {
          await this.plugin.createList(name, icon, color);
          new Notice("Список создан. Добавляйте задачи через поле «Списки».");
        }).open()
      );
      head.appendChild(add);
    }

    if (mode === "home") {
      const gear = h("button", "pult-icon-btn");
      gear.innerHTML = svgIcon("gear", 17);
      gear.title = "Настройки Pult";
      gear.addEventListener("click", () => {
        this.app.setting.open();
        this.app.setting.openTabById("pult");
      });
      head.appendChild(gear);
    }

    return head;
  }

  /* ---------------- Домашний экран ---------------- */

  renderHome(body, data) {
    const today = todayStr();
    const open = data.tasks.filter((t) => t.status !== STATUS.DONE);
    const overdue = open.filter((t) => t.scheduled && t.scheduled < today).length;
    const dueToday = open.filter((t) => t.scheduled === today).length;
    const weekEnd = window.moment().add(7, "days").format("YYYY-MM-DD");
    const weekCount = open.filter((t) => t.scheduled && t.scheduled >= today && t.scheduled <= weekEnd).length;
    const inboxCount = open.filter((t) => !t.tags.length && !t.parent).length;
    const p = this.plugin;

    const rows = [
      {
        icon: "sun", cls: "c-mint", name: "Сегодня",
        sub: overdue ? "просрочено: " + overdue : "всё по плану",
        subRed: overdue > 0, count: dueToday, mode: "today",
      },
      {
        icon: "calendar-days", cls: "c-ice", name: "Неделя",
        sub: "ближайшие 7 дней, по дням", count: weekCount, mode: "week",
      },
      {
        icon: "inbox", cls: "c-amber", name: "Входящие",
        sub: "без списков", count: inboxCount, mode: "inbox",
      },
      {
        icon: "list", cls: "c-neutral", name: "Все задачи",
        sub: "весь хранимый пул", count: open.length, mode: "all",
      },
      {
        icon: "tag", cls: "c-coral", name: "Списки",
        sub: data.lists.length ? "мои списки" : "создайте первый список", count: data.lists.length, mode: "lists",
      },
      {
        icon: "calendar", cls: "c-ice", name: "Календарь",
        sub: "месяц и перенос дат", count: null, mode: "calendar",
      },
      {
        icon: "chart", cls: "c-mint", name: "Статистика",
        sub: "время за день и неделю", count: null, mode: "stats",
      },
      {
        icon: "flame", cls: "c-amber", name: "Привычки",
        sub: data.habits.length ? "серии, числа, статистика" : "добавьте первую", count: data.habits.length, mode: "habits",
      },
      {
        icon: "chart", cls: "c-ice", name: "Таймлайн",
        sub: "длительность задач по дням", count: null, mode: "timeline",
      },
    ];

    const home = h("div", "pult-home");
    for (const r of rows) {
      const row = h("button", "pult-home-row");
      const ico = h("span", "pult-home-ico " + r.cls);
      ico.innerHTML = svgIcon(r.icon, 19);
      row.appendChild(ico);
      const info = h("span", "pult-home-info");
      info.appendChild(h("span", "pult-home-name", r.name));
      info.appendChild(h("span", "pult-home-sub" + (r.subRed ? " is-red" : ""), r.sub));
      row.appendChild(info);
      if (r.count != null) row.appendChild(h("span", "pult-home-count", String(r.count)));
      const go = h("span", "pult-home-go");
      go.innerHTML = svgIcon("next", 15);
      row.appendChild(go);
      row.addEventListener("click", () => {
        p.viewMode = r.mode;
        if (r.mode === "lists") p.listFilter = null;
        this.render();
      });
      home.appendChild(row);
    }
    body.appendChild(home);
  }

  /* ---------------- секции и строки ---------------- */

  section(title, list, data, opts) {
    opts = opts || {};
    const mode = this.plugin.viewMode;
    const key = mode === "lists" ? "lists" : mode;
    const sorted = this.sortedFor(list, this.plugin.sortModes[key] || "manual");
    const sec = h("div", "pult-section");

    const head = h("div", "pult-section-head " + (opts.cls || ""));
    if (opts.collapsible) {
      const caret = h("button", "pult-caret" + (opts.open ? " is-open" : ""));
      caret.innerHTML = svgIcon("caret", 14);
      caret.addEventListener("click", () => opts.onToggle());
      head.appendChild(caret);
    }
    head.appendChild(h("span", "pult-section-title", title));
    head.appendChild(h("span", "pult-section-count", String(list.length)));
    if (opts.right) head.appendChild(opts.right);
    sec.appendChild(head);

    if (opts.collapsible && !opts.open) return sec;

    const listWrap = h("div", "pult-sort-list");
    for (const t of sorted) {
      listWrap.appendChild(this.renderRow(t, data, { sectionList: list, depth: 0, showParent: opts.showParent }));
    }
    if (!sorted.length && opts.emptyText) {
      listWrap.appendChild(h("div", "pult-empty", opts.emptyText));
    }
    if ((this.plugin.sortModes[key] || "manual") === "manual" && sorted.length > 1) {
      this.attachDragSort(listWrap, list);
    }
    sec.appendChild(listWrap);
    return sec;
  }

  renderRow(task, data, opts) {
    opts = opts || {};
    const byParent = data.byParent;
    const done = task.status === STATUS.DONE;
    const kids = this.childrenOf(task.name, byParent);
    const hasKids = kids.length > 0;
    const isOpen = this.plugin.expanded.has(task.file.path);
    const running = !!(this.plugin.timer && this.plugin.timer.path === task.file.path);
    const sortModeOn = this.plugin.sortModeOn && opts.sectionList;
    const mode = this.plugin.viewMode;
    const sortKey = mode === "lists" ? "lists" : mode;
    const canDrag = opts.sectionList && (this.plugin.sortModes[sortKey] || "manual") === "manual";

    const wrap = h("div", "pult-item" + (done ? " is-done" : ""));
    wrap.dataset.path = task.file.path;
    const row = h("div", "pult-row" + (running ? " is-running" : ""));

    if (canDrag) {
      const handle = h("span", "pult-drag-handle", "⋮⋮");
      handle.title = "Перетащить";
      row.appendChild(handle);
    } else if (sortModeOn) {
      const mv = h("span", "pult-move");
      const up = h("button", "pult-move-btn");
      up.innerHTML = svgIcon("up", 14);
      up.addEventListener("click", (e) => {
        e.stopPropagation();
        this.moveTask(opts.sectionList, task, -1);
      });
      const down = h("button", "pult-move-btn");
      down.innerHTML = svgIcon("down", 14);
      down.addEventListener("click", (e) => {
        e.stopPropagation();
        this.moveTask(opts.sectionList, task, 1);
      });
      mv.appendChild(up);
      mv.appendChild(down);
      row.appendChild(mv);
    }

    const check = h("button", "pult-check" + (done ? " is-done" : ""));
    check.innerHTML = svgIcon("check", 12);
    check.setAttribute("aria-label", done ? "Вернуть в работу" : "Выполнено");
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.setStatus(task.file, done ? STATUS.ACTIVE : STATUS.DONE);
    });
    row.appendChild(check);

    if (hasKids) {
      const caret = h("button", "pult-caret" + (isOpen ? " is-open" : ""));
      caret.innerHTML = svgIcon("caret", 14);
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isOpen) this.plugin.expanded.delete(task.file.path);
        else this.plugin.expanded.add(task.file.path);
        this.render();
      });
      row.appendChild(caret);
    } else {
      row.appendChild(h("span", "pult-caret-spacer"));
    }

    const content = h("div", "pult-row-content");
    const titleRow = h("div", "pult-title-row");
    const prio = h("span", "pult-prio p-" + task.priority);
    prio.title = "Приоритет: " + (PRIORITY_LABEL[task.priority] || task.priority);
    titleRow.appendChild(prio);
    const title = h("button", "pult-title", task.name);
    title.addEventListener("click", () => this.openFile(task.file));
    titleRow.appendChild(title);
    content.appendChild(titleRow);

    const meta = h("div", "pult-meta");
    if (opts.showParent && task.parent) meta.appendChild(h("span", "pult-chip-mini", "↳ " + task.parent));
    for (const tag of task.tags.slice(0, 2)) {
      meta.appendChild(h("span", "pult-chip-mini is-tag", "#" + tag));
    }
    if (hasKids) {
      const p = this.progressOf(task, byParent);
      const prog = h("span", "pult-progress");
      const track = h("span", "pult-progress-track");
      const fill = h("span", "pult-progress-fill");
      fill.style.width = (p.total ? Math.round((p.done / p.total) * 100) : 0) + "%";
      track.appendChild(fill);
      prog.appendChild(track);
      prog.appendChild(h("span", "pult-progress-num", p.done + "/" + p.total));
      meta.appendChild(prog);
    }
    const ms = this.totalMs(task);
    if (ms > 0 || running) {
      const time = h("span", "pult-time" + (running ? " is-running" : ""), (running ? "⏱ " : "") + fmtDuration(ms));
      if (running) this.timerRefs.set(task.file.path, time);
      meta.appendChild(time);
    }
    const d = task.scheduled || task.due;
    if (d) {
      const overdue = !done && !!task.scheduled && task.scheduled < todayStr();
      let text = fmtDate(d);
      if (task.duration > 1) text += " · " + task.duration + "д";
      if (overdue) {
        const days = window.moment(todayStr()).diff(window.moment(task.scheduled), "days");
        text += " · " + days + "д";
      }
      meta.appendChild(
        h(
          "span",
          "pult-chip-mini" + (overdue ? " is-overdue" : "") + (!task.scheduled && task.due ? " is-due" : ""),
          text
        )
      );
    }
    if (meta.children.length) content.appendChild(meta);
    row.appendChild(content);

    const timer = h("button", "pult-act" + (running ? " is-running" : ""));
    timer.innerHTML = svgIcon("timer", 16);
    timer.title = running ? "Остановить таймер" : "Таймер";
    timer.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.startTimer(task.file);
    });
    row.appendChild(timer);

    const dots = h("button", "pult-act");
    dots.innerHTML = svgIcon("dots", 16);
    dots.title = "Действия";
    dots.addEventListener("click", (e) => {
      e.stopPropagation();
      new TaskSheet(this.app, this, task, data).open();
    });
    row.appendChild(dots);

    wrap.appendChild(row);

    if (hasKids && isOpen) {
      const kidsWrap = h("div", "pult-kids");
      for (const k of kids) {
        kidsWrap.appendChild(
          this.renderRow(k, data, { sectionList: null, depth: (opts.depth || 0) + 1, showParent: false })
        );
      }
      kidsWrap.appendChild(this.subAddRow(task));
      wrap.appendChild(kidsWrap);
    }

    return wrap;
  }

  subAddRow(parentTask) {
    const row = h("div", "pult-add-row");
    row.appendChild(h("span", "pult-add-plus", "+"));
    const input = h("input", "pult-add-input");
    input.type = "text";
    input.placeholder = "Подзадача…";
    bindKeyboardAvoidance(input);
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        const value = input.value.trim();
        input.value = "";
        this.plugin.expanded.add(parentTask.file.path);
        await this.plugin.createTask(value, parentTask.name, null, parentTask.tags);
      } else if (e.key === "Escape") {
        input.value = "";
        input.blur();
      }
    });
    row.appendChild(input);
    return row;
  }

  async reorderTasks(sectionList, fromPath, toPath) {
    if (!fromPath || !toPath || fromPath === toPath) return;
    const items = this.sortedFor(sectionList, "manual");
    const fromI = items.findIndex((t) => t.file.path === fromPath);
    const toI = items.findIndex((t) => t.file.path === toPath);
    if (fromI < 0 || toI < 0) return;
    const [moved] = items.splice(fromI, 1);
    items.splice(toI, 0, moved);
    for (let k = 0; k < items.length; k++) {
      const order = k + 1;
      if (items[k].order !== order) {
        await this.plugin.patchFrontMatter(items[k].file, (fm) => {
          fm.order = order;
        });
      }
    }
  }

  attachDragSort(container, sectionList) {
    let dragPath = null;
    let touchPath = null;
    let touchY = 0;

    const clearOver = () => container.querySelectorAll(".is-drag-over").forEach((x) => x.removeClass("is-drag-over"));

    container.querySelectorAll(".pult-item").forEach((item) => {
      const path = item.dataset.path;
      const handle = item.querySelector(".pult-drag-handle");
      if (!path) return;

      item.draggable = !!handle;
      if (handle) {
        handle.addEventListener("mousedown", (e) => e.stopPropagation());
        handle.addEventListener("touchstart", (e) => {
          touchPath = path;
          touchY = e.touches[0].clientY;
          item.addClass("is-dragging");
        }, { passive: true });
      }

      item.addEventListener("dragstart", (e) => {
        dragPath = path;
        item.addClass("is-dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      item.addEventListener("dragend", () => {
        dragPath = null;
        item.removeClass("is-dragging");
        clearOver();
      });
      item.addEventListener("dragover", (e) => {
        if (!dragPath || dragPath === path) return;
        e.preventDefault();
        clearOver();
        item.addClass("is-drag-over");
      });
      item.addEventListener("drop", async (e) => {
        e.preventDefault();
        clearOver();
        if (dragPath && dragPath !== path) await this.reorderTasks(sectionList, dragPath, path);
        dragPath = null;
      });
    });

    container.addEventListener("touchmove", (e) => {
      if (!touchPath) return;
      const y = e.touches[0].clientY;
      const el = document.elementFromPoint(e.touches[0].clientX, y);
      const target = el && el.closest(".pult-item");
      clearOver();
      if (target && target.dataset.path && target.dataset.path !== touchPath) target.addClass("is-drag-over");
      touchY = y;
    }, { passive: true });

    container.addEventListener("touchend", async () => {
      if (!touchPath) return;
      const over = container.querySelector(".pult-item.is-drag-over");
      container.querySelectorAll(".is-dragging").forEach((x) => x.removeClass("is-dragging"));
      if (over && over.dataset.path) await this.reorderTasks(sectionList, touchPath, over.dataset.path);
      touchPath = null;
      clearOver();
    });
  }

  confirmDelete(task, byParent) {
    const kids = byParent.get(task.name) || [];
    if (kids.length) {
      new Notice("Pult: у задачи " + kids.length + " подзадач(и). Сначала удалите или перенесите их.");
      return;
    }
    new ConfirmModal(this.app, "Удалить задачу «" + task.name + "»? Файл попадёт в корзину.", async () => {
      if (this.plugin.timer && this.plugin.timer.path === task.file.path) this.plugin.timer = null;
      await this.app.fileManager.trashFile(task.file);
    }).open();
  }

  /* ---------------- Сегодня ---------------- */

  renderToday(body, data) {
    const today = todayStr();
    const open = data.tasks.filter((t) => t.status !== STATUS.DONE);
    const overdue = open.filter((t) => t.scheduled && t.scheduled < today);
    const dueToday = open.filter((t) => t.scheduled === today);
    const next7 = open.filter((t) => {
      if (!t.scheduled) return false;
      return t.scheduled > today && t.scheduled <= window.moment().add(7, "days").format("YYYY-MM-DD");
    });

    if (overdue.length) body.appendChild(this.section("Просрочено", overdue, data, { cls: "is-red" }));
    body.appendChild(this.section("Сегодня", dueToday, data, { emptyText: "На сегодня всё чисто." }));
    body.appendChild(this.section("Ближайшие 7 дней", next7, data, { cls: "is-soft" }));

    if (!overdue.length && !dueToday.length && !next7.length) {
      const empty = h("div", "pult-empty is-big");
      empty.appendChild(h("div", "pult-empty-emoji", "🌤"));
      empty.appendChild(h("div", null, "Задач на сегодня нет."));
      empty.appendChild(h("div", "pult-empty-hint", "Нажмите «+» в шапке — задача сразу попадёт на сегодня."));
      body.appendChild(empty);
    }
  }

  /* ---------------- Неделя ---------------- */

  renderWeek(body, data) {
    const p = this.plugin;
    const today = todayStr();
    const week = p.weekCursor;

    const nav = h("div", "pult-week-nav");
    const prev = h("button", "pult-icon-btn");
    prev.innerHTML = svgIcon("back", 16);
    prev.addEventListener("click", () => {
      p.weekCursor = week.clone().subtract(7, "days");
      this.render();
    });
    const next = h("button", "pult-icon-btn");
    next.innerHTML = svgIcon("next", 16);
    next.addEventListener("click", () => {
      p.weekCursor = week.clone().add(7, "days");
      this.render();
    });
    nav.appendChild(prev);
    const wom = weekOfMonth(week);
    const wim = weeksInMonth(week);
    const labelWrap = h("span", "pult-week-label");
    labelWrap.appendChild(h("span", null, week.format("D MMM") + " — " + week.clone().add(6, "days").format("D MMM")));
    labelWrap.appendChild(h("span", "pult-week-of", " · нед. " + wom + " из " + wim));
    nav.appendChild(labelWrap);
    nav.appendChild(next);
    const toNow = h("button", "pult-chip", "К текущей");
    toNow.addEventListener("click", () => {
      p.weekCursor = window.moment().startOf("isoWeek");
      this.render();
    });
    nav.appendChild(toNow);
    body.appendChild(nav);

    let touchX = 0;
    body.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) touchX = e.touches[0].clientX;
    }, { passive: true });
    body.addEventListener("touchend", (e) => {
      if (!touchX || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) < 60) return;
      if (dx < 0) p.weekCursor = week.clone().add(7, "days");
      else p.weekCursor = week.clone().subtract(7, "days");
      touchX = 0;
      this.render();
    }, { passive: true });

    const overdue = data.tasks.filter((t) => t.status !== STATUS.DONE && t.scheduled && t.scheduled < today);
    if (overdue.length) body.appendChild(this.section("Просрочено", overdue, data, { cls: "is-red" }));

    for (let i = 0; i < 7; i++) {
      const day = week.clone().add(i, "days");
      const ds = day.format("YYYY-MM-DD");
      const isToday = ds === today;
      const list = data.tasks.filter((t) => t.scheduled === ds && t.status !== STATUS.DONE);
      const doneList = data.tasks.filter((t) => t.scheduled === ds && t.status === STATUS.DONE);
      const collapsed = p.weekCollapsed.has(ds) && !isToday;
      const all = list.concat(doneList);

      const sec = h("div", "pult-day" + (isToday ? " is-today" : ""));
      const head = h("div", "pult-day-head");
      const caret = h("button", "pult-caret" + (collapsed ? "" : " is-open"));
      caret.innerHTML = svgIcon("caret", 14);
      caret.addEventListener("click", () => {
        if (p.weekCollapsed.has(ds)) p.weekCollapsed.delete(ds);
        else p.weekCollapsed.add(ds);
        this.render();
      });
      head.appendChild(caret);

      const dayName = h("div", "pult-day-name");
      dayName.appendChild(h("span", "pult-day-wd", cap(day.format("dd"))));
      dayName.appendChild(h("span", "pult-day-num" + (isToday ? " is-today" : ""), String(day.date())));
      head.appendChild(dayName);
      head.appendChild(h("span", "pult-section-count", String(all.length)));

      const addBtn = h("button", "pult-icon-btn is-accent");
      addBtn.innerHTML = svgIcon("plus", 15);
      addBtn.title = "Задача на этот день";
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.openQuickAdd({ date: ds });
      });
      head.appendChild(addBtn);
      sec.appendChild(head);

      if (!collapsed) {
        const rowsWrap = h("div", "pult-day-rows pult-sort-list");
        const sorted = this.sortedFor(all, p.sortModes.week || "manual");
        for (const t of sorted) rowsWrap.appendChild(this.renderRow(t, data, { sectionList: all }));
        if (!all.length) rowsWrap.appendChild(h("div", "pult-empty", "Нет задач."));
        if (sorted.length > 1 && (p.sortModes.week || "manual") === "manual") this.attachDragSort(rowsWrap, all);
        sec.appendChild(rowsWrap);
      }

      // Перенос дат перетаскиванием из календаря (десктоп)
      sec.addEventListener("dragover", (e) => {
        if (!this.plugin.dragPath) return;
        e.preventDefault();
        sec.addClass("is-over");
      });
      sec.addEventListener("dragleave", (e) => {
        if (!sec.contains(e.relatedTarget)) sec.removeClass("is-over");
      });
      sec.addEventListener("drop", (e) => {
        sec.removeClass("is-over");
        const path = this.plugin.dragPath;
        this.plugin.dragPath = null;
        if (!path) return;
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) this.plugin.setScheduled(file, ds);
      });

      body.appendChild(sec);
    }
  }

  /* ---------------- Входящие / Все ---------------- */

  renderInbox(body, data) {
    const list = data.tasks.filter((t) => !t.parent && !t.tags.length);
    body.appendChild(this.section("Входящие", list, data, { emptyText: "Входящие пусты — отличная работа." }));
    body.appendChild(h("div", "pult-hint", "Сюда попадают задачи без списков и без родителя. Разложите их по спискам через «⋯» → «Списки»."));
  }

  renderAll(body, data) {
    const list = data.tasks.filter((t) => !t.parent);
    body.appendChild(this.section("Все задачи", list, data, { emptyText: "Пока пусто. Создайте первую через «+»." }));
  }

  /* ---------------- Списки ---------------- */

  renderLists(body, data) {
    const p = this.plugin;
    if (!p.listFilter) {
      this.renderListsIndex(body, data);
      return;
    }
    this.renderListFiltered(body, data);
  }

  renderListsIndex(body, data) {
    const known = new Map();
    for (const l of data.lists) known.set(l.name, l);
    const tagCount = new Map();
    for (const t of data.tasks) {
      for (const tag of t.tags) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
    }
    for (const tag of tagCount.keys()) {
      if (!known.has(tag)) known.set(tag, { name: tag, icon: "🏷", color: "mint", file: null });
    }

    if (!known.size) {
      const empty = h("div", "pult-empty is-big");
      empty.appendChild(h("div", "pult-empty-emoji", "🏷"));
      empty.appendChild(h("div", null, "Списков пока нет."));
      empty.appendChild(h("div", "pult-empty-hint", "Создайте список кнопкой «+» в шапке или просто укажите тег у задачи — список появится сам."));
      body.appendChild(empty);
      return;
    }

    const wrap = h("div", "pult-home");
    for (const l of [...known.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"))) {
      const count = data.tasks.filter((t) => t.status !== STATUS.DONE && t.tags.includes(l.name)).length;
      const row = h("button", "pult-home-row");
      row.appendChild(h("span", "pult-list-emoji " + "c-" + l.color, l.icon));
      const info = h("span", "pult-home-info");
      info.appendChild(h("span", "pult-home-name", l.name));
      info.appendChild(h("span", "pult-home-sub", l.file ? "список-файл" : "тег из задач"));
      row.appendChild(info);
      row.appendChild(h("span", "pult-home-count", String(count)));
      const go = h("span", "pult-home-go");
      go.innerHTML = svgIcon("next", 15);
      row.appendChild(go);
      row.addEventListener("click", () => {
        this.plugin.listFilter = "tag:" + l.name;
        this.render();
      });
      if (l.file) {
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const m = new Menu();
          m.addItem((i) => i.setTitle("Открыть файл").setIcon("file").onClick(() => this.openFile(l.file)));
          m.addItem((i) =>
            i.setTitle("Удалить список").setIcon("trash").onClick(() =>
              new ConfirmModal(this.app, "Удалить список «" + l.name + "»? Теги у задач останутся.", async () => {
                await this.app.fileManager.trashFile(l.file);
              }).open()
            )
          );
          m.showAtMouseEvent(e);
        });
      }
      wrap.appendChild(row);
    }
    body.appendChild(wrap);
    body.appendChild(
      h("div", "pult-hint", "Списки работают как теги: у задачи может быть несколько списков сразу (tags: [работа, дом]).")
    );
  }

  renderListFiltered(body, data) {
    const tag = this.plugin.listFilter.slice(4);
    const list = data.tasks.filter((t) => t.tags.includes(tag));
    body.appendChild(this.section("Задачи", list, data, { emptyText: "В этом списке пока пусто.", showParent: true }));
  }

  /* ---------------- Календарь ---------------- */

  renderCalendar(body, data) {
    const p = this.plugin;
    const today = todayStr();
    const selected = p.calSelected;

    const byDay = new Map();
    for (const t of data.tasks) {
      const d = t.scheduled || t.due;
      if (!d) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    }

    const nav = h("div", "pult-week-nav");
    const weekStart = p.calExpanded ? p.calCursor.clone().startOf("month").startOf("isoWeek") : p.calWeekCursor;
    const prev = h("button", "pult-icon-btn");
    prev.innerHTML = svgIcon("back", 16);
    prev.addEventListener("click", () => {
      if (p.calExpanded) p.calCursor = p.calCursor.clone().subtract(1, "month");
      else p.calWeekCursor = p.calWeekCursor.clone().subtract(7, "days");
      this.render();
    });
    const next = h("button", "pult-icon-btn");
    next.innerHTML = svgIcon("next", 16);
    next.addEventListener("click", () => {
      if (p.calExpanded) p.calCursor = p.calCursor.clone().add(1, "month");
      else p.calWeekCursor = p.calWeekCursor.clone().add(7, "days");
      this.render();
    });
    nav.appendChild(prev);
    const label = p.calExpanded
      ? cap(p.calCursor.format("MMMM YYYY"))
      : p.calWeekCursor.format("D MMM") + " — " + p.calWeekCursor.clone().add(6, "days").format("D MMM");
    nav.appendChild(h("span", "pult-week-label", label));
    nav.appendChild(next);
    body.appendChild(nav);

    const toggle = h("button", "pult-cal-toggle");
    toggle.innerHTML = svgIcon(p.calExpanded ? "up" : "down", 14) +
      "<span>" + (p.calExpanded ? "Свернуть до недели" : "Развернуть месяц") + "</span>";
    toggle.addEventListener("click", () => {
      p.calExpanded = !p.calExpanded;
      if (!p.calExpanded) p.calWeekCursor = window.moment(selected).startOf("isoWeek");
      this.render();
    });
    body.appendChild(toggle);

    if (!p.calExpanded) {
      const strip = h("div", "pult-cal-weekstrip");
      for (let i = 0; i < 7; i++) {
        const day = p.calWeekCursor.clone().add(i, "days");
        const ds = day.format("YYYY-MM-DD");
        const list = byDay.get(ds) || [];
        const btn = h(
          "button",
          "pult-cal-daybtn" +
            (ds === today ? " is-today" : "") +
            (ds === selected ? " is-selected" : "") +
            (day.month() !== p.calWeekCursor.month() ? " is-out" : "")
        );
        btn.appendChild(h("span", "pult-cal-daybtn-wd", cap(day.format("dd"))));
        btn.appendChild(h("span", "pult-cal-daybtn-num", String(day.date())));
        const dots = h("div", "pult-cal-daybtn-dots");
        for (const t of list.slice(0, 3)) {
          const overdue = t.status !== STATUS.DONE && t.scheduled && t.scheduled < today;
          dots.appendChild(
            h("span", "pult-cal-dot" + (t.status === STATUS.DONE ? " is-done" : "") + (overdue ? " is-overdue" : ""))
          );
        }
        btn.appendChild(dots);
        btn.addEventListener("click", () => {
          p.calSelected = ds;
          this.render();
        });
        strip.appendChild(btn);
      }
      body.appendChild(strip);
    } else {
      const grid = h("div", "pult-cal-grid pult-cal-month-mini");
      for (const wd of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) {
        grid.appendChild(h("div", "pult-cal-wd", wd));
      }
      const start = p.calCursor.clone().startOf("month").isoWeekday(1);
      for (let i = 0; i < 42; i++) {
        const day = start.clone().add(i, "days");
        const ds = day.format("YYYY-MM-DD");
        const inMonth = day.month() === p.calCursor.month();
        const list = byDay.get(ds) || [];
        const cell = h(
          "div",
          "pult-cal-cell" +
            (inMonth ? "" : " is-out") +
            (ds === today ? " is-today" : "") +
            (ds === selected ? " is-selected" : "")
        );
        cell.appendChild(h("span", "pult-cal-num", String(day.date())));
        const dots = h("div", "pult-cal-daybtn-dots");
        for (const t of list.slice(0, 3)) {
          dots.appendChild(h("span", "pult-cal-dot" + (t.status === STATUS.DONE ? " is-done" : "")));
        }
        if (list.length > 3) cell.appendChild(h("span", "pult-cal-more", "+" + (list.length - 3)));
        cell.appendChild(dots);
        cell.addEventListener("click", () => {
          p.calSelected = ds;
          p.calWeekCursor = day.clone().startOf("isoWeek");
          this.render();
        });
        grid.appendChild(cell);
      }
      body.appendChild(grid);
    }

    const dayList = (byDay.get(selected) || []).slice();
    const daySec = h("div", "pult-cal-selected-day");
    daySec.appendChild(
      this.section(cap(window.moment(selected).format("dddd, D MMMM")), dayList, data, {
        emptyText: "На этот день задач нет. «+» добавит задачу именно сюда.",
      })
    );
    body.appendChild(daySec);
  }

  /* ---------------- Статистика ---------------- */

  renderStats(body, data) {
    const p = this.plugin;
    const selDay = p.statsDay || todayStr();
    const cur = p.statsCursor;
    const allPerDay = new Map();

    const addEntry = (taskName, startRaw, endRaw, perTask) => {
      const s = window.moment(startRaw);
      const en = window.moment(endRaw);
      if (!s.isValid()) return;
      const ms = en.isValid() && en.isAfter(s) ? en.diff(s) : 0;
      if (ms <= 0) return;
      const d = s.format("YYYY-MM-DD");
      allPerDay.set(d, (allPerDay.get(d) || 0) + ms);
      if (d === selDay) perTask.set(taskName, (perTask.get(taskName) || 0) + ms);
    };

    for (const t of data.tasks) {
      for (const e of t.timeEntries) addEntry(t.name, e && e.start, e && e.end, new Map());
    }
    if (this.plugin.timer) {
      const s = window.moment(this.plugin.timer.startedAt, "YYYY-MM-DDTHH:mm:ss");
      if (s.isValid()) {
        const file = this.app.vault.getAbstractFileByPath(this.plugin.timer.path);
        const d = s.format("YYYY-MM-DD");
        const ms = Math.max(0, Date.now() - s.valueOf());
        allPerDay.set(d, (allPerDay.get(d) || 0) + ms);
      }
    }

    const perTask = new Map();
    for (const t of data.tasks) {
      for (const e of t.timeEntries) addEntry(t.name, e && e.start, e && e.end, perTask);
    }
    if (this.plugin.timer) {
      const s = window.moment(this.plugin.timer.startedAt, "YYYY-MM-DDTHH:mm:ss");
      if (s.isValid() && s.format("YYYY-MM-DD") === selDay) {
        const file = this.app.vault.getAbstractFileByPath(this.plugin.timer.path);
        addEntry(file ? file.basename : "…", this.plugin.timer.startedAt, window.moment().format("YYYY-MM-DDTHH:mm:ss"), perTask);
      }
    }

    const selMs = allPerDay.get(selDay) || 0;
    const hero = h("div", "pult-stats-hero");
    hero.appendChild(h("div", "pult-stats-hero-num", fmtDurationShort(selMs) || "0 м"));
    hero.appendChild(h("div", "pult-stats-hero-label", cap(window.moment(selDay).format("dddd, D MMMM"))));
    body.appendChild(hero);

    const nav = h("div", "pult-week-nav");
    const prev = h("button", "pult-icon-btn");
    prev.innerHTML = svgIcon("back", 16);
    prev.addEventListener("click", () => {
      p.statsCursor = cur.clone().subtract(1, "month");
      this.render();
    });
    const next = h("button", "pult-icon-btn");
    next.innerHTML = svgIcon("next", 16);
    next.addEventListener("click", () => {
      p.statsCursor = cur.clone().add(1, "month");
      this.render();
    });
    nav.appendChild(prev);
    nav.appendChild(h("span", "pult-week-label", cap(cur.format("MMMM YYYY"))));
    nav.appendChild(next);
    body.appendChild(nav);

    const cal = h("div", "pult-stats-cal");
    for (const wd of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) {
      cal.appendChild(h("div", "pult-cal-wd", wd));
    }
    const start = cur.clone().startOf("month").isoWeekday(1);
    const monthMax = Math.max.apply(null, [...allPerDay.values()].concat([1]));
    for (let i = 0; i < 42; i++) {
      const day = start.clone().add(i, "days");
      const ds = day.format("YYYY-MM-DD");
      const inMonth = day.month() === cur.month();
      const ms = allPerDay.get(ds) || 0;
      const cell = h(
        "button",
        "pult-stats-cal-cell" +
          (inMonth ? "" : " is-out") +
          (ds === todayStr() ? " is-today" : "") +
          (ds === selDay ? " is-selected" : "")
      );
      cell.appendChild(h("span", "pult-stats-cal-num", String(day.date())));
      if (ms > 0) {
        const intensity = Math.max(0.35, ms / monthMax);
        cell.style.background = "color-mix(in srgb, var(--pult-accent) " + Math.round(intensity * 100) + "%, transparent)";
        cell.appendChild(h("span", "pult-stats-cal-ms", fmtDurationShort(ms)));
      }
      cell.addEventListener("click", () => {
        p.statsDay = ds;
        this.render();
      });
      cal.appendChild(cell);
    }
    body.appendChild(cal);

    const days = last7();
    const weekTotal = days.reduce((acc, d) => acc + (allPerDay.get(d) || 0), 0);
    const max = Math.max.apply(null, days.map((d) => allPerDay.get(d) || 0).concat([1]));
    const chart = h("div", "pult-stats-chart");
    for (const d of days) {
      const v = allPerDay.get(d) || 0;
      const col = h("div", "pult-stats-col" + (d === selDay ? " is-today" : ""));
      col.appendChild(h("div", "pult-stats-val", fmtDurationShort(v)));
      const barWrap = h("div", "pult-stats-barwrap");
      const bar = h("div", "pult-stats-bar");
      bar.style.height = Math.max(v > 0 ? 6 : 2, Math.round((v / max) * 100)) + "%";
      barWrap.appendChild(bar);
      col.appendChild(barWrap);
      col.appendChild(h("div", "pult-stats-wd", window.moment(d).format("dd")));
      chart.appendChild(col);
    }
    body.appendChild(chart);
    body.appendChild(h("div", "pult-hint", "За 7 дней: " + (weekTotal ? fmtDuration(weekTotal) : "0 м") + " · тап по дню в календаре"));

    const rows = [...perTask.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const list = h("div", "pult-stats-list");
    const lh = h("div", "pult-section-head is-accent");
    lh.appendChild(h("span", "pult-section-title", "По задачам за день"));
    list.appendChild(lh);
    if (!rows.length) list.appendChild(h("div", "pult-empty", "В этот день таймер не запускался."));
    for (const [name, ms] of rows) {
      const r = h("div", "pult-stats-row");
      r.appendChild(h("span", "pult-stats-name", name));
      const track = h("span", "pult-progress-track is-wide");
      const fill = h("span", "pult-progress-fill");
      fill.style.width = Math.max(4, Math.round((ms / (rows[0][1] || 1)) * 100)) + "%";
      track.appendChild(fill);
      r.appendChild(track);
      r.appendChild(h("span", "pult-progress-num", fmtDuration(ms)));
      list.appendChild(r);
    }
    body.appendChild(list);
  }

  /* ---------------- Привычки ---------------- */

  renderHabits(body, data) {
    const p = this.plugin;
    const habits = data.habits;
    const days = last7();
    const today = todayStr();

    const tabs = h("div", "pult-hab-tabs");
    const tabList = h("button", "pult-hab-tab" + (p.habitsTab === "list" ? " is-on" : ""), "Отметки");
    const tabStats = h("button", "pult-hab-tab" + (p.habitsTab === "stats" ? " is-on" : ""), "Статистика");
    tabList.addEventListener("click", () => { p.habitsTab = "list"; this.render(); });
    tabStats.addEventListener("click", () => { p.habitsTab = "stats"; this.render(); });
    tabs.appendChild(tabList);
    tabs.appendChild(tabStats);
    body.appendChild(tabs);

    if (p.habitsTab === "stats") {
      for (const hb of habits) {
        const card = h("div", "pult-hab-stat-card c-" + hb.color);
        const head = h("div", "pult-hab-stat-head");
        head.appendChild(h("span", null, hb.icon));
        const info = h("div");
        info.appendChild(h("div", "pult-hab-title", hb.name));
        if (hb.habitType === "numeric") {
          const vals = Object.values(hb.values);
          const avg = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
          info.appendChild(h("div", "pult-hab-stat-avg", "среднее: " + avg + (hb.unit ? " " + hb.unit : "") + (hb.target ? " · цель " + hb.target : "")));
        } else {
          info.appendChild(h("div", "pult-hab-stat-avg", "серия: " + this.streakOf(hb, today) + " дн"));
        }
        head.appendChild(info);
        card.appendChild(head);
        const heat = h("div", "pult-hab-heat");
        const monthStart = window.moment().subtract(27, "days");
        let maxVal = 1;
        if (hb.habitType === "numeric") {
          for (const v of Object.values(hb.values)) if (v > maxVal) maxVal = v;
        }
        for (let i = 0; i < 28; i++) {
          const d = monthStart.clone().add(i, "days").format("YYYY-MM-DD");
          const cell = h("div", "pult-hab-heat-cell c-" + hb.color);
          if (hb.habitType === "numeric") {
            const v = hb.values[d];
            if (v != null) {
              cell.addClass("has-val");
              if (v >= maxVal * 0.7) cell.addClass("is-strong");
              cell.title = d + ": " + v + (hb.unit ? " " + hb.unit : "");
            }
          } else if (hb.done.includes(d)) {
            cell.addClass("has-val is-strong");
            cell.title = d;
          }
          heat.appendChild(cell);
        }
        card.appendChild(heat);
        body.appendChild(card);
      }
      if (!habits.length) body.appendChild(h("div", "pult-empty", "Добавьте привычку для статистики."));
      return;
    }

    const grid = h("div", "pult-hab-grid");
    grid.appendChild(h("div", "pult-hab-corner", "Привычка"));
    for (const d of days) {
      grid.appendChild(
        h("div", "pult-hab-day" + (d === today ? " is-today" : ""), window.moment(d).format("dd") + " " + window.moment(d).format("D"))
      );
    }

    for (const hb of habits) {
      const nameCell = h("div", "pult-hab-name");
      const iconBtn = h("button", "pult-hab-icon", hb.icon);
      iconBtn.addEventListener("click", (e) => this.habitMenu(hb, e));
      nameCell.appendChild(iconBtn);
      const nameWrap = h("div", "pult-hab-namewrap");
      nameWrap.appendChild(h("div", "pult-hab-title", hb.name + (hb.habitType === "numeric" && hb.unit ? " (" + hb.unit + ")" : "")));
      if (hb.habitType !== "numeric") {
        const streak = this.streakOf(hb, today);
        if (streak > 0) nameWrap.appendChild(h("div", "pult-hab-streak", "🔥 серия: " + streak + " дн"));
      }
      nameCell.appendChild(nameWrap);
      grid.appendChild(nameCell);

      for (const d of days) {
        const isNum = hb.habitType === "numeric";
        const val = isNum ? hb.values[d] : null;
        const on = isNum ? val != null && val > 0 : hb.done.includes(d);
        const cell = h(
          "button",
          "pult-hab-dot c-" + hb.color + (on ? " is-on" : "") + (val != null ? " has-val" : "") + (d === today ? " is-today" : "")
        );
        if (isNum && val != null) {
          const lbl = h("span", "pult-hab-num", String(val));
          cell.appendChild(lbl);
        }
        cell.title = window.moment(d).format("D MMMM");
        cell.addEventListener("click", async () => {
          if (isNum) {
            new HabitValueSheet(this.app, hb, d, val, async (n) => {
              await this.plugin.patchFrontMatter(hb.file, (fm) => {
                const values = parseHabitValues(fm);
                if (n == null || n <= 0) delete values[d];
                else values[d] = n;
                fm.values = values;
              });
            }).open();
          } else {
            await this.plugin.patchFrontMatter(hb.file, (fm) => {
              const arr = Array.isArray(fm.done) ? fm.done.map(toDayStr).filter(Boolean) : [];
              const i = arr.indexOf(d);
              if (i >= 0) arr.splice(i, 1);
              else arr.push(d);
              fm.done = arr;
            });
          }
        });
        grid.appendChild(cell);
      }
    }

    if (!habits.length) {
      grid.appendChild(h("div", "pult-hab-none", "Привычек пока нет. Галочки — done, числа — values в frontmatter."));
    }
    body.appendChild(grid);

    const addBtn = h("button", "pult-list-add");
    addBtn.innerHTML = svgIcon("plus", 16) + "<span>Новая привычка</span>";
    addBtn.addEventListener("click", () =>
      new HabitModal(this.app, async (name, icon, color, habitType, unit, target) => {
        await this.plugin.createHabit(name, icon, color, habitType, unit, target);
      }).open()
    );
    body.appendChild(addBtn);
  }

  renderTimeline(body, data) {
    const p = this.plugin;
    const cur = p.calCursor;
    const daysInMonth = cur.daysInMonth();
    body.style.setProperty("--pult-gantt-days", String(daysInMonth));

    const nav = h("div", "pult-week-nav");
    const prev = h("button", "pult-icon-btn");
    prev.innerHTML = svgIcon("back", 16);
    prev.addEventListener("click", () => { p.calCursor = cur.clone().subtract(1, "month"); this.render(); });
    const next = h("button", "pult-icon-btn");
    next.innerHTML = svgIcon("next", 16);
    next.addEventListener("click", () => { p.calCursor = cur.clone().add(1, "month"); this.render(); });
    nav.appendChild(prev);
    nav.appendChild(h("span", "pult-week-label", cap(cur.format("MMMM YYYY"))));
    nav.appendChild(next);
    body.appendChild(nav);

    const tasks = data.tasks.filter((t) => !t.parent && (t.scheduled || t.due) && (t.duration > 0 || t.scheduled));
    if (!tasks.length) {
      body.appendChild(h("div", "pult-empty is-big", "Нет задач с датами. Укажите scheduled и duration (дни) в карточке задачи «⋯»."));
      body.appendChild(h("div", "pult-hint", "Заготовка диаграммы Ганта — полоски показывают длительность от запланированной даты."));
      return;
    }

    const gantt = h("div", "pult-gantt");
    const monthStart = cur.clone().startOf("month");
    const head = h("div", "pult-gantt-head");
    head.appendChild(h("div", "pult-gantt-name", "Задача"));
    for (let d = 1; d <= daysInMonth; d++) {
      head.appendChild(h("div", "pult-gantt-daylbl", String(d)));
    }
    gantt.appendChild(head);

    for (const t of tasks.slice(0, 20)) {
      const row = h("div", "pult-gantt-row");
      row.appendChild(h("div", "pult-gantt-name", t.name));
      const track = h("div", "pult-gantt-track");
      track.style.setProperty("--pult-gantt-days", String(daysInMonth));
      const startDay = window.moment(t.scheduled || t.due);
      const dur = Math.max(1, t.duration || 1);
      if (startDay.isValid() && startDay.month() === cur.month() && startDay.year() === cur.year()) {
        const left = ((startDay.date() - 1) / daysInMonth) * 100;
        const width = (dur / daysInMonth) * 100;
        const bar = h("div", "pult-gantt-bar" + (t.status === STATUS.DONE ? " is-done" : ""));
        bar.style.left = left + "%";
        bar.style.width = Math.min(width, 100 - left) + "%";
        bar.title = t.name + " · " + dur + " дн.";
        track.appendChild(bar);
      }
      row.appendChild(track);
      gantt.appendChild(row);
    }
    body.appendChild(gantt);
    body.appendChild(h("div", "pult-hint", "Показаны до 20 задач. duration задаётся в «⋯» → «Длительность». Полный Гант — в следующих версиях."));
  }

  streakOf(hb, today) {
    const set = new Set(hb.done);
    let cursor = window.moment(today);
    let streak = 0;
    if (!set.has(today)) cursor = cursor.subtract(1, "day");
    while (set.has(cursor.format("YYYY-MM-DD"))) {
      streak += 1;
      cursor = cursor.subtract(1, "day");
    }
    return streak;
  }

  habitMenu(hb, evt) {
    const m = new Menu();
    m.addItem((i) => i.setTitle("Открыть файл").setIcon("file").onClick(() => this.openFile(hb.file)));
    m.addSeparator();
    m.addItem((i) =>
      i.setTitle("Удалить привычку").setIcon("trash").onClick(() =>
        new ConfirmModal(this.app, "Удалить привычку «" + hb.name + "» вместе с отметками?", async () => {
          await this.app.fileManager.trashFile(hb.file);
        }).open()
      )
    );
    m.showAtMouseEvent(evt);
  }

  /* ---------------- живой таймер ---------------- */

  updateTimerLabel(timer) {
    if (!timer) return;
    const elNode = this.timerRefs.get(timer.path);
    if (!elNode) return;
    const s = window.moment(timer.startedAt, "YYYY-MM-DDTHH:mm:ss");
    if (!s.isValid()) return;
    const totalSec = Math.max(0, Math.floor((Date.now() - s.valueOf()) / 1000));
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    elNode.textContent = "⏱ " + (hh ? hh + ":" + pad(mm) : mm) + ":" + pad(ss);
  }
}

/* ================================================================
 * Настройки
 * ================================================================ */

class PultSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Папка задач")
      .setDesc(
        "Путь от корня хранилища. Задачи — type: pult_task, списки — type: pult_list, привычки — type: pult_habit."
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_FOLDER)
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value;
            await this.plugin.saveSettings();
            this.plugin.refreshView();
          })
      );

    containerEl.createEl("p", {
      text:
        "Списки = теги (tags: [работа]). Подзадачи — parent: \"[[Имя]]\". " +
        "Ручной порядок — поле order во frontmatter. При переименовании родителя ссылки детей обновляются сами. " +
        "Панель живёт в правом сайдбаре Obsidian.",
      cls: "setting-item-description",
    });
  }
}

module.exports = PultPlugin;
