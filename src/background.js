const OFFSCREEN_PATH = "offscreen.html";
let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA", "WORKERS"],
      justification: "Recognize YouTube speech locally when transcript data is unavailable.",
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function setAudioState(state) {
  await chrome.storage.session.set({ youtubeSignAudioState: state });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return false;

  (async () => {
    if (message.type === "asr-start") {
      await ensureOffscreen();
      const tabId = message.tabId || sender.tab?.id;
      await setAudioState({ active: true, tabId, status: "Preparing video speech recognition" });
      chrome.runtime.sendMessage({ ...message, tabId, target: "offscreen" });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "asr-query") {
      const stored = await chrome.storage.session.get("youtubeSignAudioState");
      const state = stored.youtubeSignAudioState || { active: false };
      const tabId = message.tabId || sender.tab?.id;
      sendResponse({
        ok: true,
        active: Boolean(state.active && tabId && state.tabId === tabId),
        status: state.status || "",
      });
      return;
    }
    if (message.type === "asr-enable" || message.type === "asr-disable") {
      const tabId = message.tabId || sender.tab?.id;
      chrome.runtime.sendMessage({ ...message, tabId, target: "offscreen" });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "asr-stop") {
      chrome.runtime.sendMessage({ type: "asr-stop", target: "offscreen", tabId: message.tabId });
      await setAudioState({ active: false, tabId: message.tabId || sender.tab?.id, status: "Speech recognition stopped" });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "asr-status" || message.type === "asr-transcript") {
      const state = {
        active: message.active !== false,
        tabId: message.tabId,
        status: message.status || "Recognizing video speech",
      };
      await setAudioState(state);
      if (message.tabId) {
        chrome.tabs.sendMessage(message.tabId, message).catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "Unknown background message" });
  })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
