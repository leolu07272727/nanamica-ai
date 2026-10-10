let selectedProvider = "claude";
let selectedMode = "api";
let selectedWebProvider = "chatgpt-web";
const selectedModels = {
  claude: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash-lite"
};

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get([
    "claudeKey","openaiKey","geminiKey",
    "provider","claudeModel","openaiModel","geminiModel",
    "enabled","mode","webProvider"
  ], (data) => {
    if (data.claudeKey) document.getElementById("claudeKey").value = data.claudeKey;
    if (data.openaiKey) document.getElementById("openaiKey").value = data.openaiKey;
    if (data.geminiKey) document.getElementById("geminiKey").value = data.geminiKey;
    if (data.provider) { selectedProvider = data.provider; switchProvider(selectedProvider); }
    if (data.claudeModel) selectedModels.claude = data.claudeModel;
    if (data.openaiModel) selectedModels.openai = data.openaiModel;
    if (data.geminiModel) selectedModels.gemini = data.geminiModel;
    if (data.enabled === false) document.getElementById("enabled").checked = false;
    if (data.mode) { selectedMode = data.mode; switchMode(selectedMode); }
    if (data.webProvider) { selectedWebProvider = data.webProvider; switchWebProvider(selectedWebProvider); }
    updateAllModelUI();
  });

  // Mode toggle — auto-save immediately
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedMode = btn.dataset.mode;
      switchMode(selectedMode);
      chrome.storage.local.set({ mode: selectedMode });
    });
  });

  // API Provider tabs — auto-save immediately
  document.querySelectorAll(".provider-tab:not([data-web-provider])").forEach(tab => {
    tab.addEventListener("click", () => {
      selectedProvider = tab.dataset.provider;
      switchProvider(selectedProvider);
      chrome.storage.local.set({ provider: selectedProvider });
    });
  });

  // Web Provider tabs — auto-save immediately
  document.querySelectorAll("[data-web-provider]").forEach(tab => {
    tab.addEventListener("click", () => {
      selectedWebProvider = tab.dataset.webProvider;
      switchWebProvider(selectedWebProvider);
      chrome.storage.local.set({ webProvider: selectedWebProvider });
    });
  });

  // Model options
  ["claude","openai","gemini"].forEach(p => {
    document.querySelectorAll(`#${p}-models .model-option`).forEach(el => {
      el.addEventListener("click", () => {
        selectedModels[p] = el.dataset.model;
        document.querySelectorAll(`#${p}-models .model-option`).forEach(o => o.classList.remove("active"));
        el.classList.add("active");
      });
    });
  });

  document.getElementById("saveBtn").addEventListener("click", save);
});

function switchMode(mode) {
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  document.querySelectorAll(".mode-panel").forEach(p => p.classList.remove("active"));
  document.getElementById(`mode-${mode}`).classList.add("active");
}

function switchProvider(p) {
  document.querySelectorAll(".provider-tab:not([data-web-provider])").forEach(t => t.classList.toggle("active", t.dataset.provider === p));
  document.querySelectorAll(".provider-panel").forEach(panel => panel.classList.remove("active"));
  const el = document.getElementById(`panel-${p}`);
  if (el) el.classList.add("active");
}

function switchWebProvider(p) {
  document.querySelectorAll("[data-web-provider]").forEach(t => t.classList.toggle("active", t.dataset.webProvider === p));
  const labels = { "chatgpt-web": "請保持登入 chatgpt.com", "claude-web": "請保持登入 claude.ai", "gemini-web": "請保持登入 gemini.google.com" };
  const el = document.getElementById("web-status");
  if (el) el.textContent = labels[p] || "";
}

function updateAllModelUI() {
  ["claude","openai","gemini"].forEach(p => {
    document.querySelectorAll(`#${p}-models .model-option`).forEach(el => {
      el.classList.toggle("active", el.dataset.model === selectedModels[p]);
    });
  });
}

function save() {
  const status = document.getElementById("status");
  const claudeKey = document.getElementById("claudeKey").value.trim();
  const openaiKey = document.getElementById("openaiKey").value.trim();
  const geminiKey = document.getElementById("geminiKey").value.trim();
  const enabled   = document.getElementById("enabled").checked;

  if (selectedMode === "api") {
    const currentKey = { claude: claudeKey, openai: openaiKey, gemini: geminiKey }[selectedProvider];
    if (!currentKey) { status.textContent = "請輸入 API Key"; status.className = "status error"; return; }
  }

  chrome.storage.local.set({
    mode: selectedMode,
    provider: selectedProvider,
    webProvider: selectedWebProvider,
    claudeKey, openaiKey, geminiKey,
    claudeModel: selectedModels.claude,
    openaiModel: selectedModels.openai,
    geminiModel: selectedModels.gemini,
    enabled
  }, () => {
    status.textContent = "✓ 已儲存";
    status.className = "status";
    setTimeout(() => status.textContent = "", 2000);
  });
}
