const state = {
  root: null,
  tabs: [],
  active: null,
  editor: null,
  monaco: null,
  problems: [],
  panel: "problems",
  panelOpen: true,
  models: new Map(),
  treeRoot: null,
  expanded: new Set(),
  diagnoseSeq: 0,
  untitledSeq: 1,
  autoSave: false,
  settings: {
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: 14,
    theme: "dark",
    shell: "powershell",
    runArgs: "",
  },
  paletteMode: null,
  paletteItems: [],
  paletteIndex: 0,
  paletteTimer: null,
  pitonMessages: [],
  pitonBusy: false,
  pitonJobId: null,
  pitonCancelled: false,
  pitonLastRequest: null,
  pitonRoute: null,
  terminals: [],
  activeTerminalId: null,
  nextTerminalNum: 1,
  terminalPollTimer: null,
  terminalPollBusy: false,
  terminalCreating: false,
  pythonCompletionRegistered: false,
  restoringSession: false,
  sessionSaveTimer: 0,
  session: { root: null, files: [], active: null },
};

const ui = {
  tree: document.getElementById("file-tree"),
  tabs: document.getElementById("tabs"),
  welcome: document.getElementById("welcome"),
  workspace: document.getElementById("workspace-name"),
  title: document.getElementById("window-title"),
  problems: document.getElementById("problems-view"),
  problemCount: document.getElementById("problem-count"),
  statusLeft: document.getElementById("status-left"),
  statusRight: document.getElementById("status-right"),
  panel: document.getElementById("panel"),
  editorCol: document.querySelector(".editor-col"),
  terminalHosts: document.getElementById("terminal-hosts"),
};

function api() {
  const bridge = window.pywebview && window.pywebview.api;
  if (!bridge) {
    throw new Error("Запусти FC.bat — это приложение, не сайт");
  }
  return new Proxy(bridge, {
    get(target, prop) {
      const val = target[prop];
      if (typeof val !== "function") {
        return val;
      }
      return (...args) => {
        const started = val.apply(target, args);
        const name = String(prop);
        if (
          name === "pick_folder" ||
          name === "pick_file" ||
          name === "pick_save_path" ||
          name === "quit" ||
          name === "window_close" ||
          name.startsWith("piton_")
        ) {
          return started;
        }
        const ms = name === "term_poll" ? 3500 : 12000;
        let timer = 0;
        return Promise.race([
          Promise.resolve(started),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error("Редактор не ответил (" + name + ")"));
            }, ms);
          }),
        ]).finally(() => clearTimeout(timer));
      };
    },
  });
}

window.addEventListener("error", (event) => {
  const msg = (event.error && event.error.message) || event.message || "";
  if (!msg || /importScripts|workerMain|MonacoEnvironment|Script error/i.test(msg)) {
    return;
  }
  if (ui.statusLeft) {
    setStatus(String(msg).slice(0, 180), true);
  }
});
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const reason = event.reason;
  const msg = (reason && reason.message) || String(reason || "");
  if (!msg || /importScripts|workerMain|MonacoEnvironment/i.test(msg)) {
    return;
  }
  if (ui.statusLeft) {
    setStatus(String(msg).slice(0, 180), true);
  }
});
window.addEventListener("pagehide", () => {
  saveSession().catch(() => {});
});

let askPending = null;

function finishAsk(value) {
  const overlay = document.getElementById("ask-overlay");
  if (overlay) {
    overlay.classList.add("hidden");
  }
  const done = askPending;
  askPending = null;
  if (done) {
    done(value);
  }
}

function askDialog({ title, message = "", value = "", placeholder = "", input = true }) {
  finishAsk(null);
  return new Promise((resolve) => {
    askPending = resolve;
    const overlay = document.getElementById("ask-overlay");
    const titleEl = document.getElementById("ask-title");
    const messageEl = document.getElementById("ask-message");
    const wrap = document.getElementById("ask-field-wrap");
    const field = document.getElementById("ask-input");
    titleEl.textContent = title || "Forge Code";
    if (message) {
      messageEl.textContent = message;
      messageEl.classList.remove("hidden");
    } else {
      messageEl.textContent = "";
      messageEl.classList.add("hidden");
    }
    wrap.classList.toggle("hidden", !input);
    if (input) {
      field.value = value || "";
      field.placeholder = placeholder || "";
    }
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      if (input) {
        field.focus();
        field.select();
      } else {
        document.getElementById("ask-ok").focus();
      }
    });
  });
}

function askText(title, value = "", placeholder = "") {
  return askDialog({ title, value, placeholder, input: true });
}

function askConfirm(message) {
  return askDialog({ title: "Forge Code", message, input: false }).then((ok) => ok === true);
}

document.getElementById("ask-ok").addEventListener("click", () => {
  const wrap = document.getElementById("ask-field-wrap");
  const field = document.getElementById("ask-input");
  if (wrap.classList.contains("hidden")) {
    finishAsk(true);
    return;
  }
  const text = String(field.value || "").trim();
  finishAsk(text || null);
});
document.getElementById("ask-cancel").addEventListener("click", () => finishAsk(null));
document.getElementById("ask-overlay").addEventListener("click", (event) => {
  if (event.target.id === "ask-overlay") {
    finishAsk(null);
  }
});
document.addEventListener(
  "keydown",
  (event) => {
    const overlay = document.getElementById("ask-overlay");
    if (!overlay || overlay.classList.contains("hidden")) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finishAsk(null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      document.getElementById("ask-ok").click();
    }
  },
  true,
);

function setStatus(text, error = false) {
  ui.statusLeft.textContent = text;
  document.querySelector(".statusbar").classList.toggle("error", error);
}

function languageLabel(lang) {
  return lang ? lang.toUpperCase() : "";
}

function basename(path) {
  if (String(path).startsWith("untitled:")) {
    return `Безымянный-${path.split(":")[1]}`;
  }
  return path.replace(/\\/g, "/").split("/").pop();
}

function isUntitled(tab) {
  return !!(tab && (tab.untitled || String(tab.path).startsWith("untitled:")));
}

function tabByPath(path) {
  return state.tabs.find((tab) => tab.path === path);
}

function activeTab() {
  return state.tabs.find((tab) => tab.path === state.active) || null;
}

function showWelcome(show) {
  ui.welcome.classList.toggle("hidden", !show);
  const monacoHost = document.getElementById("monaco");
  if (monacoHost) {
    monacoHost.style.pointerEvents = show ? "none" : "auto";
  }
  if (show) {
    ui.statusRight.textContent = "";
    updateRunButtons();
  }
}

function canRun(tab) {
  if (!tab || !tab.path || isUntitled(tab)) {
    return false;
  }
  const name = tab.path.replace(/\\/g, "/").toLowerCase();
  return name.endsWith(".py") || name.endsWith(".pyw");
}

function updateRunButtons() {
  const visible = canRun(activeTab());
  document.querySelectorAll("[data-action='run']").forEach((button) => {
    button.classList.toggle("hidden", !visible);
  });
  document.querySelectorAll("[data-action='stop-run']").forEach((button) => {
    button.classList.toggle("hidden", !visible);
  });
}

function updateTitle() {
  const tab = activeTab();
  const hasFolder = ui.workspace.textContent !== "Нет открытой папки";
  const project = hasFolder ? ui.workspace.textContent : "";
  let title = "";
  if (tab && project) {
    title = `${basename(tab.path)} — ${project}`;
  } else if (tab) {
    title = basename(tab.path);
  } else if (project) {
    title = project;
  }
  ui.title.textContent = title;
  const osTitle = title ? `${title} — Forge Code` : "Forge Code";
  document.title = osTitle;
  const bridge = window.pywebview && window.pywebview.api;
  if (bridge && typeof bridge.set_window_title === "function") {
    bridge.set_window_title(osTitle).catch(() => {});
  }
}

function renderTabs() {
  ui.tabs.innerHTML = "";
  for (const tab of state.tabs) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tab";
    el.dataset.path = tab.path;
    el.innerHTML = `<span class="tab-name">${basename(tab.path)}</span>`;
    const close = document.createElement("span");
    close.className = "tab-close";
    close.innerHTML =
      '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.path);
    });
    el.appendChild(close);
    el.addEventListener("click", () => activateTab(tab.path));
    ui.tabs.appendChild(el);
  }
  updateTabChrome();
}

function updateTabChrome() {
  ui.tabs.querySelectorAll(".tab").forEach((el) => {
    const tab = tabByPath(el.dataset.path);
    el.classList.toggle("active", el.dataset.path === state.active);
    el.classList.toggle("dirty", !!(tab && tab.dirty));
  });
  highlightTree();
  updateRunButtons();
}

function highlightTree() {
  ui.tree.querySelectorAll(".tree-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.path === state.active);
  });
}

function findNode(node, path) {
  if (!node) {
    return null;
  }
  if (node.path === path) {
    return node;
  }
  for (const child of node.children || []) {
    const found = findNode(child, path);
    if (found) {
      return found;
    }
  }
  return null;
}

function openStandaloneFiles() {
  return state.tabs.filter((tab) => !isUntitled(tab));
}

function updateWorkspaceLabel() {
  if (state.root) {
    return;
  }
  ui.workspace.textContent = openStandaloneFiles().length ? "Открытые файлы" : "Нет открытой папки";
  updateTitle();
}

function paintTree() {
  if (!state.treeRoot) {
    const files = openStandaloneFiles();
    if (!files.length) {
      ui.tree.innerHTML = `<div class="problem-empty">Откройте папку, чтобы увидеть файлы</div>`;
      return;
    }
    ui.tree.innerHTML = "";
    for (const tab of files) {
      const row = document.createElement("div");
      row.className = "tree-item";
      row.dataset.path = tab.path;
      row.dataset.type = "file";
      row.style.setProperty("--depth", "1");
      row.title = tab.path;
      row.innerHTML = `<span class="chevron"> </span><span>${basename(tab.path)}</span>`;
      row.addEventListener("click", () => activateTab(tab.path));
      ui.tree.appendChild(row);
    }
    highlightTree();
    return;
  }
  ui.tree.innerHTML = "";
  paintChildren(state.treeRoot, 1);
}

function paintChildren(node, depth) {
  for (const child of node.children || []) {
    const row = document.createElement("div");
    row.className = "tree-item";
    row.dataset.path = child.path;
    row.dataset.type = child.type;
    row.style.setProperty("--depth", String(depth));
    if (child.type === "dir") {
      const open = state.expanded.has(child.path);
      row.innerHTML = `<span class="chevron">${open ? "▾" : "▸"}</span><span>${child.name}</span>`;
      row.addEventListener("click", () => toggleDir(child.path));
      ui.tree.appendChild(row);
      if (open && child.children) {
        paintChildren(child, depth + 1);
      }
    } else {
      row.innerHTML = `<span class="chevron"> </span><span>${child.name}</span>`;
      row.addEventListener("click", () => openFile(child.path));
      ui.tree.appendChild(row);
    }
  }
  highlightTree();
}

async function toggleDir(path) {
  if (state.expanded.has(path)) {
    state.expanded.delete(path);
    paintTree();
    return;
  }
  state.expanded.add(path);
  const node = findNode(state.treeRoot, path);
  if (node && !node.loaded) {
    try {
      const data = await api().list_dir(path);
      node.children = data.children;
      node.loaded = true;
    } catch (err) {
      state.expanded.delete(path);
      setStatus(err.message || String(err), true);
    }
  }
  paintTree();
}

