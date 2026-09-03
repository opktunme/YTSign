const defaults = { signedLanguage: "pks", enabled: false, size: "medium", appearance: "avatar", settingsVersion: 5 };
const language = document.getElementById("language");
const size = document.getElementById("size");
const enabled = document.getElementById("enabled");
const saved = document.getElementById("saved");
let settings = { ...defaults };

function render() {
  language.value = settings.signedLanguage;
  size.value = settings.size;
  settings.appearance = "avatar";
  enabled.textContent = settings.enabled ? "Disable on YouTube" : "Enable on YouTube";
  enabled.classList.toggle("on", settings.enabled);
}

function save(message = "Saved — refresh an open YouTube tab if needed") {
  chrome.storage.local.set({ youtubeSignSettings: settings }, () => {
    saved.textContent = message;
    setTimeout(() => { saved.textContent = ""; }, 2200);
  });
  render();
}

chrome.storage.local.get("youtubeSignSettings", (result) => {
  const savedSettings = result.youtubeSignSettings || {};
  settings = savedSettings.settingsVersion === defaults.settingsVersion
    ? { ...defaults, ...savedSettings }
    : { ...defaults, ...savedSettings, signedLanguage: "pks", enabled: false, settingsVersion: defaults.settingsVersion };
  if (savedSettings.settingsVersion !== defaults.settingsVersion) {
    chrome.storage.local.set({ youtubeSignSettings: settings });
  }
  render();
});

language.addEventListener("change", () => { settings.signedLanguage = language.value; save(); });
size.addEventListener("change", () => { settings.size = size.value; save(); });
enabled.addEventListener("click", async () => {
  enabled.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.includes("youtube.com/watch")) {
      throw new Error("Open a YouTube video first");
    }
    if (settings.enabled) {
      await chrome.runtime.sendMessage({ target: "background", type: "asr-stop", tabId: tab.id });
      settings.enabled = false;
      save("Disabled on this YouTube tab");
    } else {
      const streamId = await chrome.tabCapture.getMediaStreamId();
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "asr-start",
        streamId,
        tabId: tab.id,
        standby: true,
      });
      if (!response?.ok) throw new Error(response?.error || "Could not enable this video");
      settings.enabled = true;
      save("Enabled — video source selection is automatic");
    }
  } catch (error) {
    saved.textContent = error?.message || "Could not enable this video";
  } finally {
    enabled.disabled = false;
    render();
  }
});
