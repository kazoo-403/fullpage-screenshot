"use strict";

// サービスワーカー。役割は3つだけに絞る（MV3では寿命が短いので状態を持たない）。
//   1. 右クリックメニューの登録
//   2. content script（capture.js）の注入
//   3. 1コマ分の captureVisibleTab 代行と、結果通知
//
// 成否の通知に chrome.notifications を選んだ理由:
//   ページ内トーストは chrome:// やウェブストアのように content script を注入できない
//   ページでは出せず、失敗の通知経路が2つに割れる。通知なら全ケースを1系統で扱える。

const MENU_ID = "fullpage-screenshot";

// captureVisibleTab は「1秒あたり2回」の制限がある。安全側に600ms間隔を強制する。
const MIN_CAPTURE_INTERVAL_MS = 600;
const CAPTURE_RETRY = 3;
const CAPTURE_BACKOFF_MS = 1000;

// 直近のキャプチャ時刻。サービスワーカーが落ちると 0 に戻り、
// 復帰直後の1回だけ制限に当たりうるが、その場合はリトライで吸収する。
let lastCaptureAt = 0;

chrome.runtime.onInstalled.addListener(() => {
  // 二重登録を避けるため、必ず消してから作る
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "ページ全体をスクリーンショット",
      // ページ上の右クリックだけに出す。拡張機能アイコンの右クリックには出さない
      // （その経路には撮影対象のページが無く、意味のないエラーになるため）
      contexts: ["page", "frame", "selection", "link", "image", "video", "audio", "editable"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // 呼び出し元は await しないので、ここで受け止めないと未処理の reject になる
  startCapture(info, tab).catch((e) => {
    notify("error", "実行できませんでした: " + errText(e));
  });
});

// 右クリックを潰しているページ向けの別経路。ツールバーのアイコンクリックと
// ショートカット（manifest の _execute_action）の両方がここに来る。どちらも activeTab が付与される
chrome.action.onClicked.addListener((tab) => {
  startCapture({ pageUrl: tab && tab.url }, tab).catch((e) => {
    notify("error", "実行できませんでした: " + errText(e));
  });
});

async function startCapture(info, tab) {
  if (!tab || typeof tab.id !== "number") {
    notify("error", "対象のタブを特定できませんでした");
    return;
  }
  // tab.url は権限次第で undefined になりうるので、確実に取れる pageUrl を優先する
  const url = info.pageUrl || tab.url;
  const reason = unsupportedReason(url);
  if (reason) {
    notify("error", reason);
    return;
  }
  try {
    // 右クリックでの起動なので activeTab が付与されている。
    // トップフレームだけに注入する（allFrames は指定しない）。
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["capture.js"]
    });
  } catch (e) {
    // file:// は activeTab だけでは実行できず、拡張機能側の設定を変えてもらう必要がある
    if (String(url).toLowerCase().startsWith("file://")) {
      notify("error", "ローカルファイルを撮るには拡張機能の詳細で「ファイルのURLへのアクセスを許可する」をオンにしてください");
      return;
    }
    notify("error", "このページでは実行できません: " + errText(e));
  }
}

// 撮影できないページを事前に弾く。判定できない場合は通し、注入失敗側で拾う。
function unsupportedReason(url) {
  if (!url) return "このページのURLを取得できないため実行できません";
  const u = url.toLowerCase();
  if (u.startsWith("chrome://") || u.startsWith("edge://") || u.startsWith("about:") ||
      u.startsWith("devtools://") || u.startsWith("chrome-untrusted://")) {
    return "ブラウザの内部ページは撮影できません";
  }
  if (u.startsWith("chrome-extension://") || u.startsWith("moz-extension://")) {
    return "拡張機能のページは撮影できません";
  }
  if (u.startsWith("view-source:")) return "ソース表示ページは撮影できません";
  if (u.startsWith("https://chromewebstore.google.com") ||
      u.startsWith("https://chrome.google.com/webstore")) {
    return "Chrome ウェブストアでは拡張機能を実行できません";
  }
  if (!(u.startsWith("http://") || u.startsWith("https://") || u.startsWith("file://"))) {
    return "このページ（" + url.split(":")[0] + ":）は撮影できません";
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "capture-frame") {
    // reject させると content 側の await が永久に返らず、そのタブが撮影不能のまま残る
    captureFrame(sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true; // 非同期応答
  }

  if (msg.type === "report") {
    notify(msg.level, String(msg.message || ""));
    sendResponse({ ok: true });
    return false;
  }
});