async function refreshTree() {
  if (!state.root) {
    state.treeRoot = null;
    paintTree();
    return;
  }
  const root = await api().list_dir("");
  state.treeRoot = root;
  state.treeRoot.loaded = true;
  const expanded = [...state.expanded].sort((a, b) => a.length - b.length);
  for (const path of expanded) {
    const node = findNode(state.treeRoot, path);
    if (!node || node.type !== "dir") {
      state.expanded.delete(path);
      continue;
    }
    const data = await api().list_dir(path);
    node.children = data.children;
    node.loaded = true;
  }
  paintTree();
}

function renderProblems() {
  const problems = state.problems;
  ui.problemCount.textContent = String(problems.length);
  if (!problems.length) {
    ui.problems.innerHTML = `<div class="problem-empty">Ошибок нет.</div>`;
    return;
  }
  ui.problems.innerHTML = problems
    .map(
      (item) => `
      <div class="problem-row" data-path="${encodeURIComponent(item.path)}" data-line="${item.line}" data-column="${item.column}">
        <span class="dot">●</span>
        <span>${item.message} <span style="color:#858585">${basename(item.path)}</span></span>
        <span style="color:#858585">:${item.line}</span>
      </div>`
    )
    .join("");
  ui.problems.querySelectorAll(".problem-row").forEach((row) => {
    row.addEventListener("click", async () => {
      const path = decodeURIComponent(row.dataset.path);
      await openFile(path);
      const line = Number(row.dataset.line);
      const column = Number(row.dataset.column);
      state.editor?.revealLineInCenter(line);
      state.editor?.setPosition({ lineNumber: line, column: column });
      state.editor?.focus();
    });
  });
}

function applyMarkers(path, problems) {
  if (!state.monaco || !state.models.has(path)) {
    return;
  }
  const model = state.models.get(path);
  const markers = problems
    .filter((item) => item.path === path)
    .map((item) => ({
      startLineNumber: item.line,
      startColumn: item.column,
      endLineNumber: item.endLine || item.line,
      endColumn: item.endColumn || item.column + 1,
      message: item.message,
      severity: state.monaco.MarkerSeverity.Error,
      source: item.source || "fc",
    }));
  state.monaco.editor.setModelMarkers(model, "fc", markers);
}

async function refreshState() {
  const data = await api().get_state();
  state.root = data.root;
  state.autoSave = !!data.autoSave;
  state.settings = {
    fontFamily: data.fontFamily || state.settings.fontFamily,
    fontSize: Number(data.fontSize) || 14,
    theme: data.theme || "dark",
    shell: data.shell || "powershell",
    runArgs: data.runArgs != null ? String(data.runArgs) : state.settings.runArgs || "",
  };
  state.session = data.session || { root: null, files: [], active: null };
  if (data.root) {
    ui.workspace.textContent = data.name || "Папка";
  } else {
    updateWorkspaceLabel();
  }
  updateTitle();
  updateSidebarChrome();
  applyAppearance();
  await refreshTree();
}

function scheduleSaveSession() {
  if (state.restoringSession) {
    return;
  }
  clearTimeout(state.sessionSaveTimer);
  state.sessionSaveTimer = setTimeout(() => {
    saveSession().catch(() => {});
  }, 250);
}

async function saveSession() {
  if (state.restoringSession) {
    return;
  }
  const files = state.tabs.filter((tab) => !isUntitled(tab)).map((tab) => tab.path);
  let active = state.active;
  if (!active || String(active).startsWith("untitled:")) {
    active = files.length ? files[files.length - 1] : null;
  }
  await api().save_session({
    root: state.root || null,
    files,
    active,
  });
}

async function restoreSession() {
  if (!state.monaco) {
    return;
  }
  const session = state.session || {};
  const root = session.root || null;
  const files = (Array.isArray(session.files) ? session.files : []).slice(0, 8);
  const active = session.active || null;
  if (!root && !files.length) {
    return;
  }
  state.restoringSession = true;
  try {
    if (root && !state.root) {
      try {
        await api().open_folder(root);
        state.expanded.clear();
        await refreshState();
      } catch (err) {
        setStatus(err.message || String(err), true);
      }
    }
    for (const path of files) {
      try {
        await openFile(path);
      } catch (_) {
        /* файл мог исчезнуть */
      }
    }
    if (active && tabByPath(active)) {
      activateTab(active);
    }
    showWelcome(!state.active);
    if (state.root) {
      setStatus(`Восстановлено: ${state.root}`);
    } else if (state.tabs.length) {
      setStatus("Восстановлены открытые файлы");
    }
  } finally {
    state.restoringSession = false;
    scheduleSaveSession();
  }
}

function updateSidebarChrome() {
  const actions = document.querySelector(".sidebar-actions");
  if (actions) {
    actions.classList.toggle("hidden", !state.root);
  }
}

function monacoThemeName(theme) {
  if (theme === "light") {
    return "vs";
  }
  if (theme === "hc") {
    return "hc-black";
  }
  return "vs-dark";
}

function termTheme() {
  if (state.settings.theme === "light") {
    return { background: "#ffffff", foreground: "#333333", cursor: "#333333" };
  }
  if (state.settings.theme === "hc") {
    return { background: "#000000", foreground: "#ffffff", cursor: "#ffffff" };
  }
  return { background: "#1e1e1e", foreground: "#cccccc", cursor: "#ffffff" };
}

function applyAppearance() {
  document.documentElement.dataset.theme = state.settings.theme || "dark";
  if (state.monaco) {
    state.monaco.editor.setTheme(monacoThemeName(state.settings.theme));
  }
  if (state.editor) {
    state.editor.updateOptions({
      fontSize: state.settings.fontSize,
      fontFamily: state.settings.fontFamily,
    });
  }
  if (state.terminals.length) {
    for (const session of state.terminals) {
      if (!session.term) {
        continue;
      }
      session.term.options.fontSize = state.settings.fontSize;
      session.term.options.fontFamily = state.settings.fontFamily;
      session.term.options.theme = termTheme();
      try {
        session.fitAddon?.fit();
      } catch (_err) {
        /* ignore */
      }
    }
  }
}

function overlayOpen() {
  return !document.getElementById("overlay").classList.contains("hidden");
}

function settingsOpen() {
  return !document.getElementById("settings-overlay").classList.contains("hidden");
}

function pitonOpen() {
  return !document.getElementById("piton-overlay").classList.contains("hidden");
}

function copyPitonCode(text, button) {
  const markCopied = () => {
    button.textContent = "Скопировано";
    setTimeout(() => {
      button.textContent = "Копировать";
    }, 1500);
  };
  const fallback = () => {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.focus();
    area.select();
    try {
      document.execCommand("copy");
      markCopied();
    } catch (_err) {
      setStatus("Не удалось скопировать", true);
    }
    area.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(markCopied).catch(fallback);
    return;
  }
  fallback();
}

function splitPitonCodeBlocks(text) {
  const parts = [];
  const pattern = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > last) {
      parts.push({ type: "text", content: text.slice(last, match.index) });
    }
    parts.push({
      type: "code",
      lang: (match[1] || "").trim() || "code",
      content: match[2].replace(/\n$/, ""),
    });
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (last < text.length) {
    parts.push({ type: "text", content: text.slice(last) });
  }
  if (!parts.length) {
    parts.push({ type: "text", content: text });
  }
  return parts;
}

function appendPitonAssistantContent(parent, text) {
  const source = String(text ?? "");
  if (source.length > 120000) {
    const note = document.createElement("div");
    note.className = "piton-text";
    note.textContent = source.slice(0, 120000) + "\n\n… (ответ обрезан для отображения)";
    parent.appendChild(note);
    return;
  }
  for (const part of splitPitonCodeBlocks(source)) {
    if (part.type === "text") {
      if (!part.content) {
        continue;
      }
      const block = document.createElement("div");
      block.className = "piton-text";
      block.textContent = part.content;
      parent.appendChild(block);
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = "piton-code-block";
    const head = document.createElement("div");
    head.className = "piton-code-head";
    const lang = document.createElement("span");
    lang.className = "piton-code-lang";
    lang.textContent = part.lang;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "piton-copy-btn";
    copy.textContent = "Копировать";
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      copyPitonCode(part.content, copy);
    });
    head.appendChild(lang);
    head.appendChild(copy);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = part.content;
    pre.appendChild(code);
    wrap.appendChild(head);
    wrap.appendChild(pre);
    parent.appendChild(wrap);
  }
}

function renderPitonMessages() {
  const box = document.getElementById("piton-messages");
  box.innerHTML = "";
  if (!state.pitonMessages.length && !state.pitonBusy) {
    const hint = document.createElement("div");
    hint.className = "piton-msg pending";
    hint.textContent = "Спроси про код или нажми «Анализ кода» — Piton подскажет, как улучшить.";
    box.appendChild(hint);
    updatePitonRetryButton();
    return;
  }
  for (const msg of state.pitonMessages) {
    const el = document.createElement("div");
    el.className = "piton-msg " + msg.role + (msg.error ? " error" : "") + (msg.streaming ? " streaming" : "");
    if (msg.role === "assistant") {
      appendPitonAssistantContent(el, msg.content);
      if (msg.provider || msg.model) {
        const meta = document.createElement("div");
        meta.className = "piton-msg-meta";
        meta.textContent = [msg.provider, msg.model].filter(Boolean).join(" · ");
        el.appendChild(meta);
      }
    } else {
      el.textContent = msg.content;
    }
    box.appendChild(el);
  }
  if (state.pitonBusy) {
    const wait = document.createElement("div");
    wait.className = "piton-msg pending piton-thinking";
    wait.innerHTML =
      'Думаю<span class="piton-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>' +
      '<div class="piton-msg-meta">Первый ответ может занять до 15 сек</div>';
    box.appendChild(wait);
  }
  box.scrollTop = box.scrollHeight;
  updatePitonRetryButton();
}

