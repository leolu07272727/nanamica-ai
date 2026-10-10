(() => {
  // 模型預設值的唯一來源(popup.js 的 selectedModels 初始值須與此一致)。
  // 模型淘汰時只改這裡——2026-07-02 審計:三處寫死的字串各自為政,
  // gemini fallback 還停在 2.0-flash 與 popup 顯示的不同。
  const DEFAULT_MODELS = {
    claude: "claude-haiku-4-5-20251001",
    openai: "gpt-4o-mini",
    gemini: "gemini-2.5-flash-lite"
  };

  let selectionBtn = null;
  let panel = null;
  let launcher = null;
  let launcherMenu = null;
  let selectedText = "";
  let messages = [];
  let isLoading = false;
  let pendingScreenshot = null;

  // ── 初始化常駐浮動按鈕群組 ──
  function initLauncher() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get(["enabled", "launcherPos", "launcherHidden", "autoMode"], (data) => {
      if (data.enabled === false) return;

      const group = document.createElement("div");
      group.id = "ai-launcher-group";

      const pos = data.launcherPos || { right: 24, bottom: 24 };
      group.style.right  = pos.right + "px";
      group.style.bottom = pos.bottom + "px";

      if (data.launcherHidden) group.classList.add("hidden");

      // 🎯 自動答題按鈕
      const autoAnswerBtn = document.createElement("button");
      autoAnswerBtn.id = "ai-autoanswer-btn";
      autoAnswerBtn.title = "點擊答題　長按開啟自動模式";
      autoAnswerBtn.innerHTML = "🎯";
      if (data.autoMode) autoAnswerBtn.classList.add("auto-active");

      // 短按：答題一次；長按：切換自動模式
      let pressTimer = null;
      autoAnswerBtn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        pressTimer = setTimeout(() => {
          pressTimer = null;
          toggleAutoMode(autoAnswerBtn);
        }, 600);
      });
      autoAnswerBtn.addEventListener("mouseup", (e) => {
        e.stopPropagation();
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; autoAnswer(); }
      });
      autoAnswerBtn.addEventListener("mouseleave", () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      });

      // 自動模式：等到頁面出現選項才執行（排除 AI 平台本身）
      const skipDomains = ["gemini.google.com", "claude.ai", "chatgpt.com", "chat.openai.com"];
      const isAIPlatform = skipDomains.some(d => location.hostname.includes(d));
      if (data.autoMode && !isAIPlatform) {
        waitForQuizAndAnswer();
      }

      // 📷 截圖按鈕
      const screenshotBtn = document.createElement("button");
      screenshotBtn.id = "ai-screenshot-btn";
      screenshotBtn.title = "截取螢幕區域";
      screenshotBtn.innerHTML = "📷";
      screenshotBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startScreenshotCapture();
      });

      // ✦ 主按鈕
      launcher = document.createElement("button");
      launcher.id = "ai-launcher";
      launcher.title = "nanamica.ai（右鍵更多選項）";
      launcher.innerHTML = "✦";

      launcher.addEventListener("click", (e) => {
        if (group._wasDragged) return;
        if (panel) { panel.remove(); panel = null; }
        else openPanel(selectedText);
      });

      launcher.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showLauncherMenu(e.clientX, e.clientY);
      });

      group.appendChild(autoAnswerBtn);
      group.appendChild(screenshotBtn);
      group.appendChild(launcher);
      makeDraggable(group);
      document.body.appendChild(group);
    });
  }

  // ── 右鍵選單 ──
  function showLauncherMenu(x, y) {
    closeLauncherMenu();
    launcherMenu = document.createElement("div");
    launcherMenu.id = "ai-launcher-menu";
    launcherMenu.style.left = x + "px";
    launcherMenu.style.top  = y + "px";
    launcherMenu.innerHTML = `
      <div class="ai-menu-item" id="ai-menu-open">💬 開啟對話</div>
      <div class="ai-menu-item" id="ai-menu-autoanswer">🎯 自動答題</div>
      <div class="ai-menu-item" id="ai-menu-screenshot">📷 截取螢幕區域</div>
      <div class="ai-menu-item" id="ai-menu-hide">👁 隱藏按鈕</div>
    `;
    document.body.appendChild(launcherMenu);

    launcherMenu.querySelector("#ai-menu-open").addEventListener("click", () => {
      closeLauncherMenu();
      if (!panel) openPanel(selectedText);
    });
    launcherMenu.querySelector("#ai-menu-autoanswer").addEventListener("click", () => {
      closeLauncherMenu();
      autoAnswer();
    });
    launcherMenu.querySelector("#ai-menu-screenshot").addEventListener("click", () => {
      closeLauncherMenu();
      startScreenshotCapture();
    });
    launcherMenu.querySelector("#ai-menu-hide").addEventListener("click", () => {
      hideLauncher();
      closeLauncherMenu();
    });

    setTimeout(() => document.addEventListener("click", closeLauncherMenu, { once: true }), 0);
  }

  function closeLauncherMenu() {
    if (launcherMenu) { launcherMenu.remove(); launcherMenu = null; }
  }

  // 用 MutationObserver 監聽新題目，自動作答
  function waitForQuizAndAnswer() {
    let lastKey = "";
    let debounce = null;

    function tryAnswer() {
      chrome.storage.local.get(["autoMode"], (data) => {
        if (!data.autoMode) { observer.disconnect(); clearInterval(intervalId); return; }
        if (isLoading) return;
        const { options } = detectQuizOptions();
        if (options.length === 0) return;
        const qHint = location.href + "|" + (document.querySelector('.qtext,.stem,.question-text,h2,h3')?.innerText || "").slice(0, 80);
        const key = qHint + "|" + options.map(o => o.text).join("|");
        if (key === lastKey) return;
        lastKey = key;
        setTimeout(() => autoAnswer(), 400);
      });
    }

    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(tryAnswer, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const intervalId = setInterval(() => {
      if (!chrome.runtime?.id) { clearInterval(intervalId); observer.disconnect(); return; }
      chrome.storage.local.get(["autoMode"], (data) => {
        if (chrome.runtime.lastError || !data.autoMode) { clearInterval(intervalId); observer.disconnect(); return; }
        tryAnswer();
      });
    }, 500);

    tryAnswer();
    window.addEventListener("load", tryAnswer, { once: true });
  }

  function toggleAutoMode(btn) {
    chrome.storage.local.get(["autoMode"], (data) => {
      const next = !data.autoMode;
      chrome.storage.local.set({ autoMode: next });
      btn.classList.toggle("auto-active", next);
      btn.innerHTML = next ? "✅" : "⏹";
      setTimeout(() => { btn.innerHTML = "🎯"; }, 1000);
      if (next) waitForQuizAndAnswer();
    });
  }

  function hideLauncher() {
    const group = document.getElementById("ai-launcher-group");
    if (group) group.classList.add("hidden");
    chrome.storage.local.set({ launcherHidden: true });
    showRevealHint();
  }

  function showRevealHint() {
    if (document.getElementById("ai-reveal-hint")) return;
    const hint = document.createElement("div");
    hint.id = "ai-reveal-hint";
    Object.assign(hint.style, {
      position: "fixed", right: "0", bottom: "50%",
      zIndex: "2147483645",
      background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
      color: "#fff", fontSize: "11px",
      fontFamily: "-apple-system,sans-serif", fontWeight: "600",
      writingMode: "vertical-rl", padding: "10px 4px",
      borderRadius: "6px 0 0 6px", cursor: "pointer",
      boxShadow: "-3px 0 12px rgba(99,102,241,0.4)",
      opacity: "0.85", userSelect: "none",
    });
    hint.textContent = "✦ AI";
    hint.addEventListener("click", () => {
      const group = document.getElementById("ai-launcher-group");
      if (group) group.classList.remove("hidden");
      chrome.storage.local.set({ launcherHidden: false });
      hint.remove();
    });
    document.body.appendChild(hint);
  }

  // ── 拖曳 ──
  function makeDraggable(el) {
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      el._wasDragged = false;

      // 記錄游標在元素內的偏移，拖曳時保持不變
      const rect = el.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      const onMove = (ev) => {
        if (Math.abs(ev.clientX - e.clientX) > 3 || Math.abs(ev.clientY - e.clientY) > 3)
          el._wasDragged = true;
        if (!el._wasDragged) return;

        // 游標位置 - 偏移 = 元素左上角的位置
        const newLeft = ev.clientX - offsetX;
        const newTop  = ev.clientY - offsetY;

        // 轉換成 right / bottom（fixed 相對於視窗）
        const newRight  = window.innerWidth  - newLeft - el.offsetWidth;
        const newBottom = window.innerHeight - newTop  - el.offsetHeight;

        el.style.right  = Math.max(0, newRight)  + "px";
        el.style.bottom = Math.max(0, newBottom) + "px";
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (el._wasDragged) {
          chrome.storage.local.set({ launcherPos: {
            right:  parseInt(el.style.right),
            bottom: parseInt(el.style.bottom)
          }});
          setTimeout(() => { el._wasDragged = false; }, 50);
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // ── 選字彈出按鈕 ──
  document.addEventListener("mouseup", (e) => {
    const group = document.getElementById("ai-launcher-group");
    if (group && group.contains(e.target)) return;
    if (panel  && panel.contains(e.target)) return;
    setTimeout(() => {
      const sel  = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (text.length > 2) { selectedText = text; showSelectionBtn(e.clientX, e.clientY); }
      else hideSelectionBtn();
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (selectionBtn && !selectionBtn.contains(e.target)) hideSelectionBtn();
    if (launcherMenu  && !launcherMenu.contains(e.target)) closeLauncherMenu();
  });

  function showSelectionBtn(x, y) {
    chrome.storage.local.get(["enabled"], (data) => {
      if (data.enabled === false) return;
      hideSelectionBtn();
      selectionBtn = document.createElement("button");
      selectionBtn.id = "ai-selection-btn";
      selectionBtn.innerHTML = "✦ AI";
      selectionBtn.style.left = `${x + window.scrollX + 8}px`;
      selectionBtn.style.top  = `${y + window.scrollY - 36}px`;
      selectionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        hideSelectionBtn();
        openPanel(selectedText);
      });
      document.body.appendChild(selectionBtn);
    });
  }

  function hideSelectionBtn() {
    if (selectionBtn) { selectionBtn.remove(); selectionBtn = null; }
  }

  // ── 對話面板 ──
  function openPanel(text) {
    try { if (panel) panel.remove(); } catch(_) {}
    messages = [];

    panel = document.createElement("div");
    panel.id = "ai-assistant-panel";

    const group = document.getElementById("ai-launcher-group");
    if (group) {
      panel.style.right  = (parseInt(group.style.right)  || 24) + "px";
      panel.style.bottom = (parseInt(group.style.bottom) || 24) + 100 + "px";
    }

    const contextHtml = text
      ? `<div class="ai-context-box">${escHtml(text)}</div>
         <div class="ai-quick-btns">
           <button class="ai-quick-btn" data-prompt="解釋這段文字">💡 解釋</button>
           <button class="ai-quick-btn" data-prompt="將這段文字翻譯成繁體中文">🌐 翻譯</button>
           <button class="ai-quick-btn" data-prompt="幫我摘要這段文字的重點">📝 摘要</button>
           <button class="ai-quick-btn" data-prompt="分析這段文字並提供看法">🔍 分析</button>
         </div>` : "";

    panel.innerHTML = `
      <div class="ai-panel-header">
        <div class="ai-panel-title">Assistant</div>
        <button class="ai-history-btn" title="答題記錄">📋</button>
        <button class="ai-panel-close">×</button>
      </div>
      ${contextHtml}
      <div class="ai-messages"></div>
      <div class="ai-input-row">
        <textarea class="ai-input" placeholder="type..." rows="1"></textarea>
        <button class="ai-send-btn">↑</button>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector(".ai-panel-close").addEventListener("click", closePanel);
    panel.querySelector(".ai-history-btn").addEventListener("click", showHistory);

    function onEscPanel(e) {
      if (e.key === "Escape") { closePanel(); document.removeEventListener("keydown", onEscPanel); }
    }
    document.addEventListener("keydown", onEscPanel);

    function closePanel() {
      document.removeEventListener("keydown", onEscPanel);
      pendingScreenshot = null;
      try { if (panel) { panel.remove(); panel = null; } } catch(_) { panel = null; }
    }
    panel.querySelectorAll(".ai-quick-btn").forEach((btn) => {
      btn.addEventListener("click", () => sendMessage(btn.dataset.prompt, text));
    });

    const input = panel.querySelector(".ai-input");
    panel.querySelector(".ai-send-btn").addEventListener("click", () => submitInput());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitInput(); }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 80) + "px";
    });

    function submitInput() {
      const val = input.value.trim();
      if (isLoading) return;
      if (!val && !pendingScreenshot) return;
      input.value = ""; input.style.height = "auto";
      input.placeholder = "type...";
      if (pendingScreenshot) {
        const question = val || "請描述這張截圖的內容";
        const imgData = pendingScreenshot;
        pendingScreenshot = null;
        appendMsg("user", question);
        sendImageWithQuestion(imgData, question);
      } else {
        sendMessage(val, null);
      }
    }
    input.focus();
  }

  // ── 呼叫 Claude（文字） ──
  function sendMessage(userPrompt, context) {
    if (isLoading) return;
    chrome.storage.local.get(["mode","webProvider","provider","claudeKey","openaiKey","geminiKey","claudeModel","openaiModel","geminiModel"], async (data) => {
      const { provider, apiKey, model } = resolveProviderConfig(data);
      if (!apiKey) { appendMsg("assistant", "⚠️ 請先設定 API Key"); return; }

      const fullPrompt = context
        ? `以下是使用者選取的文字：\n\n「${context}」\n\n使用者的請求：${userPrompt}`
        : userPrompt;

      messages.push({ role: "user", content: fullPrompt });
      appendMsg("user", userPrompt);

      isLoading = true; updateSendBtn(true);
      const loadingEl = appendMsg("loading", `<div class="ai-dots"><span></span><span></span><span></span></div>`);

      try {
        const res = await callLLM(provider, apiKey, model, messages,
          "你是一個極度精簡的 AI 助手。只給答案，不解釋、不廢話、不反問、不使用 emoji。能一句話就一句話。使用繁體中文。");
        loadingEl?.remove();
        if (res.error) { appendMsg("assistant", `⚠️ ${res.error}`); messages.pop(); }
        else { messages.push({ role: "assistant", content: res.text }); appendMsg("assistant", res.text); }
      } catch (e) {
        loadingEl?.remove(); appendMsg("assistant", `⚠️ ${e.message}`); messages.pop();
      } finally { isLoading = false; updateSendBtn(false); }
    });
  }

  // ── 截圖 + 問題 ──
  function sendImageWithQuestion(base64, question) {
    isLoading = true; updateSendBtn(true);
    const loadingEl = appendMsg("loading", `<div class="ai-dots"><span></span><span></span><span></span></div>`);
    chrome.storage.local.get(["mode","webProvider","provider","claudeKey","openaiKey","geminiKey","claudeModel","openaiModel","geminiModel"], async (data) => {
      const { provider, apiKey, model } = resolveProviderConfig(data);
      if (!apiKey) { loadingEl?.remove(); isLoading = false; updateSendBtn(false); appendMsg("assistant", "⚠️ 請先設定 API Key"); return; }
      if (provider === "gemini-web") {
        loadingEl?.remove(); isLoading = false; updateSendBtn(false);
        appendMsg("assistant", "⚠️ Gemini 帳號模式不支援截圖。請到設定改用 Gemini API Key（免費申請：aistudio.google.com）");
        return;
      }
      try {
        const res = await callLLM(provider, apiKey, model, [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
            { type: "text", text: question }
          ]
        }], "你是一個極度精簡的 AI 助手。只給答案，不解釋、不廢話、不反問、不使用 emoji。使用繁體中文。", 256);
        loadingEl?.remove();
        if (res.error) appendMsg("assistant", `⚠️ ${res.error}`);
        else appendMsg("assistant", res.text);
      } catch(e) { loadingEl?.remove(); appendMsg("assistant", `⚠️ ${e.message}`); }
      finally { isLoading = false; updateSendBtn(false); }
    });
  }

  // ── 🎯 自動答題 ──
  function autoAnswer() {
    if (isLoading) return;
    isLoading = true;
    if (!panel) openPanel("");

    // 先找所有 radio/checkbox 群組（每題一個 name）
    const groups = findAllRadioGroups();

    if (groups.length > 1) {
      // 多題模式：批量作答
      appendMsg("assistant", `偵測到 ${groups.length} 道題目，批量作答中…`);
      answerMultipleGroups(groups);
      isLoading = false; updateSendBtn(false);
      return;
    }

    // 單題模式（radio / 或 div 按鈕式）
    const { options, type } = groups.length === 1
      ? { options: groups[0].options, type: groups[0].type }
      : detectQuizOptions();

    if (options.length === 0) {
      appendMsg("assistant", "找不到選擇題，請確認頁面上有題目。");
      isLoading = false; updateSendBtn(false);
      return;
    }

    const context = getQuizContext(options);
    appendMsg("assistant", "偵測題目中…");

    isLoading = true; updateSendBtn(true);
    chrome.storage.local.get(["mode","webProvider","provider","claudeKey","openaiKey","geminiKey","claudeModel","openaiModel","geminiModel"], async (data) => {
      const { provider, apiKey, model } = resolveProviderConfig(data);
      if (!apiKey) { appendMsg("assistant", "⚠️ 請先設定 API Key"); isLoading = false; updateSendBtn(false); return; }

      try {
        const maxLetter = options[options.length - 1]?.letter || "D";
        const res = await callLLM(provider, apiKey, model,
          [{ role: "user", content: context }],
          `以下是一道選擇題，只回答正確選項的字母（A 到 ${maxLetter}），不加任何其他文字。`, 5);

        if (res.error) { appendMsg("assistant", `⚠️ ${res.error}`); return; }

        const answer = res.text.trim();
        const matched = matchAnswer(answer, options);

        if (matched) {
          if (type === "radio" || type === "checkbox") {
            options.forEach(o => { o.el.checked = false; });
            matched.el.checked = true;
            matched.el.click();
            matched.el.dispatchEvent(new Event("change", { bubbles: true }));
            highlightAnswer(matched.el);
          } else {
            matched.el.click();
            matched.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            matched.el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
            highlightClickable(matched.el);
          }
          appendMsg("success", `已選：${matched.letter}. ${matched.text}`);
          saveHistory(context, `${matched.letter}. ${matched.text}`);
          chrome.storage.local.get(["autoMode"], (modeData) => {
            if (modeData.autoMode) {
              setTimeout(() => {
                if (clickNextQuestion()) {
                  appendMsg("assistant", "➡️ 下一題…");
                  setTimeout(() => {
                    chrome.storage.local.get(["autoMode"], (d) => { if (d.autoMode) autoAnswer(); });
                  }, 2000);
                }
              }, 1500);
            }
          });
        } else {
          appendMsg("assistant", `AI 建議：${answer}（無法自動選取）`);
        }
      } catch (e) {
        appendMsg("assistant", `⚠️ ${e.message}`);
      } finally {
        isLoading = false; updateSendBtn(false);
      }
    });
  }

  // 找頁面所有 radio/checkbox 群組（按 name 屬性分組）
  function findAllRadioGroups() {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]:not([disabled])'));
    const checks = Array.from(document.querySelectorAll('input[type="checkbox"]:not([disabled])'));
    const inputs = radios.length > 0 ? radios : checks;
    const type   = radios.length > 0 ? "radio" : "checkbox";
    if (inputs.length === 0) return [];

    const groupMap = new Map();
    inputs.forEach(inp => {
      const key = inp.name || inp.closest("fieldset")?.id || "unnamed";
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(inp);
    });

    return Array.from(groupMap.values())
      .filter(g => g.length >= 2)
      .map(g => ({
        type,
        options: g.map((el, i) => ({
          el,
          letter: String.fromCharCode(65 + i),
          text: getLabelText(el) || el.value || `選項${i + 1}`
        })),
        questionText: findQuestionText(g[0])
      }));
  }

  // 批量作答多道題
  function answerMultipleGroups(groups) {
    chrome.storage.local.get(["mode","webProvider","provider","claudeKey","openaiKey","geminiKey","claudeModel","openaiModel","geminiModel"], async (data) => {
      const { provider, apiKey, model } = resolveProviderConfig(data);
      if (!apiKey) { appendMsg("assistant", "⚠️ 請先設定 API Key"); return; }

      const loadingEl = appendMsg("loading", `<div class="ai-dots"><span></span><span></span><span></span></div>`);

      try {
        // 組合所有題目進一個 prompt
        const prompt = groups.map((g, i) => {
          const q = g.questionText || `題目 ${i + 1}`;
          const opts = g.options.map(o => `${o.letter}. ${o.text}`).join("\n");
          return `[${i + 1}] ${q}\n${opts}`;
        }).join("\n\n");

        const res = await callLLM(provider, apiKey, model,
          [{ role: "user", content: prompt }],
          `以下是 ${groups.length} 道選擇題，依序只回答每題正確選項的字母，用逗號分隔（例如 B,D,A,C）。每題字母範圍依該題選項數而定，不加任何其他文字。`,
          groups.length * 5 + 10);

        loadingEl?.remove();
        if (res.error) { appendMsg("assistant", `⚠️ ${res.error}`); return; }

        // 解析答案:抓獨立單字母 token(支援 A-Z,不再卡 A-D;忽略散文)。
        // 合法字母集 = 各題選項數的聯集(最多選項的那題決定上界)
        const maxOpts = Math.max(...groups.map(g => g.options.length));
        const validLetters = Array.from({ length: maxOpts }, (_, i) => String.fromCharCode(65 + i));
        const letters = extractAnswerLetters(res.text, validLetters);
        let done = 0;
        groups.forEach((g, i) => {
          const letter = letters[i];
          if (!letter) return;
          const matched = g.options.find(o => o.letter === letter);
          if (!matched) return;
          g.options.forEach(o => { o.el.checked = false; });
          matched.el.checked = true;
          matched.el.click();
          matched.el.dispatchEvent(new Event("change", { bubbles: true }));
          highlightAnswer(matched.el);
          done++;
        });

        appendMsg("success", `已完成 ${done}/${groups.length} 題`);
        saveHistory(`批量答題 ${groups.length} 題`, `完成 ${done}/${groups.length}`);
      } catch (e) {
        loadingEl?.remove();
        appendMsg("assistant", `⚠️ ${e.message}`);
      }
    });
  }

  // 抓選項附近的完整文字（含題目）
  function getQuizContext(options) {
    // 找包含所有選項的最小共同祖先
    let container = options[0].el;
    while (container && container !== document.body) {
      if (options.every(o => container.contains(o.el))) break;
      container = container.parentElement;
    }
    // 再往上兩層，確保包含題目文字
    let ctx = container?.parentElement?.parentElement
           || container?.parentElement
           || container;
    const text = (ctx?.innerText || "").trim().slice(0, 1200);
    return text || options.map(o => `${o.letter}. ${o.text}`).join("\n");
  }

  // 偵測頁面上的選擇題選項（支援 radio/checkbox 和 div/button 式）
  function detectQuizOptions() {
    // 1. radio / checkbox
    const radios = Array.from(document.querySelectorAll('input[type="radio"]:not([disabled])'));
    const checks = Array.from(document.querySelectorAll('input[type="checkbox"]:not([disabled])'));
    if (radios.length > 0) {
      return { type: "radio", questionEl: null, options: radios.map((el, i) => ({
        el, letter: String.fromCharCode(65 + i),
        text: getLabelText(el) || el.value || `選項${i + 1}`
      }))};
    }
    if (checks.length > 0) {
      return { type: "checkbox", questionEl: null, options: checks.map((el, i) => ({
        el, letter: String.fromCharCode(65 + i),
        text: getLabelText(el) || el.value || `選項${i + 1}`
      }))};
    }

    // 2. div/button 含 A./B./C./D. 開頭的文字
    const raw = Array.from(document.querySelectorAll(
      'li, button, [role="button"], [class*="choice"], [class*="option"], [class*="answer"], [class*="item"], div'
    )).filter(el => {
      if (el.querySelector('input')) return false;
      const text = (el.innerText || "").trim();
      return /^[A-D][.、\s]/.test(text) && text.length < 200;
    });
    // 去掉包含其他候選元素的父容器，只保留最內層
    const candidates = raw.filter(el => !raw.some(other => other !== el && el.contains(other)));

    if (candidates.length >= 2) {
      // 每個字母只保留一個（去重）
      const seen = new Set();
      const options = candidates.filter(el => {
        const letter = (el.innerText || "").trim()[0].toUpperCase();
        if (seen.has(letter)) return false;
        seen.add(letter); return true;
      }).slice(0, 6).map(el => {
        const text = (el.innerText || "").trim();
        const letter = text[0].toUpperCase();
        const body = text.replace(/^[A-D][.、\s]+/, "").trim();
        return { el, letter, text: body };
      });
      return { type: "clickable", questionEl: null, options };
    }

    return { type: null, questionEl: null, options: [] };
  }

  function clickNextQuestion() {
    const namedNext = document.querySelector('[name="next"], .mod_quiz-next-nav');
    if (namedNext && !namedNext.disabled) { namedNext.click(); return true; }

    const keywords = ["next page", "next", "continue", "繼續", "下一題", "下一頁", "następna strona", "następna"];
    const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"], a[href]'));
    for (const kw of keywords) {
      const btn = allBtns.find(el => {
        const text = (el.innerText || el.value || "").toLowerCase().trim();
        return text === kw || text.startsWith(kw);
      });
      if (btn && !btn.disabled) { btn.click(); return true; }
    }
    return false;
  }

  function highlightClickable(el) {
    const prev = el.style.cssText;
    el.style.cssText += ";outline:2px solid #22c55e !important;background:#f0fdf4 !important;border-radius:4px;";
    setTimeout(() => { el.style.cssText = prev; }, 3000);
  }

  function getLabelText(input) {
    // 方法1：for 屬性
    if (input.id) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      if (label) return label.innerText.trim();
    }
    // 方法2：包在 label 裡
    const parentLabel = input.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll("input").forEach(el => el.remove());
      return clone.innerText.trim();
    }
    // 方法3：下一個兄弟元素
    const next = input.nextElementSibling;
    if (next) return next.innerText.trim();
    // 方法4：旁邊的文字節點
    const nextNode = input.nextSibling;
    if (nextNode && nextNode.nodeType === Node.TEXT_NODE) return nextNode.textContent.trim();
    return "";
  }

  function findQuestionText(firstInput) {
    // Kampus 常見的題目容器
    const kampusSelectors = [
      ".question-text", ".quiz-question-text", ".question-body",
      "[class*='question'][class*='text']", "[class*='question'][class*='title']",
      "[class*='quiz'][class*='question']", ".q-text", ".stem",
      "h1", "h2", "h3", "h4", "h5",
    ];

    for (const sel of kampusSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 5) return el.innerText.trim();
    }

    // 往上找父元素，取最近有實質文字的容器
    let el = firstInput.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!el || el === document.body) break;
      // 取出非 input/label 子元素的文字
      for (const child of el.children) {
        if (!["INPUT","LABEL","BUTTON","SELECT"].includes(child.tagName)) {
          const t = child.innerText?.trim();
          if (t && t.length > 8) return t;
        }
      }
      el = el.parentElement;
    }
    return "";
  }

  // 從 AI 回應抽出答案字母(可含雜訊散文)。抓「獨立單字母 token」並只保留
  // 屬於合法選項的字母——這樣散文裡的 "I"(我)、"A"(冠詞)不會誤判,除非該題
  // 真的有到 I/A 那麼多選項。"B,D,A"→[B,D,A];"答案是 B 因為…"→[B];
  // "I think it should be D"(選項A-D)→[D]。支援 A-Z,不再卡 A-D。
  function extractAnswerLetters(text, validLetters) {
    const valid = new Set(validLetters || []);
    const tokens = (text || "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
    let singles = tokens.filter(t => t.length === 1);
    if (valid.size) singles = singles.filter(t => valid.has(t));
    if (singles.length) return singles;
    // fallback:退回原始字母掃描(同樣過濾合法字母)
    let all = (text || "").toUpperCase().match(/[A-Z]/g) || [];
    if (valid.size) all = all.filter(t => valid.has(t));
    return all;
  }

  function matchAnswer(answer, options) {
    // 直接字母匹配——只認屬於本題選項的獨立字母
    const validLetters = options.map(o => o.letter);
    const letters = extractAnswerLetters(answer, validLetters);
    for (const L of letters) {
      const opt = options.find(o => o.letter === L);
      if (opt) return opt;
    }
    const a = answer.toUpperCase().trim();

    // 內容匹配
    const aLower = answer.toLowerCase();
    for (const opt of options) {
      if (opt.text.toLowerCase().includes(aLower) || aLower.includes(opt.text.toLowerCase())) {
        return opt;
      }
    }

    // 詞彙相似度
    const aWords = aLower.split(/\s+/);
    let best = null, bestScore = 0;
    for (const opt of options) {
      const score = opt.text.toLowerCase().split(/\s+/).filter(w => aWords.includes(w)).length;
      if (score > bestScore) { bestScore = score; best = opt; }
    }
    return bestScore > 0 ? best : null;
  }

  function highlightAnswer(input) {
    // 找到對應的 label，加上短暫的綠色高亮
    let target = null;
    if (input.id) target = document.querySelector(`label[for="${input.id}"]`);
    if (!target) target = input.closest("label");
    if (!target) target = input.parentElement;
    if (!target) return;

    const prev = target.style.cssText;
    target.style.cssText += ";outline:2px solid #22c55e !important;background:#f0fdf4 !important;border-radius:4px;";
    setTimeout(() => { target.style.cssText = prev; }, 3000);
  }

  // ── 答題記錄 ──
  function saveHistory(question, answer) {
    chrome.storage.local.get(["answerHistory"], (data) => {
      const history = data.answerHistory || [];
      history.unshift({
        q: question.slice(0, 300),
        a: answer,
        site: location.hostname,
        time: new Date().toLocaleString("zh-TW"),
      });
      chrome.storage.local.set({ answerHistory: history.slice(0, 50) });
    });
  }

  function showHistory() {
    const container = panel?.querySelector(".ai-messages");
    if (!container) return;
    chrome.storage.local.get(["answerHistory"], (data) => {
      const history = data.answerHistory || [];
      container.innerHTML = "";
      if (history.length === 0) {
        const el = document.createElement("div");
        el.className = "ai-msg assistant";
        el.textContent = "尚無答題記錄";
        container.appendChild(el);
        return;
      }
      history.slice(0, 20).forEach((item) => {
        const el = document.createElement("div");
        el.className = "ai-msg assistant";
        el.innerHTML = `<span style="font-size:10px;color:#aaa">${item.time} · ${item.site}</span><br>${escHtml(item.q)}<br><strong style="color:#16a34a">${escHtml(item.a)}</strong>`;
        container.appendChild(el);
      });
      container.scrollTop = 0;
    });
  }

  // ── 共用 Claude API ──
  async function callLLM(provider, apiKey, model, msgs, system, maxTokens = 512) {
    // 帳號登入模式
    if (["chatgpt-web","claude-web","gemini-web"].includes(provider)) {
      const lastMsg = msgs[msgs.length - 1];
      const prompt = typeof lastMsg.content === "string" ? lastMsg.content : lastMsg.content?.find?.(c => c.type === "text")?.text || "";
      const imageBase64 = typeof lastMsg.content !== "string" ? lastMsg.content?.find?.(c => c.type === "image")?.source?.data || null : null;
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "call-web-llm", provider, prompt, imageBase64 }, (res) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (res?.error) reject(new Error(res.error));
          else resolve({ text: res?.text || "" });
        });
      });
    }
    if (provider === "openai") {
      const openaiMsgs = [{ role: "system", content: system }, ...msgs.map(m => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.map(c => c.type === "image"
            ? { type: "image_url", image_url: { url: `data:image/jpeg;base64,${c.source.data}` } }
            : { type: "text", text: c.text })
          : m.content
      }))];
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || DEFAULT_MODELS.openai, max_tokens: maxTokens, messages: openaiMsgs })
      });
      if (!res.ok) { const e = await res.json().catch(()=>({})); return { error: e?.error?.message || `HTTP ${res.status}` }; }
      const d = await res.json();
      return { text: d.choices?.[0]?.message?.content || "" };
    }

    if (provider === "gemini") {
      const geminiContents = msgs.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: Array.isArray(m.content)
          ? m.content.map(c => c.type === "image"
            ? { inlineData: { mimeType: "image/png", data: c.source.data } }
            : { text: c.text })
          : [{ text: m.content }]
      }));
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || DEFAULT_MODELS.gemini}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: geminiContents,
          generationConfig: { maxOutputTokens: maxTokens }
        })
      });
      if (!res.ok) { const e = await res.json().catch(()=>({})); return { error: e?.error?.message || `HTTP ${res.status}` }; }
      const d = await res.json();
      return { text: d.candidates?.[0]?.content?.parts?.[0]?.text || "" };
    }

    // Claude (default) — 529 overloaded 自動重試最多 3 次
    const claudeBody = JSON.stringify({ model: model || DEFAULT_MODELS.claude, max_tokens: maxTokens, system, messages: msgs });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: claudeBody,
      });
      if (res.status === 529 && attempt < 2) continue;
      if (!res.ok) { const e = await res.json().catch(()=>({})); return { error: e?.error?.message || `HTTP ${res.status}` }; }
      const d = await res.json();
      return { text: d.content?.[0]?.text || "" };
    }
  }

  // ── 截圖 ──
  function startScreenshotCapture() {
    const overlay = document.createElement("div");
    overlay.id = "ai-screenshot-overlay";
    const tip = document.createElement("div");
    tip.id = "ai-screenshot-tip";
    tip.textContent = "拖曳選取要詢問的區域　Esc 取消";
    const selBox = document.createElement("div");
    selBox.id = "ai-screenshot-selection";
    selBox.style.display = "none";

    document.body.appendChild(overlay);
    document.body.appendChild(tip);
    document.body.appendChild(selBox);

    let startX, startY, dragging = false;

    function cleanup() { overlay.remove(); tip.remove(); selBox.remove(); }

    overlay.addEventListener("mousedown", (e) => {
      dragging = true; startX = e.clientX; startY = e.clientY;
      tip.style.display = "none"; selBox.style.display = "block";
      selBox.style.left = startX + "px"; selBox.style.top = startY + "px";
      selBox.style.width = "0"; selBox.style.height = "0";
    });
    overlay.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const x = Math.min(e.clientX, startX), y = Math.min(e.clientY, startY);
      selBox.style.left = x + "px"; selBox.style.top = y + "px";
      selBox.style.width  = Math.abs(e.clientX - startX) + "px";
      selBox.style.height = Math.abs(e.clientY - startY) + "px";
    });
    overlay.addEventListener("mouseup", (e) => {
      if (!dragging) return; dragging = false;
      const x = Math.min(e.clientX, startX), y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
      cleanup();
      if (w < 10 || h < 10) return;
      captureRegion(x, y, w, h);
    });
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { cleanup(); document.removeEventListener("keydown", onEsc); }
    });
  }

  function captureRegion(x, y, w, h) {
    chrome.runtime.sendMessage({ type: "capture-screenshot" }, (res) => {
      if (chrome.runtime.lastError || !res || res.error) {
        if (!panel) openPanel("");
        appendMsg("assistant", "⚠️ 截圖失敗：" + (chrome.runtime.lastError?.message || res?.error || "未知錯誤"));
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const dpr = window.devicePixelRatio || 1;
          // 先裁切
          const cropCanvas = document.createElement("canvas");
          cropCanvas.width = w * dpr; cropCanvas.height = h * dpr;
          cropCanvas.getContext("2d").drawImage(img, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, w * dpr, h * dpr);
          // 壓縮至最長邊 1000px
          const maxSide = 1000;
          const sw = cropCanvas.width, sh = cropCanvas.height;
          const ratio = Math.min(maxSide / sw, maxSide / sh, 1);
          const ow = Math.round(sw * ratio), oh = Math.round(sh * ratio);
          const outCanvas = document.createElement("canvas");
          outCanvas.width = ow; outCanvas.height = oh;
          outCanvas.getContext("2d").drawImage(cropCanvas, 0, 0, sw, sh, 0, 0, ow, oh);
          sendScreenshotToAI(outCanvas.toDataURL("image/jpeg", 0.85));
        } catch(e) {
          if (!panel) openPanel("");
          appendMsg("assistant", "⚠️ 截圖處理失敗：" + e.message);
        }
      };
      img.src = res.dataUrl;
    });
  }

  function sendScreenshotToAI(dataUrl) {
    if (!panel) openPanel("");
    const base64 = dataUrl.replace(/^data:image\/(png|jpeg);base64,/, "");
    sendImageWithQuestion(base64, "這張截圖如果有選擇題請只回答正確選項的字母，否則請描述截圖內容。");
  }

  // ── 工具函式 ──
  function appendMsg(type, html) {
    const container = panel?.querySelector(".ai-messages");
    if (!container) return null;
    const el = document.createElement("div");
    el.className = `ai-msg ${type}`;
    if (type === "loading") el.innerHTML = html;
    else el.textContent = html;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function updateSendBtn(disabled) {
    const btn = panel?.querySelector(".ai-send-btn");
    if (btn) btn.disabled = disabled;
  }

  function resolveProviderConfig(data) {
    if (data.mode === "web") {
      return { provider: data.webProvider || "chatgpt-web", apiKey: "web", model: "" };
    }
    const provider = data.provider || "claude";
    const keyMap   = { claude: data.claudeKey, openai: data.openaiKey, gemini: data.geminiKey };
    const modelMap = { claude: data.claudeModel, openai: data.openaiModel, gemini: data.geminiModel };
    return { provider, apiKey: keyMap[provider] || "", model: modelMap[provider] || "" };
  }

  function escHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── 鍵盤快捷鍵 ──
  document.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;

    if (e.code === "KeyA") {
      e.preventDefault();
      chrome.storage.local.get(["enabled"], (data) => {
        if (data.enabled === false) return;
        autoAnswer();
      });
    } else if (e.code === "KeyS") {
      e.preventDefault();
      chrome.storage.local.get(["enabled"], (data) => {
        if (data.enabled === false) return;
        startScreenshotCapture();
      });
    } else if (e.code === "Space") {
      e.preventDefault();
      chrome.storage.local.get(["enabled"], (data) => {
        if (data.enabled === false) return;
        if (panel) { panel.remove(); panel = null; }
        else openPanel(selectedText);
      });
    } else if (e.code === "KeyH") {
      e.preventDefault();
      chrome.storage.local.get(["enabled"], (data) => {
        if (data.enabled === false) return;
        const group = document.getElementById("ai-launcher-group");
        if (!group) return;
        if (group.classList.contains("hidden")) {
          group.classList.remove("hidden");
          chrome.storage.local.set({ launcherHidden: false });
          document.getElementById("ai-reveal-hint")?.remove();
        } else {
          hideLauncher();
        }
      });
    }
  });

  // ── 啟動 ──
  initLauncher();
})();
