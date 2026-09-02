"use strict";

// ページ側（content script）で動く本体。
// スクロールしながら1コマずつサービスワーカーに撮影を依頼し、
// OffscreenCanvas 上で等倍合成して PNG をクリップボードに書く。
//
// クリップボードへの書き込みを content script でやる理由:
//   offscreen document は永久にフォーカスを持てず navigator.clipboard.write が
//   "Document is not focused" で必ず失敗するため。ページ側なら右クリック直後は
//   フォーカスがあり、外れていてもユーザーのクリックを待って貼り直せる。
(function () {
  // ===== 定数 =====
  const MAX_SIDE = 32767;       // canvas の1辺の上限（Chrome）
  const MAX_AREA = 268435456;   // canvas の面積上限（Chrome / 16384^2）
  const MAX_FRAMES = 80;        // 撮影コマ数の上限（順調なら1コマ約0.9秒）
  const MAX_TOTAL_MS = 180000;  // 全体の時間上限。リトライが続いても3分で打ち切る
  const MAX_ELEMENTS = 30000;   // 固定要素を探すときに走査する要素数の上限
  const SETTLE_MS = 250;        // スクロール後、描画が落ち着くのを待つ時間
  const PREPASS_WAIT_MS = 120;  // 遅延読み込みを発火させる下見パスの待ち時間
  const PASTE_RETRY_MS = 20000; // フォーカスが無いときにクリックを待つ時間
  const SCROLL_TOLERANCE = 2;   // 狙った位置と実際の位置のずれをどこまで許すか（CSSピクセル）
  // width:100vw などで数pxだけはみ出すページは珍しくない。
  // これ未満のはみ出しでコマを増やすと、2コマ目が1コマ目をほぼ全面上書きして
  // 固定ヘッダーが消えるだけなので、はみ出しごと切り捨てる
  const OVERFLOW_TOLERANCE = 16;

  // 内側スクローラ判定のしきい値。普通のページを誤って弾かないよう厳しめにする。
  // 埋め込みの表・リストを本文コンテナと取り違えると、撮れるページが撮れなくなる
  const INNER_MIN_HIDDEN_RATIO = 1.0;  // 隠れている量が1画面ぶん以上
  const INNER_MIN_WIDTH_RATIO = 0.8;   // 画面幅の8割以上を占める
  // ヘッダーと入力欄で画面の半分近くを使うチャット型UIも拾えるよう、高さの条件は緩めにする
  const INNER_MIN_HEIGHT_RATIO = 0.5;  // 画面高の5割以上を占める
  const INNER_MIN_BOTTOM_RATIO = 0.8;  // 下端が画面の8割より下まで届く（アプリの本文枠の特徴）
  // 中身をスクロールするのが当たり前の部品は本文コンテナとみなさない
  const INNER_SKIP_TAGS = /^(TEXTAREA|SELECT|INPUT|PRE|CODE|SVG|CANVAS|VIDEO)$/;

  // 固定要素のうち「画面上部に貼り付いたヘッダー」とみなす条件
  const TOP_ANCHOR_RATIO = 0.15;   // 上端から画面高の15%以内にある
  // 全画面オーバーレイ扱いは「縦も横も画面をほぼ覆う」場合だけ。
  // 高さだけで判定すると、画面いっぱいの固定サイドナビまで消してしまう
  const FULLSCREEN_RATIO = 0.85;   // 画面高の85%以上
  const FULLSCREEN_W_RATIO = 0.7;  // かつ画面幅の70%以上

  // ページ内トーストを出しておく時間。失敗は読む時間が要るので長く、
  // 操作待ちはクリックを待つ時間そのものに合わせる（PASTE_RETRY_MS）
  const TOAST_MS = 3000;
  const TOAST_ERROR_MS = 8000;
  const TOAST_FADE_MS = 250;       // 消えるアニメーションの長さ。待ってから要素を捨てる

  // 同じタブへ再注入されても isolated world のグローバルは共有されるので、二重起動を防げる
  if (globalThis.__fullPageShotRunning) {
    report("busy", "撮影中です。完了までお待ちください。");
    return;
  }
  globalThis.__fullPageShotRunning = true;
  // 前回のトーストが残ったまま撮り始めると、その絵ごと画像に写り込む
  removeToast();

  main()
    .catch(function (e) {
      // ユーザーが自分で止めた場合は「失敗」ではないので通知の種別を変える
      report(e && e.__abort ? "abort" : "error", errText(e));
    })
    .finally(function () { globalThis.__fullPageShotRunning = false; });

  async function main() {
    // クリップボードAPIは secure context 専用。http:// のページでは撮る前に諦める
    // （撮ってから貼れないと分かるのが一番タチが悪い）
    if (!window.isSecureContext || !navigator.clipboard || !navigator.clipboard.write) {
      throw new Error("このページ（httpなど安全でない接続）ではクリップボードに書き込めません");
    }
    const shot = await capturePage();          // ここを抜けた時点でスクロール位置とスタイルは復元済み
    await copyToClipboard(shot.blob, shot.width, shot.height, shot.partial, shot.grew);
  }

  // ===== 撮影と合成 =====
  async function capturePage() {
    if (!document.body) throw new Error("ページがまだ読み込まれていません");
    // ChromeのPDFビューアは中身が別文書で、こちらからはスクロールできない。
    // 1画面だけ撮って「ページ全体」と称するより、撮れないと伝える
    if (document.contentType === "application/pdf") {
      throw new Error("PDFの表示ページはページ全体を撮影できません");
    }

    // 標準モードなら documentElement、quirks モードなら body が実際のスクロール主体になる
    const scroller = document.scrollingElement || document.documentElement;
    const origScrollX = window.scrollX;
    const origScrollY = window.scrollY;
    const stash = [];                          // [要素, 元のstyle属性] を積んで finally で戻す

    // 長いページで待たされ続けないように Esc で抜けられるようにしておく
    let aborted = false;
    const startedAt = Date.now();
    const onAbortKey = function (e) { if (e.key === "Escape") aborted = true; };
    const checkAbort = function () {
      // キャプチャのリトライが続くと1コマ数秒かかることがあるので、全体の時間でも打ち切る
      if (!aborted && Date.now() - startedAt > MAX_TOTAL_MS) {
        throw new Error("時間内に撮り切れませんでした（" + Math.round(MAX_TOTAL_MS / 60000) + "分で打ち切り）");
      }
      if (!aborted) return;
      const err = new Error("Escキーで中止しました");
      err.__abort = true;
      throw err;
    };
    window.addEventListener("keydown", onAbortKey, true);

    try {
      // スムーススクロールが効いていると scrollTo が非同期に動いて撮影位置がずれる
      // scroll-snap も潰す。スナップ点が画面高の倍数でないと止まる位置がずれ、
      // タイルの間に撮り漏らしの帯ができる
      // overflow-anchor も切る。上の方のコンテンツが遅れて伸縮すると
      // Chrome が勝手にスクロール位置を補正し、狙った位置とずれて誤って中止になる
      saveStyle(stash, document.documentElement);
      document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
      document.documentElement.style.setProperty("scroll-snap-type", "none", "important");
      document.documentElement.style.setProperty("overflow-anchor", "none", "important");
      saveStyle(stash, document.body);
      document.body.style.setProperty("scroll-behavior", "auto", "important");
      document.body.style.setProperty("scroll-snap-type", "none", "important");
      document.body.style.setProperty("overflow-anchor", "none", "important");

      // 下見の前にも一度だけ概算で弾いておく（巨大ページで下見に時間を使う前に止めるため）
      const dpr0 = window.devicePixelRatio || 1;
      checkCanvasLimit(scroller.scrollWidth * dpr0, scroller.scrollHeight * dpr0);
      checkFrameCount(scroller.scrollWidth, scroller.scrollHeight, scroller.clientWidth, scroller.clientHeight);

      // 先に一往復して遅延読み込みを発火させる（撮影はしないので速い）
      await primeLazyLoad(scroller, checkAbort);
      checkAbort();

      const cw = scroller.clientWidth;          // スクロールバーを除いた表示幅
      const ch = scroller.clientHeight;
      if (cw <= 0 || ch <= 0) throw new Error("表示領域のサイズを取得できませんでした");

      let fullW = Math.max(scroller.scrollWidth, cw);
      let fullH = Math.max(scroller.scrollHeight, ch);
      if (fullW - cw <= OVERFLOW_TOLERANCE) fullW = cw;
      if (fullH - ch <= OVERFLOW_TOLERANCE) fullH = ch;

      // 本文がページ内のスクロール領域にある場合、その中身までは撮れない。
      // 撮影自体はやめず、「表示範囲だけ」と分かるように通知の文面を変える
      // （撮れる画像を捨てるのも、欠けたものを黙って全体と称するのも避ける）
      const innerScroller = findDominantScroller(cw, ch, fullH - ch);

      const cols = Math.ceil(fullW / cw);
      const rows = Math.ceil(fullH / ch);

      // 右から左に流れるページの横スクロールは scrollX が負になり、
      // 位置合わせが総崩れになるので黙って壊れた画像を返さず止める。
      // ビューポートの向きは body の値が伝播して決まるので body を見る
      // （html と body の OR にすると html だけ rtl のページを取り違える）
      let isRtl = false;
      try {
        isRtl = getComputedStyle(document.body).direction === "rtl";
      } catch (e) { /* 取れなければ ltr 扱い */ }
      if (isRtl && cols > 1) {
        throw new Error("右から左に流れる横スクロールのページには対応していません");
      }
      checkFrameCount(fullW, fullH, cw, ch);

      // RTL のページでは縦スクロールバーが左に出るので、切り出しの原点を右にずらす。
      // ずらさないとバーが写り込み、その幅ぶん右端のコンテンツが全コマで欠ける
      const gutterLeft = isRtl ? Math.max(0, window.innerWidth - cw) : 0;

      const dpr = window.devicePixelRatio || 1;
      checkCanvasLimit(fullW * dpr, fullH * dpr);

      // 固定要素は先に洗い出しておく。フッターや追従ウィジェットは1コマ目の前に隠して
      // 下の本文を救い、上部ヘッダーだけ1コマ目に残す。
      // 1コマで収まるページは重複しようがないので、何も隠さず見たままを撮る
      const multiFrame = cols * rows > 1;
      const pinnedSeen = new Set();
      const pinned = multiFrame ? collectPinned(cw, ch, pinnedSeen) : null;
      if (multiFrame) hidePinned(stash, pinned, "pre");
      let frameIndex = 0;

      let canvas = null;
      let ctx = null;
      let scale = 0;
      // 各列で既に描き終えた下端／各行で描き終えた右端（CSSピクセル）。
      // コマ同士が重なる最終行・最終列で、先に描いた絵を上書きしないために使う
      const drawnBottom = new Array(cols).fill(0);
      const drawnRight = new Array(rows).fill(0);

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          checkAbort();
          const targetX = col * cw;
          const targetY = row * ch;
          await scrollToPos(targetX, targetY);

          // 表示領域の大きさが変わるとコマの割り付けが崩れる。
          // 途中にできた帯抜けは被覆チェックが拾うので、ここは他のチェックと
          // 同じ許容幅にしてスクロールバーの出入り程度では止めない
          if (Math.abs(scroller.clientWidth - cw) > OVERFLOW_TOLERANCE ||
              Math.abs(scroller.clientHeight - ch) > OVERFLOW_TOLERANCE) {
            throw new Error("撮影中にウィンドウの大きさが変わりました");
          }

          // 狙った位置に届いていないまま撮り続けると、同じ絵を貼り重ねた画像を
          // 「成功」として返してしまう。到達できたかは「その時点の」限界と突き合わせる
          // （撮影中に高さが数px変わるのは普通に起きるので、撮影前の値で判定すると誤爆する）
          let x = window.scrollX;
          let y = window.scrollY;
          for (let retry = 0; retry < 2; retry++) {
            const expectedX = Math.min(targetX, Math.max(0, scroller.scrollWidth - scroller.clientWidth));
            const expectedY = Math.min(targetY, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
            // 最終行・最終列より前で頭打ちになるのは、スクロールできる範囲が狭まった証拠。
            // このまま回すと何も描けないコマを最後まで撮り続けて、理由も所要時間も狂う。
            // 許容幅は最後の被覆チェックと揃える（数pxの縮みで撮り切れるページを落とさない）
            if ((expectedY < targetY - OVERFLOW_TOLERANCE && row < rows - 1) ||
                (expectedX < targetX - OVERFLOW_TOLERANCE && col < cols - 1)) {
              throw new Error("ページをスクロールできる範囲が撮影前より狭くなりました");
            }
            if (Math.abs(x - expectedX) <= SCROLL_TOLERANCE && Math.abs(y - expectedY) <= SCROLL_TOLERANCE) break;
            if (retry === 1) {
              throw new Error("狙った位置までスクロールできませんでした（モーダル表示中やレイアウト変化の可能性）");
            }
            // 遅れて確定したレイアウトに押し戻されただけのことがあるので、一度やり直す
            await scrollToPos(targetX, targetY);
            x = window.scrollX;
            y = window.scrollY;
          }

          // スクロールしてから JS で position:fixed になる追従ヘッダーや
          // 「トップへ戻る」ボタンは出てくる位置がまちまちなので、毎コマ探し直す。
          // 処理済みは pinnedSeen で飛ばすので、隠す操作は要素ごとに1回だけ
          if (multiFrame && frameIndex > 0) {
            const late = collectPinned(cw, ch, pinnedSeen);
            for (let i = 0; i < late.length; i++) late[i].phase = "post";
            if (late.length > 0) {
              hidePinned(stash, late, "post");
              // 隠した結果が画面に反映されてから撮る
              await nextFrame();
              await nextFrame();
            }
          }
          frameIndex++;

          const bitmap = await grabFrame();
          try {
            // 撮影依頼はレート制限で待たされるので、その間にページ側のJSが
            // スクロールしていることがある。ずれたコマを貼ると継ぎ目が狂う
            if (Math.abs(window.scrollX - x) > SCROLL_TOLERANCE ||
                Math.abs(window.scrollY - y) > SCROLL_TOLERANCE) {
              throw new Error("撮影中にページがスクロールされました");
            }
            if (!canvas) {
              // 実効倍率 ＝ 撮れた画像の幅 ÷ 表示幅（devicePixelRatio とページズームの両方を含む）
              scale = bitmap.width / window.innerWidth;
              if (!isFinite(scale) || scale <= 0) scale = dpr;

              const W = Math.round(fullW * scale);
              const H = Math.round(fullH * scale);
              checkCanvasLimit(W, H);
              canvas = new OffscreenCanvas(W, H);
              ctx = canvas.getContext("2d", { alpha: false });
              if (!ctx) throw new Error("画像バッファを確保できませんでした（ページが大きすぎます）");
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, W, H);
            } else {
              // 撮影中にウィンドウの大きさやズームが変わると倍率がずれ、
              // コマの間に描かれない帯ができる。合わなくなったら止める
              const nowScale = bitmap.width / window.innerWidth;
              if (isFinite(nowScale) && Math.abs(nowScale - scale) > 0.01) {
                throw new Error("撮影中にウィンドウの大きさか表示倍率が変わりました");
              }
            }
            // 最終行・最終列はスクロールが端で止まるので前のコマと重なる。
            // 重なった部分は描かない（固定ヘッダーを残した1コマ目を上書きしないため）
            const skipTop = row > 0 ? Math.max(0, drawnBottom[col] - y) : 0;
            const skipLeft = col > 0 ? Math.max(0, drawnRight[row] - x) : 0;
            const drawW = cw - skipLeft;
            const drawH = ch - skipTop;
            if (drawW > 0 && drawH > 0) {
              // スクロールバーが写り込まないよう、表示領域ぶんだけ切り出して貼る。
              // 縦バーが左に出るページ（RTL）では、その幅ぶん右にずらして切り出す
              const sx = Math.round((skipLeft + gutterLeft) * scale);
              const sy = Math.round(skipTop * scale);
              const sw = Math.min(Math.round(drawW * scale), bitmap.width - sx);
              const sh = Math.min(Math.round(drawH * scale), bitmap.height - sy);
              if (sw > 0 && sh > 0) {
                ctx.drawImage(bitmap, sx, sy, sw, sh,
                  Math.round((x + skipLeft) * scale), Math.round((y + skipTop) * scale), sw, sh);
                // 「実際に描けた範囲」を、前のコマと地続きの時だけ進める。
                // 飛んだ場合に進めてしまうと、画像の途中にできた帯抜けを
                // 撮影後の被覆チェックが見逃して白いまま「完了」にしてしまう
                const segTop = y + skipTop;
                const segLeft = x + skipLeft;
                if (segTop <= drawnBottom[col] + SCROLL_TOLERANCE) {
                  drawnBottom[col] = Math.max(drawnBottom[col], segTop + sh / scale);
                }
                if (segLeft <= drawnRight[row] + SCROLL_TOLERANCE) {
                  drawnRight[row] = Math.max(drawnRight[row], segLeft + sw / scale);
                }
              }
            }
          } finally {
            bitmap.close();
          }

          // 上部ヘッダーと sticky は1コマ目を撮ってから隠す。
          // 横スクロールするページでも2コマ目以降に重複しないよう、行末ではなくここで行う
          if (row === 0 && col === 0 && multiFrame) hidePinned(stash, pinned, "post");
        }
      }

      // 撮影中にページが縮むと、下端や右端が白いままの画像ができあがる。
      // 全面を埋められなかったら黙って返さず失敗にする。
      // 許容幅は、はみ出しを切り捨てる基準と同じにする（数pxの伸縮で70秒の撮影を捨てないため）
      for (let col = 0; col < cols; col++) {
        if (drawnBottom[col] < fullH - OVERFLOW_TOLERANCE) {
          throw new Error("撮影中にページの高さが変わったため、最後まで撮れませんでした");
        }
      }
      for (let row = 0; row < rows; row++) {
        if (drawnRight[row] < fullW - OVERFLOW_TOLERANCE) {
          throw new Error("撮影中にページの幅が変わったため、最後まで撮れませんでした");
        }
      }

      // キャンバスに入らなかった範囲（切り捨てたはみ出し＋撮影中に伸びた分）があるかを見る。
      // 撮れた画像は捨てず、含んでいない範囲があることを通知で伝える。
      // 基準はキャンバスの実寸（fullW/fullH）。切り捨て前の rawW/rawH と比べると、
      // 実際には画像から欠けている端数を「入っている」と誤って扱ってしまう
      const grew = scroller.scrollHeight - fullH > OVERFLOW_TOLERANCE ||
                   scroller.scrollWidth - fullW > OVERFLOW_TOLERANCE;

      const blob = await canvas.convertToBlob({ type: "image/png" });
      return {
        blob: blob,
        width: canvas.width,
        height: canvas.height,
        partial: !!innerScroller,
        grew: grew
      };
    } finally {
      window.removeEventListener("keydown", onAbortKey, true);
      // 成功でも失敗でも元に戻す。スクロールを先に戻すのは、
      // スタイルを戻すと scroll-behavior:smooth が復活してアニメーションになるため
      window.scrollTo(origScrollX, origScrollY);
      restoreStyles(stash);
    }
  }

  async function grabFrame() {
    const res = await send({ type: "capture-frame" });
    if (!res || !res.ok) throw new Error((res && res.error) || "画面のキャプチャに失敗しました");
    return await createImageBitmap(dataUrlToBlob(res.dataUrl));
  }

  function checkCanvasLimit(w, h) {
    const size = Math.round(w) + "x" + Math.round(h) + "px";
    if (w > MAX_SIDE || h > MAX_SIDE) {
      throw new Error("ページが大きすぎます（" + size + "／1辺の上限 " + MAX_SIDE + "px）。縮小しない仕様のため中止しました");
    }
    if (w * h > MAX_AREA) {
      throw new Error("ページが大きすぎます（" + size + "／面積の上限 " + MAX_AREA + "平方px）。縮小しない仕様のため中止しました");
    }
  }

  function checkFrameCount(fullW, fullH, cw, ch) {
    if (cw <= 0 || ch <= 0) return;
    // 本番の分割と同じ基準で数える（わずかなはみ出しでコマ数が倍に見えると誤って弾いてしまう）
    const w = fullW - cw <= OVERFLOW_TOLERANCE ? cw : fullW;
    const h = fullH - ch <= OVERFLOW_TOLERANCE ? ch : fullH;
    const frames = Math.ceil(w / cw) * Math.ceil(h / ch);
    if (frames > MAX_FRAMES) {
      throw new Error("ページが長すぎます（" + frames + "コマ／上限" + MAX_FRAMES + "コマ）");
    }
  }

  // 本文を抱えている大きなスクロール領域を探す。
  // html/body 自身がスクローラになっている構成もあるので候補に含める。
  // pageHidden ＝ ページ自身がスクロールできる量。これを超える中身を抱えた領域だけが本文コンテナ
  function findDominantScroller(vw, vh, pageHidden) {
    const candidates = [document.documentElement, document.body].concat(collectElements());
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!el) continue;
      const tag = String(el.tagName).toUpperCase();
      // 画面いっぱいの iframe は中身が別文書なので、こちらからはスクロールできない。
      // scrollHeight では測れないため、ページ自身がほとんど伸びていない時だけ形で判定する
      // 動画・地図の埋め込みと区別するため、画面を端から端まで覆うものだけを対象にする
      if (/^(IFRAME|FRAME|EMBED|OBJECT)$/.test(tag)) {
        if (pageHidden >= vh * 0.5) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= vw * 0.9 && r.top <= vh * 0.15 && r.bottom >= vh * 0.95) {
          return el;
        }
        continue;
      }
      // SVG要素の tagName は小文字なので大文字に揃えてから判定する
      if (INNER_SKIP_TAGS.test(tag)) continue;
      if (el.isContentEditable) continue;
      const hidden = el.scrollHeight - el.clientHeight;
      if (hidden < vh * INNER_MIN_HIDDEN_RATIO || hidden <= pageHidden) continue;
      let style;
      try {
        style = getComputedStyle(el);
      } catch (e) {
        continue;
      }
      if (!/^(auto|scroll|overlay)$/.test(style.overflowY)) continue;
      const rect = el.getBoundingClientRect();
      // 上端が画面の上半分にあり、下端が画面の下の方まで届いている＝本文枠の形。
      // 下端だけ見ると、ファーストビューより下の要素は必ず条件を満たしてしまう
      if (rect.width >= vw * INNER_MIN_WIDTH_RATIO &&
          rect.height >= vh * INNER_MIN_HEIGHT_RATIO &&
          rect.top <= vh * 0.5 &&
          rect.bottom >= vh * INNER_MIN_BOTTOM_RATIO) {
        return el;
      }
    }
    return null;
  }

  // ===== スクロールと待ち =====
  async function scrollToPos(x, y) {
    window.scrollTo(x, y);
    await nextFrame();
    await nextFrame();
    await sleep(SETTLE_MS);
  }

  // 撮影せずに一度下まで送って、遅延読み込みの画像などを読ませる
  async function primeLazyLoad(scroller, checkAbort) {
    const step = Math.max(200, scroller.clientHeight);
    let guard = 0;
    for (let y = 0; y <= scroller.scrollHeight && guard < MAX_FRAMES; y += step) {
      checkAbort();
      // 無限スクロールで際限なく伸びるページは、読み込ませ続ける前にここで見切る
      checkFrameCount(scroller.scrollWidth, scroller.scrollHeight, scroller.clientWidth, step);
      window.scrollTo(0, y);
      await sleep(PREPASS_WAIT_MS);
      guard++;
    }
    window.scrollTo(0, 0);
    await sleep(PREPASS_WAIT_MS);
  }

  // ===== 固定要素の退避 =====
  // fixed / sticky を洗い出し、1コマ目より前に隠すか後に隠すかを決めておく
  // seen に入っている要素は処理済みなので飛ばす（撮影中の再スキャン用）
  function collectPinned(vw, vh, seen) {
    const elements = collectElements();
    const pinned = [];
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (seen.has(el)) continue;
      let style;
      try {
        style = getComputedStyle(el);
      } catch (e) {
        continue;
      }
      const pos = style.position;
      // transform などを持つ祖先の下では fixed でも画面ではなくその祖先に張り付く。
      // つまりページと一緒にスクロールするので重複せず、隠すと中身が消えるだけ
      if (pos === "fixed" && !isViewportFixed(el)) continue;
      if (pos === "fixed") {
        const rect = el.getBoundingClientRect();
        // 上部に貼り付いたヘッダーだけ1コマ目に残す。フッター・追従ウィジェット・
        // 全画面オーバーレイは最初から隠さないと、その裏の本文が画像から失われる
        // 背面レイヤー（z-indexが負の固定背景）は隠すと背景が丸ごと消える。
        // 全コマに写っても背景として自然なので、そのまま触らない。
        // pointer-events:none は除外条件にしない（中身だけクリック可にした
        // 全画面ラッパーの中のトーストや追従ヘッダーを取りこぼすため）
        const zIndex = parseInt(style.zIndex, 10);
        if (isFinite(zIndex) && zIndex < 0) continue;
        const coversScreen = rect.height >= vh * FULLSCREEN_RATIO && rect.width >= vw * FULLSCREEN_W_RATIO;
        // 画面を覆う固定要素のうち、隠すのは重ね順を明示したもの（＝モーダルの類）だけ。
        // z-index 未指定の全画面固定は背景レイヤー（背景画像・グラデーション）のことが多く、
        // 隠すと全コマが白抜けになるので触らない
        if (coversScreen && !(isFinite(zIndex) && zIndex >= 1)) continue;
        const isOverlay = coversScreen;
        const topAnchored = rect.top <= vh * TOP_ANCHOR_RATIO && !isOverlay;
        pinned.push({ el: el, kind: "fixed", phase: topAnchored ? "post" : "pre" });
        seen.add(el);
      } else if (pos === "sticky" && isViewportSticky(el)) {
        // 上寄せの sticky はスクロール0では本来の場所にいるので1コマ目には残す。
        // 下寄せ（bottom指定・top:auto）は1コマ目で画面下端に貼り付いて写ったうえ、
        // static 化した後に本来の位置でも写る＝二重に出るので最初から隠す
        const bottomAnchored = style.bottom !== "auto" && style.top === "auto";
        pinned.push({ el: el, kind: "sticky", phase: bottomAnchored ? "pre" : "post" });
        seen.add(el);
      }
    }
    return pinned;
  }

  // position:fixed が本当に画面基準か（＝スクロールしても動かないか）を祖先から判定する。
  // transform / perspective / filter / will-change / contain は fixed の基準を自分に引き寄せる
  function isViewportFixed(el) {
    let node = el;
    for (let guard = 0; guard < 1000; guard++) {
      let parent = node.parentElement;
      if (!parent) {
        // shadow root の境界で親が切れるので、ホスト要素に乗り換えて遡り続ける
        const root = node.getRootNode ? node.getRootNode() : null;
        if (root && root.host) parent = root.host;
        else return true;
      }
      let style;
      try {
        style = getComputedStyle(parent);
      } catch (e) {
        return true;
      }
      if (style.transform !== "none" || style.perspective !== "none" || style.filter !== "none") {
        return false;
      }
      if (style.backdropFilter && style.backdropFilter !== "none") return false;
      if (/transform|perspective|filter/.test(style.willChange)) return false;
      if (/paint|layout|strict|content/.test(style.contain)) return false;
      if (style.containerType && style.containerType !== "normal") return false;
      node = parent;
    }
    return true;
  }

  // sticky が画面基準で貼り付くか（＝ページのスクロールで動かないか）を判定する。
  // 内側のスクロール領域に貼り付く sticky（表の固定ヘッダーなど）は、
  // その領域ごとページと一緒に動くのでコマ間で重複しない＝退避してはいけない
  function isViewportSticky(el) {
    const root = document.scrollingElement || document.documentElement;
    let node = el;
    for (let guard = 0; guard < 1000; guard++) {
      let parent = node.parentElement;
      if (!parent) {
        // fixed 側と同じく shadow root の境界はホスト要素に乗り換えて越える
        const shadowRoot = node.getRootNode ? node.getRootNode() : null;
        if (shadowRoot && shadowRoot.host) parent = shadowRoot.host;
        else return true;
      }
      if (parent === root || parent === document.documentElement || parent === document.body) return true;
      let style;
      try {
        style = getComputedStyle(parent);
      } catch (e) {
        return true;
      }
      // clip は scrollport を作らないので sticky の基準にならない（hidden とは違う）
      if (/^(auto|scroll|overlay|hidden)$/.test(style.overflowY) ||
          /^(auto|scroll|overlay|hidden)$/.test(style.overflowX)) {
        return false;
      }
      node = parent;
    }
    return true;
  }

  function hidePinned(stash, pinned, phase) {
    for (let i = 0; i < pinned.length; i++) {
      const item = pinned[i];
      if (item.phase !== phase || item.done) continue;
      item.done = true;
      saveStyle(stash, item.el);
      if (item.kind === "fixed") {
        // fixed はもともと流れの外にあるので、消してもレイアウトは動かない。
        // visibility:hidden だと子孫の visibility:visible に打ち消されるので display を使う
        item.el.style.setProperty("display", "none", "important");
      } else {
        // sticky は通常フローに箱を持つので、貼り付きだけ止めれば高さは変わらない。
        // static ではなく relative + オフセット無効にする（static にすると
        // 絶対配置の子孫の基準がこの要素から外れて、飛んで写る）
        item.el.style.setProperty("position", "relative", "important");
        item.el.style.setProperty("top", "auto", "important");
        item.el.style.setProperty("right", "auto", "important");
        item.el.style.setProperty("bottom", "auto", "important");
        item.el.style.setProperty("left", "auto", "important");
      }
    }
  }

  // body 配下の要素を集める。open な shadow root も辿る
  // （Web Components 製の固定ヘッダーが querySelectorAll では拾えないため）
  function collectElements() {
    const out = [];
    const roots = [document.body];
    while (roots.length > 0 && out.length < MAX_ELEMENTS) {
      const root = roots.shift();
      const list = root.querySelectorAll("*");
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        out.push(el);
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (out.length >= MAX_ELEMENTS) break;
      }
    }
    return out;
  }

  function saveStyle(stash, el) {
    stash.push([el, el.getAttribute("style")]);
  }

  function restoreStyles(stash) {
    for (let i = stash.length - 1; i >= 0; i--) {
      const el = stash[i][0];
      const style = stash[i][1];
      try {
        if (style === null) el.removeAttribute("style");
        else el.setAttribute("style", style);
      } catch (e) {
        // 撮影中にDOMから消えた要素は無視してよい
      }
    }
  }

  // ===== クリップボード =====
  async function copyToClipboard(blob, w, h, partial, grew) {
    // 数値は縮小なしの実ピクセル。DPR2の環境ではCSSピクセルの2倍になるので明示する
    // partial のときページ自体は撮れている。撮れていないのは内側の隠れた部分だけなので
    // 「表示範囲のみ」とは言わない（実際より少なく伝えると無駄な撮り直しを招く）
    const excluded = [];
    if (partial) excluded.push("ページ内スクロール領域の隠れた部分");
    if (grew) excluded.push("画像に入りきらなかった分");
    const what = excluded.length > 0 ? excluded.join("と") + "を除いて" : "ページ全体を";
    const okMessage = what + "（実ピクセル " + w + "x" + h + "）クリップボードにコピーしました";
    try {
      await writeBlob(blob);
      report("ok", okMessage);
      return;
    } catch (e) {
      // フォーカスが外れているだけなら、次のクリックで貼り直せる見込みがある。
      // それ以外（API非対応・権限拒否など）は待たせても無駄なので即座に失敗にする
      const focusIssue = !document.hasFocus() || (e && e.name === "NotAllowedError");
      if (!focusIssue) {
        report("error", "クリップボードに書き込めませんでした: " + errText(e));
        return;
      }
      // ここは失敗ではなく操作待ちなので、結果の通知は再試行が決着してから1回だけ出す
      // リンクやボタンを押されると遷移してこのスクリプトごと消え、結果を通知できない
      report("info", "撮影完了。ページの余白（リンク・ボタン以外）を1回クリックしてください（20秒以内）");
      const result = await retryOnUserGesture(blob, PASTE_RETRY_MS);
      if (result.ok) report("ok", okMessage);
      else report("error", "クリップボードに書き込めませんでした: " + errText(result.error || e));
    }
  }

  function writeBlob(blob) {
    // navigator.clipboard は secure context でないと存在しないので、同期例外にせず reject で返す
    try {
      if (!navigator.clipboard || !navigator.clipboard.write) {
        return Promise.reject(new Error("このページではクリップボードAPIを使えません"));
      }
      return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function retryOnUserGesture(blob, timeoutMs) {
    return new Promise(function (resolve) {
      let finished = false;
      let lastError = null;
      let writing = 0;      // 書き込み中の件数。時間切れでも決着を待つ
      let timedOut = false;
      const finish = function (ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        window.removeEventListener("click", onGesture, true);
        window.removeEventListener("keydown", onGesture, true);
        window.removeEventListener("focus", onGesture, true);
        resolve({ ok: ok, error: lastError });
      };
      const onGesture = function () {
        // ユーザー操作の中で直接呼ぶ必要があるので await を挟まない
        writing++;
        writeBlob(blob).then(function () {
          writing--;
          finish(true);      // 時間切れ後に成功しても、成功として拾う
        }).catch(function (err) {
          writing--;
          lastError = err;   // 最後の失敗理由を通知に出す（最初の例外だと的外れになる）
          if (timedOut && writing === 0) finish(false);
        });
      };
      const timer = setTimeout(function () {
        timedOut = true;
        // 時間切れの瞬間に書き込みが走っていたら、その結果が出るまで確定させない
        if (writing === 0) finish(false);
      }, timeoutMs);
      window.addEventListener("click", onGesture, true);
      window.addEventListener("keydown", onGesture, true);
      window.addEventListener("focus", onGesture, true);
    });
  }

  // ===== ユーティリティ =====
  // data URL を fetch すると閲覧中ページの CSP に引っかかることがあるので自前で復号する
  function dataUrlToBlob(dataUrl) {
    const text = String(dataUrl);
    const comma = text.indexOf(",");
    if (comma < 0) throw new Error("キャプチャ画像の形式が不正です");
    const head = text.slice(0, comma);
    const body = atob(text.slice(comma + 1));
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i);
    const m = head.match(/^data:([^;,]+)/);
    return new Blob([bytes], { type: m ? m[1] : "image/png" });
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg);
    } catch (e) {
      return Promise.reject(new Error("拡張機能と通信できませんでした（拡張機能の再読み込みが必要かもしれません）"));
    }
  }

  // level は "ok" / "error" / "info"（操作待ち）/ "abort"（中止）/ "busy"（実行中）
  function report(level, message) {
    // 通知は送りっぱなしでよい（失敗しても本処理には影響しない）
    try {
      const p = chrome.runtime.sendMessage({ type: "report", level: level, message: message });
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* 何もしない */ }
    showToast(level, message);
  }

  // ===== ページ内トースト =====
  // Windowsの通知だけだと、集中モードや通知オフの環境では撮り終わりが分からない。
  // 長いページほど待ち時間が長く、その間ユーザーは画面の隅を見ていない。
  // 見ている場所（ページの上）に出して、勝手に消す（ボタンは置かない）。
  function showToast(level, message) {
    // 「実行中」は撮影中の画面に出す通知＝そのまま画像に写り込むので出さない
    if (level === "busy") return;
    try {
      const host = ensureToastHost();
      if (!host) return;
      host.__title.textContent = toastTitle(level);
      host.__title.style.color = toastColor(level);
      host.__body.textContent = String(message || "");
      clearTimeout(host.__hideTimer);
      clearTimeout(host.__dropTimer);
      clearTimeout(host.__showTimer);
      // 既に出ているものは差し替えるだけにする（消して出し直すとちらつく）。
      // 付けたばかりの要素は一度描画させないと transition が走らないので少し待つ
      // （rAF はバックグラウンドタブで止まるのでタイマーで出す）
      if (!host.__box.classList.contains("show")) {
        host.__showTimer = setTimeout(function () { host.__box.classList.add("show"); }, 30);
      }
      let ms = TOAST_MS;
      if (level === "error") ms = TOAST_ERROR_MS;
      else if (level === "info") ms = PASTE_RETRY_MS;   // クリック待ちの間は出したままにする
      host.__hideTimer = setTimeout(function () { hideToast(host); }, ms);
    } catch (e) { /* 通知が本処理を巻き込まないよう握りつぶす */ }
  }

  function toastTitle(level) {
    if (level === "ok") return "スクリーンショット完了";
    if (level === "info") return "あと1クリックで完了";
    if (level === "abort") return "中止しました";
    return "失敗しました";
  }

  function toastColor(level) {
    if (level === "ok") return "#4ade80";
    if (level === "info") return "#60a5fa";
    if (level === "abort") return "#fbbf24";
    return "#f87171";
  }

  function ensureToastHost() {
    const cached = globalThis.__fullPageShotToast;
    if (cached && cached.isConnected) return cached;
    if (!document.documentElement) return null;

    const host = document.createElement("div");
    // ページ側のCSSに巻き込まれないよう、インラインの !important で位置だけ固める
    // （インラインの !important はページの !important より強い）
    const s = host.style;
    s.setProperty("all", "initial", "important");
    s.setProperty("position", "fixed", "important");
    s.setProperty("right", "16px", "important");
    s.setProperty("bottom", "16px", "important");
    s.setProperty("z-index", "2147483647", "important");
    // クリップボードの貼り直しはユーザーのクリックで発火するので、絶対に邪魔しない
    s.setProperty("pointer-events", "none", "important");

    const root = host.attachShadow({ mode: "closed" });
    // innerHTML は Trusted Types を強制しているページで弾かれうるので組み立てる
    const style = document.createElement("style");
    style.textContent = [
      ".box{box-sizing:border-box;max-width:380px;padding:12px 16px;border-radius:10px;",
      "background:rgba(28,28,30,.94);color:#fff;",
      "font:14px/1.55 system-ui,-apple-system,'Segoe UI','Yu Gothic UI',sans-serif;",
      "box-shadow:0 6px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);",
      "transition:opacity .2s ease,transform .2s ease}",
      ".box.show{opacity:1;transform:none}",
      ".t{font-weight:700;font-size:13px;margin-bottom:2px}",
      ".b{white-space:pre-wrap;word-break:break-word}",
      "@media (prefers-reduced-motion:reduce){.box{transition:none}}"
    ].join("");
    const box = document.createElement("div");
    box.className = "box";
    const title = document.createElement("div");
    title.className = "t";
    const body = document.createElement("div");
    body.className = "b";
    box.appendChild(title);
    box.appendChild(body);
    root.appendChild(style);
    root.appendChild(box);

    // body ではなく documentElement に付ける（body 側のスタイル退避と無関係にしておく）
    document.documentElement.appendChild(host);
    host.__box = box;
    host.__title = title;
    host.__body = body;
    globalThis.__fullPageShotToast = host;
    return host;
  }

  function hideToast(host) {
    if (!host || !host.isConnected) return;
    host.__box.classList.remove("show");
    // 消えるアニメーションが終わってからDOMごと捨てる（ページに残さない）
    host.__dropTimer = setTimeout(function () { removeToast(); }, TOAST_FADE_MS);
  }

  function removeToast() {
    const host = globalThis.__fullPageShotToast;
    globalThis.__fullPageShotToast = null;
    if (!host) return;
    try {
      clearTimeout(host.__hideTimer);
      clearTimeout(host.__dropTimer);
      clearTimeout(host.__showTimer);
      if (host.isConnected) host.remove();
    } catch (e) { /* 何もしない */ }
  }

  // バックグラウンドタブでは rAF が止まるので、タイマーと競走させて必ず先へ進める。
  // 進んだ先の撮影依頼がサービスワーカー側で弾かれ、「タブが切り替わりました」を出せる
  function nextFrame() {
    return new Promise(function (r) {
      let done = false;
      const fire = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        r();
      };
      const timer = setTimeout(fire, 200);
      requestAnimationFrame(fire);
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function errText(e) {
    if (!e) return "原因不明のエラー";
    return String(e.message || e);
  }
})();