function updatePitonRouteLabel() {
  const el = document.getElementById("piton-route");
  if (!el) {
    return;
  }
  const route = state.pitonRoute;
  if (route && (route.provider || route.model)) {
    el.hidden = false;
    el.textContent = [route.provider, route.model].filter(Boolean).join(" · ");
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

function updatePitonRetryButton() {
  const btn = document.getElementById("piton-retry");
  if (!btn) {
    return;
  }
  const can = !state.pitonBusy && !!state.pitonLastRequest;
  btn.classList.toggle("hidden", !can);
  btn.disabled = state.pitonBusy;
}

function setPitonBusy(busy) {
  state.pitonBusy = busy;
  const input = document.getElementById("piton-input");
  const send = document.getElementById("piton-send");
  const cancel = document.getElementById("piton-cancel");
  const analyze = document.querySelector("[data-action='analyze-code']");
  input.disabled = busy;
  send.disabled = busy;
  send.classList.toggle("hidden", busy);
  if (cancel) {
    cancel.classList.toggle("hidden", !busy);
  }
  if (analyze) {
    analyze.disabled = busy;
  }
  updatePitonRetryButton();
}

async function cancelPiton() {
  if (!state.pitonBusy) {
    return;
  }
  state.pitonCancelled = true;
  if (state.pitonJobId) {
    try {
      await api().piton_cancel(state.pitonJobId);
    } catch (_err) {
      /* ignore */
    }
  }
  state.pitonJobId = null;
  setPitonBusy(false);
  setStatus("Piton отменён");
  renderPitonMessages();
  document.getElementById("piton-input").focus();
}

function openPiton() {
  closePalette();
  closeSettings();
  closeMenubarMenus();
  document.getElementById("piton-overlay").classList.remove("hidden");
  renderPitonMessages();
  document.getElementById("piton-input").focus();
}

function isPitonKey(event) {
  if (!event.ctrlKey || !event.shiftKey || event.altKey) {
    return false;
  }
  return event.code === "KeyP" || String(event.key || "").toLowerCase() === "p";
}

function isPaletteKey(event) {
  if (!event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  return event.code === "KeyP" || String(event.key || "").toLowerCase() === "p";
}

function isAnalyzeKey(event) {
  if (!event.ctrlKey || !event.shiftKey || event.altKey) {
    return false;
  }
  return event.code === "KeyI" || String(event.key || "").toLowerCase() === "i";
}

function bindPitonHotkeys() {
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.key || overlayOpen() || settingsOpen() || pitonOpen()) {
        return;
      }
      const target = event.target;
      const tag = target && target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      if (isPitonKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openPiton();
      } else if (isPaletteKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openQuickOpen();
      } else if (event.ctrlKey && event.shiftKey && !event.altKey && (event.code === "KeyF" || String(event.key || "").toLowerCase() === "f")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openProjectSearch();
      } else if (event.key === "F1") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openPalette();
      } else if (isAnalyzeKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        analyzeCodeWithPiton().catch((err) => setStatus(err.message || String(err), true));
      }
    },
    true,
  );
}

function isPythonTab(tab) {
  if (!tab) {
    return false;
  }
  if (tab.language === "python") {
    return true;
  }
  const name = String(tab.path || "").toLowerCase();
  return name.endsWith(".py") || name.endsWith(".pyw");
}

function applyEditorSuggestForTab(tab) {
  if (!state.editor) {
    return;
  }
  const python = isPythonTab(tab);
  state.editor.updateOptions({
    quickSuggestions: python ? { other: true, comments: false, strings: false } : false,
    suggestOnTriggerCharacters: python,
    tabCompletion: python ? "on" : "off",
  });
}

function registerPythonCompletions() {
  const monaco = state.monaco;
  if (!monaco || state.pythonCompletionRegistered) {
    return;
  }
  state.pythonCompletionRegistered = true;

  const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;
  const keywordItems = [
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
    "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  ].map((label) => ({
    label,
    kind: CompletionItemKind.Keyword,
    insertText: label,
  }));

  const builtinItems = [
    ["print", "print(${1})", "вывод в консоль"],
    ["input", "input(${1:\"текст\"})", "ввод строки"],
    ["int", "int(${1:x})", "целое число"],
    ["str", "str(${1:x})", "строка"],
    ["float", "float(${1:x})", "дробное число"],
    ["bool", "bool(${1:x})", "логический тип"],
    ["list", "list(${1:})", "список"],
    ["dict", "dict(${1:})", "словарь"],
    ["set", "set(${1:})", "множество"],
    ["tuple", "tuple(${1:})", "кортеж"],
    ["range", "range(${1:stop})", "диапазон"],
    ["len", "len(${1:obj})", "длина"],
    ["type", "type(${1:obj})", "тип"],
    ["open", "open(${1:path})", "открыть файл"],
    ["enumerate", "enumerate(${1:iterable})", "номер + элемент"],
    ["zip", "zip(${1:a}, ${2:b})", "пара элементов"],
    ["sorted", "sorted(${1:iterable})", "сортировка"],
    ["sum", "sum(${1:iterable})", "сумма"],
    ["min", "min(${1:iterable})", "минимум"],
    ["max", "max(${1:iterable})", "максимум"],
    ["abs", "abs(${1:x})", "модуль"],
    ["round", "round(${1:x}, ${2:ndigits})", "округление"],
    ["isinstance", "isinstance(${1:obj}, ${2:type})", "проверка типа"],
  ].map(([label, insertText, detail]) => ({
    label,
    kind: CompletionItemKind.Function,
    insertText,
    insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
    detail,
  }));

  const snippetItems = [
    ["for", "for ${1:i} in range(${2:n}):\n\t${3:pass}", "цикл for"],
    ["while", "while ${1:условие}:\n\t${2:pass}", "цикл while"],
    ["if", "if ${1:условие}:\n\t${2:pass}", "условие if"],
    ["elif", "elif ${1:условие}:\n\t${2:pass}", "ветка elif"],
    ["else", "else:\n\t${1:pass}", "ветка else"],
    ["def", "def ${1:имя}(${2:}):\n\t${3:pass}", "функция"],
    ["class", "class ${1:Имя}:\n\tdef __init__(self${2:}):\n\t\t${3:pass}", "класс"],
    [
      "try",
      "try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:e}:\n\t${4:pass}",
      "try/except",
    ],
    ["with", "with ${1:obj} as ${2:name}:\n\t${3:pass}", "контекст with"],
    ["import", "import ${1:module}", "импорт"],
    ["from", "from ${1:module} import ${2:name}", "from import"],
  ].map(([label, insertText, detail]) => ({
    label,
    kind: CompletionItemKind.Snippet,
    insertText,
    insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
    detail,
  }));

  const allItems = [...keywordItems, ...builtinItems, ...snippetItems];

  monaco.languages.registerCompletionItemProvider("python", {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: allItems.map((item) => ({
          ...item,
          range,
        })),
      };
    },
  });
}

function registerEditorShortcuts() {
  const monaco = state.monaco;
  if (!monaco || !state.editor) {
    return;
  }
  const { KeyMod, KeyCode } = monaco;
  const paletteKeys = KeyMod.CtrlCmd | KeyCode.KeyP;
  const pitonKeys = KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP;
  const analyzeKeys = KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI;
  if (typeof monaco.editor.addKeybindingRules === "function") {
    monaco.editor.addKeybindingRules([
      { keybinding: paletteKeys, command: "-editor.action.quickCommand" },
      { keybinding: paletteKeys, command: "-editor.action.gotoLine" },
    ]);
  }
  state.editor.addAction({
    id: "forge.quick-open",
    label: "Быстрое открытие",
    keybindings: [paletteKeys],
    run: () => {
      openQuickOpen();
      return null;
    },
  });
  state.editor.addAction({
    id: "forge.project-search",
    label: "Поиск по проекту",
    keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF],
    run: () => {
      openProjectSearch();
      return null;
    },
  });
  state.editor.addAction({
    id: "forge.command-palette",
    label: "Палитра команд",
    keybindings: [KeyCode.F1],
    run: () => {
      openPalette();
      return null;
    },
  });
  state.editor.addAction({
    id: "forge.open-piton",
    label: "Piton 1.1",
    keybindings: [pitonKeys],
    run: () => {
      openPiton();
      return null;
    },
  });
  state.editor.addAction({
    id: "forge.analyze-code",
    label: "Piton: анализ кода",
    keybindings: [analyzeKeys],
    run: () => {
      analyzeCodeWithPiton().catch((err) => setStatus(err.message || String(err), true));
      return null;
    },
  });
  state.editor.addAction({
    id: "forge.analyze-selection",
    label: "Анализ кода",
    contextMenuGroupId: "9_cutcopypaste",
    contextMenuOrder: 3,
    precondition: "editorHasSelection",
    run: () => {
      analyzeCodeWithPiton({ selectionOnly: true }).catch((err) =>
        setStatus(err.message || String(err), true),
      );
      return null;
    },
  });
}

function closePiton() {
  document.getElementById("piton-overlay").classList.add("hidden");
  if (state.active && state.editor) {
    state.editor.focus();
  }
}

function clearPiton() {
  if (state.pitonBusy) {
    return;
  }
  state.pitonMessages = [];
  state.pitonLastRequest = null;
  renderPitonMessages();
}

async function pollPitonJob(jobId) {
  let delay = 80;
  let sawText = false;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (state.pitonCancelled) {
      throw new Error("Отменено");
    }
    const data = await api().piton_poll(jobId);
    const partial = data.reply || "";
    if (partial) {
      if (!sawText) {
        sawText = true;
        setStatus("Piton печатает…");
      }
      updatePitonStreaming(partial, data.provider, data.model);
    }
    if (!data.done) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(220, delay + 10);
      continue;
    }
    if (data.error) {
      const err = new Error(data.error);
      err.provider = data.provider || null;
      err.model = data.model || null;
      err.tried = data.tried;
      throw err;
    }
    return {
      reply: data.reply || "",
      provider: data.provider || null,
      model: data.model || null,
      tried: data.tried,
    };
  }
  throw new Error("Слишком долго жду ответ. Нажми «Ещё раз».");
}

function updatePitonStreaming(text, provider, model) {
  let msg = state.pitonMessages[state.pitonMessages.length - 1];
  if (!msg || msg.role !== "assistant" || msg.error || !msg.streaming) {
    msg = {
      role: "assistant",
      content: text,
      provider: provider || null,
      model: model || null,
      streaming: true,
    };
    state.pitonMessages.push(msg);
  } else {
    msg.content = text;
    if (provider) {
      msg.provider = provider;
    }
    if (model) {
      msg.model = model;
    }
  }
  renderPitonMessages();
}

async function runPitonExchange(userVisible, request, options = {}) {
  if (state.pitonBusy) {
    setStatus("Piton ещё отвечает. Подожди или нажми «Отмена».", true);
    return;
  }
  const skipCache = !!options.skipCache;
  const isRetry = !!options.retry;
  if (!isRetry) {
    state.pitonMessages.push({ role: "user", content: userVisible });
  } else {
    while (state.pitonMessages.length) {
      const last = state.pitonMessages[state.pitonMessages.length - 1];
      if (last && last.role === "assistant" && (last.error || last.streaming)) {
        state.pitonMessages.pop();
        continue;
      }
      break;
    }
  }
  state.pitonLastRequest = { userVisible, request };
  state.pitonCancelled = false;
  state.pitonJobId = null;
  setPitonBusy(true);
  renderPitonMessages();
  setStatus(skipCache ? "Piton 1.1 пробует снова…" : "Piton 1.1 думает…");
  const busyStarted = Date.now();
  try {
    const started = await request(skipCache);
    if (!started || !started.jobId) {
      throw new Error("Не удалось запустить Piton");
    }
    state.pitonJobId = started.jobId;
    const result = await pollPitonJob(started.jobId);
    state.pitonRoute = { provider: result.provider, model: result.model };
    updatePitonRouteLabel();
    const last = state.pitonMessages[state.pitonMessages.length - 1];
    if (last && last.role === "assistant" && last.streaming) {
      last.content = result.reply;
      last.provider = result.provider;
      last.model = result.model;
      last.streaming = false;
    } else {
      state.pitonMessages.push({
        role: "assistant",
        content: result.reply,
        provider: result.provider,
        model: result.model,
      });
    }
    const route = [result.provider, result.model].filter(Boolean).join(" · ");
    setStatus(route ? `Piton ответил (${route})` : "Piton 1.1 ответил");
  } catch (err) {
    if (!state.pitonCancelled) {
      while (state.pitonMessages.length) {
        const last = state.pitonMessages[state.pitonMessages.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          state.pitonMessages.pop();
          continue;
        }
        break;
      }
      state.pitonMessages.push({
        role: "assistant",
        content: err.message || String(err),
        error: true,
        provider: err.provider || null,
        model: err.model || null,
      });
      setStatus(err.message || String(err), true);
    }
  } finally {
    state.pitonJobId = null;
    state.pitonCancelled = false;
    setPitonBusy(false);
    // защита от залипания busy
    if (Date.now() - busyStarted > 90000 && state.pitonBusy) {
      setPitonBusy(false);
    }
    renderPitonMessages();
    const input = document.getElementById("piton-input");
    if (input) {
      input.focus();
    }
  }
}

