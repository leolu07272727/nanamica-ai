// claude.ai 內部 API 的 model 字串——平台淘汰時只改這裡;若請求失敗會自動
// 改用「不帶 model」重試一次(讓伺服器用預設模型),所以就算過期也不會全死。
const CLAUDE_WEB_MODEL = "claude-opus-4-5";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "capture-screenshot") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
      else sendResponse({ dataUrl });
    });
    return true;
  }

  if (msg.type === "call-web-llm") {
    handleWebLLM(msg.provider, msg.prompt, msg.imageBase64)
      .then(text => sendResponse({ text }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

async function handleWebLLM(provider, prompt, imageBase64) {
  if (provider === "chatgpt-web") return callChatGPTWeb(prompt, imageBase64);
  if (provider === "claude-web")  return callClaudeWeb(prompt, imageBase64);
  if (provider === "gemini-web")  return callGeminiWeb(prompt, imageBase64);
  throw new Error("未知的 provider");
}

// ── 找到或開啟指定平台的分頁 ──
async function getOrOpenTab(url, matchPattern) {
  const tabs = await chrome.tabs.query({ url: matchPattern });
  if (tabs.length > 0) return tabs[0].id;
  const tab = await chrome.tabs.create({ url, active: false });
  // 等頁面載入
  await new Promise(resolve => {
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
  return tab.id;
}

// ── ChatGPT Web ──
async function callChatGPTWeb(prompt, imageBase64) {
  const tabId = await getOrOpenTab("https://chatgpt.com", "https://chatgpt.com/*");

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (prompt, imageBase64) => {
      try {
        const sessionRes = await fetch("/api/auth/session");
        const session = await sessionRes.json();
        const token = session.accessToken;
        if (!token) return { error: "請先登入 ChatGPT" };

        const userContent = imageBase64
          ? [
              { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
              { type: "text", text: prompt }
            ]
          : prompt;

        const body = {
          action: "next",
          messages: [{
            id: crypto.randomUUID(),
            author: { role: "user" },
            content: typeof userContent === "string"
              ? { content_type: "text", parts: [userContent] }
              : { content_type: "multimodal_text", parts: userContent },
            metadata: {}
          }],
          parent_message_id: crypto.randomUUID(),
          model: "auto",
          timezone_offset_min: new Date().getTimezoneOffset(),
          history_and_training_disabled: true,
          conversation_mode: { kind: "primary_assistant" },
          force_use_sse: true
        };

        const res = await fetch("/backend-api/conversation", {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let last = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value).split("\n")) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const d = JSON.parse(line.slice(6));
                if (d.message?.author?.role === "assistant") {
                  last = d.message.content.parts?.join("") || last;
                }
              } catch {}
            }
          }
        }
        return { text: last };
      } catch (e) { return { error: e.message }; }
    },
    args: [prompt, imageBase64 || null]
  });

  const r = results?.[0]?.result;
  if (!r) throw new Error("無回應");
  if (r.error) throw new Error(r.error);
  return r.text;
}

// ── Claude.ai Web ──
async function callClaudeWeb(prompt, imageBase64) {
  const tabId = await getOrOpenTab("https://claude.ai", "https://claude.ai/*");

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (prompt, imageBase64, webModel) => {
      try {
        const orgsRes = await fetch("/api/organizations");
        const orgs = await orgsRes.json();
        const orgId = orgs?.[0]?.uuid;
        if (!orgId) return { error: "請先登入 Claude.ai" };

        const convRes = await fetch(`/api/organizations/${orgId}/chat_conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "", uuid: crypto.randomUUID() })
        });
        const conv = await convRes.json();
        const convId = conv.uuid;

        if (imageBase64) return { error: "Claude 帳號模式不支援截圖，請改用 Claude API Key 模式" };

        const compUrl = `/api/organizations/${orgId}/chat_conversations/${convId}/completion`;
        const mkBody = (withModel) => JSON.stringify({
          prompt: prompt,
          attachments: [],
          files: [],
          max_tokens_to_sample: 512,
          ...(withModel ? { model: webModel } : {}),
          rendering_mode: "raw",
          stream: true
        });
        let compRes = await fetch(compUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: mkBody(true)
        });
        // model 字串過期(平台淘汰)時,不帶 model 重試讓伺服器用預設
        if (!compRes.ok) {
          compRes = await fetch(compUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: mkBody(false)
          });
          if (!compRes.ok) return { error: `Claude web HTTP ${compRes.status}(可能是 model 字串過期,見 background.js 頂部)` };
        }

        const reader = compRes.body.getReader();
        const decoder = new TextDecoder();
        let last = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value).split("\n")) {
            if (line.startsWith("data:")) {
              try {
                const d = JSON.parse(line.slice(5).trim());
                if (d.type === "content_block_delta") last += d.delta?.text || "";
                if (d.completion) last = d.completion;
              } catch {}
            }
          }
        }
        return { text: last };
      } catch (e) { return { error: e.message }; }
    },
    args: [prompt, imageBase64 || null, CLAUDE_WEB_MODEL]
  });

  const r = results?.[0]?.result;
  if (!r) throw new Error("無回應");
  if (r.error) throw new Error(r.error);
  return r.text;
}

// ── Gemini Web ──
async function callGeminiWeb(prompt, imageBase64) {
  const tabId = await getOrOpenTab("https://gemini.google.com", "https://gemini.google.com/*");

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (prompt) => {
      // Gemini web 用注入方式觸發輸入框
      try {
        const input = document.querySelector("rich-textarea p, .ql-editor p, textarea");
        if (!input) return { error: "找不到輸入框，請確認已登入 Gemini" };

        // 設定文字
        input.focus();
        document.execCommand("insertText", false, prompt);

        // 送出
        await new Promise(r => setTimeout(r, 500));
        const sendBtn = document.querySelector('[aria-label="Send message"], button[data-test-id="send-button"], .send-button');
        if (sendBtn) sendBtn.click();

        // 等待回應:輪詢到內容「連續兩次不變」= 生成完成(固定 4 秒對長回答
        // 會截斷、對短回答浪費時間;最多等 30 秒)
        const readLast = () => {
          const msgs = document.querySelectorAll("message-content, .response-content, model-response .markdown");
          return msgs[msgs.length - 1]?.innerText?.trim() || "";
        };
        let prev = "", stable = 0;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const cur = readLast();
          if (cur && cur === prev) {
            stable++;
            if (stable >= 2) break;
          } else {
            stable = 0;
          }
          prev = cur;
        }
        const finalText = readLast();
        if (!finalText) return { error: "等不到 Gemini 回應(可能 UI 改版,檢查選擇器)" };
        return { text: finalText };
      } catch (e) { return { error: e.message }; }
    },
    args: [prompt]
  });

  const r = results?.[0]?.result;
  if (!r) throw new Error("無回應");
  if (r.error) throw new Error(r.error);
  return r.text;
}
