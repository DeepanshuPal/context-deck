const $ = (id) => document.getElementById(id);
const defaults = {enabled: true, pauseOnHover: true, saveAudio: true};
chrome.storage.local.get("prefs").then(({prefs}) => {
  const p = {...defaults, ...(prefs ?? {})};
  for (const key of Object.keys(defaults)) {
    $(key).checked = p[key];
    $(key).onchange = () => { p[key] = $(key).checked; chrome.storage.local.set({prefs: p}); };
  }
});
chrome.runtime.sendMessage({type: "status"}).then(({app, pending}) => {
  if (app) {
    $("app").className = "ok"; $("app").textContent = "Connected to the Context Deck app.";
    $("dicts").textContent = app.dictionaries ? `${app.dictionaries} dictionar${app.dictionaries === 1 ? "y" : "ies"} installed.` : "No dictionary yet: in the app, click Dictionaries and download one.";
  } else {
    $("app").className = "bad"; $("app").textContent = "The Context Deck app isn't open. Open it for definitions; words you save meanwhile wait here.";
  }
  $("queue").textContent = pending ? `${pending} saved word${pending === 1 ? "" : "s"} waiting to move into the app.` : "";
});