async function retryPiton() {
  const last = state.pitonLastRequest;
  if (!last || state.pitonBusy) {
    return;
  }
  await runPitonExchange(last.userVisible, last.request, { retry: true, skipCache: true });
}

function closeEditorContextMenu() {
  const menu = document.getElementById("editor-context-menu");
  if (menu) {
    menu.classList.add("hidden");
  }
}

function setupEditorContextMenu() {
  let menu = document.getElementById("editor-context-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "editor-context-menu";
    menu.className = "editor-context-menu hidden";
    menu.innerHTML = '<button type="button" data-action="analyze-selection">Анализ кода</button>';
    document.body.appendChild(menu);
  }
  const host = document.getElementById("editor-host");
  host.addEventListener("contextmenu", (event) => {
    if (!getSelectedSnippetForPiton()) {
      closeEditorContextMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    menu.classList.remove("hidden");
    const pad = 6;
    const width = menu.offsetWidth || 160;
    const height = menu.offsetHeight || 36;
    let x = event.clientX;
    let y = event.clientY;
    if (x + width > window.innerWidth - pad) {
      x = window.innerWidth - width - pad;
    }
    if (y + height > window.innerHeight - pad) {
      y = window.innerHeight - height - pad;
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });
  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest("#editor-context-menu")) {
      closeEditorContextMenu();
    }
  });
  window.addEventListener("blur", closeEditorContextMenu);
}

const treeContext = {
  path: null,
  type: null,
};

function closeTreeContextMenu() {
  const menu = document.getElementById("tree-context-menu");
  if (menu) {
    menu.classList.add("hidden");
  }
  treeContext.path = null;
  treeContext.type = null;
}

function setupTreeContextMenu() {
  let menu = document.getElementById("tree-context-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "tree-context-menu";
    menu.className = "editor-context-menu hidden";
    menu.innerHTML = `
      <button type="button" data-action="tree-rename">Переименовать</button>
      <button type="button" data-action="tree-delete">Удалить</button>
    `;
    document.body.appendChild(menu);
  }
  ui.tree.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".tree-item");
    if (!row?.dataset.path || String(row.dataset.path).startsWith("untitled:")) {
      closeTreeContextMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    treeContext.path = row.dataset.path;
    treeContext.type = row.dataset.type || "file";
    menu.classList.remove("hidden");
    const pad = 6;
    const width = menu.offsetWidth || 160;
    const height = menu.offsetHeight || 72;
    let x = event.clientX;
    let y = event.clientY;
    if (x + width > window.innerWidth - pad) {
      x = window.innerWidth - width - pad;
    }
    if (y + height > window.innerHeight - pad) {
      y = window.innerHeight - height - pad;
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });
  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest("#tree-context-menu")) {
      closeTreeContextMenu();
    }
  });
  window.addEventListener("blur", closeTreeContextMenu);
}

async function renameTreeEntry(path) {
  if (!path) {
    return;
  }
  const current = basename(path);
  const next = await askText("Переименовать", current);
  if (!next || next.trim() === current) {
    return;
  }
  const data = await api().rename_entry(path, next.trim());
  const tab = tabByPath(path);
  if (tab) {
    const model = state.models.get(path);
    state.models.delete(path);
    tab.path = data.path;
    if (data.language) {
      tab.language = data.language;
    }
    state.models.set(data.path, model);
    if (state.active === path) {
      state.active = data.path;
    }
    if (state.monaco && data.language) {
      state.monaco.editor.setModelLanguage(model, data.language);
    }
    renderTabs();
    updateTitle();
  }
  if (state.root) {
    await refreshTree();
  } else {
    updateWorkspaceLabel();
    paintTree();
  }
  setStatus(`Переименовано: ${basename(data.path)}`);
}

async function deleteTreeEntry(path) {
  if (!path) {
    return;
  }
  const name = basename(path);
  if (!(await askConfirm(`Удалить «${name}»?`))) {
    return;
  }
  const tab = tabByPath(path);
  if (tab?.dirty && !(await askConfirm("Файл изменён. Удалить без сохранения?"))) {
    return;
  }
  if (tab) {
    await closeTab(path, { force: true });
  }
  await api().delete_entry(path);
  if (state.expanded.has(path)) {
    state.expanded.delete(path);
  }
  if (state.root) {
    await refreshTree();
  } else {
    updateWorkspaceLabel();
    paintTree();
  }
  setStatus(`Удалено: ${name}`);
}

function getSelectedSnippetForPiton() {
  if (!state.editor) {
    return null;
  }
  const model = state.editor.getModel();
  const selection = state.editor.getSelection();
  if (!model || !selection || selection.isEmpty()) {
    return null;
  }
  const code = model.getValueInRange(selection);
  if (!code.trim()) {
    return null;
  }
  const tab = activeTab();
  const filename = tab ? basename(tab.path) : "без имени";
  const language = typeof model.getLanguageId === "function" ? model.getLanguageId() : "";
  return { code, filename, language, scope: "selection" };
}

function getEditorSnippetForPiton() {
  if (!state.editor) {
    return null;
  }
  const model = state.editor.getModel();
  if (!model) {
    return null;
  }
  const selection = state.editor.getSelection();
  let code = "";
  let scope = "file";
  if (selection && !selection.isEmpty()) {
    code = model.getValueInRange(selection);
    scope = "selection";
  } else {
    code = model.getValue();
  }
  if (!code.trim()) {
    return null;
  }
  const tab = activeTab();
  const filename = tab ? basename(tab.path) : "без имени";
  const language = typeof model.getLanguageId === "function" ? model.getLanguageId() : "";
  return { code, filename, language, scope };
}

async function analyzeCodeWithPiton({ selectionOnly = false } = {}) {
  const snippet = selectionOnly ? getSelectedSnippetForPiton() : getEditorSnippetForPiton();
  if (!snippet) {
    setStatus(
      selectionOnly ? "Выделите код для анализа" : "Откройте файл с кодом или выделите фрагмент",
      true,
    );
    return;
  }
  openPiton();
  const scopeLabel = snippet.scope === "selection" ? "выделение" : "весь файл";
  const userLine = `Анализ кода: ${snippet.filename} (${scopeLabel})`;
  await runPitonExchange(userLine, (skipCache) =>
    api().piton_analyze_code({
      code: snippet.code,
      filename: snippet.filename,
      language: snippet.language,
      skip_cache: !!skipCache,
    }),
  );
}

async function sendPitonMessage() {
  const input = document.getElementById("piton-input");
  const text = input.value.trim();
  if (!text) {
    return;
  }
  if (state.pitonBusy) {
    setStatus("Piton ещё отвечает. Подожди или нажми «Отмена».", true);
    return;
  }
  input.value = "";
  await runPitonExchange(text, (skipCache) => {
    const messages = state.pitonMessages
      .filter((msg) => !msg.error && !msg.streaming)
      .map((msg) => ({ role: msg.role, content: String(msg.content || "") }));
    return api().piton_start({ messages, skip_cache: !!skipCache });
  });
}

function runEditorAction(id) {
  if (!state.editor) {
    return;
  }
  const action = state.editor.getAction(id);
  if (action) {
    action.run();
    return;
  }
  state.editor.trigger("keyboard", id, null);
}

function findInEditor() {
  if (!state.editor) {
    setStatus("Редактор ещё загружается");
    return;
  }
  if (!state.active) {
    newUntitled();
  }
  showWelcome(false);
  const model = state.editor.getModel();
  if (!model) {
    setStatus("Откройте файл, чтобы искать");
    return;
  }
  state.editor.focus();
  const find = state.editor.getContribution("editor.contrib.findController");
  if (find && typeof find.start === "function") {
    find.start({
      forceRevealReplace: false,
      seedSearchStringFromSelection: "single",
      seedSearchStringFromNonEmptySelection: true,
      seedSearchStringFromGlobalClipboard: false,
      shouldFocus: 1,
      shouldAnimate: true,
      updateSearchScope: false,
    });
  } else {
    state.editor.trigger("keyboard", "actions.find");
  }
  requestAnimationFrame(relabelFindWidget);
  setTimeout(relabelFindWidget, 80);
}

function replaceInEditor() {
  if (!state.active || !state.editor) {
    setStatus("Откройте файл, чтобы искать");
    return;
  }
  state.editor.focus();
  runEditorAction("editor.action.startFindReplaceAction");
  requestAnimationFrame(relabelFindWidget);
  setTimeout(relabelFindWidget, 50);
}

function findNext(back = false) {
  if (!state.active) {
    return;
  }
  runEditorAction(back ? "editor.action.previousMatchFindAction" : "editor.action.nextMatchFindAction");
}

function relabelFindWidget() {
  const widget = document.querySelector(".find-widget");
  if (!widget) {
    return;
  }
  const inputs = widget.querySelectorAll("input, textarea");
  if (inputs[0]) {
    inputs[0].placeholder = "Поиск";
    inputs[0].setAttribute("aria-label", "Поиск");
    inputs[0].setAttribute("title", "Поиск");
  }
}

function commandList() {
  return [
    { title: "Быстрое открытие файла", keys: "Ctrl+P", run: openQuickOpen },
    { title: "Поиск по проекту", keys: "Ctrl+Shift+F", run: openProjectSearch },
    { title: "Поиск", keys: "Ctrl+F", run: findInEditor },
    { title: "Заменить", keys: "Ctrl+H", run: replaceInEditor },
    { title: "Поиск далее", keys: "F3", run: () => findNext(false) },
    { title: "Поиск ранее", keys: "Shift+F3", run: () => findNext(true) },
    { title: "Piton 1.1", keys: "Ctrl+Shift+P", run: openPiton },
    { title: "Piton: анализ кода", keys: "Ctrl+Shift+I", run: analyzeCodeWithPiton },
    { title: "Piton: объяснить ошибку", run: explainTerminalError },
    { title: "Палитра команд", keys: "F1", run: openPalette },
    { title: "Параметры", keys: "Ctrl+,", run: openSettings },
    { title: "Открыть папку", run: openFolder },
    { title: "Открыть файл", keys: "Ctrl+O", run: openFileDialog },
    { title: "Новый текстовый файл", keys: "Ctrl+N", run: newUntitled },
    { title: "Сохранить", keys: "Ctrl+S", run: () => saveTab().catch(() => {}) },
    { title: "Сохранить как", keys: "Ctrl+Shift+S", run: () => saveAs().catch((err) => setStatus(err.message || String(err), true)) },
    { title: "Сохранить все", run: () => saveAll().catch((err) => setStatus(err.message || String(err), true)) },
    { title: "Запустить Python", keys: "F5", run: runActive },
    { title: "Остановить Python", keys: "Shift+F5", run: stopRun },
    {
      title: "Показать терминал",
      keys: "Ctrl+`",
      run: () => {
        setPanelOpen(true);
        showPanel("terminal");
      },
    },
    {
      title: "Новый терминал",
      keys: "Ctrl+Shift+`",
      run: () => {
        setPanelOpen(true);
        showPanel("terminal");
        createTerminal().catch((err) => setStatus(err.message || String(err), true));
      },
    },
    { title: "Новый файл в проекте", run: () => createEntry("file") },
    { title: "Новая папка", run: () => createEntry("dir") },
    { title: "Обновить проводник", run: refreshTree },
    { title: "Закрыть редактор", keys: "Ctrl+F4", run: () => state.active && closeTab(state.active) },
    { title: "Закрыть папку", run: closeFolder },
  ];
}

