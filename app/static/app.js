(function () {
  "use strict";

  const LEGACY_KEY = "daily-seal-v1";
  const PREVIEW_KEY = "daily-seal-owner-view";
  const SHANGHAI_TZ = "Asia/Shanghai";
  const MAX_PROOF_FILE_BYTES = 10 * 1024 * 1024;
  const PROOF_FILE_RULES = Object.freeze({
    jpg: { label: "JPG", image: true },
    jpeg: { label: "JPG", image: true },
    png: { label: "PNG", image: true },
    webp: { label: "WebP", image: true },
    pdf: { label: "PDF", image: false },
    txt: { label: "TXT", image: false },
    csv: { label: "CSV", image: false },
    docx: { label: "DOCX", image: false },
    xlsx: { label: "XLSX", image: false },
    pptx: { label: "PPTX", image: false },
  });
  const PROOF_MIME_RULES = Object.freeze({
    "image/jpeg": PROOF_FILE_RULES.jpg,
    "image/png": PROOF_FILE_RULES.png,
    "image/webp": PROOF_FILE_RULES.webp,
    "application/pdf": PROOF_FILE_RULES.pdf,
    "text/plain": PROOF_FILE_RULES.txt,
    "text/csv": PROOF_FILE_RULES.csv,
    "application/csv": PROOF_FILE_RULES.csv,
    "text/comma-separated-values": PROOF_FILE_RULES.csv,
    "application/vnd.ms-excel": PROOF_FILE_RULES.csv,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": PROOF_FILE_RULES.docx,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": PROOF_FILE_RULES.xlsx,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": PROOF_FILE_RULES.pptx,
  });

  const state = {
    csrfToken: "",
    registrationOpen: false,
    user: null,
    tasks: [],
    stats: {},
    publicPoms: {},
    activeStage: null,
    stageYears: {},
    mode: "visitor",
    historyYear: Number(dateKeyInShanghai().slice(0, 4)),
    visitorHistoryYear: Number(dateKeyInShanghai().slice(0, 4)),
    ownerHistoryExpanded: false,
    visitorHistoryLimit: 8,
    selectedOwnerDate: "",
    selectedVisitorDate: "",
    proofPreviewUrl: "",
    stageImagePreviewUrl: "",
    forcedPasswordChange: false,
    confirmResolver: null,
    focusSaveTimer: null,
    renderedDate: dateKeyInShanghai(),
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function fileExtension(name) {
    const match = typeof name === "string" ? name.trim().match(/\.([a-z0-9]+)$/i) : null;
    return match ? match[1].toLowerCase() : "";
  }

  function proofFileInfo(file) {
    const extension = fileExtension(file && file.name);
    const mime = typeof (file && file.type) === "string" ? file.type.trim().toLowerCase() : "";
    const extensionRule = extension ? PROOF_FILE_RULES[extension] : null;
    const rule = extensionRule;
    return {
      allowed: Boolean(rule),
      extension,
      mime,
      label: rule ? rule.label : "FILE",
      isImage: Boolean(rule && rule.image),
    };
  }

  function formatFileSize(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function proofAssetUrl(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    try {
      const parsed = new URL(raw, window.location.origin);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch (_error) {
      return "";
    }
  }

  function proofAttachment(record) {
    if (!record || typeof record !== "object") return null;
    const url = proofAssetUrl(record.proofFileUrl || record.proofImageUrl);
    if (!url) return null;
    const name = typeof record.proofFileName === "string" && record.proofFileName.trim()
      ? record.proofFileName.trim()
      : (record.proofImageUrl ? "完成证明图片.jpg" : "完成附件");
    const mime = typeof record.proofFileMime === "string" ? record.proofFileMime.trim().toLowerCase() : "";
    const rule = PROOF_MIME_RULES[mime] || PROOF_FILE_RULES[fileExtension(name)] || null;
    const legacyImage = Boolean(record.proofImageUrl && !record.proofFileMime);
    return {
      url,
      name,
      mime,
      size: record.proofFileSize !== null
        && record.proofFileSize !== ""
        && Number.isFinite(Number(record.proofFileSize))
        ? Number(record.proofFileSize)
        : null,
      label: rule ? rule.label : (legacyImage ? "JPG" : "FILE"),
      isImage: Boolean((rule && rule.image) || mime.startsWith("image/") || legacyImage),
    };
  }

  function hasProofAttachment(record) {
    return Boolean(proofAttachment(record));
  }

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }

  function dateKeyInShanghai() {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: SHANGHAI_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function shiftDate(key, amount) {
    const value = new Date(`${key}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + amount);
    return value.toISOString().slice(0, 10);
  }

  function dateLabel(key, options) {
    const value = new Date(`${key}T04:00:00Z`);
    return new Intl.DateTimeFormat("zh-CN", Object.assign({
      timeZone: SHANGHAI_TZ,
      month: "long",
      day: "numeric",
      weekday: "short",
    }, options || {})).format(value);
  }

  function completionTime(value) {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: SHANGHAI_TZ,
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
  }

  function taskMap() {
    return new Map(state.tasks.map((task) => [task.date, task]));
  }

  function taskFor(key) {
    return state.tasks.find((task) => task.date === key) || null;
  }

  function taskResultStatus(task) {
    if (!task) return "pending";
    if (["completed", "incomplete"].includes(task.resultStatus)) return task.resultStatus;
    return task.done ? "completed" : "pending";
  }

  function taskHasResult(task) {
    return taskResultStatus(task) !== "pending";
  }

  function taskCompletionPercent(task) {
    const status = taskResultStatus(task);
    if (status === "completed") return 100;
    if (status === "pending") return 0;
    const value = Number.parseInt(task && task.completionPercent, 10);
    return Number.isInteger(value) ? Math.min(99, Math.max(0, value)) : 0;
  }

  function taskResultNote(task) {
    if (!task) return "";
    if (typeof task.resultNote === "string" && task.resultNote.trim()) return task.resultNote.trim();
    return typeof task.proofText === "string" ? task.proofText.trim() : "";
  }

  function taskProgressLevel(task) {
    if (!taskHasResult(task)) return 0;
    const percent = taskCompletionPercent(task);
    if (percent === 0) return 0;
    if (percent < 25) return 1;
    if (percent < 50) return 2;
    if (percent < 75) return 3;
    if (percent < 100) return 4;
    return 5;
  }

  function taskResultLabel(task, includePercent) {
    const status = taskResultStatus(task);
    if (status === "completed") return includePercent ? "已完成 · 100%" : "已完成";
    if (status === "incomplete") {
      return includePercent ? `未完成 · ${taskCompletionPercent(task)}%` : "未完成";
    }
    return "待反馈";
  }

  function publicPomsFor(key) {
    const parsed = Number.parseInt(state.publicPoms[key], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  function statsFor(key) {
    const value = state.stats[key];
    const source = value && typeof value === "object" ? value : {};
    const parsedPublicPoms = publicPomsFor(key);
    const parsedPrivatePoms = Number.parseInt(source.poms, 10);
    const poms = parsedPublicPoms > 0 ? parsedPublicPoms : parsedPrivatePoms;
    return {
      poms: Number.isInteger(poms) && poms > 0 ? poms : 0,
      note: typeof source.note === "string" ? source.note : "",
      distractions: typeof source.distractions === "string" ? source.distractions : "",
    };
  }

  function canBuildPrivateRecords(scope) {
    return Boolean(scope === "owner" && state.user && state.user.role === "owner");
  }

  function canViewPrivateRecordDetails(scope) {
    return canBuildPrivateRecords(scope) && state.mode === "owner";
  }

  function privateRecordFor(key) {
    const value = state.stats[key];
    const source = value && typeof value === "object" ? value : {};
    const distractions = typeof source.distractions === "string" ? source.distractions.trim() : "";
    const note = typeof source.note === "string" ? source.note.trim() : "";
    return { distractions, note, hasContent: Boolean(distractions || note) };
  }

  function stageDate(value) {
    if (typeof value !== "string") return "";
    const key = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : "";
  }

  function stageStartDate(stage) {
    return stage ? stageDate(stage.startDate || stage.startedAt) : "";
  }

  function stageCompletionDate(stage) {
    return stage ? stageDate(stage.completionDate || stage.completedAt) : "";
  }

  function inclusiveDays(startKey, endKey) {
    if (!startKey || !endKey) return 0;
    const start = Date.parse(`${startKey}T12:00:00Z`);
    const end = Date.parse(`${endKey}T12:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return Math.floor((end - start) / 86400000) + 1;
  }

  function stageDuration(stage, endKey) {
    if (stage && Number.isInteger(stage.durationDays) && stage.durationDays > 0) return stage.durationDays;
    return inclusiveDays(stageStartDate(stage), stageCompletionDate(stage) || endKey || dateKeyInShanghai());
  }

  function stageYearData(year) {
    return state.stageYears[String(year)] || { completedStages: [], completionDates: [] };
  }

  function stageFromCache(stageId) {
    if (stageId === null || stageId === undefined) return null;
    if (state.activeStage && String(state.activeStage.id) === String(stageId)) return state.activeStage;
    const seen = new Set();
    for (const value of Object.values(state.stageYears)) {
      for (const stage of value.completedStages || []) {
        if (seen.has(stage.id)) continue;
        seen.add(stage.id);
        if (String(stage.id) === String(stageId)) return stage;
      }
    }
    return null;
  }

  function stageCompletionForDate(year, key) {
    const data = stageYearData(year);
    const matches = (data.completionDates || []).filter((item) => item && item.date === key);
    return matches.length ? matches[matches.length - 1] : null;
  }

  function latestCompletedStage() {
    const unique = new Map();
    Object.values(state.stageYears).forEach((value) => {
      (value.completedStages || []).forEach((stage) => unique.set(String(stage.id), stage));
    });
    return Array.from(unique.values()).sort((a, b) => stageCompletionDate(b).localeCompare(stageCompletionDate(a)))[0] || null;
  }

  function httpUrl(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch (_error) {
      return "";
    }
  }

  function setExternalProofLink(element, value) {
    const url = httpUrl(value);
    element.hidden = !url;
    if (url) element.href = url;
    else element.removeAttribute("href");
  }

  function taskProofLabel(task) {
    if (!task) return "";
    if (taskResultNote(task)) return taskResultNote(task);
    if (task.proofUrl) return "已添加证据链接";
    if (hasProofAttachment(task)) return "已上传完成附件";
    return taskResultStatus(task) === "incomplete" ? "已留下未完成反馈" : "已留下完成记录";
  }

  async function loadStageYear(year) {
    const payload = await api(`/api/stages?year=${encodeURIComponent(String(year))}`);
    state.activeStage = payload.activeStage || null;
    state.stageYears[String(year)] = {
      completedStages: Array.isArray(payload.completedStages) ? payload.completedStages : [],
      completionDates: Array.isArray(payload.completionDates) ? payload.completionDates : [],
    };
    return state.stageYears[String(year)];
  }

  function setVisible(element, visible) {
    if (element) element.hidden = !visible;
  }

  function setMessage(element, message, success) {
    if (!element) return;
    element.textContent = message || "";
    element.classList.toggle("is-success", Boolean(success));
    element.hidden = !message;
  }

  function setLoading(button, loading) {
    if (!button) return;
    if (loading) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = button.dataset.loadingLabel || "请稍候…";
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    } else {
      if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  async function api(path, options) {
    const init = Object.assign({ credentials: "same-origin" }, options || {});
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "application/json");
    if (!["GET", "HEAD"].includes(method)) {
      headers.set("X-CSRF-Token", state.csrfToken);
    }
    if (init.body && !(init.body instanceof FormData) && typeof init.body !== "string") {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(init.body);
    }
    init.headers = headers;

    let response;
    try {
      response = await fetch(path, init);
    } catch (_error) {
      throw new ApiError("暂时无法连接服务器，请检查网络后重试。", 0, "network_error");
    }

    const isJson = (response.headers.get("content-type") || "").includes("application/json");
    const payload = isJson ? await response.json().catch(() => ({})) : null;
    if (!response.ok) {
      throw new ApiError(
        payload && payload.error ? payload.error : "请求没有成功，请稍后重试。",
        response.status,
        payload && payload.code ? payload.code : "request_failed",
      );
    }
    return payload;
  }

  function showPrimaryView(name) {
    setVisible($("#boot-view"), name === "boot");
    setVisible($("#auth-view"), name === "auth");
    setVisible($("#app-view"), name === "app");
  }

  function toast(message, kind) {
    const region = $("#toast-region");
    const item = document.createElement("div");
    item.className = `toast ${kind === "error" ? "is-error" : "is-success"}`;
    item.textContent = message;
    region.appendChild(item);
    window.setTimeout(() => item.remove(), 3600);
  }

  function switchAuthTab(name) {
    if (name === "register" && !state.registrationOpen) name = "login";
    $$('[data-auth-tab]').forEach((button) => {
      const active = button.dataset.authTab === name;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$('[data-auth-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.authPanel !== name;
    });
    $("#auth-title").textContent = name === "login" ? "欢迎回来" : "创建只读账号";
    $("#auth-description").textContent = name === "login"
      ? "登录后继续查看今天的记录。"
      : "注册后可查看 blue 的任务、阶段与完成记录。";
    setMessage($("#auth-message"), "");
    const focusTarget = name === "login" ? $("#login-email") : $("#register-email");
    window.setTimeout(() => focusTarget.focus(), 0);
  }

  function configureRegistration(open) {
    state.registrationOpen = Boolean(open);
    setVisible($("#register-tab"), state.registrationOpen);
    $(".auth-tabs").classList.toggle("is-single", !state.registrationOpen);
    if (!state.registrationOpen && !$("#register-panel").hidden) switchAuthTab("login");
  }

  function setPasswordVisibility(button, visible) {
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "隐藏" : "显示";
    button.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    button.setAttribute("aria-pressed", String(visible));
  }

  function resetPasswordVisibility() {
    $$('[data-toggle-password]').forEach((button) => setPasswordVisibility(button, false));
  }

  function accountDetails() {
    const email = state.user ? state.user.email : "";
    const initial = (email.charAt(0) || "Q").toUpperCase();
    $("#account-email").textContent = email || "—";
    $("#account-email-short").textContent = email ? email.split("@")[0] : "账户";
    $("#account-avatar").textContent = initial;
    $("#account-avatar-large").textContent = initial;
    const owner = state.user && state.user.role === "owner";
    $("#account-role-label").textContent = owner ? "管理者" : "只读访客";
    $("#role-badge").textContent = owner && state.mode === "owner" ? "管理者" : "只读";
  }

  async function loadSession() {
    const payload = await api("/api/session");
    state.csrfToken = payload.csrfToken;
    state.user = payload.user;
    configureRegistration(Boolean(payload.registrationOpen));
    return payload;
  }

  async function loadData() {
    const payload = await api("/api/data");
    state.tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    state.stats = payload.stats && typeof payload.stats === "object" ? payload.stats : {};
    state.publicPoms = payload.publicPoms && typeof payload.publicPoms === "object" ? payload.publicPoms : {};
    state.user = payload.user || state.user;
    const currentYear = Number(dateKeyInShanghai().slice(0, 4));
    const years = Array.from(new Set([currentYear, state.historyYear, state.visitorHistoryYear]));
    await Promise.all(years.map((year) => loadStageYear(year)));
    renderAll();
  }

  async function enterApp() {
    showPrimaryView("app");
    const owner = state.user && state.user.role === "owner";
    if (!owner) clearPrivateClientState();
    $("#view-switcher").hidden = !owner;
    state.mode = owner && sessionStorage.getItem(PREVIEW_KEY) !== "visitor" ? "owner" : "visitor";
    accountDetails();
    await loadData();
    setMode(state.mode);
    checkLegacyData();
    if (state.user.mustChangePassword) openPasswordDialog(true);
  }

  function showAuth() {
    clearPrivateClientState();
    state.user = null;
    state.tasks = [];
    state.stats = {};
    state.publicPoms = {};
    state.selectedOwnerDate = "";
    state.selectedVisitorDate = "";
    state.activeStage = null;
    state.stageYears = {};
    state.forcedPasswordChange = false;
    sessionStorage.removeItem(PREVIEW_KEY);
    $("#login-form").reset();
    $("#register-form").reset();
    resetPasswordVisibility();
    showPrimaryView("auth");
    switchAuthTab("login");
  }

  function clearPrivateClientState() {
    window.clearTimeout(state.focusSaveTimer);
    state.focusSaveTimer = null;
    state.stats = {};
    state.publicPoms = {};
    state.selectedOwnerDate = "";
    state.selectedVisitorDate = "";
    state.activeStage = null;
    state.stageYears = {};
    $("#today-task-text").textContent = "";
    $("#tomorrow-task-text").textContent = "";
    $("#today-proof-text").textContent = "";
    $("#today-proof-summary").hidden = true;
    $("#visitor-today-task-text").textContent = "";
    $("#visitor-proof-text").textContent = "";
    $("#visitor-today-proof").hidden = true;
    $("#focus-poms").value = "0";
    $("#focus-distractions").value = "";
    $("#focus-note").value = "";
    $("#visitor-today-poms").textContent = "0 个番茄";
    $("#history-grid").replaceChildren();
    $("#history-list").replaceChildren();
    $("#visitor-history-grid").replaceChildren();
    $("#visitor-history-list").replaceChildren();
    $("#proof-view-text").textContent = "";
    $("#proof-view-time").textContent = "";
    resetRecordAttachment("daily");
    resetRecordAttachment("stage");
    $("#record-stage-section").hidden = true;
    $("#record-daily-section").hidden = true;
    $("#record-focus-section").hidden = true;
    $("#record-private-section").hidden = true;
    $("#record-distractions-text").textContent = "";
    $("#record-note-text").textContent = "";
    $("#account-email").textContent = "—";
    $("#account-email-short").textContent = "账户";
    $("#account-role-label").textContent = "";
    $("#task-form").reset();
    $("#proof-form").reset();
    $("#stage-form").reset();
    $("#stage-complete-form").reset();
    $("#password-form").reset();
    clearProofPreview();
    setExistingProofAttachment(null);
    clearStageImagePreview();
    ["#task-dialog", "#proof-dialog", "#stage-dialog", "#stage-complete-dialog", "#proof-view-dialog", "#password-dialog", "#confirm-dialog"].forEach((selector) => {
      const dialog = $(selector);
      if (dialog.open) closeDialog(dialog);
    });
  }

  async function bootstrap() {
    showPrimaryView("boot");
    try {
      const session = await loadSession();
      if (session.authenticated && session.user) {
        await enterApp();
      } else {
        showAuth();
      }
    } catch (error) {
      showPrimaryView("auth");
      setMessage($("#auth-message"), error.message);
    }
  }

  function setMode(mode) {
    const owner = state.user && state.user.role === "owner";
    state.mode = owner && mode === "owner" ? "owner" : "visitor";
    if (owner) sessionStorage.setItem(PREVIEW_KEY, state.mode);
    $("#owner-view").hidden = state.mode !== "owner";
    $("#visitor-view").hidden = state.mode !== "visitor";
    $("#preview-banner").hidden = !(owner && state.mode === "visitor");
    $$('[data-switch-view]').forEach((button) => {
      const active = button.dataset.switchView === state.mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    accountDetails();
    if (state.mode === "visitor") renderVisitor();
  }

  function updateStatus(element, task, emptyText, pendingText) {
    element.classList.remove("status-pending", "status-done", "status-incomplete");
    const status = taskResultStatus(task);
    if (status === "completed") {
      element.textContent = "已完成";
      element.classList.add("status-done");
    } else if (status === "incomplete") {
      element.textContent = "未完成";
      element.classList.add("status-incomplete");
    } else {
      element.textContent = task ? pendingText : emptyText;
      element.classList.add("status-pending");
    }
  }

  function currentStreak(tasks) {
    const map = new Map(tasks.map((task) => [task.date, task]));
    const today = dateKeyInShanghai();
    let cursor = map.get(today) && map.get(today).done ? today : shiftDate(today, -1);
    let count = 0;
    while (map.get(cursor) && map.get(cursor).done) {
      count += 1;
      cursor = shiftDate(cursor, -1);
    }
    return count;
  }

  function configureStageExpansion(prefix, stage) {
    const card = $(`#${prefix}-stage-card`);
    const button = $(`#${prefix}-stage-expand`);
    card.classList.remove("is-expanded");
    button.setAttribute("aria-expanded", "false");
    button.textContent = "展开完整内容";
    button.hidden = !stage || !((stage.title || "").length > 72 || (stage.description || "").length > 180);
  }

  function toggleStageExpansion(prefix) {
    const card = $(`#${prefix}-stage-card`);
    const button = $(`#${prefix}-stage-expand`);
    const expanded = !card.classList.contains("is-expanded");
    card.classList.toggle("is-expanded", expanded);
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "收起内容" : "展开完整内容";
  }

  function renderStageCards() {
    const stage = state.activeStage;
    const latest = latestCompletedStage();
    const today = dateKeyInShanghai();
    const start = stageStartDate(stage);

    $("#owner-stage-active").hidden = !stage;
    $("#owner-stage-empty").hidden = Boolean(stage);
    $("#owner-stage-status").textContent = stage ? "进行中" : "未设定";
    $("#owner-stage-status").classList.toggle("is-active", Boolean(stage));
    if (stage) {
      $("#owner-stage-title").textContent = stage.title;
      $("#owner-stage-description").textContent = stage.description || "";
      $("#owner-stage-description").hidden = !stage.description;
      $("#owner-stage-start").textContent = start || "—";
      $("#owner-stage-days").textContent = `${stageDuration(stage, today)} 天`;
      $("#edit-stage-button").dataset.stageId = String(stage.id);
      $("#complete-stage-button").dataset.stageId = String(stage.id);
    } else {
      $("#owner-stage-empty-title strong").textContent = latest ? "可以开始下一阶段" : "还没有当前阶段";
      $("#owner-stage-empty-copy").textContent = latest
        ? "上一阶段已经完成，新的阶段会从设定当天开始记录。"
        : "设定一个比每日任务更长的目标，完成后才能开始下一个。";
      $("#create-stage-button").textContent = latest ? "开始下一阶段" : "设定当前阶段";
    }
    configureStageExpansion("owner", stage);

    $("#visitor-stage-active").hidden = !stage;
    $("#visitor-stage-empty").hidden = Boolean(stage);
    $("#visitor-stage-status").textContent = stage ? "进行中" : "未设定";
    $("#visitor-stage-status").classList.toggle("is-active", Boolean(stage));
    if (stage) {
      $("#visitor-stage-title").textContent = stage.title;
      $("#visitor-stage-description").textContent = stage.description || "";
      $("#visitor-stage-description").hidden = !stage.description;
      $("#visitor-stage-start").textContent = start || "—";
      $("#visitor-stage-days").textContent = `${stageDuration(stage, today)} 天`;
    }
    configureStageExpansion("visitor", stage);

    [["owner", $("#owner-last-stage")], ["visitor", $("#visitor-last-stage")]].forEach(([prefix, button]) => {
      button.hidden = !latest;
      if (!latest) return;
      const completed = stageCompletionDate(latest);
      button.dataset.stageId = String(latest.id);
      button.dataset.recordDate = completed;
      $(`#${prefix}-last-stage-title`).textContent = latest.title;
      $(`#${prefix}-last-stage-meta`).textContent = `${completed || "已完成"} · 用时 ${stageDuration(latest, completed)} 天`;
    });
  }

  function renderOwner() {
    if (!state.user || state.user.role !== "owner") return;
    const today = dateKeyInShanghai();
    const tomorrow = shiftDate(today, 1);
    const todayTask = taskFor(today);
    const tomorrowTask = taskFor(tomorrow);
    const nowLabel = dateLabel(today);

    $("#owner-date-label").textContent = nowLabel;
    $("#today-date").textContent = `${today} · ${nowLabel}`;
    $("#tomorrow-date").textContent = `${tomorrow} · ${dateLabel(tomorrow)}`;
    $("#owner-streak-count").textContent = String(currentStreak(state.tasks));

    $("#today-task-text").textContent = todayTask ? todayTask.text : "今天还没有设置任务。";
    $("#today-empty-hint").hidden = Boolean(todayTask);
    updateStatus($("#today-status"), todayTask, "未设置", "待完成");
    $("#edit-today-task").dataset.taskDate = today;
    $("#edit-today-task").textContent = todayTask ? "编辑任务" : "设置任务";
    $("#edit-today-task").hidden = Boolean(todayTask && taskHasResult(todayTask));
    $("#complete-today-task").dataset.taskDate = today;
    $("#complete-today-task").hidden = !todayTask;
    $("#complete-today-task").textContent = todayTask && taskHasResult(todayTask) ? "更新反馈" : "记录今日结果";

    const ownerResult = Boolean(todayTask && taskHasResult(todayTask));
    $("#today-proof-summary").hidden = !ownerResult;
    $("#today-proof-summary").classList.toggle("is-incomplete", Boolean(ownerResult && taskResultStatus(todayTask) === "incomplete"));
    if (ownerResult) {
      $("#today-result-label").textContent = taskResultLabel(todayTask, true);
      $("#today-result-icon").textContent = taskResultStatus(todayTask) === "completed" ? "✓" : "—";
      $("#today-proof-text").textContent = taskProofLabel(todayTask);
      $("#view-today-proof").dataset.taskDate = today;
    }

    $("#tomorrow-task-text").textContent = tomorrowTask ? tomorrowTask.text : "还没有安排明天。";
    $("#edit-tomorrow-task").dataset.taskDate = tomorrow;
    $("#edit-tomorrow-task").textContent = tomorrowTask ? "编辑" : "设置";

    const todayStats = statsFor(today);
    $("#focus-poms").value = String(todayStats.poms);
    $("#focus-distractions").value = todayStats.distractions;
    $("#focus-note").value = todayStats.note;
    renderHistory("owner");
  }

  function renderVisitor() {
    const today = dateKeyInShanghai();
    const task = taskFor(today);
    $("#visitor-today-date").textContent = `${today} · ${dateLabel(today)}`;
    $("#visitor-today-task-text").textContent = task ? task.text : "今天还没有公开任务。";
    updateStatus($("#visitor-today-status"), task, "暂无任务", "进行中");
    $("#visitor-today-poms").textContent = `${publicPomsFor(today)} 个番茄`;
    const hasResult = Boolean(task && taskHasResult(task));
    $("#visitor-today-proof").hidden = !hasResult;
    $("#visitor-today-proof").classList.toggle("is-incomplete", Boolean(hasResult && taskResultStatus(task) === "incomplete"));
    if (hasResult) {
      $("#visitor-result-label").textContent = `今日${taskResultLabel(task, true)}`;
      $("#visitor-result-icon").textContent = taskResultStatus(task) === "completed" ? "✓" : "—";
      $("#visitor-proof-time").textContent = completionTime(task.resultRecordedAt || task.completedAt) || "已记录";
      $("#visitor-proof-text").textContent = taskProofLabel(task);
      $("#visitor-view-proof").dataset.taskDate = today;
    }
    renderHistory("visitor");
  }

  function bestStreak(tasks) {
    const keys = tasks.filter((task) => task.done).map((task) => task.date).sort();
    let best = 0;
    let current = 0;
    let previous = "";
    keys.forEach((key) => {
      current = previous && shiftDate(previous, 1) === key ? current + 1 : 1;
      best = Math.max(best, current);
      previous = key;
    });
    return best;
  }

  function daysInYear(year) {
    return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  }

  function yearDateKey(year, dayIndex) {
    const value = new Date(Date.UTC(year, 0, 1 + dayIndex));
    return value.toISOString().slice(0, 10);
  }

  function renderHistory(scope) {
    const visitor = scope === "visitor";
    const prefix = visitor ? "visitor-" : "";
    const year = visitor ? state.visitorHistoryYear : state.historyYear;
    const today = dateKeyInShanghai();
    const yearTasks = state.tasks.filter((task) => task.date.startsWith(`${year}-`) && task.date <= today);
    const stages = stageYearData(year);
    const completionMap = new Map();
    (stages.completionDates || []).forEach((item) => {
      if (item && item.date) completionMap.set(item.date, item.stageId);
    });
    const doneCount = yearTasks.filter((task) => task.done).length;
    const scheduledCount = yearTasks.length;
    $(`#${prefix}history-year-label`).textContent = String(year);
    $(`#${prefix}history-done-count`).textContent = String(doneCount);
    $(`#${prefix}history-rate`).textContent = scheduledCount ? `${Math.round((doneCount / scheduledCount) * 100)}%` : "0%";
    $(`#${prefix}history-best-streak`).textContent = String(bestStreak(yearTasks));

    const previous = visitor ? $("#visitor-previous-year") : $("#previous-year");
    const next = visitor ? $("#visitor-next-year") : $("#next-year");
    previous.disabled = year <= 2020;
    next.disabled = year >= Number(today.slice(0, 4));

    const grid = $(`#${prefix}history-grid`);
    grid.replaceChildren();
    const map = taskMap();
    const focusableCells = [];
    const selectedDate = visitor ? state.selectedVisitorDate : state.selectedOwnerDate;
    const firstDay = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    const mondayOffset = (firstDay + 6) % 7;
    for (let index = 0; index < mondayOffset; index += 1) {
      const spacer = document.createElement("span");
      spacer.className = "heatmap-cell is-spacer";
      spacer.setAttribute("aria-hidden", "true");
      grid.appendChild(spacer);
    }
    for (let index = 0; index < daysInYear(year); index += 1) {
      const key = yearDateKey(year, index);
      const task = map.get(key);
      const poms = publicPomsFor(key);
      const hasPrivate = key <= today && canBuildPrivateRecords(scope) && privateRecordFor(key).hasContent;
      const stageId = completionMap.get(key);
      const stage = stageId === undefined ? null : stageFromCache(stageId);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "heatmap-cell";
      cell.dataset.recordDate = key;
      cell.setAttribute("role", "gridcell");
      if (task) cell.classList.add("is-task");
      if (task && taskHasResult(task)) {
        cell.classList.add("is-recorded", `progress-${taskProgressLevel(task)}`);
        cell.style.setProperty("--daily-result-color", `var(--progress-${taskProgressLevel(task)})`);
      }
      if (task && taskResultStatus(task) === "completed") cell.classList.add("is-done");
      if (task && taskResultStatus(task) === "incomplete") cell.classList.add("is-incomplete");
      if (poms > 0) cell.classList.add("is-focus-record");
      if (hasPrivate) cell.classList.add("has-private-record");
      if (stageId !== undefined) cell.classList.add("is-stage-complete");
      if (stageId !== undefined && task && taskHasResult(task)) cell.classList.add("has-daily-result");
      if (selectedDate === key) cell.classList.add("is-selected");
      const status = [];
      if (stageId !== undefined) status.push(`阶段已完成${stage ? `：${stage.title}` : ""}`);
      if (task) {
        const result = taskHasResult(task) ? taskResultLabel(task, true) : "待反馈";
        const feedback = taskHasResult(task) && taskResultNote(task) ? `；反馈：${taskResultNote(task)}` : "";
        status.push(`每日任务${result}：${task.text}${feedback}`);
      }
      if (poms > 0) status.push(`专注番茄：${poms} 个`);
      if (hasPrivate) status.push("含私人记录，仅你可见");
      if (!status.length) status.push("无记录");
      cell.setAttribute("aria-label", `${key}，${status.join("；")}`);
      cell.title = `${key} · ${status.join(" · ")}`;
      cell.disabled = key > today || (!task && stageId === undefined && poms <= 0 && !hasPrivate);
      cell.tabIndex = -1;
      if (!cell.disabled) focusableCells.push(cell);
      cell.addEventListener("click", () => {
        if (visitor) state.selectedVisitorDate = key;
        else state.selectedOwnerDate = key;
        grid.querySelectorAll(".heatmap-cell.is-selected").forEach((item) => item.classList.remove("is-selected"));
        grid.querySelectorAll(".heatmap-cell[tabindex='0']").forEach((item) => { item.tabIndex = -1; });
        cell.classList.add("is-selected");
        cell.tabIndex = 0;
        openDateRecord(key, task, stageId, scope);
      });
      grid.appendChild(cell);
    }
    const tabStop = focusableCells.find((cell) => cell.dataset.recordDate === selectedDate)
      || focusableCells[focusableCells.length - 1];
    if (tabStop) tabStop.tabIndex = 0;
    renderHistoryList(scope, yearTasks, year);
  }

  function handleHistoryGridKeydown(event) {
    const grid = event.currentTarget;
    const current = event.target.closest("button[data-record-date]");
    if (!current || !grid.contains(current) || current.disabled) return;
    const cells = Array.from(grid.querySelectorAll("button[data-record-date]"));
    let target = null;
    if (event.key === "Home") {
      target = cells.find((cell) => !cell.disabled) || null;
    } else if (event.key === "End") {
      target = cells.slice().reverse().find((cell) => !cell.disabled) || null;
    } else {
      const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
      if (!step) return;
      const yearPrefix = current.dataset.recordDate.slice(0, 4);
      const byDate = new Map(cells.map((cell) => [cell.dataset.recordDate, cell]));
      let candidateDate = current.dataset.recordDate;
      for (let attempt = 0; attempt < 366; attempt += 1) {
        candidateDate = shiftDate(candidateDate, step);
        if (!candidateDate.startsWith(`${yearPrefix}-`)) break;
        const candidate = byDate.get(candidateDate);
        if (candidate && !candidate.disabled) {
          target = candidate;
          break;
        }
      }
    }
    if (!target) return;
    event.preventDefault();
    cells.forEach((cell) => { cell.tabIndex = -1; });
    target.tabIndex = 0;
    target.focus();
  }

  function renderHistoryList(scope, yearTasks, year) {
    const visitor = scope === "visitor";
    const list = visitor ? $("#visitor-history-list") : $("#history-list");
    const today = dateKeyInShanghai();
    const entries = new Map();
    yearTasks.filter((task) => task.date <= today).forEach((task) => {
      entries.set(task.date, { date: task.date, task, stageId: null, stage: null, poms: publicPomsFor(task.date) });
    });
    const stages = stageYearData(year);
    (stages.completionDates || []).forEach((completion) => {
      if (!completion || !completion.date || completion.date > today) return;
      const entry = entries.get(completion.date) || {
        date: completion.date,
        task: null,
        stageId: null,
        stage: null,
        poms: publicPomsFor(completion.date),
      };
      entry.stageId = completion.stageId;
      entry.stage = (stages.completedStages || []).find((stage) => String(stage.id) === String(completion.stageId)) || stageFromCache(completion.stageId);
      entries.set(completion.date, entry);
    });
    Object.keys(state.publicPoms).forEach((key) => {
      const poms = publicPomsFor(key);
      if (!key.startsWith(`${year}-`) || key > today || poms <= 0) return;
      const entry = entries.get(key) || { date: key, task: null, stageId: null, stage: null, poms };
      entry.poms = poms;
      entries.set(key, entry);
    });
    if (canBuildPrivateRecords(scope)) {
      Object.keys(state.stats).forEach((key) => {
        const privateRecord = privateRecordFor(key);
        if (!key.startsWith(`${year}-`) || key > today || !privateRecord.hasContent) return;
        const entry = entries.get(key) || {
          date: key,
          task: null,
          stageId: null,
          stage: null,
          poms: publicPomsFor(key),
        };
        entry.hasPrivate = true;
        entries.set(key, entry);
      });
    }
    const ordered = Array.from(entries.values()).sort((a, b) => b.date.localeCompare(a.date));
    const limit = visitor ? state.visitorHistoryLimit : (state.ownerHistoryExpanded ? ordered.length : 8);
    list.replaceChildren();
    if (!ordered.length) {
      const empty = document.createElement("li");
      empty.className = "history-empty";
      empty.textContent = visitor ? "暂时还没有公开记录。" : "完成后，记录会安静地留在这里。";
      list.appendChild(empty);
    } else {
      ordered.slice(0, limit).forEach((entry) => {
        const item = document.createElement("li");
        item.className = "history-item";
        if (entry.stageId !== null) item.classList.add("has-stage");
        if (entry.poms > 0) item.classList.add("has-focus");
        if (entry.hasPrivate) item.classList.add("has-private-record");
        const time = document.createElement("time");
        time.className = "history-item-date";
        time.dateTime = entry.date;
        time.textContent = entry.date.slice(5).replace("-", ".");
        const text = document.createElement("p");
        text.className = "history-item-task";
        if (entry.stage && entry.task) text.textContent = `${entry.stage.title} · ${entry.task.text}`;
        else if (entry.stage) text.textContent = entry.stage.title;
        else if (entry.task) text.textContent = entry.task.text;
        else if (entry.poms > 0) text.textContent = "专注记录";
        else if (entry.hasPrivate) text.textContent = "私人记录";
        else text.textContent = "阶段成果";
        if (entry.poms > 0) {
          const focusMeta = document.createElement("span");
          focusMeta.className = "history-item-poms";
          focusMeta.textContent = `专注 · ${entry.poms} 个番茄`;
          text.appendChild(focusMeta);
        }
        const action = document.createElement("button");
        action.type = "button";
        if (entry.stageId !== null && entry.task && taskHasResult(entry.task)) {
          action.className = "history-item-status is-combined";
          action.textContent = `阶段 · ${taskResultLabel(entry.task, false)}`;
        } else if (entry.stageId !== null) {
          action.className = "history-item-status is-stage";
          action.textContent = "阶段完成";
        } else if (!entry.task && entry.poms > 0) {
          action.className = "history-item-status is-focus";
          action.textContent = "查看";
        } else if (!entry.task && entry.hasPrivate) {
          action.className = "history-item-status is-private";
          action.textContent = "查看";
        } else {
          const status = taskResultStatus(entry.task);
          action.className = `history-item-status${status === "completed" ? " is-done" : (status === "incomplete" ? " is-incomplete" : " is-pending")}`;
          action.textContent = taskResultLabel(entry.task, status === "incomplete");
        }
        const recordKinds = [];
        if (entry.stageId !== null) recordKinds.push("阶段成果");
        if (entry.task) recordKinds.push("每日记录");
        if (entry.poms > 0) recordKinds.push("专注记录");
        if (entry.hasPrivate) recordKinds.push("私人记录");
        action.setAttribute("aria-label", `查看 ${entry.date} 的${recordKinds.join("和")}`);
        action.addEventListener("click", () => openDateRecord(entry.date, entry.task, entry.stageId, scope));
        item.append(time, text, action);
        list.appendChild(item);
      });
    }

    if (visitor) {
      const more = $("#visitor-load-more");
      more.hidden = ordered.length <= state.visitorHistoryLimit;
    } else {
      const all = $("#show-all-history");
      all.hidden = ordered.length <= 8;
      all.textContent = state.ownerHistoryExpanded ? "收起" : "查看全部";
    }
  }

  function renderAll() {
    renderStageCards();
    renderOwner();
    renderVisitor();
    accountDetails();
  }

  function showDialog(dialog) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function openTaskEditor(key) {
    if (!state.user || state.user.role !== "owner" || state.mode !== "owner") return;
    const task = taskFor(key);
    if (task && task.done) {
      toast("已完成的任务不能直接修改。", "error");
      return;
    }
    $("#task-date-input").value = key;
    $("#task-dialog-date").textContent = `${key} · ${dateLabel(key)}`;
    $("#task-text-input").value = task ? task.text : "";
    $("#task-dialog-title").textContent = task ? "编辑任务" : "设置任务";
    $("#delete-task-button").hidden = !task;
    setMessage($("#task-dialog-message"), "");
    updateCharacterCount($("#task-text-input"));
    showDialog($("#task-dialog"));
    window.setTimeout(() => $("#task-text-input").focus(), 0);
  }

  async function saveTask(event) {
    event.preventDefault();
    const button = $("#save-task-button");
    const key = $("#task-date-input").value;
    const text = $("#task-text-input").value.trim();
    if (!text) {
      setMessage($("#task-dialog-message"), "请填写任务内容。");
      $("#task-text-input").focus();
      return;
    }
    setLoading(button, true);
    setMessage($("#task-dialog-message"), "");
    try {
      await api(`/api/tasks/${encodeURIComponent(key)}`, { method: "PUT", body: { text } });
      closeDialog($("#task-dialog"));
      await loadData();
      toast("任务已保存。", "success");
    } catch (error) {
      setMessage($("#task-dialog-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  async function confirmAction(description, confirmLabel) {
    $("#confirm-dialog-description").textContent = description;
    $("#confirm-submit").textContent = confirmLabel || "确认";
    showDialog($("#confirm-dialog"));
    return new Promise((resolve) => {
      state.confirmResolver = resolve;
    });
  }

  function finishConfirmation(value) {
    if (state.confirmResolver) {
      const resolve = state.confirmResolver;
      state.confirmResolver = null;
      resolve(value);
    }
    closeDialog($("#confirm-dialog"));
  }

  async function deleteTask() {
    const key = $("#task-date-input").value;
    const confirmed = await confirmAction(`确定删除 ${key} 的任务吗？`, "删除任务");
    if (!confirmed) return;
    const button = $("#delete-task-button");
    setLoading(button, true);
    try {
      await api(`/api/tasks/${encodeURIComponent(key)}`, { method: "DELETE" });
      closeDialog($("#task-dialog"));
      await loadData();
      toast("任务已删除。", "success");
    } catch (error) {
      setMessage($("#task-dialog-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  function attachmentUploadUi(scope) {
    const daily = scope === "daily";
    return {
      previewKey: daily ? "proofPreviewUrl" : "stageImagePreviewUrl",
      input: $(daily ? "#proof-image-input" : "#stage-proof-image"),
      dropzone: $(daily ? "#proof-dropzone" : "#stage-proof-dropzone"),
      preview: $(daily ? "#proof-image-preview" : "#stage-image-preview"),
      image: $(daily ? "#proof-preview-image" : "#stage-preview-image"),
      imageAlt: daily ? "待上传的每日完成证明图片预览" : "待上传的阶段成果图片预览",
      icon: $(daily ? "#proof-preview-file-icon" : "#stage-preview-file-icon"),
      type: $(daily ? "#proof-file-type" : "#stage-file-type"),
      name: $(daily ? "#proof-image-name" : "#stage-image-name"),
      size: $(daily ? "#proof-file-size" : "#stage-file-size"),
      remove: $(daily ? "#remove-proof-image" : "#remove-stage-image"),
      message: $(daily ? "#proof-dialog-message" : "#stage-complete-message"),
      existing: daily ? $("#proof-existing-file") : null,
    };
  }

  function clearAttachmentPreview(scope) {
    const ui = attachmentUploadUi(scope);
    if (state[ui.previewKey]) URL.revokeObjectURL(state[ui.previewKey]);
    state[ui.previewKey] = "";
    ui.input.value = "";
    ui.image.hidden = true;
    ui.image.removeAttribute("src");
    ui.image.removeAttribute("title");
    ui.image.alt = ui.imageAlt;
    ui.icon.hidden = true;
    ui.icon.textContent = "FILE";
    ui.type.textContent = "附件";
    ui.name.textContent = "—";
    ui.name.removeAttribute("title");
    ui.size.textContent = "—";
    ui.preview.hidden = true;
    ui.dropzone.hidden = false;
    if (ui.existing) ui.existing.hidden = !ui.existing.dataset.label;
  }

  function previewAttachmentFile(file, scope) {
    if (!file) return;
    const ui = attachmentUploadUi(scope);
    const info = proofFileInfo(file);
    if (!info.allowed) {
      clearAttachmentPreview(scope);
      setMessage(
        ui.message,
        ["heic", "heif"].includes(info.extension)
          ? "HEIC 暂不支持，请在照片中导出为 JPG，或上传截图。"
          : "附件必须带有受支持的扩展名：JPG、PNG、WebP、PDF、TXT、CSV、DOCX、XLSX 或 PPTX。",
      );
      return;
    }
    if (file.size > MAX_PROOF_FILE_BYTES) {
      clearAttachmentPreview(scope);
      setMessage(ui.message, "附件不能超过 10 MB。");
      return;
    }
    if (state[ui.previewKey]) URL.revokeObjectURL(state[ui.previewKey]);
    state[ui.previewKey] = "";
    ui.image.hidden = true;
    ui.image.removeAttribute("src");
    ui.icon.hidden = info.isImage;
    ui.icon.textContent = info.label;
    if (info.isImage) {
      try {
        state[ui.previewKey] = URL.createObjectURL(file);
        ui.image.src = state[ui.previewKey];
        ui.image.title = file.name;
        ui.image.alt = `${file.name} 图片预览`;
        ui.image.hidden = false;
      } catch (_error) {
        ui.icon.hidden = false;
      }
    }
    ui.type.textContent = info.isImage ? `${info.label} 图片` : `${info.label} 文件`;
    ui.name.textContent = file.name;
    ui.name.title = file.name;
    ui.size.textContent = formatFileSize(file.size);
    ui.preview.hidden = false;
    ui.dropzone.hidden = true;
    if (ui.existing) ui.existing.hidden = true;
    setMessage(ui.message, "");
  }

  function setExistingProofAttachment(task) {
    const note = $("#proof-existing-file");
    const attachment = proofAttachment(task);
    note.dataset.label = attachment ? attachment.name : "";
    note.textContent = attachment
      ? `已保存：${attachment.name}。选择新附件会替换；不选择则保留。`
      : "";
    if (attachment) note.title = attachment.name;
    else note.removeAttribute("title");
    note.hidden = !attachment;
  }

  function clearProofPreview() {
    clearAttachmentPreview("daily");
  }

  function clearStageImagePreview() {
    clearAttachmentPreview("stage");
  }

  function selectedResultStatus() {
    const selected = document.querySelector('input[name="resultStatus"]:checked');
    return selected ? selected.value : "";
  }

  function updateResultForm() {
    const status = selectedResultStatus();
    const completed = status === "completed";
    const progress = $("#result-progress-input");
    const previousProgress = Number.parseInt(progress.value, 10);
    if (completed) {
      progress.max = "100";
      progress.value = "100";
      progress.disabled = true;
    } else {
      progress.max = "99";
      if (previousProgress >= 100) progress.value = "50";
      progress.disabled = false;
    }
    const percent = completed ? 100 : Math.min(99, Math.max(0, Number.parseInt(progress.value, 10) || 0));
    $("#result-progress-output").textContent = `${percent}%`;
    $("#result-progress-field").classList.toggle("is-locked", completed);
    $("#result-progress-help").textContent = completed
      ? "选择“完成”时自动记为 100%。"
      : "选择最接近实际进度的数值，年度记录会随完成量加深。";
    $("#result-note-label").textContent = completed ? "完成备注" : "未完成原因";
    $("#proof-text-input").placeholder = completed
      ? "简单写下完成了什么、结果如何…"
      : "简单记录卡在哪里、下一步怎样调整…";
    $("#proof-requirement").textContent = completed
      ? "必填 · 完成备注会公开显示"
      : "必填 · 未完成原因会公开显示";
  }

  function openProofEditor(key) {
    if (!state.user || state.user.role !== "owner" || state.mode !== "owner") return;
    const task = taskFor(key);
    if (!task) return;
    clearProofPreview();
    $("#proof-date-input").value = key;
    $("#proof-dialog-date").textContent = `${key} · ${task.text}`;
    $("#proof-dialog-title").textContent = taskHasResult(task) ? "更新今日反馈" : "记录今日结果";
    const status = taskResultStatus(task) === "incomplete" ? "incomplete" : "completed";
    $("#result-status-completed").checked = status === "completed";
    $("#result-status-incomplete").checked = status === "incomplete";
    $("#result-progress-input").value = String(status === "completed" ? 100 : taskCompletionPercent(task));
    $("#proof-text-input").value = taskResultNote(task);
    $("#proof-url-input").value = task.proofUrl || "";
    setExistingProofAttachment(task);
    $("#submit-proof-button").textContent = taskHasResult(task) ? "更新反馈" : "保存反馈";
    setMessage($("#proof-dialog-message"), "");
    updateResultForm();
    updateCharacterCount($("#proof-text-input"));
    showDialog($("#proof-dialog"));
    window.setTimeout(() => $("#proof-text-input").focus(), 0);
  }

  async function submitProof(event) {
    event.preventDefault();
    const key = $("#proof-date-input").value;
    const task = taskFor(key);
    const resultStatus = selectedResultStatus();
    const completionPercent = resultStatus === "completed"
      ? 100
      : Math.min(99, Math.max(0, Number.parseInt($("#result-progress-input").value, 10) || 0));
    const resultNote = $("#proof-text-input").value.trim();
    const proofUrlRaw = $("#proof-url-input").value.trim();
    const proofUrl = httpUrl(proofUrlRaw);
    const file = $("#proof-image-input").files[0];
    if (proofUrlRaw && !proofUrl) {
      setMessage($("#proof-dialog-message"), "证据链接必须以 http:// 或 https:// 开头。");
      $("#proof-url-input").focus();
      return;
    }
    if (!resultNote) {
      setMessage($("#proof-dialog-message"), resultStatus === "completed" ? "请填写完成备注。" : "请填写未完成原因。");
      $("#proof-text-input").focus();
      return;
    }
    const formData = new FormData();
    formData.append("resultStatus", resultStatus);
    formData.append("completionPercent", String(completionPercent));
    formData.append("resultNote", resultNote);
    formData.append("proofUrl", proofUrl);
    if (file) formData.append("attachment", file, file.name);
    const button = $("#submit-proof-button");
    setLoading(button, true);
    setMessage($("#proof-dialog-message"), "");
    try {
      await api(`/api/tasks/${encodeURIComponent(key)}/result`, { method: "POST", body: formData });
      closeDialog($("#proof-dialog"));
      clearProofPreview();
      await loadData();
      toast(task && taskHasResult(task) ? "今日反馈已更新。" : "今日反馈已保存。", "success");
    } catch (error) {
      setMessage($("#proof-dialog-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  function recordAttachmentUi(scope) {
    const stage = scope === "stage";
    const prefix = stage ? "record-stage" : "record-daily";
    return {
      image: $(stage ? "#record-stage-image" : "#proof-view-image"),
      file: $(`#${prefix}-file`),
      type: $(`#${prefix}-file-type`),
      name: $(`#${prefix}-file-name`),
      meta: $(`#${prefix}-file-meta`),
      imageAlt: stage ? "阶段成果图片" : "每日完成证明图片",
    };
  }

  function resetRecordAttachment(scope) {
    const ui = recordAttachmentUi(scope);
    ui.image.hidden = true;
    ui.image.removeAttribute("src");
    ui.image.removeAttribute("title");
    ui.file.hidden = true;
    ui.file.removeAttribute("href");
    ui.file.removeAttribute("download");
    ui.file.removeAttribute("aria-label");
    ui.file.removeAttribute("title");
    ui.type.textContent = "FILE";
    ui.name.textContent = "附件";
    ui.name.removeAttribute("title");
    ui.meta.textContent = "—";
  }

  function renderRecordAttachment(record, scope) {
    resetRecordAttachment(scope);
    const attachment = proofAttachment(record);
    if (!attachment) return;
    const ui = recordAttachmentUi(scope);
    if (attachment.isImage) {
      ui.image.src = attachment.url;
      ui.image.alt = `${ui.imageAlt}：${attachment.name}`;
      ui.image.title = attachment.name;
      ui.image.hidden = false;
      return;
    }
    const size = formatFileSize(attachment.size);
    ui.file.href = attachment.url;
    ui.file.download = attachment.name;
    ui.file.setAttribute("aria-label", `下载附件：${attachment.name}`);
    ui.file.title = attachment.name;
    ui.type.textContent = attachment.label;
    ui.name.textContent = attachment.name;
    ui.name.title = attachment.name;
    ui.meta.textContent = [attachment.label, size].filter(Boolean).join(" · ");
    ui.file.hidden = false;
  }

  function resetRecordDetails() {
    $("#record-stage-section").hidden = true;
    $("#record-daily-section").hidden = true;
    $("#record-focus-section").hidden = true;
    $("#record-private-section").hidden = true;
    $("#record-distractions-block").hidden = true;
    $("#record-note-block").hidden = true;
    $("#record-distractions-text").textContent = "";
    $("#record-note-text").textContent = "";
    $("#record-empty-state").hidden = true;
    resetRecordAttachment("stage");
    resetRecordAttachment("daily");
    setExternalProofLink($("#record-stage-proof-url"), "");
    setExternalProofLink($("#record-daily-proof-url"), "");
  }

  function renderStageRecord(stage) {
    const section = $("#record-stage-section");
    section.hidden = false;
    const start = stageStartDate(stage);
    const completed = stageCompletionDate(stage);
    $("#record-stage-title").textContent = stage.title || "阶段成果";
    $("#record-stage-description").textContent = stage.description || "";
    $("#record-stage-description").hidden = !stage.description;
    $("#record-stage-start").textContent = start || "—";
    $("#record-stage-completed").textContent = completed || "—";
    $("#record-stage-duration").textContent = `用时 ${stageDuration(stage, completed)} 天`;
    $("#record-stage-proof-text").textContent = stage.proofText || "";
    $("#record-stage-proof-text").hidden = !stage.proofText;
    setExternalProofLink($("#record-stage-proof-url"), stage.proofUrl);
    renderRecordAttachment(stage, "stage");
  }

  function renderDailyRecord(task) {
    const section = $("#record-daily-section");
    section.hidden = false;
    const status = taskResultStatus(task);
    const hasResult = taskHasResult(task);
    const statusElement = $("#record-daily-status");
    statusElement.classList.remove("is-completed", "is-incomplete", "is-pending");
    statusElement.classList.add(status === "completed" ? "is-completed" : (status === "incomplete" ? "is-incomplete" : "is-pending"));
    statusElement.textContent = taskResultLabel(task, false);
    $("#record-daily-title").textContent = task.text;
    $("#record-daily-progress").textContent = hasResult ? `完成程度 ${taskCompletionPercent(task)}%` : "尚未记录结果";
    $("#record-daily-feedback-label").textContent = status === "incomplete" ? "未完成原因" : "完成备注";
    $("#proof-view-text").textContent = taskResultNote(task) || "未填写文字反馈。";
    $("#record-daily-feedback").hidden = !hasResult;
    $("#proof-view-time").textContent = hasResult
      ? `记录于 ${completionTime(task.resultRecordedAt || task.completedAt) || "已记录"}`
      : "等待反馈";
    setExternalProofLink($("#record-daily-proof-url"), task.proofUrl);
    renderRecordAttachment(task, "daily");
  }

  function renderFocusRecord(key) {
    const poms = publicPomsFor(key);
    if (poms <= 0) return false;
    $("#record-focus-count").textContent = String(poms);
    $("#record-focus-section").hidden = false;
    return true;
  }

  function renderPrivateRecord(key, scope) {
    if (!canViewPrivateRecordDetails(scope)) return false;
    const record = privateRecordFor(key);
    if (!record.hasContent) return false;
    const distractionsBlock = $("#record-distractions-block");
    const noteBlock = $("#record-note-block");
    distractionsBlock.hidden = !record.distractions;
    noteBlock.hidden = !record.note;
    $("#record-distractions-text").textContent = record.distractions;
    $("#record-note-text").textContent = record.note;
    $("#record-private-section").hidden = false;
    return true;
  }

  async function openDateRecord(key, task, stageId, scope) {
    resetRecordDetails();
    let stage = stageId === null || stageId === undefined ? null : stageFromCache(stageId);
    if (!stage && stageId !== null && stageId !== undefined) {
      try {
        const payload = await api(`/api/stages/${encodeURIComponent(String(stageId))}`);
        stage = payload.stage || null;
      } catch (error) {
        toast(error.message, "error");
      }
    }
    if (stage) renderStageRecord(stage);
    if (task) renderDailyRecord(task);
    const hasFocus = renderFocusRecord(key);
    const hasPrivate = renderPrivateRecord(key, scope);
    const sectionCount = Number(Boolean(stage)) + Number(Boolean(task)) + Number(hasFocus) + Number(hasPrivate);
    $("#proof-view-title").textContent = sectionCount > 1
      ? "当日记录"
      : (stage ? "阶段成果" : (task ? "每日记录" : (hasFocus ? "专注记录" : "私人记录")));
    $("#proof-view-date").textContent = `${key} · ${dateLabel(key)}`;
    $("#record-empty-state").hidden = Boolean(stage || task || hasFocus || hasPrivate);
    showDialog($("#proof-view-dialog"));
  }

  function openRecord(task, scope) {
    if (!task) return;
    const completion = stageCompletionForDate(Number(task.date.slice(0, 4)), task.date);
    openDateRecord(task.date, task, completion ? completion.stageId : null, scope);
  }

  function openStageEditor() {
    if (!state.user || state.user.role !== "owner" || state.mode !== "owner") return;
    const stage = state.activeStage;
    $("#stage-form").reset();
    $("#stage-id-input").value = stage ? String(stage.id) : "";
    $("#stage-title-input").value = stage ? stage.title : "";
    $("#stage-description-input").value = stage ? (stage.description || "") : "";
    $("#stage-dialog-title").textContent = stage ? "编辑当前阶段" : "设定当前阶段";
    $("#save-stage-button").textContent = stage ? "保存修改" : "开始这个阶段";
    setMessage($("#stage-dialog-message"), "");
    updateCharacterCount($("#stage-title-input"));
    updateCharacterCount($("#stage-description-input"));
    showDialog($("#stage-dialog"));
    window.setTimeout(() => $("#stage-title-input").focus(), 0);
  }

  async function saveStage(event) {
    event.preventDefault();
    if (!state.user || state.user.role !== "owner" || state.mode !== "owner") return;
    const id = $("#stage-id-input").value;
    const title = $("#stage-title-input").value.trim();
    const description = $("#stage-description-input").value.trim();
    if (!title) {
      setMessage($("#stage-dialog-message"), "请填写阶段名称。");
      $("#stage-title-input").focus();
      return;
    }
    const button = $("#save-stage-button");
    setLoading(button, true);
    setMessage($("#stage-dialog-message"), "");
    try {
      await api(id ? `/api/stages/${encodeURIComponent(id)}` : "/api/stages", {
        method: id ? "PUT" : "POST",
        body: { title, description },
      });
      closeDialog($("#stage-dialog"));
      await loadData();
      toast(id ? "当前阶段已更新。" : "当前阶段已开始。", "success");
    } catch (error) {
      setMessage($("#stage-dialog-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  function openStageCompletion() {
    if (!state.user || state.user.role !== "owner" || state.mode !== "owner" || !state.activeStage) return;
    clearStageImagePreview();
    $("#stage-complete-form").reset();
    $("#stage-complete-id").value = String(state.activeStage.id);
    $("#stage-complete-name").textContent = state.activeStage.title;
    setMessage($("#stage-complete-message"), "");
    updateCharacterCount($("#stage-proof-text"));
    showDialog($("#stage-complete-dialog"));
    window.setTimeout(() => $("#stage-proof-text").focus(), 0);
  }

  async function completeStage(event) {
    event.preventDefault();
    if (!state.user || state.user.role !== "owner" || state.mode !== "owner") return;
    const id = $("#stage-complete-id").value;
    const proofText = $("#stage-proof-text").value.trim();
    const proofUrlRaw = $("#stage-proof-url").value.trim();
    const proofUrl = httpUrl(proofUrlRaw);
    const file = $("#stage-proof-image").files[0];
    if (proofUrlRaw && !proofUrl) {
      setMessage($("#stage-complete-message"), "证据链接必须以 http:// 或 https:// 开头。");
      $("#stage-proof-url").focus();
      return;
    }
    if (!proofText && !proofUrl && !file) {
      setMessage($("#stage-complete-message"), "请填写完成说明、证据链接或选择一个附件。");
      return;
    }
    const formData = new FormData();
    formData.append("proofText", proofText);
    formData.append("proofUrl", proofUrl);
    if (file) formData.append("attachment", file, file.name);
    const button = $("#submit-stage-complete");
    setLoading(button, true);
    setMessage($("#stage-complete-message"), "");
    try {
      await api(`/api/stages/${encodeURIComponent(id)}/complete`, { method: "POST", body: formData });
      closeDialog($("#stage-complete-dialog"));
      clearStageImagePreview();
      await loadData();
      toast("阶段已完成，今天已在年度记录中标为金色。", "success");
    } catch (error) {
      setMessage($("#stage-complete-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  async function moveHistoryYear(scope, amount) {
    const visitor = scope === "visitor";
    const key = visitor ? "visitorHistoryYear" : "historyYear";
    const currentYear = Number(dateKeyInShanghai().slice(0, 4));
    const previous = state[key];
    state[key] = Math.min(currentYear, Math.max(2020, previous + amount));
    try {
      await loadStageYear(state[key]);
      renderStageCards();
      renderHistory(scope);
    } catch (error) {
      state[key] = previous;
      renderHistory(scope);
      toast(error.message, "error");
    }
  }

  async function saveFocus(showFeedback) {
    if (!state.user || state.user.role !== "owner" || state.mode !== "owner") return;
    window.clearTimeout(state.focusSaveTimer);
    const poms = Number.parseInt($("#focus-poms").value, 10);
    const note = $("#focus-note").value;
    const distractions = $("#focus-distractions").value;
    if (!Number.isInteger(poms) || poms < 0 || poms > 100000) {
      if (showFeedback) toast("专注番茄数量应在 0–100000 之间。", "error");
      return;
    }
    const button = $("#save-focus");
    if (showFeedback) setLoading(button, true);
    try {
      const result = await api(`/api/stats/${dateKeyInShanghai()}`, {
        method: "PUT",
        body: { poms, note, distractions },
      });
      const today = dateKeyInShanghai();
      state.stats[today] = result.stats;
      state.publicPoms[today] = result.stats.poms;
      renderHistory("owner");
      renderVisitor();
      if (showFeedback) toast("今日专注已保存。", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      if (showFeedback) setLoading(button, false);
    }
  }

  function scheduleFocusSave() {
    window.clearTimeout(state.focusSaveTimer);
    state.focusSaveTimer = window.setTimeout(() => saveFocus(false), 700);
  }

  function checkLegacyData() {
    const status = $("#legacy-data-status");
    const label = $("#legacy-data-label");
    const button = $("#import-legacy-data");
    if (!state.user || state.user.role !== "owner") return;
    let valid = false;
    try {
      const value = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
      valid = Boolean(value && typeof value === "object" && value.tasks && typeof value.tasks === "object");
    } catch (_error) {
      valid = false;
    }
    status.classList.toggle("has-data", valid);
    button.hidden = !valid;
    label.textContent = valid ? "发现这台设备上的旧版记录" : "这台设备没有需要迁移的旧记录";
  }

  async function importLegacyData() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    } catch (_error) {
      data = null;
    }
    if (!data) {
      checkLegacyData();
      return;
    }
    const confirmed = await confirmAction("把这台设备中的旧版任务、番茄钟和分心记录合并到账号吗？服务器已有记录不会被覆盖。", "开始迁移");
    if (!confirmed) return;
    const button = $("#import-legacy-data");
    setLoading(button, true);
    try {
      const result = await api("/api/import", { method: "POST", body: { data } });
      await loadData();
      localStorage.removeItem(LEGACY_KEY);
      $("#legacy-data-label").textContent = `迁移完成，新增 ${result.importedTasks} 条任务记录`;
      button.textContent = "已完成迁移";
      button.disabled = true;
      toast("旧版记录已安全合并。", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      if (!button.disabled) setLoading(button, false);
    }
  }

  function openPasswordDialog(forced) {
    state.forcedPasswordChange = Boolean(forced);
    $("#password-required-notice").hidden = !forced;
    $("#password-dialog-close").hidden = forced;
    $("#cancel-password-change").hidden = forced;
    $("#password-dialog-title").textContent = forced ? "设置你的新密码" : "修改密码";
    $("#password-dialog-description").textContent = forced
      ? "当前为临时密码，修改后才能继续管理。"
      : "修改后，其他设备会退出登录。";
    $("#password-form").reset();
    setMessage($("#password-dialog-message"), "");
    showDialog($("#password-dialog"));
    window.setTimeout(() => $("#current-password").focus(), 0);
  }

  async function changePassword(event) {
    event.preventDefault();
    const currentPassword = $("#current-password").value;
    const newPassword = $("#new-password").value;
    const confirmPassword = $("#new-password-confirm").value;
    if (newPassword.length < 10) {
      setMessage($("#password-dialog-message"), "新密码至少需要 10 个字符。");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage($("#password-dialog-message"), "两次输入的新密码不一致。");
      return;
    }
    const button = $("#save-password-button");
    setLoading(button, true);
    try {
      await api("/api/change-password", { method: "POST", body: { currentPassword, newPassword } });
      state.forcedPasswordChange = false;
      $("#password-form").reset();
      closeDialog($("#password-dialog"));
      const session = await loadSession();
      state.user = session.user;
      await loadData();
      toast("密码已修改，其他设备已退出登录。", "success");
    } catch (error) {
      setMessage($("#password-dialog-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  async function login(event) {
    event.preventDefault();
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    if (!email || !password) {
      setMessage($("#auth-message"), "请输入邮箱和密码。");
      return;
    }
    const button = $("#login-submit");
    setLoading(button, true);
    setMessage($("#auth-message"), "");
    try {
      const result = await api("/api/login", { method: "POST", body: { email, password } });
      state.user = result.user;
      await loadSession();
      await enterApp();
      $("#login-form").reset();
    } catch (error) {
      setMessage($("#auth-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  async function register(event) {
    event.preventDefault();
    const email = $("#register-email").value.trim();
    const password = $("#register-password").value;
    const confirmation = $("#register-password-confirm").value;
    if (!email || password.length < 10) {
      setMessage($("#auth-message"), "请输入有效邮箱，密码至少 10 个字符。");
      return;
    }
    if (password !== confirmation) {
      setMessage($("#auth-message"), "两次输入的密码不一致。");
      return;
    }
    const button = $("#register-submit");
    setLoading(button, true);
    setMessage($("#auth-message"), "");
    try {
      const result = await api("/api/register", { method: "POST", body: { email, password } });
      state.user = result.user;
      await loadSession();
      await enterApp();
      $("#register-form").reset();
      toast("只读账号已创建。", "success");
    } catch (error) {
      setMessage($("#auth-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  async function logout() {
    const button = $("#logout-button");
    setLoading(button, true);
    try {
      await api("/api/logout", { method: "POST" });
      $("#account-menu").open = false;
      await loadSession();
      showAuth();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setLoading(button, false);
    }
  }

  function updateCharacterCount(input) {
    const counter = document.querySelector(`[data-character-count="${input.id}"]`);
    if (counter) counter.textContent = String(input.value.length);
  }

  function bindAttachmentPicker(scope) {
    const ui = attachmentUploadUi(scope);
    ui.input.addEventListener("change", (event) => previewAttachmentFile(event.target.files[0], scope));
    ui.remove.addEventListener("click", () => {
      clearAttachmentPreview(scope);
      ui.input.focus();
    });
    ["dragenter", "dragover"].forEach((name) => ui.dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      ui.dropzone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach((name) => ui.dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      ui.dropzone.classList.remove("is-dragging");
    }));
    ui.dropzone.addEventListener("drop", (event) => {
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
      if (!files.length) return;
      if (files.length !== 1) {
        clearAttachmentPreview(scope);
        setMessage(ui.message, "一次只能选择一个附件。");
        return;
      }
      try {
        const transfer = new DataTransfer();
        transfer.items.add(files[0]);
        ui.input.files = transfer.files;
      } catch (_error) {
        clearAttachmentPreview(scope);
        setMessage(ui.message, "当前浏览器无法拖放附件，请点按选择。");
        return;
      }
      previewAttachmentFile(files[0], scope);
    });
  }

  function bindEvents() {
    $$('[data-auth-tab]').forEach((button) => button.addEventListener("click", () => switchAuthTab(button.dataset.authTab)));
    $(".auth-tabs").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      switchAuthTab($("#login-panel").hidden ? "login" : "register");
    });
    $("#login-form").addEventListener("submit", login);
    $("#register-form").addEventListener("submit", register);
    $$('[data-toggle-password]').forEach((button) => {
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.togglePassword);
        if (!input) return;
        setPasswordVisibility(button, input.type === "password");
      });
    });
    $$('[data-switch-view]').forEach((button) => button.addEventListener("click", () => setMode(button.dataset.switchView)));
    $("#edit-today-task").addEventListener("click", () => openTaskEditor($("#edit-today-task").dataset.taskDate));
    $("#edit-tomorrow-task").addEventListener("click", () => openTaskEditor($("#edit-tomorrow-task").dataset.taskDate));
    $("#complete-today-task").addEventListener("click", () => openProofEditor($("#complete-today-task").dataset.taskDate));
    $("#view-today-proof").addEventListener("click", () => openRecord(taskFor($("#view-today-proof").dataset.taskDate), "owner"));
    $("#visitor-view-proof").addEventListener("click", () => openRecord(taskFor($("#visitor-view-proof").dataset.taskDate), "visitor"));
    $("#create-stage-button").addEventListener("click", openStageEditor);
    $("#edit-stage-button").addEventListener("click", openStageEditor);
    $("#complete-stage-button").addEventListener("click", openStageCompletion);
    $("#owner-stage-expand").addEventListener("click", () => toggleStageExpansion("owner"));
    $("#visitor-stage-expand").addEventListener("click", () => toggleStageExpansion("visitor"));
    $("#stage-form").addEventListener("submit", saveStage);
    $("#stage-complete-form").addEventListener("submit", completeStage);
    [["owner", $("#owner-last-stage")], ["visitor", $("#visitor-last-stage")]].forEach(([scope, button]) => button.addEventListener("click", () => {
      if (!button.dataset.stageId || !button.dataset.recordDate) return;
      openDateRecord(button.dataset.recordDate, taskFor(button.dataset.recordDate), button.dataset.stageId, scope);
    }));
    $("#task-form").addEventListener("submit", saveTask);
    $("#delete-task-button").addEventListener("click", deleteTask);
    $("#proof-form").addEventListener("submit", submitProof);
    $$('input[name="resultStatus"]').forEach((input) => input.addEventListener("change", updateResultForm));
    $("#result-progress-input").addEventListener("input", updateResultForm);
    bindAttachmentPicker("daily");
    bindAttachmentPicker("stage");
    $("#focus-form").addEventListener("submit", (event) => {
      event.preventDefault();
      saveFocus(true);
    });
    $$('[data-step]').forEach((button) => button.addEventListener("click", () => {
      const input = $("#focus-poms");
      const next = Math.min(100000, Math.max(0, (Number.parseInt(input.value, 10) || 0) + Number(button.dataset.step)));
      input.value = String(next);
      scheduleFocusSave();
    }));
    $("#focus-poms").addEventListener("change", scheduleFocusSave);
    $("#focus-distractions").addEventListener("input", scheduleFocusSave);
    $("#focus-note").addEventListener("input", scheduleFocusSave);
    $("#import-legacy-data").addEventListener("click", importLegacyData);
    $("#show-all-history").addEventListener("click", () => {
      state.ownerHistoryExpanded = !state.ownerHistoryExpanded;
      renderHistory("owner");
    });
    $("#visitor-load-more").addEventListener("click", () => {
      state.visitorHistoryLimit += 8;
      renderHistory("visitor");
    });
    $("#previous-year").addEventListener("click", () => moveHistoryYear("owner", -1));
    $("#next-year").addEventListener("click", () => moveHistoryYear("owner", 1));
    $("#visitor-previous-year").addEventListener("click", () => moveHistoryYear("visitor", -1));
    $("#visitor-next-year").addEventListener("click", () => moveHistoryYear("visitor", 1));
    [$("#history-grid"), $("#visitor-history-grid")].forEach((grid) => {
      grid.addEventListener("keydown", handleHistoryGridKeydown);
    });
    $("#open-password-dialog").addEventListener("click", () => {
      $("#account-menu").open = false;
      openPasswordDialog(false);
    });
    $("#password-form").addEventListener("submit", changePassword);
    $("#password-dialog").addEventListener("cancel", (event) => {
      if (state.forcedPasswordChange) event.preventDefault();
    });
    $("#logout-button").addEventListener("click", logout);
    $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (dialog === $("#password-dialog") && state.forcedPasswordChange) return;
      if (dialog === $("#confirm-dialog")) finishConfirmation(false);
      else closeDialog(dialog);
    }));
    $("#confirm-form").addEventListener("submit", (event) => {
      event.preventDefault();
      finishConfirmation(true);
    });
    $("#confirm-dialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      finishConfirmation(false);
    });
    [$("#task-dialog"), $("#proof-dialog"), $("#stage-dialog"), $("#stage-complete-dialog")].forEach((dialog) => dialog.addEventListener("close", () => {
      setMessage(dialog.querySelector(".form-message"), "");
      if (dialog === $("#proof-dialog")) clearProofPreview();
      if (dialog === $("#stage-complete-dialog")) clearStageImagePreview();
    }));
    [$("#task-text-input"), $("#proof-text-input"), $("#stage-title-input"), $("#stage-description-input"), $("#stage-proof-text")].forEach((input) => {
      input.addEventListener("input", () => updateCharacterCount(input));
    });
  }

  bindEvents();
  bootstrap();

  window.setInterval(async () => {
    const current = dateKeyInShanghai();
    if (current !== state.renderedDate) {
      state.renderedDate = current;
      state.historyYear = Number(current.slice(0, 4));
      state.visitorHistoryYear = state.historyYear;
      if (state.user) {
        try {
          await loadData();
        } catch (_error) {
          toast("日期已更新，刷新页面即可继续。", "error");
        }
      }
    }
  }, 30000);
}());