async function captureFrame(sender) {
  const tab = sender && sender.tab;
  if (!tab || typeof tab.windowId !== "number") {
    return { ok: false, error: "送信元のタブが不明です" };
  }
  for (let attempt = 1; attempt <= CAPTURE_RETRY; attempt++) {
    const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);

    // 撮影中にタブが切り替わると別タブを撮ってしまうので、待機の直後に毎回確認する
    try {
      const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (!active[0] || active[0].id !== tab.id) {
        return { ok: false, error: "撮影中にタブが切り替わりました" };
      }
      // 最小化されると描画が止まり、captureVisibleTab がエラーを返さずに
      // 古いフレームを返すことがある。無言で崩れるより止めた方がよい。
      // フォーカスの有無までは見ない（別モニタや裏ウィンドウでも正しく撮れるため）
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === "minimized") {
        return { ok: false, error: "撮影中にウィンドウが最小化されました" };
      }
    } catch (e) {
      return { ok: false, error: "タブの状態を確認できませんでした: " + errText(e) };
    }

    try {
      lastCaptureAt = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      lastCaptureAt = Date.now();
      if (!dataUrl) throw new Error("空の画像が返りました");
      // 確認と撮影の間に切り替わっていた場合に別タブの絵を混ぜないよう、撮った後にも見る
      const stillActive = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (!stillActive[0] || stillActive[0].id !== tab.id) {
        return { ok: false, error: "撮影中にタブが切り替わりました" };
      }
      return { ok: true, dataUrl: dataUrl };
    } catch (e) {
      lastCaptureAt = Date.now();
      if (attempt === CAPTURE_RETRY) {
        return { ok: false, error: "画面のキャプチャに失敗しました: " + errText(e) };
      }
      await sleep(CAPTURE_BACKOFF_MS);
    }
  }
  // ここには来ない想定だが、undefined を返すと content 側が原因不明のエラーになる
  return { ok: false, error: "画面のキャプチャに失敗しました" };
}

// level は "ok"（完了）/ "error"（失敗）/ "info"（操作待ち）/ "abort"（中止）/ "busy"（実行中）
function notify(level, message) {
  let title = "スクリーンショット: 失敗";
  if (level === "ok") title = "スクリーンショット: 完了";
  else if (level === "info") title = "スクリーンショット: 操作待ち";
  else if (level === "abort") title = "スクリーンショット: 中止";
  else if (level === "busy") title = "スクリーンショット: 実行中";

  // IDを固定して、操作待ち→完了などの通知が積み上がらず置き換わるようにする。
  // ただし「実行中」は別IDにする（貼り付け待ちの案内を上書きして消してしまうため）
  const id = level === "busy" ? MENU_ID + ":busy" : MENU_ID;
  // 結果が出たら「実行中」は用済みなので消す（並んで残らないように）。
  // コールバック形式で呼ぶ（Promiseを返すのは新しめのChromeだけで、
  // 古い版では undefined になり .catch で落ちる）。失敗はここで握りつぶす
  const ignoreError = () => { void chrome.runtime.lastError; };
  if (level !== "busy") {
    chrome.notifications.clear(MENU_ID + ":busy", ignoreError);
  }
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: title,
    message: message || "原因不明のエラー",
    priority: 0
  }, ignoreError);
}

function errText(e) {
  if (!e) return "unknown";
  return String(e.message || e);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