function closePalette() {
  document.getElementById("overlay").classList.add("hidden");
  state.paletteMode = null;
  state.paletteItems = [];
  if (state.paletteTimer) {
    clearTimeout(state.paletteTimer);
    state.paletteTimer = null;
  }
  if (state.active && state.editor) {
    state.editor.focus();
  }
}

function closeSettings() {
  document.getElementById("settings-overlay").classList.add("hidden");
}

function openSettings() {
  closePalette();
  closePiton();
  closeMenubarMenus();
  document.getElementById("set-font").value = state.settings.fontFamily;
  document.getElementById("set-size").value = String(state.settings.fontSize);
  document.getElementById("set-theme").value = state.settings.theme;
  document.getElementById("set-shell").value = state.settings.shell;
  document.getElementById("set-run-args").value = state.settings.runArgs || "";
  document.getElementById("settings-overlay").classList.remove("hidden");
  document.getElementById("set-font").focus();
  document.getElementById("set-font").select();
}

async function saveSettings() {
  const payload = {
    fontFamily: document.getElementById("set-font").value.trim() || state.settings.fontFamily,
    fontSize: Number(document.getElementById("set-size").value) || 14,
    theme: document.getElementById("set-theme").value,
    shell: document.getElementById("set-shell").value,
    runArgs: document.getElementById("set-run-args").value || "",
  };
  try {
    const data = await api().update_settings(payload);
    state.settings = {
      fontFamily: data.fontFamily || payload.fontFamily,
      fontSize: Number(data.fontSize) || payload.fontSize,
      theme: data.theme || payload.theme,
      shell: data.shell || payload.shell,
      runArgs: data.runArgs != null ? String(data.runArgs) : payload.runArgs,
    };
    applyAppearance();
    const session = activeTerminal();
    if (session?.term) {
      try {
        session.fitAddon?.fit();
        api().term_resize(session.id, session.term.cols, session.term.rows).catch(() => {});
      } catch (_err) {
        /* ignore */
      }
    }
    closeSettings();
    setStatus("Параметры сохранены");
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function filterByQuery(items, query, fields) {
  const q = query.trim().toLowerCase();
  const source = q
    ? items.filter((item) => fields.some((field) => String(item[field] || "").toLowerCase().includes(q)))
    : items;
  return source.slice(0, 80);
}

function renderPalette() {
  const list = document.getElementById("palette-list");
  list.innerHTML = "";
  if (!state.paletteItems.length) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = "Ничего не найдено";
    list.appendChild(empty);
    return;
  }
  state.paletteItems.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-item" + (index === state.paletteIndex ? " active" : "");
    btn.dataset.index = String(index);
    const main = document.createElement("span");
    main.className = "palette-main";
    main.append(item.title);
    if (item.hint) {
      const hint = document.createElement("div");
      hint.className = "dim";
      hint.textContent = item.hint;
      main.appendChild(hint);
    }
    const keys = document.createElement("span");
    keys.className = "dim";
    keys.textContent = item.keys || "";
    btn.append(main, keys);
    list.appendChild(btn);
  });
  list.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
}

function highlightPalette() {
  const items = document.querySelectorAll("#palette-list .palette-item");
  items.forEach((el, index) => {
    el.classList.toggle("active", index === state.paletteIndex);
  });
  document.querySelector("#palette-list .palette-item.active")?.scrollIntoView({ block: "nearest" });
}

function setPaletteItems(items) {
  state.paletteItems = items;
  state.paletteIndex = Math.min(state.paletteIndex, Math.max(0, items.length - 1));
  if (!items.length) {
    state.paletteIndex = 0;
  }
  renderPalette();
}

function refreshPaletteItems() {
  const query = document.getElementById("palette-input").value;
  const mode = state.paletteMode;
  if (mode === "files" || mode === "search") {
    if (state.paletteTimer) {
      clearTimeout(state.paletteTimer);
    }
    state.paletteTimer = setTimeout(() => {
      loadPaletteRemote(query, mode).catch((err) => setStatus(err.message || String(err), true));
    }, mode === "search" ? 180 : 60);
    return;
  }
  setPaletteItems(
    filterByQuery(commandList(), query, ["title", "keys"]).map((item) => ({
      title: item.title,
      keys: item.keys || "",
      run: item.run,
    }))
  );
}

async function loadPaletteRemote(query, mode) {
  if (state.paletteMode !== mode) {
    return;
  }
  if (!state.root) {
    setPaletteItems([
      {
        title: "Сначала откройте папку",
        keys: "",
        run: openFolder,
      },
    ]);
    return;
  }
  if (mode === "search" && String(query || "").trim().length < 2) {
    setPaletteItems([
      {
        title: "Введите минимум 2 символа",
        hint: "Поиск по содержимому файлов проекта",
        keys: "",
        run: () => {},
      },
    ]);
    return;
  }
  if (mode === "files") {
    const data = await api().list_files(query || "");
    if (state.paletteMode !== "files") {
      return;
    }
    setPaletteItems(
      (data.files || []).map((file) => ({
        title: file.name,
        hint: file.relative,
        keys: "",
        run: () => openFile(file.path),
      }))
    );
    return;
  }
  const data = await api().search_files(query || "");
  if (state.paletteMode !== "search") {
    return;
  }
  setPaletteItems(
    (data.hits || []).map((hit) => ({
      title: `${hit.relative}:${hit.line}`,
      hint: hit.preview || "",
      keys: "",
      run: async () => {
        await openFile(hit.path);
        const line = Number(hit.line) || 1;
        state.editor?.revealLineInCenter(line);
        state.editor?.setPosition({ lineNumber: line, column: 1 });
        state.editor?.focus();
      },
    }))
  );
}

function openPaletteShell({ mode, title, placeholder }) {
  closeSettings();
  closePiton();
  closeMenubarMenus();
  state.paletteMode = mode;
  state.paletteIndex = 0;
  document.getElementById("palette-title").textContent = title;
  const input = document.getElementById("palette-input");
  input.placeholder = placeholder;
  input.value = "";
  document.getElementById("overlay").classList.remove("hidden");
  refreshPaletteItems();
  input.focus();
}

function openPalette() {
  openPaletteShell({ mode: "commands", title: "Команды", placeholder: "Команда" });
}

function openQuickOpen() {
  openPaletteShell({ mode: "files", title: "Открыть файл", placeholder: "Имя файла" });
}

function openProjectSearch() {
  openPaletteShell({ mode: "search", title: "Поиск по проекту", placeholder: "Текст в файлах" });
}

function movePalette(delta) {
  if (!state.paletteItems.length) {
    return;
  }
  const next = state.paletteIndex + delta;
  state.paletteIndex = (next + state.paletteItems.length) % state.paletteItems.length;
  highlightPalette();
}

function acceptPalette() {
  const item = state.paletteItems[state.paletteIndex];
  if (!item) {
    return;
  }
  closePalette();
  Promise.resolve(item.run()).catch((err) => setStatus(err.message || String(err), true));
}

async function applyFolderPath(folderPath) {
  if (!folderPath) {
    return;
  }
  if (state.root && folderPath !== state.root && state.tabs.length) {
    if (state.tabs.some((tab) => tab.dirty) && !(await askConfirm("Есть несохранённые файлы. Открыть другую папку и закрыть их?"))) {
      setStatus("Папка не сменена");
      return;
    }
    closeAllTabs();
  }
  try {
    await api().open_folder(folderPath);
  } catch (err) {
    setStatus(err.message || String(err), true);
    return;
  }
  state.expanded.clear();
  await refreshState();
  showWelcome(!state.active);
  setStatus(`Открыто: ${folderPath}`);
  const active = activeTerminal();
  if (active) {
    api().term_cd(active.id, folderPath).catch(() => {});
  }
  scheduleSaveSession();
}

async function openFolder() {
  setStatus("Выберите папку в диалоге…");
  await new Promise((resolve) => setTimeout(resolve, 120));
  let picked;
  try {
    picked = await api().pick_folder();
  } catch (err) {
    setStatus(err.message || String(err), true);
    return;
  }
  if (!picked || !picked.path) {
    setStatus("Папка не выбрана");
    return;
  }
  await applyFolderPath(picked.path);
}

async function openFileDialog() {
  setStatus("Выберите файл в диалоге…");
  await new Promise((resolve) => setTimeout(resolve, 120));
  let picked;
  try {
    picked = await api().pick_file();
  } catch (err) {
    setStatus(err.message || String(err), true);
    return;
  }
  if (!picked.path) {
    setStatus("Файл не выбран");
    return;
  }
  await openFile(picked.path);
}

function newUntitled() {
  if (!state.monaco) {
    return;
  }
  const path = `untitled:${state.untitledSeq++}`;
  const model = state.monaco.editor.createModel("", "plaintext");
  const tab = { path, dirty: true, language: "plaintext", untitled: true };
  state.models.set(path, model);
  state.tabs.push(tab);
  model.onDidChangeContent(() => {
    if (!tab.dirty) {
      tab.dirty = true;
      updateTabChrome();
    }
  });
  renderTabs();
  activateTab(path);
  showWelcome(false);
  setStatus("Новый файл");
}

async function openFile(path) {
  let tab = tabByPath(path);
  if (!tab) {
    let file;
    try {
      file = await api().read_file(path);
    } catch (err) {
      setStatus(err.message || String(err), true);
      return;
    }
    const model = state.monaco.editor.createModel(file.content, file.language);
    state.models.set(path, model);
    tab = { path, dirty: false, language: file.language };
    state.tabs.push(tab);
    model.onDidChangeContent(() => {
      if (!tab.dirty) {
        tab.dirty = true;
        updateTabChrome();
      }
      scheduleDiagnose(tab.path);
    });
    renderTabs();
    diagnoseNow(path).catch((err) => setStatus(err.message || String(err), true));
  }
  activateTab(path);
  showWelcome(false);
  if (!state.root) {
    updateWorkspaceLabel();
    paintTree();
  }
  scheduleSaveSession();
}

function activateTab(path) {
  const tab = tabByPath(path);
  if (!tab || !state.editor) {
    return;
  }
  state.active = path;
  state.editor.setModel(state.models.get(path));
  ui.statusRight.textContent = languageLabel(tab.language);
  applyEditorSuggestForTab(tab);
  updateTabChrome();
  updateTitle();
  scheduleSaveSession();
}

