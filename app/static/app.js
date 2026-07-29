(function () {
  "use strict";

  const LEGACY_KEY = "daily-seal-v1";
  const PREVIEW_KEY = "daily-seal-owner-view";
  const ACTIVE_SPACE_KEY = "day1-active-space";
  const SHANGHAI_TZ = "Asia/Shanghai";
  const VIEWER_CODE_REFRESH_CONFIRMATION = "我确认刷新并知道会断开所有访客端连接";
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
    spaces: [],
    defaultSpaceId: "",
    activeSpaceId: "",
    workspace: null,
    access: "",
    tasks: [],
    stats: {},
    publicPoms: {},
    activeGoal: null,
    activeStage: null,
    stageYears: {},
    mode: "visitor",
    returnToPlatform: false,
    connectionLostReason: "",
    connectionLostKind: "",
    viewerCode: "",
    viewerCodeConnections: 0,
    platformOverview: null,
    platformIpAccess: null,
    platformTab: "spaces",
    deleteSpaceTarget: null,
    messagesPayload: null,
    selectedConversationId: "",
    messageRefreshTimer: null,
    privateRequestEpoch: 0,
    messageRequestEpoch: 0,
    lastAccessCheckAt: 0,
    historyYear: Number(dateKeyInShanghai().slice(0, 4)),
    visitorHistoryYear: Number(dateKeyInShanghai().slice(0, 4)),
    ownerHistoryExpanded: false,
    visitorHistoryLimit: 8,
    selectedOwnerDate: "",
    selectedVisitorDate: "",
    progressFiles: [],
    progressPreviewUrls: [],
    progressRecordId: "",
    progressUploadId: null,
    progressUploadDate: "",
    progressBaselinePercent: 0,
    stageImagePreviewUrl: "",
    recordViewDate: "",
    recordViewScope: "visitor",
    forcedPasswordChange: false,
    confirmResolver: null,
    focusSaveTimer: null,
    renderedDate: dateKeyInShanghai(),
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function textValue(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : (fallback || "");
  }

  function normalizeSpace(space) {
    if (!space || typeof space !== "object") return null;
    const publicId = textValue(space.publicId || space.id);
    if (!publicId) return null;
    return {
      publicId,
      name: textValue(space.name, "未命名 Day1"),
      access: space.access === "owner" ? "owner" : "viewer",
      connectionStatus: ["revoked", "blocked"].includes(space.connectionStatus) ? space.connectionStatus : "active",
      revokedReason: textValue(space.revokedReason),
      canDisconnect: Boolean(space.canDisconnect),
      platformPreview: Boolean(space.platformPreview || space.access === "platform_preview"),
      appearance: {
        mascotEnabled: true,
      },
      ownerEmail: textValue(space.ownerEmail),
      ownerDisplayName: textValue(space.ownerDisplayName || space.ownerName),
      activeConnections: Number.isFinite(Number(space.activeConnections)) ? Number(space.activeConnections) : 0,
      isBlueSpace: Boolean(space.isBlueSpace),
    };
  }

  function spaceById(publicId) {
    return state.spaces.find((space) => space.publicId === publicId) || null;
  }

  function activeSpace() {
    return state.workspace || spaceById(state.activeSpaceId);
  }

  function canManageActiveWorkspace() {
    return Boolean(state.user && state.activeSpaceId && state.access === "owner" && state.mode === "owner");
  }

  function isPlatformAdmin() {
    return Boolean(state.user && state.user.isPlatformAdmin);
  }

  function isSpaceScopedApi(path) {
    return [
      "/api/data",
      "/api/tasks",
      "/api/stats",
      "/api/stages",
      "/api/import",
      "/api/export",
      "/api/messages",
      "/api/spaces/current",
    ].some((prefix) => path === prefix || path.startsWith(prefix));
  }

  function uniqueToken(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return `${prefix}-${window.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

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
    constructor(message, status, code, payload) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.payload = payload || null;
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

  function taskProgressEntries(task) {
    if (!task || !Array.isArray(task.progressEntries)) return [];
    return task.progressEntries
      .filter((entry) => entry && typeof entry === "object")
      .slice()
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }

  function progressPercent(entry) {
    const value = Number.parseInt(entry && entry.progressPercent, 10);
    return Number.isInteger(value) ? Math.min(100, Math.max(0, value)) : 0;
  }

  function progressIsSupplemental(entry, taskDate) {
    if (!entry || entry.legacy) return false;
    if (typeof entry.supplemental === "boolean") return entry.supplemental;
    return Boolean(entry.recordDate && taskDate && entry.recordDate > taskDate);
  }

  function latestProgressEntry(task) {
    const entries = taskProgressEntries(task);
    return entries.length ? entries[entries.length - 1] : null;
  }

  function taskDayProgressEntries(task) {
    return taskProgressEntries(task).filter((entry) => !progressIsSupplemental(entry, task && task.date));
  }

  function taskSupplementEntries(task) {
    return taskProgressEntries(task).filter((entry) => progressIsSupplemental(entry, task && task.date));
  }

  function latestDayProgressEntry(task) {
    const entries = taskDayProgressEntries(task);
    return entries.length ? entries[entries.length - 1] : null;
  }

  function latestSupplementEntry(task) {
    const entries = taskSupplementEntries(task);
    return entries.length ? entries[entries.length - 1] : null;
  }

  function taskHasProgress(task) {
    return taskProgressEntries(task).length > 0;
  }

  function taskHasSupplement(task) {
    if (!task) return false;
    if (typeof task.supplemented === "boolean") return task.supplemented;
    return taskSupplementEntries(task).length > 0;
  }

  function taskHasPublicRecord(task) {
    return Boolean(task && (taskHasResult(task) || taskHasProgress(task)));
  }

  function taskResultStatus(task) {
    if (!task) return "pending";
    if (["completed", "incomplete"].includes(task.resultStatus)) return task.resultStatus;
    return task.done ? "completed" : "pending";
  }

  function taskHasResult(task) {
    return taskResultStatus(task) !== "pending";
  }

  function taskResultIsStale(task) {
    if (!taskHasResult(task) || task.resultLocked) return false;
    if (typeof task.resultIsStale === "boolean") return task.resultIsStale;
    const latest = latestDayProgressEntry(task);
    if (!latest) return false;
    const latestTime = Date.parse(latest.createdAt || "");
    const resultTime = Date.parse(task.resultRecordedAt || task.completedAt || "");
    return Number.isFinite(latestTime) && Number.isFinite(resultTime) && latestTime > resultTime;
  }

  function taskCompletionPercent(task) {
    const status = taskResultStatus(task);
    if (status === "completed") return 100;
    const stored = Number.parseInt(task && task.completionPercent, 10);
    const storedPercent = Number.isInteger(stored) ? Math.min(99, Math.max(0, stored)) : 0;
    if (status === "pending") return progressPercent(latestDayProgressEntry(task));
    if (taskResultIsStale(task)) return progressPercent(latestDayProgressEntry(task));
    return storedPercent;
  }

  function taskSupplementPercent(task) {
    const stored = Number.parseInt(task && task.supplementCompletionPercent, 10);
    if (Number.isInteger(stored)) return Math.min(100, Math.max(0, stored));
    return progressPercent(latestSupplementEntry(task));
  }

  function taskCompletionSummary(task) {
    const original = taskCompletionPercent(task);
    if (!taskHasSupplement(task)) return `当日 ${original}%`;
    return `当日 ${original}% · 次日补充至 ${taskSupplementPercent(task)}%`;
  }

  function taskCanAddProgress(task) {
    if (!task) return false;
    if (typeof task.canAddProgress === "boolean") return task.canAddProgress;
    const today = dateKeyInShanghai();
    return task.date === today || task.date === shiftDate(today, -1);
  }

  function taskCanRecordResult(task) {
    if (!task) return false;
    if (typeof task.canRecordResult === "boolean") return task.canRecordResult;
    return task.date === dateKeyInShanghai() && !task.resultLocked;
  }

  function taskResultNote(task) {
    if (!task) return "";
    if (typeof task.resultNote === "string" && task.resultNote.trim()) return task.resultNote.trim();
    return typeof task.proofText === "string" ? task.proofText.trim() : "";
  }

  function taskProgressLevel(task) {
    if (!taskHasPublicRecord(task)) return 0;
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
      if (taskResultIsStale(task)) return includePercent ? `有新进度 · ${taskCompletionPercent(task)}%` : "有新进度";
      return includePercent ? `未完成 · ${taskCompletionPercent(task)}%` : "未完成";
    }
    if (taskHasProgress(task)) {
      return includePercent ? `进行中 · ${taskCompletionPercent(task)}%` : "进行中";
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
    return Boolean(scope === "owner" && state.user && state.access === "owner");
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
    const latest = latestProgressEntry(task);
    const latestTime = latest ? Date.parse(latest.createdAt || "") : Number.NaN;
    const resultTime = Date.parse(task.resultRecordedAt || task.completedAt || "");
    const latestIsNewest = Boolean(latest && (!Number.isFinite(resultTime) || (Number.isFinite(latestTime) && latestTime >= resultTime)));
    if (latestIsNewest && typeof latest.note === "string" && latest.note.trim()) return latest.note.trim();
    if (latestIsNewest) return `${taskProgressEntries(task).length} 次进度更新 · 当前 ${progressPercent(latest)}%`;
    if (taskResultNote(task)) return taskResultNote(task);
    if (latest && typeof latest.note === "string" && latest.note.trim()) return latest.note.trim();
    if (latest) return `${taskProgressEntries(task).length} 次进度更新 · 当前 ${progressPercent(latest)}%`;
    if (task.proofUrl) return "已添加证据链接";
    if (hasProofAttachment(task)) return "已上传完成附件";
    return taskResultStatus(task) === "incomplete" ? "已留下最终反馈" : "已留下完成记录";
  }

  function shanghaiHour() {
    const value = new Intl.DateTimeFormat("en-GB", {
      timeZone: SHANGHAI_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(new Date());
    return Number.parseInt(value, 10) || 0;
  }

  function contextualCopy(task, visitor) {
    const hour = shanghaiHour();
    const status = taskResultStatus(task);
    if (!task) {
      return visitor
        ? "今天的页面还很安静，新的任务出现后会留在这里。"
        : "先定下一件事，今天就从一个清楚的起点开始。";
    }
    if (status === "completed") {
      return visitor
        ? "今天的目标已经收好，过程与结果都留在了这里。"
        : "今天已经收好。停下来看看这一路，再安心结束。";
    }
    if (status === "incomplete") {
      return visitor
        ? "真实的进度也被认真留下，下一次可以从这里继续。"
        : "结果不必被修饰。记住走到哪里，明天就不必重新寻找方向。";
    }
    if (taskHasProgress(task)) {
      const percent = taskCompletionPercent(task);
      if (hour >= 20) return visitor
        ? `今天已经走到 ${percent}%，晚些时候会留下最后的落点。`
        : `今天走到 ${percent}% 了。只确认下一步，不必一次想完全部。`;
      return visitor
        ? `今天已经留下 ${taskProgressEntries(task).length} 次脚印，事情正在向前。`
        : `已经走到 ${percent}%。把范围收小，继续完成眼前这一段。`;
    }
    if (hour < 11) return visitor
      ? "新的一天刚刚展开，今天的方向已经写在这里。"
      : "先从最小的一步开始，让行动带来后面的清晰。";
    if (hour < 18) return visitor
      ? "事情正在发生，下一次进度会接着写在这里。"
      : "不需要追赶全部，只把此刻能推进的一段做实。";
    return visitor
      ? "一天还没有定稿，最后的结果会如实留在这里。"
      : "先停一下，确认现在的位置，再选择今晚最值得完成的一步。";
  }

  async function loadStageYear(year) {
    const payload = await api(`/api/stages?year=${encodeURIComponent(String(year))}`);
    state.activeGoal = payload.activeGoal || null;
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
    if (state.activeSpaceId && isSpaceScopedApi(path)) {
      headers.set("X-Day1-Space", state.activeSpaceId);
    }
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
      const error = new ApiError(
        payload && payload.error ? payload.error : "请求没有成功，请稍后重试。",
        response.status,
        payload && payload.code ? payload.code : "request_failed",
        payload,
      );
      if (response.status === 410 && error.code === "preview_access_revoked") {
        handleRevokedConnection(payload);
      } else if (
        response.status === 403
        && error.code === "visitor_ip_blocked"
        && state.activeSpaceId
        && isSpaceScopedApi(path)
      ) {
        handleBlockedConnection(payload);
      } else if (response.status === 410 && error.code === "space_deleted" && !path.startsWith("/api/platform/")) {
        handleDeletedSpace(payload);
      } else if (
        response.status === 403
        && error.code === "space_access_required"
        && state.activeSpaceId
        && isSpaceScopedApi(path)
      ) {
        await reconcileMissingSpaceAccess(payload);
      }
      throw error;
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
    $("#auth-title").textContent = name === "login" ? "欢迎回来" : "注册 Blue Day1";
    $("#auth-description").textContent = name === "login"
      ? "登录后继续查看今天的记录。"
      : "用识别码预览一个端，或用 Blue 的邀请创建自己的管理端。";
    setMessage($("#auth-message"), "");
    const focusTarget = name === "login"
      ? $("#login-email")
      : (selectedRegistrationKind() === "manager" ? $("#register-manager-invite") : $("#register-viewer-code"));
    window.setTimeout(() => focusTarget.focus(), 0);
  }

  function selectedRegistrationKind() {
    const selected = document.querySelector('input[name="registrationKind"]:checked');
    return selected && selected.value === "manager" ? "manager" : "viewer";
  }

  function switchRegistrationKind(kind) {
    const manager = kind === "manager";
    $("#viewer-registration-fields").hidden = manager;
    $("#manager-registration-fields").hidden = !manager;
    $("#register-viewer-code").required = !manager;
    $("#register-manager-invite").required = manager;
    $("#register-space-name").required = manager;
    $$(".registration-kind-option").forEach((option) => {
      const input = option.querySelector('input[name="registrationKind"]');
      option.classList.toggle("is-active", Boolean(input && input.checked));
    });
    $("#register-notice-title").textContent = manager
      ? "用 Blue 的邀请创建独立管理端"
      : "用识别码加入一个 Day1";
    $("#register-notice-copy").textContent = manager
      ? "创建后只管理自己的记录，不能操作其他管理端。"
      : "注册后只能查看对方公开的记录，并给管理者留言。";
    $("#register-submit").textContent = manager ? "创建我的管理端" : "创建访客账号";
    setMessage($("#auth-message"), "");
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
    const displayName = state.user ? textValue(state.user.displayName) : "";
    const initial = (displayName.charAt(0) || email.charAt(0) || "Q").toUpperCase();
    $("#account-email").textContent = email || "—";
    $("#account-email-short").textContent = displayName || (email ? email.split("@")[0] : "账户");
    $("#account-avatar").textContent = initial;
    $("#account-avatar-large").textContent = initial;
    const roleLabel = isPlatformAdmin()
      ? "Blue 平台管理员"
      : (state.user && ["owner", "manager"].includes(state.user.role) ? "管理者" : "只读访客");
    $("#account-role-label").textContent = roleLabel;
    const badge = $("#role-badge");
    badge.textContent = state.mode === "platform"
      ? "平台"
      : (canManageActiveWorkspace() ? "管理者" : "只读");
    badge.classList.toggle("is-owner", canManageActiveWorkspace() || state.mode === "platform");
    $("#account-platform-overview").hidden = !isPlatformAdmin();
    $("#platform-entry-wrap").hidden = !isPlatformAdmin();
  }

  async function loadSession() {
    const payload = await api("/api/session");
    state.csrfToken = payload.csrfToken;
    state.user = payload.user;
    state.spaces = (Array.isArray(payload.spaces) ? payload.spaces : []).map(normalizeSpace).filter(Boolean);
    state.defaultSpaceId = textValue(payload.defaultSpaceId);
    configureRegistration(Boolean(payload.registrationOpen));
    const storedSpaceId = sessionStorage.getItem(ACTIVE_SPACE_KEY) || "";
    const currentIsKnown = Boolean(state.activeSpaceId && spaceById(state.activeSpaceId));
    if (!currentIsKnown) {
      state.activeSpaceId = [storedSpaceId, state.defaultSpaceId]
        .find((publicId) => Boolean(publicId && spaceById(publicId)))
        || (state.spaces[0] ? state.spaces[0].publicId : "");
    }
    return payload;
  }

  async function refreshSpaceAccess() {
    if (!state.user || !state.activeSpaceId || state.returnToPlatform || ["platform", "connection-lost"].includes(state.mode)) return;
    const payload = await api("/api/session");
    if (!payload.authenticated || !payload.user) {
      showAuth();
      return;
    }
    state.csrfToken = payload.csrfToken || state.csrfToken;
    state.user = payload.user;
    const spaces = (Array.isArray(payload.spaces) ? payload.spaces : []).map(normalizeSpace).filter(Boolean);
    const current = spaces.find((space) => space.publicId === state.activeSpaceId);
    state.spaces = spaces;
    if (!current) {
      handleDeletedSpace({
        error: "这个管理端已被删除，相关记录与访客连接已不再保留。",
      });
      return;
    }
    if (current.connectionStatus === "revoked") {
      state.workspace = current;
      state.access = current.access;
      handleRevokedConnection({
        revokedReason: current.revokedReason,
      });
      return;
    }
    if (current.connectionStatus === "blocked") {
      state.workspace = current;
      state.access = current.access;
      handleBlockedConnection({ error: current.revokedReason });
      return;
    }
    state.workspace = Object.assign({}, state.workspace || {}, current);
    state.access = current.access;
    renderWorkspaceChrome();
    configureMessageWidget();
  }

  async function loadData() {
    if (!state.activeSpaceId) throw new ApiError("请先连接或选择一个 Day1。", 400, "space_required");
    const payload = await api("/api/data");
    const previousWorkspace = spaceById(state.activeSpaceId);
    const workspace = normalizeSpace(Object.assign({}, payload.workspace || {}, {
      access: payload.access || (payload.workspace && payload.workspace.access),
    })) || previousWorkspace;
    if (workspace && previousWorkspace) {
      workspace.canDisconnect = workspace.canDisconnect || previousWorkspace.canDisconnect;
      workspace.platformPreview = workspace.platformPreview || previousWorkspace.platformPreview;
    }
    state.workspace = workspace;
    state.access = payload.access === "owner" || (workspace && workspace.access === "owner") ? "owner" : "viewer";
    if (workspace) {
      workspace.access = state.access;
      const existingIndex = state.spaces.findIndex((space) => space.publicId === workspace.publicId);
      if (existingIndex >= 0) state.spaces.splice(existingIndex, 1, workspace);
      else state.spaces.push(workspace);
    }
    state.tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    state.stats = payload.stats && typeof payload.stats === "object" ? payload.stats : {};
    state.publicPoms = payload.publicPoms && typeof payload.publicPoms === "object" ? payload.publicPoms : {};
    state.user = payload.user || state.user;
    const currentYear = Number(dateKeyInShanghai().slice(0, 4));
    const years = Array.from(new Set([currentYear, state.historyYear, state.visitorHistoryYear]));
    await Promise.all(years.map((year) => loadStageYear(year)));
    renderAll();
    renderWorkspaceChrome();
  }

  async function enterApp() {
    accountDetails();
    renderWorkspaceMenu();
    const selectedSpace = spaceById(state.activeSpaceId);
    if (!selectedSpace) {
      showPrimaryView("app");
      showConnectionLost("你还没有连接任何预览端。输入识别码后，就能在这里查看对应的 Day1。", true, "empty");
      return;
    }
    if (selectedSpace.connectionStatus === "revoked") {
      showPrimaryView("app");
      state.workspace = selectedSpace;
      state.access = selectedSpace.access;
      showConnectionLost(selectedSpace.revokedReason, false, "revoked");
      return;
    }
    if (selectedSpace.connectionStatus === "blocked") {
      showPrimaryView("app");
      state.workspace = selectedSpace;
      state.access = selectedSpace.access;
      showConnectionLost(selectedSpace.revokedReason, false, "blocked");
      return;
    }
    const preferredMode = selectedSpace.access === "owner" && sessionStorage.getItem(PREVIEW_KEY) !== "visitor"
      ? "owner"
      : "visitor";
    try {
      await loadData();
    } catch (error) {
      if (["preview_access_revoked", "visitor_ip_blocked", "space_deleted", "space_access_required"].includes(error.code)) return;
      throw error;
    }
    showPrimaryView("app");
    setMode(preferredMode);
    checkLegacyData();
    if (state.user.mustChangePassword) openPasswordDialog(true);
  }

  function showAuth() {
    clearPrivateClientState();
    state.user = null;
    state.tasks = [];
    state.stats = {};
    state.publicPoms = {};
    state.spaces = [];
    state.defaultSpaceId = "";
    state.activeSpaceId = "";
    state.workspace = null;
    state.access = "";
    state.platformOverview = null;
    state.platformIpAccess = null;
    state.deleteSpaceTarget = null;
    state.connectionLostKind = "";
    state.connectionLostReason = "";
    state.messagesPayload = null;
    state.lastAccessCheckAt = 0;
    state.selectedOwnerDate = "";
    state.selectedVisitorDate = "";
    state.activeGoal = null;
    state.activeStage = null;
    state.stageYears = {};
    state.forcedPasswordChange = false;
    sessionStorage.removeItem(PREVIEW_KEY);
    sessionStorage.removeItem(ACTIVE_SPACE_KEY);
    $("#login-form").reset();
    $("#register-form").reset();
    resetPasswordVisibility();
    switchRegistrationKind("viewer");
    showPrimaryView("auth");
    switchAuthTab("login");
  }

  function clearPrivateClientState() {
    state.privateRequestEpoch += 1;
    window.clearTimeout(state.focusSaveTimer);
    state.focusSaveTimer = null;
    state.stats = {};
    state.publicPoms = {};
    state.selectedOwnerDate = "";
    state.selectedVisitorDate = "";
    state.activeGoal = null;
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
    $("#record-progress-section").hidden = true;
    $("#record-progress-list").replaceChildren();
    $("#record-focus-section").hidden = true;
    $("#record-private-section").hidden = true;
    $("#record-distractions-text").textContent = "";
    $("#record-note-text").textContent = "";
    $("#record-add-progress").hidden = true;
    $("#account-email").textContent = "—";
    $("#account-email-short").textContent = "账户";
    $("#account-role-label").textContent = "";
    $("#task-form").reset();
    $("#progress-form").reset();
    $("#proof-form").reset();
    $("#goal-form").reset();
    $("#stage-form").reset();
    $("#stage-complete-form").reset();
    $("#subgoal-form").reset();
    $("#subgoal-form").dataset.editId = "";
    $("#password-form").reset();
    $("#message-form").reset();
    $("#message-panel").hidden = true;
    $("#message-toggle").setAttribute("aria-expanded", "false");
    clearMessageContent();
    state.viewerCode = "";
    state.viewerCodeConnections = 0;
    $("#viewer-code-value").textContent = "展开后载入";
    $("#viewer-code-connections").textContent = "—";
    $("#copy-viewer-code").disabled = true;
    $("#open-refresh-viewer-code").disabled = true;
    state.platformOverview = null;
    state.platformIpAccess = null;
    state.deleteSpaceTarget = null;
    $("#platform-space-count").textContent = "—";
    $("#platform-user-count").textContent = "—";
    $("#platform-connection-count").textContent = "—";
    $("#platform-spaces-list").replaceChildren();
    $("#platform-users-list").replaceChildren();
    $("#platform-visitor-ip-list").replaceChildren();
    $("#platform-ip-block-list").replaceChildren();
    $("#platform-blacklist-count").textContent = "0 条";
    setMessage($("#platform-message"), "");
    $("#manager-invite-code").textContent = "—";
    $("#manager-invite-result").hidden = true;
    $("#manager-invite-empty").hidden = false;
    setMessage($("#manager-invite-message"), "");
    $("#delete-space-form").reset();
    $("#delete-space-submit").disabled = true;
    setMessage($("#delete-space-message"), "");
    $("#ip-block-form").reset();
    setMessage($("#ip-block-message"), "");
    $("#workspace-danger-zone").hidden = true;
    $("#workspace-danger-zone").open = false;
    clearProgressFiles();
    clearStageImagePreview();
    ["#task-dialog", "#progress-dialog", "#proof-dialog", "#goal-route-dialog", "#goal-dialog", "#stage-dialog", "#stage-complete-dialog", "#proof-view-dialog", "#password-dialog", "#confirm-dialog", "#connect-space-dialog", "#refresh-viewer-code-dialog", "#delete-space-dialog", "#ip-block-dialog", "#manager-invite-dialog"].forEach((selector) => {
      const dialog = $(selector);
      if (dialog.open) closeDialog(dialog);
    });
  }

  function clearWorkspaceState() {
    state.tasks = [];
    state.stats = {};
    state.publicPoms = {};
    state.activeGoal = null;
    state.activeStage = null;
    state.stageYears = {};
    state.workspace = null;
    state.access = "";
    clearPrivateClientState();
    accountDetails();
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

  function workspaceOption(space) {
    const row = document.createElement("div");
    row.className = "workspace-option-row";
    const button = document.createElement("button");
    button.className = "workspace-option";
    button.type = "button";
    button.dataset.workspaceId = space.publicId;
    if (space.publicId === state.activeSpaceId && state.mode !== "platform") {
      button.classList.add("is-current");
      button.setAttribute("aria-current", "page");
    }
    if (space.connectionStatus === "revoked") button.classList.add("is-revoked");
    if (space.connectionStatus === "blocked") button.classList.add("is-blocked");

    const mark = document.createElement("span");
    mark.className = "workspace-option-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = (space.name.charAt(0) || "D").toUpperCase();

    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = space.name;
    const meta = document.createElement("small");
    meta.textContent = space.connectionStatus === "revoked"
      ? "连接已失效"
      : (space.connectionStatus === "blocked"
        ? "当前网络受限"
        : (space.access === "owner" ? "我的管理端" : "只读预览"));
    copy.append(name, meta);

    const indicator = document.createElement("span");
    indicator.className = "workspace-option-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.textContent = space.publicId === state.activeSpaceId && state.mode !== "platform" ? "✓" : "›";
    button.append(mark, copy);
    if (space.access === "owner") button.appendChild(indicator);
    button.addEventListener("click", () => switchWorkspace(space.publicId));
    row.appendChild(button);
    if (space.access !== "owner") {
      const disconnect = document.createElement("button");
      disconnect.className = "workspace-option-disconnect";
      disconnect.type = "button";
      disconnect.textContent = "断开";
      disconnect.dataset.loadingLabel = "…";
      disconnect.setAttribute("aria-label", `断开与 ${space.name} 的预览连接`);
      disconnect.addEventListener("click", () => disconnectWorkspace(space, disconnect));
      row.appendChild(disconnect);
    }
    return row;
  }

  function renderWorkspaceMenu() {
    const list = $("#workspace-list");
    list.replaceChildren();
    if (!state.spaces.length) {
      const empty = document.createElement("p");
      empty.className = "workspace-list-empty";
      empty.textContent = "还没有可切换的端。";
      list.appendChild(empty);
    } else {
      const ordered = state.spaces.slice().sort((a, b) => {
        if (a.access !== b.access) return a.access === "owner" ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      });
      ordered.forEach((space) => list.appendChild(workspaceOption(space)));
    }
    $("#platform-entry-wrap").hidden = !isPlatformAdmin();
  }

  async function disconnectWorkspace(space, button) {
    if (!space || space.access === "owner") return;
    $("#workspace-menu").open = false;
    const persistentConnection = Boolean(space.canDisconnect);
    const description = persistentConnection
      ? `断开与「${space.name}」的预览连接吗？这个端会从切换列表移除；对方的记录和既有留言不会被删除。以后需要使用有效识别码重新连接。`
      : `从切换列表移除「${space.name}」吗？不会影响对方的管理端，以后仍可从平台概览重新预览。`;
    const confirmed = await confirmAction(description, persistentConnection ? "确认断开" : "确认移除");
    if (!confirmed) return;

    const disconnectedActiveSpace = space.publicId === state.activeSpaceId;
    const returnToPlatform = Boolean(state.returnToPlatform && isPlatformAdmin());
    setLoading(button, true);
    try {
      if (persistentConnection) {
        const transientPreviews = state.spaces.filter((item) => (
          item.publicId !== space.publicId
          && item.platformPreview
          && !item.canDisconnect
        ));
        const payload = await api(`/api/spaces/connections/${encodeURIComponent(space.publicId)}`, {
          method: "DELETE",
        });
        const serverSpaces = (Array.isArray(payload.spaces) ? payload.spaces : []).map(normalizeSpace).filter(Boolean);
        const serverIds = new Set(serverSpaces.map((item) => item.publicId));
        state.spaces = serverSpaces.concat(
          transientPreviews.filter((item) => !serverIds.has(item.publicId)),
        );
        state.defaultSpaceId = textValue(payload.defaultSpaceId);
      } else {
        state.spaces = state.spaces.filter((item) => item.publicId !== space.publicId);
      }

      if (!disconnectedActiveSpace) {
        renderWorkspaceChrome();
        toast(persistentConnection ? "预览连接已断开。" : "已从切换列表移除。", "success");
        return;
      }

      $("#message-panel").hidden = true;
      $("#message-toggle").setAttribute("aria-expanded", "false");
      clearMessageContent();
      sessionStorage.removeItem(ACTIVE_SPACE_KEY);
      clearWorkspaceState();

      if (returnToPlatform) {
        state.returnToPlatform = false;
        const fallback = state.spaces.find((item) => item.access === "owner" && item.connectionStatus === "active")
          || state.spaces.find((item) => item.connectionStatus === "active")
          || null;
        state.activeSpaceId = fallback ? fallback.publicId : "";
        if (fallback) sessionStorage.setItem(ACTIVE_SPACE_KEY, fallback.publicId);
        showPrimaryView("app");
        setMode("platform");
        await loadPlatformOverview();
      } else {
        const fallback = state.spaces.find((item) => item.access === "owner" && item.connectionStatus === "active")
          || state.spaces.find((item) => item.connectionStatus === "active")
          || null;
        if (fallback) {
          await switchWorkspace(
            fallback.publicId,
            fallback.access === "owner" ? "owner" : "visitor",
          );
        } else {
          state.activeSpaceId = "";
          showPrimaryView("app");
          showConnectionLost(
            "当前没有已连接的预览端。需要时可输入新的识别码。",
            true,
            "empty",
          );
        }
      }
      toast(persistentConnection ? "预览连接已断开。" : "已从切换列表移除。", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setLoading(button, false);
    }
  }

  function renderWorkspaceChrome() {
    const space = activeSpace();
    const name = space ? space.name : "未连接端";
    $("#active-workspace-name").textContent = state.mode === "platform" ? "平台概览" : name;
    $("#active-workspace-access").textContent = state.mode === "platform"
      ? "Blue 平台"
      : (space && ["revoked", "blocked"].includes(space.connectionStatus)
        ? (space.connectionStatus === "blocked" ? "访问受限" : "连接已失效")
        : (state.access === "owner" ? "我的管理端" : "只读预览"));
    $("#workspace-mark").textContent = state.mode === "platform" ? "P" : ((name.charAt(0) || "D").toUpperCase());
    $("#footer-workspace-name").textContent = state.mode === "platform"
      ? "Blue 平台"
      : (space ? space.name : "BlueDay1");
    $("#view-switcher").hidden = !(state.access === "owner" && ["owner", "visitor"].includes(state.mode));
    $("#workspace-view-actions-mobile").hidden = !(state.access === "owner" && ["owner", "visitor"].includes(state.mode));
    const canDeleteOwnSpace = Boolean(
      space
      && state.access === "owner"
      && !space.isBlueSpace
      && !isPlatformAdmin(),
    );
    $("#workspace-danger-zone").hidden = !canDeleteOwnSpace;
    if (!canDeleteOwnSpace) $("#workspace-danger-zone").open = false;
    renderWorkspaceMenu();
    accountDetails();
  }

  function showDashboardView(name) {
    ["owner", "visitor", "platform", "connection-lost"].forEach((view) => {
      const element = $(`#${view}-view`);
      if (element) element.hidden = view !== name;
    });
  }

  function showConnectionLost(reason, noSpaces, kind) {
    const nextKind = noSpaces ? "empty" : (kind || state.connectionLostKind || "revoked");
    state.mode = "connection-lost";
    state.connectionLostKind = nextKind;
    state.connectionLostReason = textValue(reason, "管理者已经刷新识别码，请向管理者获取新的识别码。");
    showDashboardView("connection-lost");
    const title = nextKind === "blocked"
      ? "当前网络暂时无法访问预览"
      : (nextKind === "deleted"
        ? "这个管理端已被删除"
        : (noSpaces ? "还没有连接的预览端" : "这个预览连接已失效"));
    $("#connection-lost-title").textContent = title;
    $("#connection-lost-reason").textContent = state.connectionLostReason;
    $("#connection-lost-kicker").textContent = nextKind === "blocked"
      ? "BlueDay1 · 访问安全"
      : "BlueDay1 · 预览连接";
    const mark = $("#connection-lost-mark");
    mark.textContent = nextKind === "blocked" ? "!" : (nextKind === "deleted" ? "—" : "×");
    mark.classList.toggle("is-blocked", nextKind === "blocked");
    mark.classList.toggle("is-deleted", nextKind === "deleted");
    const primary = $("#connection-lost-primary");
    primary.textContent = nextKind === "blocked" ? "重新检查" : (nextKind === "deleted" ? "连接其他端" : "输入新识别码");
    primary.dataset.connectionAction = nextKind === "blocked" ? "retry" : "connect";
    const alternatives = state.spaces.filter((space) => space.publicId !== state.activeSpaceId && space.connectionStatus === "active");
    $("#switch-after-connection-lost").hidden = alternatives.length === 0;
    $("#preview-banner").hidden = true;
    $("#message-widget").hidden = true;
    renderWorkspaceChrome();
  }

  function handleRevokedConnection(payload) {
    const reason = textValue(payload && (payload.revokedReason || payload.error), "管理者已经刷新识别码，请向管理者获取新的识别码。");
    const current = spaceById(state.activeSpaceId);
    if (current) {
      current.connectionStatus = "revoked";
      current.revokedReason = reason;
    }
    state.tasks = [];
    state.stats = {};
    state.publicPoms = {};
    state.activeGoal = null;
    state.activeStage = null;
    state.stageYears = {};
    state.messagesPayload = null;
    clearPrivateClientState();
    showPrimaryView("app");
    showConnectionLost(reason, false, "revoked");
  }

  function handleBlockedConnection(payload) {
    const reason = textValue(
      payload && (payload.revokedReason || payload.error),
      "当前网络地址已被 Blue 平台加入访客黑名单，暂时无法访问预览端。如有疑问请联系 Blue。",
    );
    const current = spaceById(state.activeSpaceId);
    if (current) {
      current.connectionStatus = "blocked";
      current.revokedReason = reason;
      state.workspace = current;
      state.access = current.access;
    }
    state.tasks = [];
    state.stats = {};
    state.publicPoms = {};
    state.activeGoal = null;
    state.activeStage = null;
    state.stageYears = {};
    state.messagesPayload = null;
    clearPrivateClientState();
    showPrimaryView("app");
    showConnectionLost(reason, false, "blocked");
  }

  function handleDeletedSpace(payload, deletedSpaceId) {
    const deletedId = deletedSpaceId || state.activeSpaceId;
    const reason = textValue(
      payload && (payload.deletedReason || payload.error),
      "这个管理端已被删除，相关记录、附件与访客连接已不再保留。",
    );
    state.spaces = state.spaces.filter((space) => space.publicId !== deletedId);
    state.tasks = [];
    state.stats = {};
    state.publicPoms = {};
    state.activeGoal = null;
    state.activeStage = null;
    state.stageYears = {};
    state.workspace = null;
    state.access = "";
    state.messagesPayload = null;
    state.activeSpaceId = "";
    sessionStorage.removeItem(ACTIVE_SPACE_KEY);
    sessionStorage.removeItem(PREVIEW_KEY);
    clearPrivateClientState();
    showPrimaryView("app");
    if (isPlatformAdmin() && state.returnToPlatform) {
      state.returnToPlatform = false;
      setMode("platform");
      toast("这个管理端已被删除，已返回平台概览。", "success");
      void loadPlatformOverview();
      return;
    }
    showConnectionLost(reason, false, "deleted");
  }

  async function reconcileMissingSpaceAccess(payload) {
    const missingSpaceId = state.activeSpaceId;
    try {
      await loadSession();
    } catch (_error) {
      return;
    }
    const current = spaceById(missingSpaceId);
    if (!current) {
      handleDeletedSpace(payload, missingSpaceId);
      return;
    }
    state.activeSpaceId = missingSpaceId;
    state.workspace = current;
    state.access = current.access;
    if (current.connectionStatus === "blocked") handleBlockedConnection({ error: current.revokedReason });
    else if (current.connectionStatus === "revoked") handleRevokedConnection({ error: current.revokedReason });
  }

  async function handleConnectionLostPrimary() {
    if (state.connectionLostKind !== "blocked") {
      openConnectSpaceDialog();
      return;
    }
    const button = $("#connection-lost-primary");
    const blockedSpaceId = state.activeSpaceId;
    setLoading(button, true);
    try {
      await loadSession();
      const current = spaceById(blockedSpaceId);
      if (!current) {
        handleDeletedSpace({ error: "这个管理端已被删除，相关记录与访客连接已不再保留。" });
        return;
      }
      if (current.connectionStatus === "blocked") {
        state.workspace = current;
        state.access = current.access;
        showConnectionLost(current.revokedReason, false, "blocked");
        toast("当前网络仍处于访客访问限制中。", "error");
        return;
      }
      await switchWorkspace(current.publicId);
      toast("访问限制已解除。", "success");
    } catch (error) {
      if (!["visitor_ip_blocked", "space_deleted"].includes(error.code)) toast(error.message, "error");
    } finally {
      setLoading(button, false);
    }
  }

  async function switchWorkspace(publicId, preferredMode, fromPlatform) {
    const selected = spaceById(publicId) || normalizeSpace({
      publicId,
      name: "Day1",
      access: "viewer",
      connectionStatus: "active",
    });
    if (!selected) return;
    $("#workspace-menu").open = false;
    clearWorkspaceState();
    state.activeSpaceId = selected.publicId;
    state.workspace = selected;
    state.access = selected.access;
    state.returnToPlatform = Boolean(fromPlatform);
    sessionStorage.setItem(ACTIVE_SPACE_KEY, selected.publicId);
    if (selected.connectionStatus === "revoked") {
      showPrimaryView("app");
      showConnectionLost(selected.revokedReason, false, "revoked");
      return;
    }
    if (selected.connectionStatus === "blocked") {
      showPrimaryView("app");
      showConnectionLost(selected.revokedReason, false, "blocked");
      return;
    }
    showPrimaryView("boot");
    try {
      await loadData();
      showPrimaryView("app");
      const nextMode = preferredMode || (state.access === "owner" && sessionStorage.getItem(PREVIEW_KEY) !== "visitor" ? "owner" : "visitor");
      setMode(nextMode);
      checkLegacyData();
    } catch (error) {
      if (["preview_access_revoked", "visitor_ip_blocked", "space_deleted", "space_access_required"].includes(error.code)) return;
      showPrimaryView("app");
      showConnectionLost(error.message || "暂时无法打开这个端。", false, "revoked");
    }
  }

  function setMode(mode) {
    if (mode === "platform" && isPlatformAdmin()) {
      state.mode = "platform";
      showDashboardView("platform");
      $("#preview-banner").hidden = true;
      $("#message-widget").hidden = true;
      clearMessageContent();
      renderWorkspaceChrome();
      switchPlatformTab(state.platformTab);
      return;
    }
    if (mode === "connection-lost") {
      showConnectionLost(state.connectionLostReason, !state.spaces.length, state.connectionLostKind);
      return;
    }
    const ownerMode = mode === "owner" && state.access === "owner";
    state.mode = ownerMode ? "owner" : "visitor";
    if (state.access === "owner") sessionStorage.setItem(PREVIEW_KEY, state.mode);
    showDashboardView(state.mode);
    const ownPreview = state.access === "owner" && state.mode === "visitor";
    const platformPreview = state.returnToPlatform && state.mode === "visitor";
    $("#preview-banner").hidden = !(ownPreview || platformPreview);
    $("#preview-banner-title").textContent = platformPreview ? "平台只读预览" : "访客预览";
    $("#preview-banner-copy").textContent = platformPreview
      ? "你只能检查公开记录；留言中只会显示你与这个端之间的对话。"
      : "这是其他账号看到的只读页面。";
    $("#exit-preview-button").textContent = platformPreview ? "返回平台" : "返回管理";
    $("#exit-preview-button").dataset.switchView = platformPreview ? "platform" : "owner";
    $$('[data-switch-view]').forEach((button) => {
      const active = button.dataset.switchView === state.mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderWorkspaceChrome();
    if (state.mode === "visitor") renderVisitor();
    configureMessageWidget();
    if (state.mode === "owner" && $("#access-tools").open && !state.viewerCode) loadViewerCode();
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
      element.textContent = task && taskHasProgress(task) ? `进行中 · ${taskCompletionPercent(task)}%` : (task ? pendingText : emptyText);
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

  function activeGoalStage() {
    const goal = state.activeGoal;
    if (!goal) return null;
    if (state.activeStage && String(state.activeStage.goalId) === String(goal.id)) return state.activeStage;
    return (goal.stages || []).find((stage) => stage.status === "active") || null;
  }


  function nextGoalSubgoal() {
    const stage = activeGoalStage();
    if (!stage) return null;
    return (stage.subgoals || []).find((item) => !item.completed) || null;
  }


  function setGoalProgress(prefix, percent) {
    const value = Math.min(100, Math.max(0, Number(percent) || 0));
    const label = $(`#${prefix}-goal-percent`);
    const bar = $(`#${prefix}-goal-progressbar`);
    if (label) label.textContent = `${value}%`;
    if (bar) {
      bar.setAttribute("aria-valuenow", String(value));
      const fill = bar.querySelector("span");
      if (fill) fill.style.width = `${value}%`;
    }
  }


  function renderGoalBanner(prefix, readonly) {
    const banner = $(`#${prefix}-goal-banner`);
    const goal = state.activeGoal;
    if (!banner) return;
    if (readonly && !goal) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.classList.toggle("is-empty", !goal);
    banner.dataset.goalColor = goal ? goal.colorKey : "mist";
    const title = $(`#${prefix}-goal-title`);
    const description = $(`#${prefix}-goal-description`);
    const nextRow = $(`#${prefix}-goal-next`);
    const stageLabel = $(`#${prefix}-goal-stage`);
    if (!goal) {
      title.textContent = "还没有设定长期目标";
      description.textContent = "把最终想抵达的位置写清楚，今天会更容易找到方向。";
      description.hidden = false;
      nextRow.hidden = true;
      stageLabel.textContent = "完成阶段后，进度会累加到这里。";
      setGoalProgress(prefix, 0);
      banner.dataset.goalState = "empty";
      if (!readonly) {
        $("#owner-goal-primary").textContent = "设定长期目标";
        $("#owner-goal-route").hidden = true;
        $("#owner-goal-today").hidden = true;
      }
      return;
    }
    title.textContent = goal.title;
    description.textContent = goal.description || "";
    description.hidden = !goal.description;
    const stage = activeGoalStage();
    const next = nextGoalSubgoal();
    nextRow.hidden = !next;
    if (next) nextRow.querySelector("strong").textContent = next.title;
    if (stage) {
      stageLabel.textContent = `当前阶段 · ${stage.title} · 完成后 +${stage.weightPercent || 0}%`;
    } else if (goal.remainingPercent > 0) {
      stageLabel.textContent = `还有 ${goal.remainingPercent}% 待规划为后续阶段。`;
    } else {
      stageLabel.textContent = "全部阶段已经完成，可以归档这个长期目标。";
    }
    setGoalProgress(prefix, goal.progressPercent);
    banner.dataset.goalState = goal.progressPercent >= 100 ? "complete" : (goal.progressPercent >= 75 ? "near" : "active");
    if (!readonly) {
      $("#owner-goal-primary").textContent = "编辑长期目标";
      $("#owner-goal-route").hidden = false;
      $("#owner-goal-today").hidden = !next;
    }
  }


  function renderGoalRoute() {
    const goal = state.activeGoal;
    if (!goal) return;
    const drawer = $("#goal-route-dialog");
    drawer.dataset.goalColor = goal.colorKey || "mist";
    $("#goal-route-goal-title").textContent = goal.title;
    $("#goal-route-goal-description").textContent = goal.description || "没有补充描述。";
    $("#goal-route-percent").textContent = `${goal.progressPercent}%`;
    const progress = $("#goal-route-progressbar");
    progress.setAttribute("aria-valuenow", String(goal.progressPercent));
    progress.querySelector("span").style.width = `${goal.progressPercent}%`;
    $("#goal-route-allocation").textContent = goal.remainingPercent
      ? `已规划 ${goal.allocatedPercent}% · 待规划 ${goal.remainingPercent}%`
      : `已规划 100% · 已完成 ${goal.progressPercent}%`;

    const list = $("#goal-route-stages");
    list.replaceChildren();
    const stages = Array.isArray(goal.stages) ? goal.stages : [];
    if (!stages.length) {
      const empty = document.createElement("li");
      empty.className = "goal-route-empty";
      empty.textContent = "还没有阶段。先把长期目标拆成第一段路。";
      list.append(empty);
    }
    stages.forEach((stage, index) => {
      const item = document.createElement("li");
      item.className = `goal-route-stage is-${stage.status}`;
      const marker = document.createElement("span");
      marker.className = "goal-route-stage-marker";
      marker.textContent = String(index + 1).padStart(2, "0");
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = stage.title;
      const meta = document.createElement("span");
      const completed = Number(stage.completedSubgoalCount || 0);
      const total = Number(stage.subgoalCount || 0);
      meta.textContent = stage.status === "completed"
        ? `已完成 · 长期进度 +${stage.weightPercent || 0}%`
        : `进行中 · 子目标 ${completed}/${total} · 完成后 +${stage.weightPercent || 0}%`;
      copy.append(title, meta);
      item.append(marker, copy);
      list.append(item);
    });

    const canManage = canManageActiveWorkspace();
    $$(`[data-goal-owner-only]`).forEach((element) => { element.hidden = !canManage; });
    const activeStage = activeGoalStage();
    const currentSection = $("#goal-route-current");
    currentSection.hidden = !activeStage;
    if (activeStage) {
      $("#goal-route-current-title").textContent = activeStage.title;
      $("#goal-route-subgoal-count").textContent = `${activeStage.completedSubgoalCount || 0}/${activeStage.subgoalCount || 0}`;
      const subgoalList = $("#goal-route-subgoals");
      subgoalList.replaceChildren();
      const subgoals = Array.isArray(activeStage.subgoals) ? activeStage.subgoals : [];
      if (!subgoals.length) {
        const empty = document.createElement("li");
        empty.className = "goal-route-empty";
        empty.textContent = canManage ? "添加第一个子目标，让下一步变得明确。" : "这个阶段还没有公开子目标。";
        subgoalList.append(empty);
      }
      subgoals.forEach((subgoal, index) => {
        const item = document.createElement("li");
        item.className = `goal-route-subgoal${subgoal.completed ? " is-completed" : ""}`;
        const toggle = document.createElement(canManage ? "button" : "span");
        toggle.className = "subgoal-toggle";
        toggle.textContent = subgoal.completed ? "✓" : "";
        if (canManage) {
          toggle.type = "button";
          toggle.dataset.subgoalAction = "toggle";
          toggle.dataset.subgoalId = String(subgoal.id);
          toggle.setAttribute("aria-label", subgoal.completed ? "标记为未完成" : "标记为已完成");
        }
        const title = document.createElement(canManage ? "button" : "span");
        title.className = "subgoal-title";
        title.textContent = subgoal.title;
        if (canManage) {
          title.type = "button";
          title.dataset.subgoalAction = "edit";
          title.dataset.subgoalId = String(subgoal.id);
        }
        item.append(toggle, title);
        if (canManage) {
          const actions = document.createElement("div");
          actions.className = "subgoal-actions";
          [["up", "上移", index === 0], ["down", "下移", index === subgoals.length - 1], ["delete", "删除", false]].forEach(([action, label, disabled]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.disabled = disabled;
            button.dataset.subgoalAction = action;
            button.dataset.subgoalId = String(subgoal.id);
            actions.append(button);
          });
          item.append(actions);
        }
        subgoalList.append(item);
      });
    }
    const stageButton = $("#goal-route-stage-button");
    stageButton.hidden = !canManage || Boolean(activeStage) || goal.remainingPercent <= 0;
    $("#goal-route-owner-actions").hidden = !canManage;
    $("#complete-goal-button").disabled = !goal.canComplete;
    $("#complete-goal-button").title = goal.canComplete ? "" : "需要规划满 100% 并完成全部阶段";
    if (activeStage) {
      const ready = activeStage.subgoalCount > 0 && activeStage.completedSubgoalCount === activeStage.subgoalCount;
      $("#goal-route-complete-stage").disabled = !ready;
      $("#goal-route-complete-stage").title = ready ? "" : "请先完成全部子目标";
    }
  }


  function renderGoalExperience() {
    renderGoalBanner("owner", false);
    renderGoalBanner("visitor", true);
    if (state.activeGoal) renderGoalRoute();
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
      const completedSubgoals = Number(stage.completedSubgoalCount || 0);
      const totalSubgoals = Number(stage.subgoalCount || 0);
      const nextSubgoal = (stage.subgoals || []).find((item) => !item.completed);
      $("#owner-stage-subgoal-summary").textContent = totalSubgoals
        ? `子目标 ${completedSubgoals}/${totalSubgoals}${nextSubgoal ? ` · 下一步：${nextSubgoal.title}` : " · 已全部完成"}`
        : "还没有添加子目标";
      $("#edit-stage-button").dataset.stageId = String(stage.id);
      $("#complete-stage-button").dataset.stageId = String(stage.id);
      const needsSubgoals = stage.goalId !== null && stage.goalId !== undefined;
      const stageReady = !needsSubgoals || (totalSubgoals > 0 && completedSubgoals === totalSubgoals);
      $("#complete-stage-button").disabled = !stageReady;
      $("#complete-stage-button").title = stageReady ? "" : "请先完成当前阶段的全部子目标";
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
      const completedSubgoals = Number(stage.completedSubgoalCount || 0);
      const totalSubgoals = Number(stage.subgoalCount || 0);
      const nextSubgoal = (stage.subgoals || []).find((item) => !item.completed);
      $("#visitor-stage-subgoal-summary").textContent = totalSubgoals
        ? `子目标 ${completedSubgoals}/${totalSubgoals}${nextSubgoal ? ` · 下一步：${nextSubgoal.title}` : " · 已全部完成"}`
        : "还没有添加子目标";
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
    renderGoalExperience();
  }

  function renderOwner() {
    if (!state.user || state.access !== "owner") return;
    const today = dateKeyInShanghai();
    const tomorrow = shiftDate(today, 1);
    const todayTask = taskFor(today);
    const tomorrowTask = taskFor(tomorrow);
    const nowLabel = dateLabel(today);

    $("#owner-date-label").textContent = nowLabel;
    $("#owner-context-line").textContent = contextualCopy(todayTask, false);
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
    $("#complete-today-task").hidden = !todayTask || !taskCanRecordResult(todayTask);
    $("#complete-today-task").textContent = todayTask && taskHasResult(todayTask) ? "更新最终结果" : "记录最终结果";
    $("#add-today-progress").dataset.taskDate = today;
    $("#add-today-progress").hidden = !todayTask || !taskCanAddProgress(todayTask);
    $("#add-today-progress").textContent = todayTask && taskHasProgress(todayTask) ? "继续补充进度" : "添加进度";

    const ownerRecord = Boolean(todayTask && taskHasPublicRecord(todayTask));
    $("#today-proof-summary").hidden = !ownerRecord;
    $("#today-proof-summary").classList.toggle("is-incomplete", Boolean(ownerRecord && taskResultStatus(todayTask) === "incomplete"));
    if (ownerRecord) {
      $("#today-result-label").textContent = taskResultLabel(todayTask, true);
      $("#today-result-icon").textContent = taskResultStatus(todayTask) === "completed" ? "✓" : (taskResultStatus(todayTask) === "incomplete" ? "—" : "↗");
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
    const workspace = activeSpace();
    const workspaceName = workspace ? workspace.name : "Day1";
    $("#visitor-page-title").textContent = `${workspaceName} 的每日记录`;
    $("#visitor-record-kicker").hidden = false;
    $("#visitor-context-line").textContent = contextualCopy(task, true);
    $("#visitor-mascot").classList.toggle("is-resting", Boolean(task && taskHasResult(task)));
    $("#visitor-mascot").classList.toggle("is-following", Boolean(task && taskHasProgress(task) && !taskHasResult(task)));
    $("#visitor-today-date").textContent = `${today} · ${dateLabel(today)}`;
    $("#visitor-today-task-text").textContent = task ? task.text : "今天还没有公开任务。";
    updateStatus($("#visitor-today-status"), task, "暂无任务", "进行中");
    $("#visitor-today-poms").textContent = `${publicPomsFor(today)} 个番茄`;
    const hasRecord = Boolean(task && taskHasPublicRecord(task));
    $("#visitor-today-proof").hidden = !hasRecord;
    $("#visitor-today-proof").classList.toggle("is-incomplete", Boolean(hasRecord && taskResultStatus(task) === "incomplete"));
    if (hasRecord) {
      $("#visitor-result-label").textContent = `今日${taskResultLabel(task, true)}`;
      $("#visitor-result-icon").textContent = taskResultStatus(task) === "completed" ? "✓" : (taskResultStatus(task) === "incomplete" ? "—" : "↗");
      const latest = latestProgressEntry(task);
      const resultValue = task.resultRecordedAt || task.completedAt || "";
      const latestValue = latest && latest.createdAt ? latest.createdAt : "";
      const newestValue = Date.parse(latestValue) >= Date.parse(resultValue) ? latestValue : resultValue;
      $("#visitor-proof-time").textContent = completionTime(newestValue || latestValue || resultValue) || "已记录";
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
      if (task && taskHasPublicRecord(task)) {
        cell.classList.add("is-recorded", `progress-${taskProgressLevel(task)}`);
        cell.style.setProperty("--daily-result-color", `var(--progress-${taskProgressLevel(task)})`);
      }
      if (task && taskResultStatus(task) === "completed") cell.classList.add("is-done");
      if (task && taskResultStatus(task) === "incomplete") cell.classList.add("is-incomplete");
      if (task && taskHasSupplement(task)) cell.classList.add("is-supplemented");
      if (poms > 0) cell.classList.add("is-focus-record");
      if (hasPrivate) cell.classList.add("has-private-record");
      if (stageId !== undefined) cell.classList.add("is-stage-complete");
      if (stageId !== undefined && task && taskHasPublicRecord(task)) cell.classList.add("has-daily-result");
      if (selectedDate === key) cell.classList.add("is-selected");
      const status = [];
      if (stageId !== undefined) status.push(`阶段已完成${stage ? `：${stage.title}` : ""}`);
      if (task) {
        const result = taskHasPublicRecord(task) ? taskResultLabel(task, true) : "待反馈";
        const supplement = taskHasSupplement(task) ? `；次日补充至 ${taskSupplementPercent(task)}%` : "";
        const feedback = taskHasResult(task) && taskResultNote(task) ? `；反馈：${taskResultNote(task)}` : "";
        status.push(`每日任务${result}${supplement}：${task.text}${feedback}`);
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
        if (entry.task && taskHasSupplement(entry.task)) item.classList.add("is-supplemented");
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
        if (entry.task && taskHasSupplement(entry.task)) {
          const supplementMeta = document.createElement("span");
          supplementMeta.className = "history-item-supplement";
          supplementMeta.textContent = `次日补至 ${taskSupplementPercent(entry.task)}%`;
          text.appendChild(supplementMeta);
        }
        const action = document.createElement("button");
        action.type = "button";
        if (entry.stageId !== null && entry.task && taskHasPublicRecord(entry.task)) {
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
          action.textContent = taskResultLabel(entry.task, status === "incomplete" || taskHasProgress(entry.task));
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

  function openTaskEditor(key, suggestedText = "") {
    if (!canManageActiveWorkspace()) return;
    const task = taskFor(key);
    if (task && taskHasResult(task)) {
      toast("已记录最终结果的任务不能直接修改。", "error");
      return;
    }
    $("#task-date-input").value = key;
    $("#task-dialog-date").textContent = `${key} · ${dateLabel(key)}`;
    $("#task-text-input").value = task ? task.text : suggestedText;
    $("#task-dialog-title").textContent = task ? "编辑任务" : "设置任务";
    $("#delete-task-button").hidden = !task;
    setMessage($("#task-dialog-message"), "");
    updateCharacterCount($("#task-text-input"));
    showDialog($("#task-dialog"));
    window.setTimeout(() => $("#task-text-input").focus(), 0);
  }

  async function saveTask(event) {
    event.preventDefault();
    if (!canManageActiveWorkspace()) return;
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
    if (!canManageActiveWorkspace()) return;
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

  function stageUploadUi() {
    return {
      input: $("#stage-proof-image"),
      dropzone: $("#stage-proof-dropzone"),
      preview: $("#stage-image-preview"),
      image: $("#stage-preview-image"),
      icon: $("#stage-preview-file-icon"),
      type: $("#stage-file-type"),
      name: $("#stage-image-name"),
      size: $("#stage-file-size"),
      remove: $("#remove-stage-image"),
      message: $("#stage-complete-message"),
    };
  }

  function clearStageImagePreview() {
    const ui = stageUploadUi();
    if (state.stageImagePreviewUrl) URL.revokeObjectURL(state.stageImagePreviewUrl);
    state.stageImagePreviewUrl = "";
    ui.input.value = "";
    ui.image.hidden = true;
    ui.image.removeAttribute("src");
    ui.image.removeAttribute("title");
    ui.icon.hidden = true;
    ui.icon.textContent = "FILE";
    ui.type.textContent = "附件";
    ui.name.textContent = "—";
    ui.name.removeAttribute("title");
    ui.size.textContent = "—";
    ui.preview.hidden = true;
    ui.dropzone.hidden = false;
  }

  function previewStageFile(file) {
    if (!file) return;
    const ui = stageUploadUi();
    const info = proofFileInfo(file);
    if (!info.allowed || file.size > MAX_PROOF_FILE_BYTES) {
      clearStageImagePreview();
      setMessage(ui.message, !info.allowed
        ? (["heic", "heif"].includes(info.extension)
          ? "HEIC 暂不支持，请在照片中导出为 JPG，或上传截图。"
          : "附件必须是受支持的照片或文件格式。")
        : "附件不能超过 10 MB。");
      return;
    }
    if (state.stageImagePreviewUrl) URL.revokeObjectURL(state.stageImagePreviewUrl);
    state.stageImagePreviewUrl = "";
    ui.image.hidden = true;
    ui.image.removeAttribute("src");
    ui.icon.hidden = info.isImage;
    ui.icon.textContent = info.label;
    if (info.isImage) {
      try {
        state.stageImagePreviewUrl = URL.createObjectURL(file);
        ui.image.src = state.stageImagePreviewUrl;
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
    setMessage(ui.message, "");
  }

  function revokeProgressPreviewUrls() {
    state.progressPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    state.progressPreviewUrls = [];
  }

  function clearProgressFiles() {
    revokeProgressPreviewUrls();
    state.progressFiles = [];
    state.progressRecordId = "";
    state.progressUploadId = null;
    state.progressUploadDate = "";
    state.progressBaselinePercent = 0;
    const input = $("#progress-file-input");
    if (input) input.value = "";
    const preview = $("#progress-files-preview");
    if (preview) {
      preview.replaceChildren();
      preview.hidden = true;
    }
    const controls = $("#progress-controls");
    if (controls) controls.querySelectorAll("input, textarea").forEach((element) => { element.disabled = false; });
    const button = $("#submit-progress-button");
    if (button && !button.disabled) button.textContent = "保存这次进度";
  }

  function renderProgressFiles() {
    revokeProgressPreviewUrls();
    const preview = $("#progress-files-preview");
    preview.replaceChildren();
    preview.hidden = state.progressFiles.length === 0;
    let foldedBody = null;
    if (state.progressFiles.length > 6) {
      const details = document.createElement("details");
      details.className = "progress-assets-more attachment-queue-more";
      const summary = document.createElement("summary");
      summary.textContent = `查看其余 ${state.progressFiles.length - 6} 个待上传文件`;
      foldedBody = document.createElement("div");
      foldedBody.className = "progress-assets-more-body";
      details.append(summary, foldedBody);
      preview.appendChild(details);
    }
    state.progressFiles.forEach((queued, index) => {
      const file = queued.file;
      const info = proofFileInfo(file);
      const item = document.createElement("article");
      item.className = "attachment-preview attachment-queue-item";
      item.setAttribute("role", "listitem");
      let visual;
      if (info.isImage && index < 6) {
        visual = document.createElement("img");
        visual.className = "attachment-thumbnail";
        visual.alt = "";
        try {
          const url = URL.createObjectURL(file);
          state.progressPreviewUrls.push(url);
          visual.src = url;
        } catch (_error) {
          visual = null;
        }
      }
      if (!visual) {
        visual = document.createElement("span");
        visual.className = "attachment-type-icon";
        visual.setAttribute("aria-hidden", "true");
        visual.textContent = info.label;
      }
      const copy = document.createElement("div");
      copy.className = "attachment-copy";
      const type = document.createElement("span");
      type.className = "attachment-type";
      type.textContent = info.isImage ? `${info.label} 图片` : `${info.label} 文件`;
      const name = document.createElement("p");
      name.className = "attachment-name";
      name.textContent = file.name;
      name.title = file.name;
      const size = document.createElement("p");
      size.className = "attachment-size";
      size.textContent = formatFileSize(file.size);
      copy.append(type, name, size);
      const remove = document.createElement("button");
      remove.className = "attachment-remove";
      remove.type = "button";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除 ${file.name}`);
      remove.addEventListener("click", () => {
        state.progressFiles.splice(index, 1);
        renderProgressFiles();
        $("#progress-file-input").focus();
      });
      item.append(visual, copy, remove);
      if (foldedBody && index >= 6) foldedBody.appendChild(item);
      else preview.insertBefore(item, preview.querySelector(".attachment-queue-more"));
    });
  }

  function addProgressFiles(files) {
    const rejected = [];
    const fileKey = (file) => [file.name, file.size, file.lastModified, file.type].join("\u0000");
    const existing = new Set(state.progressFiles.map((queued) => fileKey(queued.file)));
    Array.from(files || []).forEach((file) => {
      const info = proofFileInfo(file);
      if (!info.allowed) rejected.push(`${file.name}：格式不支持`);
      else if (file.size > MAX_PROOF_FILE_BYTES) rejected.push(`${file.name}：超过 10 MB`);
      else if (existing.has(fileKey(file))) rejected.push(`${file.name}：已在待上传列表`);
      else {
        existing.add(fileKey(file));
        state.progressFiles.push({ file, clientUploadId: uniqueToken("upload") });
      }
    });
    $("#progress-file-input").value = "";
    renderProgressFiles();
    setMessage($("#progress-dialog-message"), rejected.length
      ? `${rejected.slice(0, 3).join("；")}${rejected.length > 3 ? `；另有 ${rejected.length - 3} 个文件未加入` : ""}`
      : "");
  }

  function updateProgressOutput() {
    const value = Math.min(100, Math.max(0, Number.parseInt($("#progress-percent-input").value, 10) || 0));
    $("#progress-percent-output").textContent = `${value}%`;
  }

  function openProgressEditor(key) {
    if (!canManageActiveWorkspace()) return;
    const task = taskFor(key);
    if (!task) return;
    if (!taskCanAddProgress(task)) {
      toast("只能记录今天，或补充昨天的进度。", "error");
      return;
    }
    const supplemental = task.progressEntryMode === "supplement" || key === shiftDate(dateKeyInShanghai(), -1);
    clearProgressFiles();
    $("#progress-form").reset();
    state.progressRecordId = uniqueToken("progress");
    $("#progress-date-input").value = key;
    $("#progress-dialog-title").textContent = supplemental ? "补充昨日进度" : "添加一次进度";
    $("#progress-dialog-date").textContent = `${key} · ${task.text}`;
    $("#progress-note-help").textContent = supplemental
      ? "这条记录会标为次日补充；原完成度和完成结果不会改变。"
      : "每次保存都会追加一条公开时间记录，不会覆盖之前的内容。";
    $("#progress-dialog .record-destination-note").textContent = supplemental
      ? "补充会作为公开节点保留实际记录时间，但不会改写昨天 24:00 已冻结的结果。"
      : "保存一次，就增加一个带时间的公开节点；备注、链接和附件会给访客查看。私人便签和分心记录始终不会公开。";
    $("#submit-progress-button").textContent = supplemental ? "保存这次补充" : "保存这次进度";
    const latest = latestProgressEntry(task);
    state.progressBaselinePercent = Math.max(
      latest ? progressPercent(latest) : 0,
      taskCompletionPercent(task),
    );
    $("#progress-percent-input").value = String(state.progressBaselinePercent);
    const existingAssets = taskProgressEntries(task).flatMap((entry) => Array.isArray(entry.assets) ? entry.assets : []);
    const existingFiles = existingAssets.filter((asset) => asset && asset.kind === "file").length;
    const existingLinks = existingAssets.filter((asset) => asset && asset.kind === "link").length;
    const existingSummary = $("#progress-existing-assets");
    existingSummary.hidden = existingFiles + existingLinks === 0;
    existingSummary.textContent = existingSummary.hidden
      ? ""
      : `已保留 ${existingFiles} 个照片或文件、${existingLinks} 个链接；本次只需选择新增内容。`;
    updateProgressOutput();
    updateCharacterCount($("#progress-note-input"));
    setMessage($("#progress-dialog-message"), "");
    showDialog($("#progress-dialog"));
    window.setTimeout(() => $("#progress-note-input").focus(), 0);
  }

  function createdProgressFromPayload(payload) {
    const direct = payload && (payload.progress || payload.progressEntry || payload.entry);
    if (direct && direct.id !== undefined && direct.id !== null) return direct;
    const task = payload && payload.task;
    const entries = taskProgressEntries(task);
    return entries.length ? entries[entries.length - 1] : null;
  }

  async function submitProgress(event) {
    event.preventDefault();
    if (!canManageActiveWorkspace()) return;
    const key = $("#progress-date-input").value;
    const button = $("#submit-progress-button");
    const rawLinks = $("#progress-links-input").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const invalidLink = rawLinks.find((value) => !httpUrl(value));
    if (!state.progressUploadId && invalidLink) {
      setMessage($("#progress-dialog-message"), `链接格式不正确：${invalidLink}`);
      $("#progress-links-input").focus();
      return;
    }
    const nextPercent = Math.min(100, Math.max(0, Number.parseInt($("#progress-percent-input").value, 10) || 0));
    const note = $("#progress-note-input").value.trim();
    if (!state.progressUploadId
      && !note
      && rawLinks.length === 0
      && state.progressFiles.length === 0
      && nextPercent === state.progressBaselinePercent) {
      setMessage($("#progress-dialog-message"), "这次还没有新增内容。写一句备注、调整进度，或添加链接/文件后再保存。");
      $("#progress-note-input").focus();
      return;
    }
    setLoading(button, true);
    setMessage($("#progress-dialog-message"), "");
    let keepOpen = false;
    try {
      if (!state.progressUploadId) {
        const payload = await api(`/api/tasks/${encodeURIComponent(key)}/progress`, {
          method: "POST",
          body: {
            note,
            progressPercent: nextPercent,
            links: rawLinks.map((value) => httpUrl(value)),
            hasPendingFiles: state.progressFiles.length > 0,
            clientRecordId: state.progressRecordId,
          },
        });
        const created = createdProgressFromPayload(payload);
        if (!created || created.id === undefined || created.id === null) {
          throw new ApiError("进度已经保存，但服务器没有返回附件接收编号。刷新后可继续添加。", 0, "missing_progress_id");
        }
        state.progressUploadId = created.id;
        state.progressUploadDate = key;
      }

      const failed = [];
      const files = state.progressFiles.slice();
      for (let index = 0; index < files.length; index += 1) {
        const queued = files[index];
        const file = queued.file;
        button.textContent = `正在上传 ${index + 1}/${files.length}…`;
        const formData = new FormData();
        formData.append("attachment", file, file.name);
        formData.append("clientUploadId", queued.clientUploadId);
        try {
          await api(`/api/tasks/${encodeURIComponent(state.progressUploadDate)}/progress/${encodeURIComponent(String(state.progressUploadId))}/files`, {
            method: "POST",
            body: formData,
          });
        } catch (error) {
          failed.push({ queued, error });
        }
      }

      await loadData();
      if (failed.length) {
        keepOpen = true;
        state.progressFiles = failed.map((item) => item.queued);
        renderProgressFiles();
        $("#progress-controls").querySelectorAll("input, textarea").forEach((element) => { element.disabled = true; });
        const firstError = failed[0].error && failed[0].error.message ? failed[0].error.message : "上传失败";
        setMessage($("#progress-dialog-message"), `进度与已成功的附件都已保存；还有 ${failed.length} 个附件未上传。${firstError}`);
      } else {
        closeDialog($("#progress-dialog"));
        clearProgressFiles();
        toast(files.length ? `进度已保存，${files.length} 个附件已按顺序上传。` : "这次进度已保存。", "success");
      }
    } catch (error) {
      setMessage($("#progress-dialog-message"), error.message);
    } finally {
      setLoading(button, false);
      if (keepOpen) button.textContent = "重试未上传附件";
    }
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
      if (previousProgress >= 100) {
        const task = taskFor($("#proof-date-input").value);
        const latest = latestProgressEntry(task);
        const stored = Number.parseInt(task && task.completionPercent, 10);
        const baseline = latest
          ? progressPercent(latest)
          : (taskResultStatus(task) === "incomplete" && Number.isInteger(stored) ? stored : 0);
        progress.value = String(Math.min(99, Math.max(0, baseline)));
      }
      progress.disabled = false;
    }
    const percent = completed ? 100 : Math.min(99, Math.max(0, Number.parseInt(progress.value, 10) || 0));
    $("#result-progress-output").textContent = `${percent}%`;
    $("#result-progress-field").classList.toggle("is-locked", completed);
    $("#result-progress-help").textContent = completed
      ? "选择“完成”时自动记为 100%。"
      : "选择最接近实际进度的数值，年度记录会随完成量加深。";
    $("#result-note-label").textContent = "备注";
    $("#proof-text-input").placeholder = completed
      ? "简单写下今天完成了什么、结果如何…"
      : "如实写下今天最后走到了哪里…";
    $("#proof-requirement").textContent = "必填 · 备注会公开显示在当天记录中";
  }

  function openProofEditor(key) {
    if (!canManageActiveWorkspace()) return;
    const task = taskFor(key);
    if (!task) return;
    if (!taskCanRecordResult(task)) {
      toast("当天 24:00 后结果已经冻结，不能再修改。", "error");
      return;
    }
    $("#proof-date-input").value = key;
    $("#proof-dialog-date").textContent = `${key} · ${task.text}`;
    $("#proof-dialog-title").textContent = taskHasResult(task) ? "更新今日反馈" : "记录今日结果";
    const status = taskResultStatus(task) === "incomplete" ? "incomplete" : "completed";
    $("#result-status-completed").checked = status === "completed";
    $("#result-status-incomplete").checked = status === "incomplete";
    $("#result-progress-input").value = String(status === "completed" ? 100 : taskCompletionPercent(task));
    $("#proof-text-input").value = taskResultNote(task);
    $("#submit-proof-button").textContent = taskHasResult(task) ? "更新最终结果" : "保存最终结果";
    setMessage($("#proof-dialog-message"), "");
    updateResultForm();
    updateCharacterCount($("#proof-text-input"));
    showDialog($("#proof-dialog"));
    window.setTimeout(() => $("#proof-text-input").focus(), 0);
  }

  async function submitProof(event) {
    event.preventDefault();
    if (!canManageActiveWorkspace()) return;
    const key = $("#proof-date-input").value;
    const task = taskFor(key);
    const resultStatus = selectedResultStatus();
    const completionPercent = resultStatus === "completed"
      ? 100
      : Math.min(99, Math.max(0, Number.parseInt($("#result-progress-input").value, 10) || 0));
    const resultNote = $("#proof-text-input").value.trim();
    if (!resultNote) {
      setMessage($("#proof-dialog-message"), "请填写备注。");
      $("#proof-text-input").focus();
      return;
    }
    const formData = new FormData();
    formData.append("resultStatus", resultStatus);
    formData.append("completionPercent", String(completionPercent));
    formData.append("resultNote", resultNote);
    const button = $("#submit-proof-button");
    setLoading(button, true);
    setMessage($("#proof-dialog-message"), "");
    try {
      await api(`/api/tasks/${encodeURIComponent(key)}/result`, { method: "POST", body: formData });
      closeDialog($("#proof-dialog"));
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

  function isRemovableProgressAsset(entry, asset) {
    if (!canManageActiveWorkspace()) return false;
    if (!entry || entry.legacy || !asset || entry.recordDate !== dateKeyInShanghai()) return false;
    return /^\d+$/.test(String(entry.id)) && /^\d+$/.test(String(asset.id));
  }

  function assetRemoveButton(taskDate, entry, asset, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "progress-asset-remove";
    button.textContent = "移除";
    button.setAttribute("aria-label", `移除${label}`);
    button.addEventListener("click", async () => {
      const description = label === "链接"
        ? "确定移除这条链接吗？只会移除链接，不会删除整条进度。"
        : `确定删除这个${label}吗？文件会立即从服务器删除且不能恢复；不会删除整条进度。`;
      const confirmed = await confirmAction(description, "确认移除");
      if (!confirmed) return;
      button.disabled = true;
      try {
        await api(`/api/tasks/${encodeURIComponent(taskDate)}/progress/${encodeURIComponent(String(entry.id))}/assets/${encodeURIComponent(String(asset.id))}`, { method: "DELETE" });
        await loadData();
        const refreshed = taskFor(taskDate);
        if (refreshed && $("#proof-view-dialog").open) renderDailyRecord(refreshed);
        toast(`${label}已移除。`, "success");
      } catch (error) {
        button.disabled = false;
        toast(error.message, "error");
      }
    });
    return button;
  }

  function appendProgressItems(container, items, label) {
    const visibleCount = 4;
    items.slice(0, visibleCount).forEach((item) => container.appendChild(item));
    if (items.length <= visibleCount) return;
    const details = document.createElement("details");
    details.className = "progress-assets-more";
    const summary = document.createElement("summary");
    summary.textContent = `查看其余 ${items.length - visibleCount} 个${label}`;
    const body = document.createElement("div");
    body.className = "progress-assets-more-body";
    items.slice(visibleCount).forEach((item) => body.appendChild(item));
    details.append(summary, body);
    container.appendChild(details);
  }

  function progressLinkItem(taskDate, entry, asset) {
    const row = document.createElement("div");
    row.className = "progress-link-row";
    const link = document.createElement("a");
    link.className = "progress-link";
    link.href = httpUrl(asset.url);
    link.target = "_blank";
    link.rel = "noopener noreferrer nofollow";
    link.textContent = asset.url;
    link.title = asset.url;
    const action = document.createElement("span");
    action.setAttribute("aria-hidden", "true");
    action.textContent = "↗";
    link.appendChild(action);
    row.appendChild(link);
    if (isRemovableProgressAsset(entry, asset)) row.appendChild(assetRemoveButton(taskDate, entry, asset, "链接"));
    return row;
  }

  function progressFileItem(taskDate, entry, asset) {
    const attachment = proofAttachment(asset);
    if (!attachment) return null;
    const row = document.createElement("div");
    row.className = `progress-file-row${attachment.isImage ? " is-image" : ""}`;
    if (attachment.isImage) {
      const link = document.createElement("a");
      link.className = "progress-image-link";
      link.href = attachment.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `打开图片：${attachment.name}`);
      const image = document.createElement("img");
      image.src = attachment.url;
      image.alt = attachment.name;
      image.loading = "lazy";
      link.appendChild(image);
      const caption = document.createElement("span");
      caption.textContent = attachment.name;
      link.appendChild(caption);
      row.appendChild(link);
    } else {
      const link = document.createElement("a");
      link.className = "record-file-card progress-file-card";
      link.href = attachment.url;
      link.download = attachment.name;
      link.setAttribute("aria-label", `下载附件：${attachment.name}`);
      const type = document.createElement("span");
      type.className = "record-file-type";
      type.textContent = attachment.label;
      const copy = document.createElement("span");
      copy.className = "record-file-copy";
      const name = document.createElement("strong");
      name.textContent = attachment.name;
      name.title = attachment.name;
      const meta = document.createElement("small");
      meta.textContent = [attachment.label, formatFileSize(attachment.size)].filter(Boolean).join(" · ");
      copy.append(name, meta);
      const action = document.createElement("span");
      action.className = "record-file-action";
      action.textContent = "下载";
      link.append(type, copy, action);
      row.appendChild(link);
    }
    if (isRemovableProgressAsset(entry, asset)) row.appendChild(assetRemoveButton(taskDate, entry, asset, attachment.isImage ? "图片" : "附件"));
    return row;
  }

  function buildProgressEntry(taskDate, entry, latest) {
    const article = document.createElement("article");
    const supplemental = progressIsSupplemental(entry, taskDate);
    article.className = `progress-entry${latest ? " is-latest" : ""}${entry.legacy ? " is-legacy" : ""}${supplemental ? " is-supplemental" : ""}`;
    const header = document.createElement("header");
    header.className = "progress-entry-header";
    const time = document.createElement("time");
    time.dateTime = entry.createdAt || "";
    const timeLabel = completionTime(entry.createdAt) || "已记录";
    time.textContent = supplemental ? `次日补充 · ${timeLabel}` : timeLabel;
    const percent = document.createElement("span");
    percent.className = "progress-entry-percent";
    percent.textContent = `${progressPercent(entry)}%`;
    header.append(time, percent);
    article.appendChild(header);
    if (entry.legacy) {
      const legacy = document.createElement("p");
      legacy.className = "progress-entry-legacy";
      legacy.textContent = "此前保存的证据";
      article.appendChild(legacy);
    }
    if (typeof entry.note === "string" && entry.note.trim()) {
      const note = document.createElement("p");
      note.className = "progress-entry-note";
      note.textContent = entry.note.trim();
      article.appendChild(note);
    }
    const assets = Array.isArray(entry.assets) ? entry.assets : [];
    const linkItems = assets.filter((asset) => asset && asset.kind === "link" && httpUrl(asset.url))
      .map((asset) => progressLinkItem(taskDate, entry, asset));
    const fileItems = assets.filter((asset) => asset && asset.kind === "file")
      .map((asset) => progressFileItem(taskDate, entry, asset)).filter(Boolean);
    if (linkItems.length) {
      const group = document.createElement("div");
      group.className = "progress-link-list";
      appendProgressItems(group, linkItems, "链接");
      article.appendChild(group);
    }
    if (fileItems.length) {
      const group = document.createElement("div");
      group.className = "progress-file-list";
      appendProgressItems(group, fileItems, "文件");
      article.appendChild(group);
    }
    return article;
  }

  function renderProgressTimeline(task) {
    const section = $("#record-progress-section");
    const list = $("#record-progress-list");
    const entries = taskProgressEntries(task);
    list.replaceChildren();
    section.hidden = entries.length === 0;
    const supplementCount = taskSupplementEntries(task).length;
    $("#record-progress-count").textContent = supplementCount
      ? `${entries.length - supplementCount} 次当日 · ${supplementCount} 次补充`
      : `${entries.length} 次更新`;
    if (!entries.length) return;
    const latest = entries[entries.length - 1];
    list.appendChild(buildProgressEntry(task.date, latest, true));
    if (entries.length > 1) {
      const details = document.createElement("details");
      details.className = "progress-archive";
      const summary = document.createElement("summary");
      summary.textContent = `查看较早的 ${entries.length - 1} 次进度`;
      const body = document.createElement("div");
      body.className = "progress-archive-body";
      entries.slice(0, -1).reverse().forEach((entry) => body.appendChild(buildProgressEntry(task.date, entry, false)));
      details.append(summary, body);
      list.appendChild(details);
    }
  }

  function resetRecordDetails() {
    $("#record-stage-section").hidden = true;
    $("#record-daily-section").hidden = true;
    $("#record-focus-section").hidden = true;
    $("#record-private-section").hidden = true;
    $("#record-progress-section").hidden = true;
    $("#record-progress-list").replaceChildren();
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
    $("#record-daily-progress").textContent = hasResult ? taskCompletionSummary(task) : "尚未记录结果";
    $("#record-daily-feedback-label").textContent = "备注";
    $("#proof-view-text").textContent = taskResultNote(task) || "未填写文字反馈。";
    $("#record-daily-feedback").hidden = !hasResult;
    const latest = latestProgressEntry(task);
    $("#proof-view-time").textContent = hasResult
      ? (task.resultLockSource === "automatic"
        ? "当日 24:00 · 自动锁定"
        : `最终结果 · ${completionTime(task.resultRecordedAt || task.completedAt) || "已记录"}`)
      : (latest ? `最近更新 · ${completionTime(latest.createdAt) || "已记录"}` : "等待反馈");
    renderProgressTimeline(task);
    if (taskHasProgress(task)) {
      setExternalProofLink($("#record-daily-proof-url"), "");
      resetRecordAttachment("daily");
    } else {
      setExternalProofLink($("#record-daily-proof-url"), task.proofUrl);
      renderRecordAttachment(task, "daily");
    }
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
    state.recordViewDate = key;
    state.recordViewScope = scope;
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
    const canAddProgress = Boolean(task && scope === "owner" && canManageActiveWorkspace() && taskCanAddProgress(task));
    $("#record-add-progress").hidden = !canAddProgress;
    $("#record-add-progress").textContent = task && task.progressEntryMode === "supplement" ? "补充昨日进度" : "继续补充进度";
    $("#record-add-progress").dataset.taskDate = canAddProgress ? key : "";
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

  function openGoalEditor() {
    if (!canManageActiveWorkspace()) return;
    const goal = state.activeGoal;
    if ($("#goal-route-dialog").open) closeDialog($("#goal-route-dialog"));
    $("#goal-form").reset();
    $("#goal-id-input").value = goal ? String(goal.id) : "";
    $("#goal-title-input").value = goal ? goal.title : "";
    $("#goal-description-input").value = goal ? (goal.description || "") : "";
    const color = goal ? goal.colorKey : "mist";
    $$(`input[name="goalColor"]`).forEach((input) => { input.checked = input.value === color; });
    $("#goal-dialog-title").textContent = goal ? "编辑长期目标" : "设定长期目标";
    $("#save-goal-button").textContent = goal ? "保存修改" : "开始这个长期目标";
    const adopt = !goal && state.activeStage && (state.activeStage.goalId === null || state.activeStage.goalId === undefined);
    $("#goal-adopt-stage-field").hidden = !adopt;
    setMessage($("#goal-dialog-message"), "");
    updateCharacterCount($("#goal-title-input"));
    updateCharacterCount($("#goal-description-input"));
    showDialog($("#goal-dialog"));
    window.setTimeout(() => $("#goal-title-input").focus(), 0);
  }


  async function saveGoal(event) {
    event.preventDefault();
    if (!canManageActiveWorkspace()) return;
    const id = $("#goal-id-input").value;
    const title = $("#goal-title-input").value.trim();
    const description = $("#goal-description-input").value.trim();
    const selectedColor = $(`input[name="goalColor"]:checked`);
    if (!title) {
      setMessage($("#goal-dialog-message"), "请填写长期目标名称。");
      $("#goal-title-input").focus();
      return;
    }
    const body = { title, description, colorKey: selectedColor ? selectedColor.value : "mist" };
    if (!id && !$("#goal-adopt-stage-field").hidden) {
      const weight = Number($("#goal-adopt-stage-weight").value);
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
        setMessage($("#goal-dialog-message"), "当前阶段占比必须是 1 到 100 的整数。");
        return;
      }
      body.activeStageWeight = weight;
    }
    const button = $("#save-goal-button");
    setLoading(button, true);
    setMessage($("#goal-dialog-message"), "");
    try {
      await api(id ? `/api/goals/${encodeURIComponent(id)}` : "/api/goals", {
        method: id ? "PUT" : "POST",
        body,
      });
      closeDialog($("#goal-dialog"));
      await loadData();
      toast(id ? "长期目标已更新。" : "长期方向已经写清楚。", "success");
    } catch (error) {
      setMessage($("#goal-dialog-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }


  function openGoalRoute() {
    if (!state.activeGoal) {
      if (canManageActiveWorkspace()) openGoalEditor();
      return;
    }
    renderGoalRoute();
    showDialog($("#goal-route-dialog"));
  }


  async function completeActiveGoal() {
    const goal = state.activeGoal;
    if (!canManageActiveWorkspace() || !goal || !goal.canComplete) return;
    const confirmed = await confirmAction(`确认完成长期目标“${goal.title}”？完成后目标与阶段路线会归档。`, "完成长期目标");
    if (!confirmed) return;
    try {
      await api(`/api/goals/${encodeURIComponent(String(goal.id))}/complete`, { method: "POST", body: {} });
      closeDialog($("#goal-route-dialog"));
      await loadData();
      toast("长期目标已经完成并归档。", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }


  function arrangeGoalNextToday() {
    const next = nextGoalSubgoal();
    if (!next || !canManageActiveWorkspace()) return;
    const today = dateKeyInShanghai();
    if (taskFor(today)) {
      toast("今天已经有任务，不会覆盖现有安排。", "error");
      return;
    }
    if ($("#goal-route-dialog").open) closeDialog($("#goal-route-dialog"));
    openTaskEditor(today, next.title);
  }


  function resetSubgoalEditor() {
    $("#subgoal-form").dataset.editId = "";
    $("#subgoal-title-input").value = "";
    $("#add-subgoal-button").textContent = "添加";
    $("#cancel-subgoal-edit").hidden = true;
    setMessage($("#subgoal-message"), "");
  }


  async function saveSubgoal(event) {
    event.preventDefault();
    const stage = activeGoalStage();
    if (!canManageActiveWorkspace() || !stage) return;
    const title = $("#subgoal-title-input").value.trim();
    if (!title) {
      setMessage($("#subgoal-message"), "请写下一个明确的子目标。");
      return;
    }
    const editId = $("#subgoal-form").dataset.editId;
    const button = $("#add-subgoal-button");
    setLoading(button, true);
    try {
      await api(editId ? `/api/subgoals/${encodeURIComponent(editId)}` : `/api/stages/${encodeURIComponent(String(stage.id))}/subgoals`, {
        method: editId ? "PUT" : "POST",
        body: { title },
      });
      resetSubgoalEditor();
      await loadData();
      toast(editId ? "子目标已更新。" : "下一小步已经加入路线。", "success");
    } catch (error) {
      setMessage($("#subgoal-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }


  async function handleSubgoalAction(event) {
    const button = event.target.closest("[data-subgoal-action]");
    if (!button || !canManageActiveWorkspace()) return;
    const stage = activeGoalStage();
    if (!stage) return;
    const id = Number(button.dataset.subgoalId);
    const subgoals = Array.isArray(stage.subgoals) ? stage.subgoals : [];
    const index = subgoals.findIndex((item) => item.id === id);
    if (index < 0) return;
    const subgoal = subgoals[index];
    const action = button.dataset.subgoalAction;
    if (action === "edit") {
      $("#subgoal-form").dataset.editId = String(id);
      $("#subgoal-title-input").value = subgoal.title;
      $("#add-subgoal-button").textContent = "保存";
      $("#cancel-subgoal-edit").hidden = false;
      $("#subgoal-title-input").focus();
      return;
    }
    try {
      if (action === "toggle") {
        await api(`/api/subgoals/${encodeURIComponent(String(id))}`, {
          method: "PUT",
          body: { completed: !subgoal.completed },
        });
      } else if (action === "delete") {
        const confirmed = await confirmAction(`删除子目标“${subgoal.title}”？`, "删除子目标");
        if (!confirmed) return;
        await api(`/api/subgoals/${encodeURIComponent(String(id))}`, { method: "DELETE" });
      } else if (action === "up" || action === "down") {
        const target = action === "up" ? index - 1 : index + 1;
        if (target < 0 || target >= subgoals.length) return;
        const ids = subgoals.map((item) => item.id);
        [ids[index], ids[target]] = [ids[target], ids[index]];
        await api(`/api/stages/${encodeURIComponent(String(stage.id))}/subgoals/reorder`, {
          method: "POST",
          body: { ids },
        });
      }
      resetSubgoalEditor();
      await loadData();
    } catch (error) {
      toast(error.message, "error");
    }
  }


  function openStageEditor() {
    if (!canManageActiveWorkspace()) return;
    if ($("#goal-route-dialog").open) closeDialog($("#goal-route-dialog"));
    const stage = state.activeStage;
    $("#stage-form").reset();
    $("#stage-id-input").value = stage ? String(stage.id) : "";
    $("#stage-title-input").value = stage ? stage.title : "";
    $("#stage-description-input").value = stage ? (stage.description || "") : "";
    const goal = state.activeGoal;
    const weightField = $("#stage-weight-field");
    weightField.hidden = !goal;
    if (goal) {
      const currentWeight = stage && String(stage.goalId) === String(goal.id) ? Number(stage.weightPercent || 0) : 0;
      const available = Math.max(1, Number(goal.remainingPercent || 0) + currentWeight);
      $("#stage-weight-input").max = String(available);
      $("#stage-weight-input").value = String(currentWeight || Math.min(25, available));
      $("#stage-weight-help").textContent = `最多 ${available}% · 阶段完成后才计入长期进度。`;
    }
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
    if (!canManageActiveWorkspace()) return;
    const id = $("#stage-id-input").value;
    const title = $("#stage-title-input").value.trim();
    const description = $("#stage-description-input").value.trim();
    if (!title) {
      setMessage($("#stage-dialog-message"), "请填写阶段名称。");
      $("#stage-title-input").focus();
      return;
    }
    const body = { title, description };
    if (!$("#stage-weight-field").hidden) {
      const weightPercent = Number($("#stage-weight-input").value);
      const maximum = Number($("#stage-weight-input").max);
      if (!Number.isInteger(weightPercent) || weightPercent < 1 || weightPercent > maximum) {
        setMessage($("#stage-dialog-message"), `阶段占比必须是 1 到 ${maximum} 的整数。`);
        $("#stage-weight-input").focus();
        return;
      }
      body.weightPercent = weightPercent;
    }
    const button = $("#save-stage-button");
    setLoading(button, true);
    setMessage($("#stage-dialog-message"), "");
    try {
      await api(id ? `/api/stages/${encodeURIComponent(id)}` : "/api/stages", {
        method: id ? "PUT" : "POST",
        body,
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
    if (!canManageActiveWorkspace() || !state.activeStage) return;
    if ($("#goal-route-dialog").open) closeDialog($("#goal-route-dialog"));
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
    if (!canManageActiveWorkspace()) return;
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
    if (!canManageActiveWorkspace()) return;
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
    if (!state.user || state.access !== "owner" || !isPlatformAdmin()) {
      status.classList.remove("has-data");
      status.hidden = true;
      button.hidden = true;
      return;
    }
    status.hidden = false;
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
    if (!isPlatformAdmin() || state.access !== "owner") return;
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

  async function copyText(value, successMessage) {
    const text = textValue(value);
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("copy_failed");
      }
      toast(successMessage || "已复制。", "success");
      return true;
    } catch (_error) {
      toast("无法自动复制，请长按代码手动复制。", "error");
      return false;
    }
  }

  async function loadViewerCode() {
    if (state.access !== "owner" || !state.activeSpaceId) return;
    const requestEpoch = state.privateRequestEpoch;
    const requestedSpaceId = state.activeSpaceId;
    const requestedUserEmail = state.user && state.user.email;
    setMessage($("#viewer-code-message"), "");
    $("#viewer-code-value").textContent = "正在载入…";
    try {
      const payload = await api("/api/spaces/current/viewer-code");
      if (
        state.privateRequestEpoch !== requestEpoch
        || !state.user
        || state.user.email !== requestedUserEmail
        || state.activeSpaceId !== requestedSpaceId
        || state.access !== "owner"
      ) return;
      state.viewerCode = textValue(payload.viewerCode || payload.code);
      state.viewerCodeConnections = Number.isFinite(Number(payload.activeConnections))
        ? Number(payload.activeConnections)
        : 0;
      $("#viewer-code-value").textContent = state.viewerCode || "尚未生成";
      $("#viewer-code-connections").textContent = `${state.viewerCodeConnections} 个有效访客连接`;
      $("#copy-viewer-code").disabled = !state.viewerCode;
      $("#open-refresh-viewer-code").disabled = !state.viewerCode;
    } catch (error) {
      if (
        state.privateRequestEpoch !== requestEpoch
        || !state.user
        || state.user.email !== requestedUserEmail
        || state.activeSpaceId !== requestedSpaceId
        || state.access !== "owner"
      ) return;
      $("#viewer-code-value").textContent = "暂时无法载入";
      $("#copy-viewer-code").disabled = true;
      $("#open-refresh-viewer-code").disabled = true;
      setMessage($("#viewer-code-message"), error.message);
    }
  }

  function openRefreshViewerCodeDialog() {
    if (!state.viewerCode || state.access !== "owner") return;
    $("#refresh-viewer-code-form").reset();
    $("#refresh-viewer-code-submit").disabled = true;
    $("#refresh-viewer-code-impact").textContent = state.viewerCodeConnections > 0
      ? `将断开 ${state.viewerCodeConnections} 个现有访客连接`
      : "将让当前识别码立即失效";
    setMessage($("#refresh-viewer-code-message"), "");
    showDialog($("#refresh-viewer-code-dialog"));
    window.setTimeout(() => $("#refresh-viewer-code-confirmation").focus(), 0);
  }

  function validateViewerCodeRefresh() {
    const matches = $("#refresh-viewer-code-confirmation").value.trim() === VIEWER_CODE_REFRESH_CONFIRMATION;
    $("#refresh-viewer-code-submit").disabled = !matches;
    return matches;
  }

  async function refreshViewerCode(event) {
    event.preventDefault();
    if (!validateViewerCodeRefresh() || state.access !== "owner") return;
    const button = $("#refresh-viewer-code-submit");
    setLoading(button, true);
    setMessage($("#refresh-viewer-code-message"), "");
    try {
      const payload = await api("/api/spaces/current/viewer-code/refresh", {
        method: "POST",
        body: { confirmation: VIEWER_CODE_REFRESH_CONFIRMATION },
      });
      state.viewerCode = textValue(payload.viewerCode || payload.code);
      state.viewerCodeConnections = Number.isFinite(Number(payload.activeConnections)) ? Number(payload.activeConnections) : 0;
      $("#viewer-code-value").textContent = state.viewerCode || "已刷新";
      $("#viewer-code-connections").textContent = `${state.viewerCodeConnections} 个有效访客连接`;
      $("#copy-viewer-code").disabled = !state.viewerCode;
      closeDialog($("#refresh-viewer-code-dialog"));
      toast("识别码已刷新，旧连接已经失效。", "success");
    } catch (error) {
      setMessage($("#refresh-viewer-code-message"), error.message);
    } finally {
      setLoading(button, false);
      validateViewerCodeRefresh();
    }
  }

  function openConnectSpaceDialog() {
    $("#workspace-menu").open = false;
    $("#connect-space-form").reset();
    setMessage($("#connect-space-message"), "");
    showDialog($("#connect-space-dialog"));
    window.setTimeout(() => $("#connect-space-code").focus(), 0);
  }

  async function connectSpace(event) {
    event.preventDefault();
    const viewerCode = $("#connect-space-code").value.trim();
    if (!viewerCode) {
      setMessage($("#connect-space-message"), "请输入预览识别码。");
      return;
    }
    const previousIds = new Set(state.spaces.map((space) => space.publicId));
    const button = $("#connect-space-submit");
    setLoading(button, true);
    setMessage($("#connect-space-message"), "");
    try {
      const payload = await api("/api/spaces/connect", { method: "POST", body: { viewerCode } });
      const returnedSpace = normalizeSpace(payload && (payload.space || payload.workspace));
      await loadSession();
      if (returnedSpace) {
        const index = state.spaces.findIndex((space) => space.publicId === returnedSpace.publicId);
        if (index >= 0) state.spaces.splice(index, 1, returnedSpace);
        else state.spaces.push(returnedSpace);
      }
      const publicId = textValue(
        payload && (payload.publicId || payload.spaceId || (payload.space && payload.space.publicId)),
      ) || (returnedSpace && returnedSpace.publicId)
        || (state.spaces.find((space) => !previousIds.has(space.publicId) && space.connectionStatus === "active") || {}).publicId
        || state.activeSpaceId;
      closeDialog($("#connect-space-dialog"));
      toast("预览端已连接。", "success");
      if (publicId) await switchWorkspace(publicId, "visitor");
      else renderWorkspaceMenu();
    } catch (error) {
      setMessage($("#connect-space-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  function platformSpaces(payload) {
    const values = payload && (payload.spaces || payload.managers || payload.workspaces);
    return Array.isArray(values) ? values : [];
  }

  function platformUsers(payload) {
    const values = payload && (payload.users || payload.sessions || payload.loggedInUsers);
    return Array.isArray(values) ? values : [];
  }

  function platformCount(payload, keys, fallback) {
    for (const key of keys) {
      const direct = payload && payload[key];
      const nested = payload && payload.counts && payload.counts[key];
      const value = direct !== undefined ? direct : nested;
      if (Number.isFinite(Number(value))) return Number(value);
    }
    return fallback;
  }

  function platformSpaceRow(rawSpace) {
    const space = normalizeSpace(Object.assign({}, rawSpace, {
      access: rawSpace && rawSpace.access ? rawSpace.access : "viewer",
      platformPreview: true,
    }));
    if (!space) return null;
    const row = document.createElement("article");
    row.className = "platform-list-row";

    const identity = document.createElement("div");
    identity.className = "platform-list-identity";
    const mark = document.createElement("span");
    mark.className = "workspace-option-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = (space.name.charAt(0) || "D").toUpperCase();
    const copy = document.createElement("p");
    const title = document.createElement("strong");
    title.textContent = space.name;
    const owner = document.createElement("span");
    owner.textContent = textValue(
      rawSpace && (
        rawSpace.ownerDisplayName
        || rawSpace.ownerName
        || rawSpace.ownerEmail
        || (rawSpace.owner && (rawSpace.owner.displayName || rawSpace.owner.email))
      ),
      "独立管理端",
    );
    copy.append(title, owner);
    identity.append(mark, copy);

    const meta = document.createElement("div");
    meta.className = "platform-list-meta";
    const connections = Number(rawSpace && (rawSpace.activeConnections ?? rawSpace.viewerCount ?? rawSpace.visitorCount ?? rawSpace.connectionCount));
    const users = Number(rawSpace && (rawSpace.loggedInUsers ?? rawSpace.activeUsers));
    const connectionLabel = document.createElement("span");
    connectionLabel.textContent = `${Number.isFinite(connections) ? connections : 0} 个访客连接`;
    const userLabel = document.createElement("span");
    userLabel.textContent = Number.isFinite(users) ? `${users} 个登录用户` : "只读预览权限";
    meta.append(connectionLabel, userLabel);

    const actions = document.createElement("div");
    actions.className = "platform-list-actions";
    const preview = document.createElement("button");
    preview.className = "button button-quiet button-small";
    preview.type = "button";
    preview.textContent = "预览";
    preview.addEventListener("click", async () => {
      if (!spaceById(space.publicId)) state.spaces.push(space);
      await switchWorkspace(space.publicId, "visitor", true);
    });
    if (!space.isBlueSpace) {
      const more = document.createElement("details");
      more.className = "platform-more-menu";
      const moreTrigger = document.createElement("summary");
      moreTrigger.className = "button button-quiet button-small platform-more-trigger";
      moreTrigger.textContent = "更多";
      moreTrigger.setAttribute("aria-label", `${space.name} 的更多操作`);
      const morePanel = document.createElement("div");
      morePanel.className = "platform-more-panel";
      const remove = document.createElement("button");
      remove.className = "menu-button menu-button-danger";
      remove.type = "button";
      remove.textContent = "删除管理端…";
      remove.addEventListener("click", () => {
        more.open = false;
        openDeleteSpaceDialog({
          publicId: space.publicId,
          name: space.name,
          source: "platform",
        });
      });
      morePanel.appendChild(remove);
      more.append(moreTrigger, morePanel);
      actions.append(preview, more);
    } else {
      actions.appendChild(preview);
    }
    row.append(identity, meta, actions);
    return row;
  }

  function platformUserRow(user) {
    const row = document.createElement("article");
    row.className = "platform-list-row platform-user-row";
    const identity = document.createElement("div");
    identity.className = "platform-list-identity";
    const mark = document.createElement("span");
    mark.className = "workspace-option-mark";
    mark.setAttribute("aria-hidden", "true");
    const name = textValue(user && (user.displayName || user.name || user.email), "用户");
    mark.textContent = (name.charAt(0) || "U").toUpperCase();
    const copy = document.createElement("p");
    const title = document.createElement("strong");
    title.textContent = name;
    const email = document.createElement("span");
    email.textContent = textValue(user && user.email, "未提供邮箱");
    copy.append(title, email);
    identity.append(mark, copy);
    const meta = document.createElement("div");
    meta.className = "platform-list-meta";
    const role = document.createElement("span");
    role.textContent = user && (user.isPlatformAdmin || user.role === "blue")
      ? "Blue 平台管理员"
      : (user && ["owner", "manager"].includes(user.role) ? "管理者" : "访客");
    const current = document.createElement("span");
    const previewSpaces = user && Array.isArray(user.previewSpaces) ? user.previewSpaces : [];
    const ownedSpaceName = user && user.ownedSpace
      ? textValue(typeof user.ownedSpace === "string" ? user.ownedSpace : (user.ownedSpace.name || user.ownedSpace.publicId))
      : "";
    current.textContent = textValue(
      user && (
        user.spaceName
        || user.currentSpaceName
        || ownedSpaceName
        || (previewSpaces.length ? `已连接 ${previewSpaces.length} 个预览端` : "")
      ),
      "当前未进入管理端",
    );
    meta.append(role, current);
    row.append(identity, meta);
    return row;
  }

  function spaceDeleteConfirmation(spaceName) {
    return `我确认删除${spaceName}并知道会清除全部内容`;
  }

  function openDeleteSpaceDialog(target) {
    if (!target || !target.publicId || !target.name) return;
    if (target.source === "owner" && (isPlatformAdmin() || (activeSpace() && activeSpace().isBlueSpace))) return;
    state.deleteSpaceTarget = {
      publicId: target.publicId,
      name: target.name,
      source: target.source === "platform" ? "platform" : "owner",
    };
    const phrase = spaceDeleteConfirmation(target.name);
    $("#delete-space-name").textContent = target.name;
    $("#delete-space-phrase").textContent = phrase;
    $("#delete-space-confirmation").value = "";
    $("#delete-space-submit").disabled = true;
    setMessage($("#delete-space-message"), "");
    showDialog($("#delete-space-dialog"));
    window.setTimeout(() => $("#delete-space-confirmation").focus(), 0);
  }

  function openOwnSpaceDeleteDialog() {
    const space = activeSpace();
    if (!space || state.access !== "owner" || space.isBlueSpace || isPlatformAdmin()) return;
    openDeleteSpaceDialog({
      publicId: space.publicId,
      name: space.name,
      source: "owner",
    });
  }

  function validateSpaceDeletion() {
    const target = state.deleteSpaceTarget;
    const valid = Boolean(
      target
      && $("#delete-space-confirmation").value === spaceDeleteConfirmation(target.name),
    );
    $("#delete-space-submit").disabled = !valid;
  }

  async function deleteSpace(event) {
    event.preventDefault();
    const target = state.deleteSpaceTarget;
    if (!target) return;
    const confirmation = $("#delete-space-confirmation").value;
    if (confirmation !== spaceDeleteConfirmation(target.name)) {
      validateSpaceDeletion();
      setMessage($("#delete-space-message"), "请完整输入上方确认句。");
      return;
    }
    const button = $("#delete-space-submit");
    setLoading(button, true);
    setMessage($("#delete-space-message"), "");
    try {
      const path = target.source === "platform"
        ? `/api/platform/spaces/${encodeURIComponent(target.publicId)}`
        : "/api/spaces/current";
      await api(path, {
        method: "DELETE",
        body: { confirmation },
      });
      closeDialog($("#delete-space-dialog"));
      state.deleteSpaceTarget = null;
      if (target.source === "owner") {
        try {
          await loadSession();
        } catch (_error) {
          window.location.reload();
          return;
        }
        showAuth();
        toast(`${target.name} 已永久删除。`, "success");
        return;
      }
      state.spaces = state.spaces.filter((space) => space.publicId !== target.publicId);
      if (state.activeSpaceId === target.publicId) {
        state.activeSpaceId = "";
        state.workspace = null;
        state.access = "";
        sessionStorage.removeItem(ACTIVE_SPACE_KEY);
      }
      await loadPlatformOverview();
      toast(`${target.name} 已永久删除。`, "success");
    } catch (error) {
      setMessage($("#delete-space-message"), error.message);
    } finally {
      setLoading(button, false);
      validateSpaceDeletion();
    }
  }

  function securityStatusLabel(status) {
    if (status === "blocked") return "已拉黑";
    if (status === "revoked") return "连接失效";
    return "最近活跃";
  }

  function platformVisitorIpRow(item) {
    const row = document.createElement("article");
    row.className = "platform-security-row";
    const copy = document.createElement("div");
    copy.className = "platform-security-copy";
    const heading = document.createElement("div");
    heading.className = "platform-security-line";
    const ip = document.createElement("code");
    ip.textContent = textValue(item && item.ip, "未知地址");
    const status = document.createElement("span");
    const statusValue = textValue(item && item.status, "active");
    status.className = `platform-security-status is-${statusValue}`;
    status.textContent = securityStatusLabel(statusValue);
    heading.append(ip, status);
    const visitor = item && item.visitor ? item.visitor : {};
    const space = item && item.space ? item.space : {};
    const identity = textValue(visitor.displayName || visitor.email, "访客");
    const detail = document.createElement("p");
    detail.textContent = `${identity} · ${textValue(space.name, "未知端")} · ${completionTime(item && item.lastSeenAt) || "时间未知"}`;
    copy.append(heading, detail);
    const action = document.createElement("button");
    action.className = "button button-danger-quiet button-small";
    action.type = "button";
    action.textContent = statusValue === "blocked" ? "已拉黑" : "拉黑";
    action.disabled = statusValue === "blocked" || !textValue(item && item.ip);
    action.addEventListener("click", () => openIpBlockDialog(item.ip));
    row.append(copy, action);
    return row;
  }

  function platformIpBlockRow(block) {
    const row = document.createElement("article");
    row.className = "platform-security-row";
    const copy = document.createElement("div");
    copy.className = "platform-security-copy";
    const heading = document.createElement("div");
    heading.className = "platform-security-line";
    const ip = document.createElement("code");
    ip.textContent = textValue(block && block.ip, "未知地址");
    const status = document.createElement("span");
    status.className = "platform-security-status is-blocked";
    status.textContent = "已拉黑";
    heading.append(ip, status);
    const detail = document.createElement("p");
    const note = textValue(block && block.note, "无备注");
    const affected = Number(block && block.affectedConnections);
    detail.textContent = `${note} · ${Number.isFinite(affected) ? affected : 0} 个现有连接 · ${completionTime(block && block.createdAt) || "时间未知"}`;
    copy.append(heading, detail);
    const action = document.createElement("button");
    action.className = "button button-quiet button-small";
    action.type = "button";
    action.textContent = "解除";
    action.addEventListener("click", () => removeIpBlock(block, action));
    row.append(copy, action);
    return row;
  }

  function renderPlatformIpAccess() {
    const payload = state.platformIpAccess || {};
    const visitors = Array.isArray(payload.visitors) ? payload.visitors : [];
    const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
    const visitorList = $("#platform-visitor-ip-list");
    const blockList = $("#platform-ip-block-list");
    visitorList.replaceChildren();
    blockList.replaceChildren();
    if (!visitors.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "还没有可显示的访客地址。";
      visitorList.appendChild(empty);
    } else {
      visitors.forEach((item) => visitorList.appendChild(platformVisitorIpRow(item)));
    }
    if (!blocks.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "黑名单为空。";
      blockList.appendChild(empty);
    } else {
      blocks.forEach((block) => blockList.appendChild(platformIpBlockRow(block)));
    }
    $("#platform-blacklist-count").textContent = `${blocks.length} 条`;
  }

  async function loadPlatformIpAccess() {
    if (!isPlatformAdmin()) return;
    const requestEpoch = state.privateRequestEpoch;
    const requestedUserEmail = state.user && state.user.email;
    if (!state.platformIpAccess) {
      $("#platform-visitor-ip-list").innerHTML = '<p class="history-empty">正在载入访客地址…</p>';
      $("#platform-ip-block-list").innerHTML = '<p class="history-empty">正在载入黑名单…</p>';
    }
    setMessage($("#platform-message"), "");
    try {
      const payload = await api("/api/platform/ip-access");
      if (
        requestEpoch !== state.privateRequestEpoch
        || !isPlatformAdmin()
        || !state.user
        || state.user.email !== requestedUserEmail
      ) return;
      state.platformIpAccess = payload;
      renderPlatformIpAccess();
    } catch (error) {
      if (requestEpoch !== state.privateRequestEpoch) return;
      setMessage($("#platform-message"), error.message);
    }
  }

  function openIpBlockDialog(ip) {
    if (!isPlatformAdmin()) return;
    $("#ip-block-form").reset();
    $("#ip-block-address").value = textValue(ip);
    setMessage($("#ip-block-message"), "");
    showDialog($("#ip-block-dialog"));
    window.setTimeout(() => {
      const field = $("#ip-block-address");
      field.focus();
      if (field.value) field.select();
    }, 0);
  }

  async function createIpBlock(event) {
    event.preventDefault();
    if (!isPlatformAdmin()) return;
    const button = $("#ip-block-submit");
    setLoading(button, true);
    setMessage($("#ip-block-message"), "");
    try {
      const payload = await api("/api/platform/ip-blocks", {
        method: "POST",
        body: {
          ip: $("#ip-block-address").value.trim(),
          note: $("#ip-block-note").value.trim(),
        },
      });
      closeDialog($("#ip-block-dialog"));
      state.platformIpAccess = null;
      await loadPlatformIpAccess();
      const affected = Number(payload && payload.block && payload.block.affectedConnections);
      toast(`已加入黑名单${Number.isFinite(affected) && affected > 0 ? `，限制 ${affected} 个现有连接` : ""}。`, "success");
    } catch (error) {
      setMessage($("#ip-block-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  async function removeIpBlock(block, button) {
    if (!isPlatformAdmin() || !block || !block.id) return;
    const confirmed = await confirmAction(`解除 ${textValue(block.ip, "这个地址")} 的访客访问限制吗？`, "确认解除");
    if (!confirmed) return;
    setLoading(button, true);
    try {
      await api(`/api/platform/ip-blocks/${encodeURIComponent(String(block.id))}`, {
        method: "DELETE",
      });
      state.platformIpAccess = null;
      await loadPlatformIpAccess();
      toast(`${textValue(block.ip, "该地址")} 已从黑名单移除。`, "success");
    } catch (error) {
      if (error.code === "not_found") {
        state.platformIpAccess = null;
        await loadPlatformIpAccess();
        toast("这条黑名单已经被移除。", "success");
      } else {
        toast(error.message, "error");
      }
    } finally {
      setLoading(button, false);
    }
  }

  function renderPlatformOverview() {
    const payload = state.platformOverview || {};
    const spaces = platformSpaces(payload);
    const users = platformUsers(payload);
    $("#platform-space-count").textContent = String(platformCount(payload, ["spaceCount", "managerCount"], spaces.length));
    $("#platform-user-count").textContent = String(platformCount(payload, ["userCount", "loggedInUserCount", "signedInUserCount", "activeSessionCount"], users.length));
    const fallbackConnections = spaces.reduce((total, space) => {
      const value = Number(space && (space.activeConnections ?? space.viewerCount ?? space.visitorCount ?? space.connectionCount));
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);
    $("#platform-connection-count").textContent = String(platformCount(payload, ["connectionCount", "activeConnectionCount", "connectedViewerCount"], fallbackConnections));

    const spacesList = $("#platform-spaces-list");
    spacesList.replaceChildren();
    if (!spaces.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "还没有可查看的管理端。";
      spacesList.appendChild(empty);
    } else {
      spaces.forEach((space) => {
        const row = platformSpaceRow(space);
        if (row) spacesList.appendChild(row);
      });
    }

    const usersList = $("#platform-users-list");
    usersList.replaceChildren();
    if (!users.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "当前没有登录用户。";
      usersList.appendChild(empty);
    } else {
      users.forEach((user) => usersList.appendChild(platformUserRow(user)));
    }
  }

  async function loadPlatformOverview() {
    if (!isPlatformAdmin()) return;
    const requestEpoch = state.privateRequestEpoch;
    const requestedUserEmail = state.user && state.user.email;
    setMessage($("#platform-message"), "");
    try {
      const payload = await api("/api/platform/overview");
      if (
        state.privateRequestEpoch !== requestEpoch
        || !isPlatformAdmin()
        || !state.user
        || state.user.email !== requestedUserEmail
      ) return;
      state.platformOverview = payload;
      renderPlatformOverview();
    } catch (error) {
      if (
        state.privateRequestEpoch !== requestEpoch
        || !isPlatformAdmin()
        || !state.user
        || state.user.email !== requestedUserEmail
      ) return;
      setMessage($("#platform-message"), error.message);
    }
  }

  async function openPlatformOverview() {
    if (!isPlatformAdmin()) return;
    $("#workspace-menu").open = false;
    $("#account-menu").open = false;
    state.returnToPlatform = false;
    setMode("platform");
    await loadPlatformOverview();
  }

  function switchPlatformTab(name) {
    state.platformTab = ["spaces", "users", "access"].includes(name) ? name : "spaces";
    $$("[data-platform-tab]").forEach((button) => {
      const active = button.dataset.platformTab === state.platformTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $("#platform-spaces-panel").hidden = state.platformTab !== "spaces";
    $("#platform-users-panel").hidden = state.platformTab !== "users";
    $("#platform-access-panel").hidden = state.platformTab !== "access";
    if (state.platformTab === "access") void loadPlatformIpAccess();
  }

  function handlePlatformTabKeydown(event) {
    const tabs = $$("[data-platform-tab]");
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    switchPlatformTab(next.dataset.platformTab);
    next.focus();
  }

  function openManagerInviteDialog() {
    if (!isPlatformAdmin()) return;
    $("#manager-invite-result").hidden = true;
    $("#manager-invite-empty").hidden = false;
    $("#manager-invite-code").textContent = "—";
    $("#generate-manager-invite").textContent = "生成邀请码";
    setMessage($("#manager-invite-message"), "");
    showDialog($("#manager-invite-dialog"));
  }

  async function generateManagerInvite(event) {
    event.preventDefault();
    if (!isPlatformAdmin()) return;
    const button = $("#generate-manager-invite");
    let generated = false;
    setLoading(button, true);
    setMessage($("#manager-invite-message"), "");
    try {
      const payload = await api("/api/platform/manager-invites", { method: "POST", body: {} });
      const code = textValue(payload.managerInviteCode || payload.inviteCode || payload.code);
      if (!code) throw new ApiError("邀请码已生成，但响应中没有可复制的代码。", 500, "missing_invite_code");
      $("#manager-invite-code").textContent = code;
      $("#manager-invite-result").hidden = false;
      $("#manager-invite-empty").hidden = true;
      generated = true;
    } catch (error) {
      setMessage($("#manager-invite-message"), error.message);
    } finally {
      setLoading(button, false);
      if (generated) button.textContent = "再生成一个";
    }
  }

  function messageWindow() {
    const payload = state.messagesPayload || {};
    return payload.window && typeof payload.window === "object" ? payload.window : {};
  }

  function messageMode() {
    if (state.messagesPayload && state.messagesPayload.mode === "owner") return "owner";
    if (state.messagesPayload && state.messagesPayload.mode === "viewer") return "viewer";
    return state.access === "owner" && state.mode === "owner" ? "owner" : "viewer";
  }

  function clearMessageRefreshTimer() {
    window.clearTimeout(state.messageRefreshTimer);
    state.messageRefreshTimer = null;
  }

  function clearMessageContent(placeholder) {
    state.messageRequestEpoch += 1;
    clearMessageRefreshTimer();
    state.messagesPayload = null;
    state.selectedConversationId = "";
    $("#message-conversation-list").replaceChildren();
    $("#message-conversation-list").hidden = true;
    $("#message-thread").replaceChildren();
    $("#message-form").hidden = true;
    $("#message-unread-count").hidden = true;
    $("#message-unread-count").textContent = "0";
    if (placeholder) {
      const empty = document.createElement("p");
      empty.className = "message-empty";
      empty.textContent = placeholder;
      $("#message-thread").appendChild(empty);
    }
  }

  function closedOwnerMessagePayload(windowState) {
    return {
      mode: "owner",
      contentAvailable: false,
      conversations: [],
      window: Object.assign({}, windowState || {}, {
        isOpen: false,
        label: "每天 20:00–21:00 开放查看与回复",
      }),
    };
  }

  function messageWindowRemainingMs(windowState, requestElapsedMs) {
    const closesAt = Date.parse(windowState && windowState.closesAt);
    const serverNow = Date.parse(windowState && windowState.serverNow);
    if (Number.isFinite(closesAt) && Number.isFinite(serverNow)) {
      return closesAt - serverNow - Math.max(0, Number(requestElapsedMs) || 0);
    }
    if (Number.isFinite(closesAt)) return closesAt - Date.now();
    return null;
  }

  function scheduleOwnerMessageExpiry(payload, requestElapsedMs) {
    clearMessageRefreshTimer();
    if (!payload || payload.mode !== "owner" || !payload.window || !payload.window.isOpen) return;
    const remaining = messageWindowRemainingMs(payload.window, requestElapsedMs);
    if (!Number.isFinite(remaining)) return;
    const expectedSpaceId = state.activeSpaceId;
    state.messageRefreshTimer = window.setTimeout(() => {
      state.messageRefreshTimer = null;
      if (state.activeSpaceId !== expectedSpaceId || state.messagesPayload !== payload) return;
      state.messagesPayload = closedOwnerMessagePayload(payload.window);
      state.selectedConversationId = "";
      renderMessages();
      if (!$("#message-panel").hidden && !$("#message-widget").hidden) loadMessages(true);
    }, Math.max(0, Math.min(remaining + 25, 2147483000)));
  }

  function messageTimestamp(value) {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: SHANGHAI_TZ,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
  }

  function messageBubble(message, mode) {
    const item = document.createElement("article");
    const senderRole = textValue(message && (message.senderRole || message.senderKind || message.role || message.authorRole));
    const ownerMessage = senderRole === "owner" || senderRole === "manager" || Boolean(message && message.isOwnerReply);
    const own = mode === "owner" ? ownerMessage : !ownerMessage;
    item.className = `message-bubble${own ? " is-own" : ""}`;
    const body = document.createElement("p");
    body.textContent = textValue(message && (message.body || message.text), "—");
    const meta = document.createElement("small");
    meta.textContent = `${ownerMessage ? "管理端" : "访客"}${messageTimestamp(message && (message.createdAt || message.sentAt)) ? ` · ${messageTimestamp(message.createdAt || message.sentAt)}` : ""}`;
    item.append(body, meta);
    return item;
  }

  function ownerConversations() {
    const payload = state.messagesPayload || {};
    return Array.isArray(payload.conversations) ? payload.conversations : [];
  }

  function conversationId(conversation) {
    return String(conversation && (conversation.visitorUserId || conversation.userId || conversation.id || ""));
  }

  function selectedConversation() {
    return ownerConversations().find((conversation) => conversationId(conversation) === state.selectedConversationId) || null;
  }

  function renderMessageWindowStatus() {
    const windowState = messageWindow();
    const mode = messageMode();
    const open = Boolean(windowState.isOpen);
    $("#message-window-label").textContent = textValue(
      windowState.label,
      open ? "回复时段 · 20:00–21:00" : (mode === "owner" ? "留言暂未开放查看" : "留言会在今晚送达"),
    );
    $("#message-window-copy").textContent = open
      ? (mode === "owner" ? "现在可以查看并回复今天的留言。" : "管理端现在可以看到并回复留言。")
      : (mode === "owner"
        ? "回复时段外无法查看新留言；下一时段由服务器安排。"
        : "你可以随时留言，管理端只会在规定时段看到。");
    $("#message-window-status").classList.toggle("is-open", open);
  }

  function renderMessages() {
    const payload = state.messagesPayload || {};
    const mode = messageMode();
    renderMessageWindowStatus();
    const conversationList = $("#message-conversation-list");
    const thread = $("#message-thread");
    const form = $("#message-form");
    const input = $("#message-input");
    conversationList.replaceChildren();
    thread.replaceChildren();

    if (mode === "owner") {
      const conversations = ownerConversations();
      conversationList.hidden = false;
      if (!state.selectedConversationId && conversations.length) {
        state.selectedConversationId = conversationId(conversations[0]);
      }
      if (!conversations.length) {
        const empty = document.createElement("p");
        empty.className = "message-empty";
        empty.textContent = messageWindow().isOpen ? "今天还没有访客留言。" : "留言会在回复时段开放查看。";
        thread.appendChild(empty);
      } else {
        conversations.forEach((conversation) => {
          const id = conversationId(conversation);
          const button = document.createElement("button");
          button.className = `message-conversation-option${id === state.selectedConversationId ? " is-active" : ""}`;
          button.type = "button";
          const title = document.createElement("strong");
          title.textContent = textValue(conversation.displayName || conversation.visitorDisplayName || conversation.email, "访客");
          const summary = document.createElement("span");
          summary.textContent = textValue(conversation.preview || conversation.lastMessage, "查看留言");
          button.append(title, summary);
          button.addEventListener("click", () => {
            state.selectedConversationId = id;
            renderMessages();
          });
          conversationList.appendChild(button);
        });
        const conversation = selectedConversation();
        const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
        messages.forEach((message) => thread.appendChild(messageBubble(message, mode)));
      }
      const canReply = Boolean(messageWindow().isOpen && selectedConversation());
      form.hidden = !canReply;
      input.placeholder = "回复这位访客…";
      $("#send-message-button").textContent = "回复";
      $("#message-compose-label").textContent = "回复访客";
    } else {
      conversationList.hidden = true;
      const messages = Array.isArray(payload.messages)
        ? payload.messages
        : (payload.conversation && Array.isArray(payload.conversation.messages) ? payload.conversation.messages : []);
      if (!messages.length) {
        const empty = document.createElement("p");
        empty.className = "message-empty";
        empty.textContent = "这里会安静地保存你与管理端之间的留言。";
        thread.appendChild(empty);
      } else {
        messages.forEach((message) => thread.appendChild(messageBubble(message, mode)));
      }
      form.hidden = false;
      input.placeholder = "写下一句话…";
      $("#send-message-button").textContent = "发送";
      $("#message-compose-label").textContent = "写下留言";
    }
    thread.scrollTop = thread.scrollHeight;
    const unread = Number(payload.unreadCount);
    $("#message-unread-count").hidden = !(Number.isFinite(unread) && unread > 0);
    $("#message-unread-count").textContent = Number.isFinite(unread) && unread > 99 ? "99+" : String(unread || 0);
  }

  function configureMessageWidget() {
    const supportedSurface = (state.access === "owner" && state.mode === "owner")
      || (state.access === "viewer" && state.mode === "visitor");
    const visible = Boolean(
      state.user
      && state.activeSpaceId
      && supportedSurface
      && (!activeSpace() || activeSpace().connectionStatus !== "revoked"),
    );
    const platformPreview = Boolean(
      isPlatformAdmin()
      && state.access === "viewer"
      && activeSpace()
      && activeSpace().platformPreview,
    );
    $("#message-toggle-label").textContent = state.access === "owner"
      ? "访客留言"
      : (platformPreview ? "给此端留言" : "留言");
    $("#message-panel-title").textContent = state.access === "owner"
      ? "访客留言"
      : (platformPreview ? "给此端留言" : "留言");
    $("#message-widget").hidden = !visible;
    if (!visible) {
      $("#message-panel").hidden = true;
      $("#message-toggle").setAttribute("aria-expanded", "false");
      clearMessageContent();
    }
  }

  async function loadMessages(silent) {
    if ($("#message-widget").hidden || $("#message-panel").hidden || !state.activeSpaceId) return;
    const requestEpoch = ++state.messageRequestEpoch;
    const requestedSpaceId = state.activeSpaceId;
    const requestedMode = state.mode;
    const requestedAt = Date.now();
    if (!silent) setMessage($("#message-panel-message"), "");
    try {
      const payload = await api("/api/messages");
      if (
        state.messageRequestEpoch !== requestEpoch
        || $("#message-panel").hidden
        || $("#message-widget").hidden
        || state.activeSpaceId !== requestedSpaceId
        || state.mode !== requestedMode
      ) return;
      const elapsed = Date.now() - requestedAt;
      const expiredOwnerPayload = payload
        && payload.mode === "owner"
        && payload.window
        && payload.window.isOpen
        && messageWindowRemainingMs(payload.window, elapsed) <= 0;
      state.messagesPayload = expiredOwnerPayload
        ? closedOwnerMessagePayload(payload.window)
        : payload;
      renderMessages();
      scheduleOwnerMessageExpiry(state.messagesPayload, elapsed);
    } catch (error) {
      if (error.code === "preview_access_revoked") return;
      if (
        state.messageRequestEpoch !== requestEpoch
        || $("#message-panel").hidden
        || $("#message-widget").hidden
        || state.activeSpaceId !== requestedSpaceId
        || state.mode !== requestedMode
      ) return;
      clearMessageContent("暂时无法读取留言。");
      setMessage($("#message-panel-message"), error.message);
    }
  }

  async function toggleMessagePanel(open) {
    const nextOpen = typeof open === "boolean" ? open : $("#message-panel").hidden;
    if (nextOpen) clearMessageContent("正在读取留言…");
    $("#message-panel").hidden = !nextOpen;
    $("#message-toggle").setAttribute("aria-expanded", String(nextOpen));
    if (nextOpen) {
      await loadMessages(false);
      if ($("#message-panel").hidden) return;
      window.setTimeout(() => {
        const target = $("#message-form").hidden ? $("#close-message-panel") : $("#message-input");
        target.focus();
      }, 0);
    } else {
      clearMessageContent();
      $("#message-toggle").focus();
    }
  }

  async function submitMessage(event) {
    event.preventDefault();
    const body = $("#message-input").value.trim();
    if (!body) {
      setMessage($("#message-panel-message"), "请先写下留言。");
      return;
    }
    const mode = messageMode();
    const button = $("#send-message-button");
    setLoading(button, true);
    setMessage($("#message-panel-message"), "");
    try {
      if (mode === "owner") {
        const conversation = selectedConversation();
        if (!conversation || !messageWindow().isOpen) throw new ApiError("当前不在回复时段。", 403, "reply_window_closed");
        const visitorUserId = conversationId(conversation);
        await api(`/api/messages/${encodeURIComponent(visitorUserId)}/reply`, { method: "POST", body: { body } });
      } else {
        await api("/api/messages", { method: "POST", body: { body } });
      }
      $("#message-input").value = "";
      await loadMessages(true);
      toast(mode === "owner" ? "回复已发送。" : "留言已送出。", "success");
    } catch (error) {
      setMessage($("#message-panel-message"), error.message);
    } finally {
      setLoading(button, false);
    }
  }

  async function exportData(event) {
    event.preventDefault();
    if (!canManageActiveWorkspace()) return;
    const link = $("#export-data");
    link.setAttribute("aria-busy", "true");
    link.classList.add("is-loading");
    try {
      const response = await fetch("/api/export", {
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "X-Day1-Space": state.activeSpaceId,
        },
      });
      if (!response.ok) {
        const payload = (response.headers.get("content-type") || "").includes("application/json")
          ? await response.json().catch(() => ({}))
          : {};
        if (response.status === 410 && payload.code === "preview_access_revoked") handleRevokedConnection(payload);
        throw new ApiError(payload.error || "导出没有成功，请稍后重试。", response.status, payload.code, payload);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const download = document.createElement("a");
      download.href = url;
      download.download = `blue-day1-${dateKeyInShanghai()}.json`;
      document.body.appendChild(download);
      download.click();
      download.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast("备份已开始下载。", "success");
    } catch (error) {
      if (error.code !== "preview_access_revoked") toast(error.message, "error");
    } finally {
      link.removeAttribute("aria-busy");
      link.classList.remove("is-loading");
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
    const registrationKind = selectedRegistrationKind();
    const displayName = $("#register-display-name").value.trim();
    const email = $("#register-email").value.trim();
    const password = $("#register-password").value;
    const confirmation = $("#register-password-confirm").value;
    const viewerCode = $("#register-viewer-code").value.trim();
    const managerInviteCode = $("#register-manager-invite").value.trim();
    const spaceName = $("#register-space-name").value.trim();
    if (!displayName || !email || password.length < 10) {
      setMessage($("#auth-message"), "请填写名称和有效邮箱，密码至少 10 个字符。");
      return;
    }
    if (registrationKind === "viewer" && !viewerCode) {
      setMessage($("#auth-message"), "请输入预览识别码。");
      return;
    }
    if (registrationKind === "manager" && (!managerInviteCode || !spaceName)) {
      setMessage($("#auth-message"), "请输入管理邀请码和管理端名称。");
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
      const body = { registrationKind, displayName, email, password };
      if (registrationKind === "manager") {
        body.managerInviteCode = managerInviteCode;
        body.spaceName = spaceName;
      } else {
        body.viewerCode = viewerCode;
      }
      const result = await api("/api/register", { method: "POST", body });
      state.user = result.user;
      await loadSession();
      await enterApp();
      $("#register-form").reset();
      switchRegistrationKind("viewer");
      toast(registrationKind === "manager" ? "你的管理端已创建。" : "访客账号已创建。", "success");
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

  function bindStageAttachmentPicker() {
    const ui = stageUploadUi();
    ui.input.addEventListener("change", (event) => previewStageFile(event.target.files[0]));
    ui.remove.addEventListener("click", () => {
      clearStageImagePreview();
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
        clearStageImagePreview();
        setMessage(ui.message, "一次只能选择一个附件。");
        return;
      }
      try {
        const transfer = new DataTransfer();
        transfer.items.add(files[0]);
        ui.input.files = transfer.files;
      } catch (_error) {
        clearStageImagePreview();
        setMessage(ui.message, "当前浏览器无法拖放附件，请点按选择。");
        return;
      }
      previewStageFile(files[0]);
    });
  }

  function bindProgressPicker() {
    const input = $("#progress-file-input");
    const dropzone = $("#progress-dropzone");
    input.addEventListener("change", (event) => addProgressFiles(event.target.files));
    ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      dropzone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    }));
    dropzone.addEventListener("drop", (event) => addProgressFiles(event.dataTransfer ? event.dataTransfer.files : []));
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
    $$('input[name="registrationKind"]').forEach((input) => input.addEventListener("change", () => switchRegistrationKind(selectedRegistrationKind())));
    $$('[data-toggle-password]').forEach((button) => {
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.togglePassword);
        if (!input) return;
        setPasswordVisibility(button, input.type === "password");
      });
    });
    $$('[data-switch-view]').forEach((button) => button.addEventListener("click", () => {
      $("#workspace-menu").open = false;
      setMode(button.dataset.switchView);
    }));
    $("#workspace-menu").addEventListener("toggle", () => {
      if ($("#workspace-menu").open) {
        $("#account-menu").open = false;
        renderWorkspaceMenu();
      }
    });
    $("#account-menu").addEventListener("toggle", () => {
      if ($("#account-menu").open) $("#workspace-menu").open = false;
    });
    $("#edit-today-task").addEventListener("click", () => openTaskEditor($("#edit-today-task").dataset.taskDate));
    $("#edit-tomorrow-task").addEventListener("click", () => openTaskEditor($("#edit-tomorrow-task").dataset.taskDate));
    $("#add-today-progress").addEventListener("click", () => openProgressEditor($("#add-today-progress").dataset.taskDate));
    $("#complete-today-task").addEventListener("click", () => openProofEditor($("#complete-today-task").dataset.taskDate));
    $("#view-today-proof").addEventListener("click", () => openRecord(taskFor($("#view-today-proof").dataset.taskDate), "owner"));
    $("#visitor-view-proof").addEventListener("click", () => openRecord(taskFor($("#visitor-view-proof").dataset.taskDate), "visitor"));
    $("#record-add-progress").addEventListener("click", () => {
      const key = $("#record-add-progress").dataset.taskDate;
      if (!key) return;
      closeDialog($("#proof-view-dialog"));
      openProgressEditor(key);
    });
    $("#owner-goal-primary").addEventListener("click", openGoalEditor);
    $("#owner-goal-route").addEventListener("click", openGoalRoute);
    $("#visitor-goal-route").addEventListener("click", openGoalRoute);
    $("#owner-goal-today").addEventListener("click", arrangeGoalNextToday);
    $("#goal-route-stage-button").addEventListener("click", openStageEditor);
    $("#edit-goal-button").addEventListener("click", openGoalEditor);
    $("#complete-goal-button").addEventListener("click", completeActiveGoal);
    $("#goal-route-edit-stage").addEventListener("click", openStageEditor);
    $("#goal-route-complete-stage").addEventListener("click", openStageCompletion);
    $("#goal-form").addEventListener("submit", saveGoal);
    $("#subgoal-form").addEventListener("submit", saveSubgoal);
    $("#cancel-subgoal-edit").addEventListener("click", resetSubgoalEditor);
    $("#goal-route-subgoals").addEventListener("click", handleSubgoalAction);
    $("#create-stage-button").addEventListener("click", () => {
      if (state.activeGoal) openStageEditor();
      else openGoalEditor();
    });
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
    $("#progress-form").addEventListener("submit", submitProgress);
    $("#progress-percent-input").addEventListener("input", updateProgressOutput);
    $("#proof-form").addEventListener("submit", submitProof);
    $$('input[name="resultStatus"]').forEach((input) => input.addEventListener("change", updateResultForm));
    $("#result-progress-input").addEventListener("input", updateResultForm);
    bindProgressPicker();
    bindStageAttachmentPicker();
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
    $("#export-data").addEventListener("click", exportData);
    $("#access-tools").addEventListener("toggle", () => {
      if ($("#access-tools").open && state.access === "owner" && !state.viewerCode) loadViewerCode();
    });
    $("#copy-viewer-code").addEventListener("click", () => copyText(state.viewerCode, "预览识别码已复制。"));
    $("#open-refresh-viewer-code").addEventListener("click", openRefreshViewerCodeDialog);
    $("#refresh-viewer-code-confirmation").addEventListener("input", validateViewerCodeRefresh);
    $("#refresh-viewer-code-form").addEventListener("submit", refreshViewerCode);
    $("#open-delete-own-space").addEventListener("click", openOwnSpaceDeleteDialog);
    $("#delete-space-confirmation").addEventListener("input", validateSpaceDeletion);
    $("#delete-space-form").addEventListener("submit", deleteSpace);
    $$("[data-open-connect-space]").forEach((button) => button.addEventListener("click", openConnectSpaceDialog));
    $("#connect-space-form").addEventListener("submit", connectSpace);
    $("#open-platform-overview").addEventListener("click", openPlatformOverview);
    $("#account-platform-overview").addEventListener("click", openPlatformOverview);
    $("#create-manager-invite").addEventListener("click", openManagerInviteDialog);
    $("#manager-invite-form").addEventListener("submit", generateManagerInvite);
    $("#copy-manager-invite").addEventListener("click", () => copyText($("#manager-invite-code").textContent, "管理邀请码已复制。"));
    $("#open-manual-ip-block").addEventListener("click", () => openIpBlockDialog(""));
    $("#ip-block-form").addEventListener("submit", createIpBlock);
    $$("[data-platform-tab]").forEach((button) => {
      button.addEventListener("click", () => switchPlatformTab(button.dataset.platformTab));
      button.addEventListener("keydown", handlePlatformTabKeydown);
    });
    $("#switch-after-connection-lost").addEventListener("click", () => {
      const alternative = state.spaces.find((space) => space.publicId !== state.activeSpaceId && space.connectionStatus === "active");
      if (alternative) switchWorkspace(alternative.publicId);
    });
    $("#connection-lost-primary").addEventListener("click", handleConnectionLostPrimary);
    $("#message-toggle").addEventListener("click", () => toggleMessagePanel());
    $("#close-message-panel").addEventListener("click", () => toggleMessagePanel(false));
    $("#message-form").addEventListener("submit", submitMessage);
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
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("#message-panel").hidden) {
        event.preventDefault();
        toggleMessagePanel(false);
      }
    });
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
    [$("#task-dialog"), $("#progress-dialog"), $("#proof-dialog"), $("#stage-dialog"), $("#stage-complete-dialog")].forEach((dialog) => dialog.addEventListener("close", () => {
      setMessage(dialog.querySelector(".form-message"), "");
      if (dialog === $("#progress-dialog")) clearProgressFiles();
      if (dialog === $("#stage-complete-dialog")) clearStageImagePreview();
    }));
    $("#delete-space-dialog").addEventListener("close", () => {
      state.deleteSpaceTarget = null;
      $("#delete-space-form").reset();
      $("#delete-space-submit").disabled = true;
      setMessage($("#delete-space-message"), "");
    });
    $("#ip-block-dialog").addEventListener("close", () => {
      $("#ip-block-form").reset();
      setMessage($("#ip-block-message"), "");
    });
    [$("#task-text-input"), $("#progress-note-input"), $("#proof-text-input"), $("#stage-title-input"), $("#stage-description-input"), $("#stage-proof-text")].forEach((input) => {
      input.addEventListener("input", () => updateCharacterCount(input));
    });
  }

  bindEvents();
  bootstrap();

  window.setInterval(async () => {
    const current = dateKeyInShanghai();
    if (state.user) {
      const task = taskFor(current);
      $("#owner-context-line").textContent = contextualCopy(task, false);
      $("#visitor-context-line").textContent = contextualCopy(task, true);
      if (Date.now() - state.lastAccessCheckAt >= 60000) {
        state.lastAccessCheckAt = Date.now();
        try {
          await refreshSpaceAccess();
        } catch (_error) {
          // Access will be checked again on the next content request or interval.
        }
      }
      if (!$("#message-panel").hidden && !$("#message-widget").hidden) {
        loadMessages(true);
      }
    }
    if (current !== state.renderedDate) {
      state.renderedDate = current;
      state.historyYear = Number(current.slice(0, 4));
      state.visitorHistoryYear = state.historyYear;
      if (state.user && state.activeSpaceId && !["platform", "connection-lost"].includes(state.mode)) {
        try {
          await loadData();
        } catch (_error) {
          toast("日期已更新，刷新页面即可继续。", "error");
        }
      }
    }
  }, 30000);
}());