function closeAllTabs() {
  for (const tab of state.tabs) {
    state.models.get(tab.path)?.dispose();
  }
  state.tabs = [];
  state.active = null;
  state.models.clear();
  state.problems = [];
  state.editor?.setModel(null);
  renderProblems();
  renderTabs();
  updateTitle();
  showWelcome(true);
  if (!state.root) {
    updateWorkspaceLabel();
    paintTree();
  }
  scheduleSaveSession();
}

async function closeTab(path, options = {}) {
  const tab = tabByPath(path);
  if (!tab) {
    return;
  }
  if (tab.dirty && !options.force) {
    if (!(await askConfirm(`Сохранить изменения в ${basename(path)} и закрыть вкладку?`))) {
      return;
    }
    try {
      await saveTab(path);
    } catch (err) {
      setStatus(err.message || String(err), true);
      return;
    }
  }
  const model = state.models.get(path);
  model?.dispose();
  state.models.delete(path);
  state.tabs = state.tabs.filter((item) => item.path !== path);
  if (state.active === path) {
    const next = state.tabs[state.tabs.length - 1];
    state.active = next ? next.path : null;
    if (next) {
      activateTab(next.path);
    } else {
      state.editor.setModel(null);
      showWelcome(true);
      renderTabs();
      updateTitle();
    }
  } else {
    renderTabs();
  }
  if (!state.root) {
    updateWorkspaceLabel();
    paintTree();
  }
  scheduleSaveSession();
}

async function saveTab(path = state.active) {
  const tab = tabByPath(path);
  if (!tab) {
    return;
  }
  if (isUntitled(tab)) {
    await saveAs(path);
    return;
  }
  const model = state.models.get(path);
  try {
    await api().write_file(path, model.getValue());
  } catch (err) {
    setStatus(err.message || String(err), true);
    throw err;
  }
  tab.dirty = false;
  updateTabChrome();
  setStatus(`Сохранено ${basename(path)}`);
  await diagnoseNow(tab.path, true);
}

async function saveAs(path = state.active) {
  const tab = tabByPath(path);
  if (!tab) {
    return;
  }
  const suggested = isUntitled(tab) ? "untitled.py" : tab.path;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const picked = await api().pick_save_path(suggested);
  if (!picked.path) {
    return;
  }
  const model = state.models.get(tab.path);
  const saved = await api().write_file(picked.path, model.getValue());
  const oldPath = tab.path;
  state.models.delete(oldPath);
  tab.path = saved.path;
  tab.untitled = false;
  tab.language = saved.language || tab.language;
  tab.dirty = false;
  state.models.set(tab.path, model);
  if (state.monaco) {
    state.monaco.editor.setModelLanguage(model, tab.language);
  }
  if (state.active === oldPath) {
    state.active = tab.path;
  }
  renderTabs();
  updateTitle();
  await refreshTree();
  setStatus(`Сохранено ${basename(tab.path)}`);
  await diagnoseNow(tab.path, true);
}

async function saveAll() {
  for (const tab of [...state.tabs]) {
    if (tab.dirty) {
      await saveTab(tab.path);
    }
  }
}

async function revertFile() {
  const tab = activeTab();
  if (!tab || isUntitled(tab)) {
    return;
  }
  if (tab.dirty && !(await askConfirm("Отменить несохранённые изменения?"))) {
    return;
  }
  const file = await api().read_file(tab.path);
  const model = state.models.get(tab.path);
  model.setValue(file.content);
  tab.dirty = false;
  updateTabChrome();
  await diagnoseNow(tab.path, true);
  setStatus("Файл возвращён с диска");
}

async function closeFolder() {
  if (!state.root) {
    return;
  }
  if (state.tabs.some((tab) => tab.dirty) && !(await askConfirm("Есть несохранённые файлы. Закрыть папку?"))) {
    return;
  }
  closeAllTabs();
  await api().close_folder();
  state.expanded.clear();
  await refreshState();
  showWelcome(true);
  setStatus("Папка закрыта");
  scheduleSaveSession();
}

async function toggleAutoSave() {
  state.autoSave = !state.autoSave;
  await api().set_auto_save(state.autoSave);
  setStatus(state.autoSave ? "Автосохранение включено" : "Автосохранение выключено");
}

let diagnoseTimer = 0;
function scheduleDiagnose(path) {
  clearTimeout(diagnoseTimer);
  diagnoseTimer = setTimeout(() => diagnoseNow(path), 800);
}

async function diagnoseNow(path, force = false) {
  const tab = tabByPath(path);
  const model = state.models.get(path);
  if (!tab || !model) {
    return;
  }
  const content = model.getValue();
  if (!force && content.length > 120000) {
    return;
  }
  if (!force && tab.lastDiag === content) {
    return;
  }
  const seq = ++state.diagnoseSeq;
  let data;
  try {
    data = await api().diagnose(path, content);
  } catch (err) {
    if (seq === state.diagnoseSeq) {
      setStatus(err.message || String(err), true);
    }
    return;
  }
  if (seq !== state.diagnoseSeq || state.active !== path) {
    return;
  }
  tab.lastDiag = content;
  state.problems = data.problems || [];
  renderProblems();
  applyMarkers(path, state.problems);
}

function showPanel(name) {
  state.panel = name;
  document.querySelectorAll(".panel-tab[data-panel]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.panel === name);
  });
  document.getElementById("problems-view").classList.toggle("hidden", name !== "problems");
  document.getElementById("terminal-view").classList.toggle("hidden", name !== "terminal");
  updateTerminalActions();
  syncTerminalPolling();
  if (name === "terminal") {
    refreshTerminalView();
  }
}

function setPanelOpen(open) {
  state.panelOpen = open;
  ui.editorCol.classList.toggle("panel-collapsed", !open);
  syncTerminalPolling();
  if (open && state.panel === "terminal") {
    refreshTerminalView();
  }
}

function shouldPollTerminal() {
  return state.panel === "terminal" && state.panelOpen && !!activeTerminal()?.id;
}

function syncTerminalPolling() {
  if (!shouldPollTerminal()) {
    stopTerminalPolling();
    return;
  }
  startTerminalPolling();
}

function stopTerminalPolling() {
  if (state.terminalPollTimer) {
    clearTimeout(state.terminalPollTimer);
    state.terminalPollTimer = null;
  }
  state.terminalPollBusy = false;
}

function startTerminalPolling() {
  if (state.terminalPollTimer) {
    return;
  }
  const tick = () => {
    state.terminalPollTimer = null;
    if (!shouldPollTerminal() || document.hidden) {
      if (shouldPollTerminal() && !document.hidden) {
        state.terminalPollTimer = setTimeout(tick, 400);
      }
      return;
    }
    if (state.terminalPollBusy) {
      state.terminalPollTimer = setTimeout(tick, 400);
      return;
    }
    const session = activeTerminal();
    if (!session?.id || !session.term) {
      state.terminalPollTimer = setTimeout(tick, 400);
      return;
    }
    const bridge = window.pywebview && window.pywebview.api;
    if (!bridge) {
      state.terminalPollTimer = setTimeout(tick, 400);
      return;
    }
    state.terminalPollBusy = true;
    api()
      .term_poll(session.id)
      .then((chunk) => {
        if (chunk?.data) {
          const text = String(chunk.data);
          session.term.write(text.length > 48000 ? text.slice(-48000) : text);
        }
      })
      .catch(() => {})
      .finally(() => {
        state.terminalPollBusy = false;
        if (shouldPollTerminal() && !document.hidden) {
          state.terminalPollTimer = setTimeout(tick, 400);
        }
      });
  };
  state.terminalPollTimer = setTimeout(tick, 400);
}

function shellLabel(shellName) {
  const name = String(shellName || "powershell").toLowerCase();
  if (name.includes("pwsh")) {
    return "pwsh";
  }
  if (name.includes("cmd")) {
    return "cmd";
  }
  return "PowerShell";
}

function activeTerminal() {
  return state.terminals.find((item) => item.id === state.activeTerminalId) || null;
}

function updateTerminalActions() {
  const actions = document.getElementById("terminal-panel-actions");
  const killBtn = document.getElementById("kill-terminal-btn");
  const panelTabs = document.querySelector(".panel-tabs");
  if (actions) {
    actions.classList.toggle("hidden", state.panel !== "terminal");
  }
  if (panelTabs) {
    panelTabs.classList.toggle("terminal-mode", state.panel === "terminal");
  }
  if (killBtn) {
    killBtn.disabled = !activeTerminal()?.id;
  }
  updateTerminalEmptyState();
}

function updateTerminalEmptyState() {
  const empty = document.getElementById("terminal-empty");
  const hosts = ui.terminalHosts;
  if (!empty || !hosts) {
    return;
  }
  const showEmpty = state.panel === "terminal" && !state.terminals.length;
  empty.classList.toggle("hidden", !showEmpty);
  hosts.classList.toggle("hidden", showEmpty);
}

function refreshTerminalView() {
  updateTerminalEmptyState();
  const session = activeTerminal();
  if (!session) {
    return;
  }
  requestAnimationFrame(() => {
    try {
      session.fitAddon?.fit();
      if (session.term) {
        api().term_resize(session.id, session.term.cols, session.term.rows).catch(() => {});
        if (state.panel === "terminal" && state.panelOpen) {
          session.term.focus();
        }
      }
    } catch (_err) {
      /* ignore */
    }
  });
}

function disposeTerminalSession(session) {
  if (!session) {
    return;
  }
  try {
    session.term?.dispose();
  } catch (_err) {
    /* ignore */
  }
  session.host?.remove();
  if (session.id) {
    api().term_close(session.id).catch(() => {});
  }
}

function activateTerminal(sessionId) {
  state.activeTerminalId = sessionId;
  ui.terminalHosts.querySelectorAll(".terminal-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.sessionId === sessionId);
  });
  syncTerminalPolling();
  updateTerminalActions();
  const session = activeTerminal();
  if (!session) {
    return;
  }
  requestAnimationFrame(() => {
    try {
      session.fitAddon?.fit();
      if (session.term) {
        api().term_resize(session.id, session.term.cols, session.term.rows).catch(() => {});
        if (state.panel === "terminal" && state.panelOpen) {
          session.term.focus();
        }
      }
    } catch (_err) {
      /* ignore */
    }
  });
}

async function createTerminal() {
  if (state.terminalCreating) {
    return null;
  }
  if (!window.Terminal) {
    throw new Error("xterm.js не загружен");
  }
  if (!ui.terminalHosts) {
    throw new Error("Не найден контейнер терминала");
  }

  state.terminalCreating = true;
  setStatus("Запуск терминала…");

  let session = null;
  try {
    for (const existing of [...state.terminals]) {
      if (existing.id) {
        closeTerminal(existing.id);
      } else {
        disposeTerminalSession(existing);
        state.terminals = state.terminals.filter((item) => item !== existing);
      }
    }

    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const host = document.createElement("div");
    host.className = "terminal-xterm-host";
    pane.appendChild(host);
    ui.terminalHosts.appendChild(pane);

    const term = new window.Terminal({
      cursorBlink: true,
      fontSize: state.settings.fontSize,
      fontFamily: state.settings.fontFamily,
      theme: termTheme(),
      scrollback: 5000,
    });
    const Fit = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
    const fitAddon = new Fit();
    term.loadAddon(fitAddon);
    term.open(host);
    fitAddon.fit();

    session = {
      id: "",
      title: "",
      term,
      fitAddon,
      host: pane,
    };
    state.terminals.push(session);

    const created = await api().term_create(term.cols, term.rows);
    session.id = created.sessionId;
    pane.dataset.sessionId = session.id;
    const base = shellLabel(created.shell || state.settings.shell);
    const same = state.terminals.filter((item) => item !== session && item.title.startsWith(base)).length;
    session.title = same ? `${base} (${same + 2})` : base;

    term.onData((data) => {
      api().term_write(session.id, data).catch(() => {});
    });

    state.activeTerminalId = session.id;
    activateTerminal(session.id);
    syncTerminalPolling();
    updateTerminalEmptyState();
    setStatus("Терминал готов");
    return session;
  } catch (err) {
    if (session) {
      state.terminals = state.terminals.filter((item) => item !== session);
      disposeTerminalSession(session);
    }
    updateTerminalEmptyState();
    throw err;
  } finally {
    state.terminalCreating = false;
  }
}

function closeTerminal(sessionId) {
  const index = state.terminals.findIndex((item) => item.id === sessionId);
  if (index < 0) {
    return;
  }
  const session = state.terminals[index];
  disposeTerminalSession(session);
  state.terminals.splice(index, 1);
  if (state.activeTerminalId === sessionId) {
    const next = state.terminals[Math.min(index, state.terminals.length - 1)];
    state.activeTerminalId = next ? next.id : null;
  }
  if (state.activeTerminalId) {
    activateTerminal(state.activeTerminalId);
  } else {
    syncTerminalPolling();
    updateTerminalActions();
  }
}

async function ensureLiveTerminal() {
  if (!state.terminals.length) {
    await createTerminal();
    return;
  }
  refreshTerminalView();
}

async function runActive() {
  const tab = activeTab();
  if (!canRun(tab)) {
    return;
  }
  await saveTab(tab.path);
  const runArgs = String(state.settings.runArgs || "");
  setPanelOpen(true);
  showPanel("terminal");
  await ensureLiveTerminal();
  const session = activeTerminal();
  if (!session) {
    return;
  }
  const result = await api().term_run_python(session.id, tab.path, runArgs);
  if (result?.sessionId && result.sessionId !== session.id) {
    session.id = result.sessionId;
    if (session.host) {
      session.host.dataset.sessionId = result.sessionId;
    }
    state.activeTerminalId = result.sessionId;
  }
  setStatus(runArgs ? `Запуск с аргументами: ${runArgs}` : "Запуск в терминале");
}

function getTerminalErrorText() {
  const session = activeTerminal();
  if (!session?.term) {
    return "";
  }
  const selected = String(session.term.getSelection?.() || "").trim();
  if (selected) {
    return selected.slice(0, 8000);
  }
  try {
    const buf = session.term.buffer.active;
    const end = buf.baseY + buf.cursorY;
    const start = Math.max(0, end - 80);
    const lines = [];
    for (let i = start; i <= end; i += 1) {
      const line = buf.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join("\n").trim().slice(-4000);
  } catch (_err) {
    return "";
  }
}

async function explainTerminalError() {
  const text = getTerminalErrorText();
  if (!text) {
    setStatus("Нет текста в терминале. Выделите ошибку или запустите программу", true);
    return;
  }
  const tab = activeTab();
  const filename = tab && !isUntitled(tab) ? basename(tab.path) : "";
  openPiton();
  await runPitonExchange("Объясни ошибку из терминала", (skipCache) =>
    api().piton_explain_error({ text, filename, skip_cache: !!skipCache }),
  );
}

async function stopRun() {
  if (!canRun(activeTab())) {
    return;
  }
  setPanelOpen(true);
  showPanel("terminal");
  await ensureLiveTerminal();
  const session = activeTerminal();
  if (!session?.id) {
    setStatus("Нет терминала", true);
    return;
  }
  await api().term_interrupt(session.id);
  setStatus("Программа остановлена");
}

async function createEntry(kind) {
  if (!state.root) {
    await openFolder();
    if (!state.root) {
      return;
    }
  }
  const relative = await askText(
    kind === "dir" ? "Новая папка" : "Новый файл",
    "",
    kind === "dir" ? "например homework" : "например main.py",
  );
  if (!relative) {
    return;
  }
  try {
    const created = await api().create_entry(relative, kind);
    await refreshTree();
    if (kind !== "dir") {
      await openFile(created.path);
    }
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function closeFileMenu() {
  const menu = document.getElementById("file-menu");
  if (menu) {
    menu.hidden = true;
  }
}

function closeEditMenu() {
  const menu = document.getElementById("edit-menu");
  if (menu) {
    menu.hidden = true;
  }
}

function closeTerminalMenu() {
  const menu = document.getElementById("terminal-menu");
  if (menu) {
    menu.hidden = true;
  }
}

function closeMenubarMenus() {
  closeFileMenu();
  closeEditMenu();
  closeTerminalMenu();
}

function fillTerminalMenu() {
  const setDisabled = (action, off) => {
    document.querySelectorAll(`#terminal-menu [data-action="${action}"]`).forEach((el) => {
      el.disabled = !!off;
    });
  };
  setDisabled("close-terminal", !activeTerminal()?.id);
}

function fillFileMenu() {
  const tab = activeTab();
  const setDisabled = (action, off) => {
    document.querySelectorAll(`#file-menu [data-action="${action}"]`).forEach((el) => {
      el.disabled = !!off;
    });
  };
  setDisabled("save", !tab);
  setDisabled("save-as", !tab);
  setDisabled("save-all", !state.tabs.some((item) => item.dirty));
  setDisabled("revert", !tab || isUntitled(tab));
  setDisabled("close-editor", !tab);
  setDisabled("close-folder", !state.root);
  setDisabled("new-file", !state.root);
  document.getElementById("autosave-item").classList.toggle("checked", state.autoSave);
  const recent = document.getElementById("recent-list");
  const recentFiles = document.getElementById("recent-files-list");
  recent.innerHTML = "";
  if (recentFiles) {
    recentFiles.innerHTML = "";
  }
  api()
    .get_state()
    .then((data) => {
      for (const path of data.recent || []) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.action = "open-recent";
        btn.dataset.path = path;
        btn.textContent = path;
        recent.appendChild(btn);
      }
      if (!recentFiles) {
        return;
      }
      for (const path of data.recentFiles || []) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.action = "open-recent-file";
        btn.dataset.path = path;
        btn.textContent = path;
        recentFiles.appendChild(btn);
      }
    })
    .catch(() => {});
}

function wireActions() {
  const fileMenuBtn = document.getElementById("file-menu-btn");
  if (fileMenuBtn) {
    fileMenuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = document.getElementById("file-menu");
      closeEditMenu();
      closeTerminalMenu();
      if (menu.hidden) {
        fillFileMenu();
        menu.hidden = false;
      } else {
        menu.hidden = true;
      }
    });
  }
  const editMenuBtn = document.getElementById("edit-menu-btn");
  if (editMenuBtn) {
    editMenuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = document.getElementById("edit-menu");
      closeFileMenu();
      closeTerminalMenu();
      menu.hidden = !menu.hidden;
    });
  }
  const terminalMenuBtn = document.getElementById("terminal-menu-btn");
  if (terminalMenuBtn) {
    terminalMenuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = document.getElementById("terminal-menu");
      closeFileMenu();
      closeEditMenu();
      if (menu.hidden) {
        fillTerminalMenu();
        menu.hidden = false;
      } else {
        menu.hidden = true;
      }
    });
  }
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-root")) {
      closeMenubarMenus();
    }
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    const button = target && target.closest("[data-action]");
    if (!button || button.disabled) {
      return;
    }
    if (button.closest("#file-menu") || button.closest("#edit-menu") || button.closest("#terminal-menu")) {
      closeMenubarMenus();
    }
    const action = button.dataset.action;
    const actions = {
      "open-folder": openFolder,
      "open-file": openFileDialog,
      "open-recent": () => applyFolderPath(button.dataset.path),
      "open-recent-file": () => openFile(button.dataset.path).catch((err) => setStatus(err.message || String(err), true)),
      "new-untitled": newUntitled,
      "new-window": () => api().new_window().catch((err) => setStatus(err.message, true)),
      save: () => saveTab().catch(() => {}),
      "save-as": () => saveAs().catch((err) => setStatus(err.message || String(err), true)),
      "save-all": () => saveAll().catch((err) => setStatus(err.message || String(err), true)),
      "toggle-autosave": toggleAutoSave,
      revert: () => revertFile().catch((err) => setStatus(err.message || String(err), true)),
      "close-editor": () => closeTab(state.active),
      "close-folder": closeFolder,
      quit: async () => {
        clearTimeout(state.sessionSaveTimer);
        try {
          await saveSession();
        } catch (_) {}
        return api().quit();
      },
      "window-minimize": () => api().window_minimize().catch(() => {}),
      "window-maximize": () => api().window_toggle_maximize().catch(() => {}),
      "window-close": async () => {
        clearTimeout(state.sessionSaveTimer);
        try {
          await saveSession();
        } catch (_) {}
        return api().window_close().catch(() => api().quit());
      },
      run: runActive,
      "stop-run": () => stopRun().catch((err) => setStatus(err.message || String(err), true)),
      "tree-rename": () => {
        const path = treeContext.path;
        closeTreeContextMenu();
        renameTreeEntry(path).catch((err) => setStatus(err.message || String(err), true));
      },
      "tree-delete": () => {
        const path = treeContext.path;
        closeTreeContextMenu();
        deleteTreeEntry(path).catch((err) => setStatus(err.message || String(err), true));
      },
      "new-file": () => createEntry("file"),
      "new-folder": () => createEntry("dir"),
      "refresh-tree": refreshTree,
      "toggle-panel": () => setPanelOpen(!state.panelOpen),
      "new-terminal": () => {
        setPanelOpen(true);
        showPanel("terminal");
        createTerminal().catch((err) => setStatus(err.message || String(err), true));
      },
      "show-terminal": () => {
        setPanelOpen(true);
        showPanel("terminal");
      },
      "close-terminal": () => {
        const session = activeTerminal();
        if (session?.id) {
          closeTerminal(session.id);
        }
      },
      "focus-explorer": () => {},
      "find-in-editor": findInEditor,
      "replace-in-editor": replaceInEditor,
      "quick-open": openQuickOpen,
      "project-search": openProjectSearch,
      "explain-error": () => explainTerminalError().catch((err) => setStatus(err.message || String(err), true)),
      "edit-undo": () => runEditorAction("undo"),
      "edit-redo": () => runEditorAction("redo"),
      "edit-cut": () => runEditorAction("editor.action.clipboardCutAction"),
      "edit-copy": () => runEditorAction("editor.action.clipboardCopyAction"),
      "edit-paste": () => runEditorAction("editor.action.clipboardPasteAction"),
      "command-palette": openPalette,
      "open-settings": openSettings,
      "open-piton": openPiton,
      "close-piton": closePiton,
      "clear-piton": clearPiton,
      "cancel-piton": cancelPiton,
      "retry-piton": () => retryPiton().catch((err) => setStatus(err.message || String(err), true)),
      "analyze-code": analyzeCodeWithPiton,
      "analyze-selection": () => {
        closeEditorContextMenu();
        analyzeCodeWithPiton({ selectionOnly: true }).catch((err) =>
          setStatus(err.message || String(err), true),
        );
      },
      "save-settings": () => saveSettings().catch((err) => setStatus(err.message || String(err), true)),
      "close-settings": closeSettings,
    };
    try {
      const run = actions[action];
      if (run) {
        Promise.resolve(run()).catch((err) => setStatus(err.message || String(err), true));
      }
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });
  document.querySelectorAll(".panel-tab[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setPanelOpen(true);
      showPanel(btn.dataset.panel);
    });
  });
  document.getElementById("overlay").addEventListener("click", (event) => {
    if (event.target.id === "overlay") {
      closePalette();
    }
  });
  document.getElementById("settings-overlay").addEventListener("click", (event) => {
    if (event.target.id === "settings-overlay") {
      closeSettings();
    }
  });
  document.getElementById("piton-overlay").addEventListener("click", (event) => {
    if (event.target.id === "piton-overlay") {
      closePiton();
    }
  });
  document.getElementById("piton-form").addEventListener("submit", (event) => {
    event.preventDefault();
    sendPitonMessage().catch((err) => setStatus(err.message || String(err), true));
  });
  document.getElementById("piton-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendPitonMessage().catch((err) => setStatus(err.message || String(err), true));
    }
  });
  document.getElementById("palette-input").addEventListener("input", () => {
    state.paletteIndex = 0;
    refreshPaletteItems();
  });
  document.getElementById("palette-list").addEventListener("mousedown", (event) => {
    if (event.target.closest(".palette-item")) {
      event.preventDefault();
    }
  });
  document.getElementById("palette-list").addEventListener("click", (event) => {
    const item = event.target.closest(".palette-item");
    if (!item) {
      return;
    }
    state.paletteIndex = Number(item.dataset.index);
    acceptPalette();
  });
  document.getElementById("palette-list").addEventListener("mousemove", (event) => {
    const item = event.target.closest(".palette-item");
    if (!item) {
      return;
    }
    const index = Number(item.dataset.index);
    if (index !== state.paletteIndex) {
      state.paletteIndex = index;
      highlightPalette();
    }
  });
  document.addEventListener(
    "keydown",
    (event) => {
    if (!event.key) {
      return;
    }
    if (overlayOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        movePalette(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        movePalette(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        acceptPalette();
      }
      return;
    }
    if (settingsOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
      } else if (event.key === "Enter") {
        event.preventDefault();
        saveSettings().catch((err) => setStatus(err.message || String(err), true));
      }
      return;
    }
    if (pitonOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePiton();
      }
      return;
    }
    if (event.key === "Escape") {
      closeEditorContextMenu();
    }
    if (isPitonKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      openPiton();
    } else if (isPaletteKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      openQuickOpen();
    } else if (event.key === "F1") {
      event.preventDefault();
      event.stopPropagation();
      openPalette();
    } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      openProjectSearch();
    } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveAs().catch(() => {});
    } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      api().new_window().catch((err) => setStatus(err.message, true));
    } else if (event.ctrlKey && event.key === ",") {
      event.preventDefault();
      event.stopPropagation();
      openSettings();
    } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      findInEditor();
    } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "h") {
      event.preventDefault();
      event.stopPropagation();
      replaceInEditor();
    } else if (event.key === "F3") {
      event.preventDefault();
      event.stopPropagation();
      findNext(event.shiftKey);
    } else if (event.ctrlKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveTab().catch(() => {});
    } else if (event.ctrlKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      newUntitled();
    } else if (event.ctrlKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      openFileDialog();
    } else if (event.key === "F5") {
      if (!canRun(activeTab())) {
        return;
      }
      event.preventDefault();
      runActive();
    } else if (event.shiftKey && event.key === "F5") {
      if (!canRun(activeTab())) {
        return;
      }
      event.preventDefault();
      stopRun().catch((err) => setStatus(err.message || String(err), true));
    } else if (event.ctrlKey && event.key === "F4") {
      event.preventDefault();
      if (state.active) {
        closeTab(state.active);
      }
    } else if (event.ctrlKey && event.shiftKey && event.key === "`") {
      event.preventDefault();
      setPanelOpen(true);
      showPanel("terminal");
      createTerminal().catch((err) => setStatus(err.message || String(err), true));
    } else if (event.ctrlKey && event.key === "`") {
      event.preventDefault();
      setPanelOpen(!state.panelOpen);
      if (state.panelOpen) {
        showPanel("terminal");
      }
    } else if (event.key === "Escape") {
      closeMenubarMenus();
    }
    },
    false
  );
}

function setupSashes() {
  const shell = document.querySelector(".shell");
  const side = document.getElementById("sash-side");
  const panel = document.getElementById("sash-panel");
  let drag = null;
  side.addEventListener("mousedown", () => {
    drag = { type: "side" };
  });
  panel.addEventListener("mousedown", () => {
    drag = { type: "panel" };
  });
  window.addEventListener("mouseup", () => {
    drag = null;
    side.classList.remove("dragging");
    panel.classList.remove("dragging");
    if (state.panel === "terminal") {
      refreshTerminalView();
    }
  });
  window.addEventListener("mousemove", (event) => {
    if (!drag) {
      return;
    }
    if (drag.type === "side") {
      side.classList.add("dragging");
      const width = Math.min(480, Math.max(180, event.clientX - 48));
      shell.style.setProperty("--sidebar", `${width}px`);
    } else {
      panel.classList.add("dragging");
      const fromBottom = window.innerHeight - event.clientY - 22;
      const height = Math.min(400, Math.max(90, fromBottom));
      document.querySelector(".editor-col").style.setProperty("--panel", `${height}px`);
      setPanelOpen(true);
    }
  });
}

function loadScript(src, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    const timer = setTimeout(() => {
      el.remove();
      reject(new Error("Таймаут загрузки: " + src));
    }, timeoutMs);
    el.src = src;
    el.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    el.onerror = () => {
      clearTimeout(timer);
      reject(new Error(src));
    };
    document.head.appendChild(el);
  });
}

async function setupMonaco() {
  const cdnVs = "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs";
  let vs = "monaco/vs";
  try {
    await loadScript("monaco/vs/loader.js");
  } catch {
    vs = cdnVs;
    await loadScript(`${cdnVs}/loader.min.js`);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Редактор не загрузился")), 20000);
    window.require.config({
      paths: { vs },
    });
    window.MonacoEnvironment = {
      getWorkerUrl() {
        let base = String(vs || "").replace(/\/?$/, "/");
        try {
          base = new URL(base, window.location.href).href;
        } catch (_err) {
          /* keep relative */
        }
        if (!base.endsWith("/")) {
          base += "/";
        }
        const worker = new URL("base/worker/workerMain.js", base).href;
        const src =
          "self.MonacoEnvironment={baseUrl:" +
          JSON.stringify(base) +
          "};importScripts(" +
          JSON.stringify(worker) +
          ");";
        return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      },
    };
    window.require(["vs/editor/editor.main"], () => {
      clearTimeout(timer);
      state.monaco = window.monaco;
      state.editor = window.monaco.editor.create(document.getElementById("monaco"), {
        theme: "vs-dark",
        automaticLayout: true,
        fontSize: 14,
        fontFamily: "Consolas, 'Cascadia Mono', monospace",
        minimap: { enabled: false },
        smoothScrolling: false,
        cursorBlinking: "solid",
        padding: { top: 8 },
        renderLineHighlight: "line",
        quickSuggestions: false,
        wordBasedSuggestions: "off",
        parameterHints: { enabled: false },
        hover: { enabled: true, delay: 400 },
        occurrencesHighlight: false,
        links: false,
        folding: false,
        renderWhitespace: "none",
        find: {
          seedSearchStringFromSelection: "always",
          addExtraSpaceOnTop: false,
          autoFindInSelection: "never",
        },
        model: null,
      });
      registerEditorShortcuts();
      registerPythonCompletions();
      resolve();
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function bootBackend() {
  setStatus("Загрузка редактора…");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const raw = window.pywebview && window.pywebview.api;
    if (raw && (typeof raw.get_state === "function" || typeof raw.state === "function")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const raw = window.pywebview && window.pywebview.api;
  if (!raw || (typeof raw.get_state !== "function" && typeof raw.state !== "function")) {
    throw new Error("Окно не подключилось. Закрой программу и запусти FC.bat");
  }
  try {
    await setupMonaco();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
  try {
    await refreshState();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
  try {
    await restoreSession();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
  showWelcome(!state.active);
  if (state.monaco && !state.root && !state.tabs.length) {
    setStatus("Откройте папку, чтобы начать");
  } else if (state.monaco && state.root && !state.tabs.length) {
    setStatus(`Открыто: ${state.root}`);
  }
  hideSplash();
  reportUi();
}

function reportUi() {
  try {
    const statusbar = document.querySelector(".statusbar");
    api().ui_report({
      ready: true,
      status: (ui.statusLeft && ui.statusLeft.textContent) || "",
      error: !!(statusbar && statusbar.classList.contains("error")),
      tabCount: (state.tabs || []).length,
      tabNames: (state.tabs || []).map((tab) => basename(tab.path)),
      root: state.root || null,
    }).catch(() => {});
  } catch (_) {
    /* bridge not ready */
  }
}

const splashShownAt = Date.now();

function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash || splash.classList.contains("splash-hide")) {
    return;
  }
  const wait = Math.max(0, 700 - (Date.now() - splashShownAt));
  setTimeout(() => {
    splash.classList.add("splash-hide");
    splash.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      if (splash.parentNode) {
        splash.remove();
      }
    }, 400);
  }, wait);
}

let uiShellReady = false;
let backendBootStarted = false;

function initShell() {
  if (uiShellReady) {
    return;
  }
  uiShellReady = true;
  wireActions();
  bindPitonHotkeys();
  setupEditorContextMenu();
  setupTreeContextMenu();
  setupSashes();
  const titlebar = document.querySelector(".titlebar");
  if (titlebar) {
    titlebar.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, .menu, .win-controls, a, input")) {
        return;
      }
      const bridge = window.pywebview && window.pywebview.api;
      if (bridge && typeof bridge.window_toggle_maximize === "function") {
        bridge.window_toggle_maximize().catch(() => {});
      }
    });
  }
  showPanel("problems");
  renderProblems();
  showWelcome(true);
  setStatus("Forge Code готов");
  if (!state.autoSaveTimer) {
    state.autoSaveTimer = setInterval(() => {
      if (!state.autoSave) {
        return;
      }
      for (const tab of state.tabs) {
        if (tab.dirty && !isUntitled(tab)) {
          saveTab(tab.path).catch(() => {});
        }
      }
    }, 2000);
  }
}

function bootBackendOnce() {
  if (backendBootStarted) {
    return;
  }
  backendBootStarted = true;
  bootBackend().catch((err) => {
    console.error(err);
    setStatus(err.message || String(err), true);
    hideSplash();
    reportUi();
  });
}

function start() {
  initShell();
  setTimeout(hideSplash, 8000);
  const ready = () => window.pywebview && window.pywebview.api;
  if (ready()) {
    bootBackendOnce();
    return;
  }
  setStatus("Подключение…");
  window.addEventListener(
    "pywebviewready",
    () => {
      bootBackendOnce();
    },
    { once: true },
  );
  setTimeout(() => {
    if (!backendBootStarted && ready()) {
      bootBackendOnce();
    }
  }, 300);
}

start();
