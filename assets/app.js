/* 47都道府県 料理制覇マップ — フロントエンド
 * data/prefectures.json（地方区分 + 都道府県辞書）、data/japan-map.json（SVG 地図）、
 * data/posts.json（投稿配列）を読み、日本地図の choropleth を描画する。
 * 投稿モジュール(post.js)向けに window.JFM を公開する。
 */
(function () {
  "use strict";

  // 制覇の分母
  const TOTAL = 47;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const $ = (sel) => document.querySelector(sel);

  // 描画に使うデータをモジュールスコープに保持
  const state = { posts: [], byCode: new Map(), prefs: {}, regions: [], map: null };
  const mapRefs = { el: null, svg: null, label: null, paths: new Map(), pins: new Map(), tip: null };

  // ---- ユーティリティ -------------------------------------------------
  // 投稿数に応じた塗りの段階 (色は styles.css の .lv1〜.lv4)
  function levelFor(n) {
    return n >= 5 ? 4 : n >= 3 ? 3 : n >= 2 ? 2 : 1;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  const allCodes = () => Object.keys(state.prefs).sort();
  const regionCodes = (key) => allCodes().filter((c) => state.prefs[c].region === key);
  const isLocal = (post) => post.local === true;

  function nameOf(code) {
    const p = state.prefs[code];
    return p ? p.ja : code;
  }

  // 「現地で食べた」は地図のマーカーと同じ藍色の点で統一する
  const PIN_DOT = `<i class="pin-dot" aria-hidden="true"></i>`;
  const LOCAL_BADGE = `<span class="local-badge" title="現地で食べた">${PIN_DOT}現地</span>`;
  const PEND_BADGE = `<span class="pend-badge" title="公開サイトへ反映中(1〜2分)">⏳反映中</span>`;

  function mediaHTML(post, cls) {
    // 反映待ちの投稿は、Pages 配信前でも見えるソース(セッション内blob→raw URL)を優先
    const src = post.imageLocal || (post.pending && post.imageRemote) || post.image;
    if (src) {
      return `<img class="${cls}" src="${esc(src)}" alt="${esc(post.pref)}の料理" loading="lazy" />`;
    }
    const p = state.prefs[post.code];
    return `<div class="card-ph">${esc(p ? p.short : "🍽️")}</div>`;
  }

  // ---- 都道府県名リゾルバ（post.js からも利用） -----------------------
  // 全角/半角・カタカナ/ひらがな・長音記号付きローマ字(Ō)・記号の違いを吸収する
  function normalize(raw) {
    let s = String(raw == null ? "" : raw).normalize("NFKC").trim().toLowerCase();
    s = s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
    s = s.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
    s = s.replace(/[\s#＃「」『』()（）:：、。・,.'"\-_/]+/g, "");
    // ローマ字の長音ゆれ (Toukyou / Oosaka / Hokkaidou)
    if (/^[a-z]+$/.test(s)) s = s.replace(/ou/g, "o").replace(/oo/g, "o").replace(/uu/g, "u");
    return s;
  }

  let resolverIndex = null;
  function buildResolver() {
    resolverIndex = new Map();
    const put = (k, code) => {
      const key = normalize(k);
      if (key && !resolverIndex.has(key)) resolverIndex.set(key, code);
    };
    const SUFFIX = { 都: ["と", "to"], 府: ["ふ", "fu"], 県: ["けん", "ken"] };
    for (const code of allCodes()) {
      const p = state.prefs[code];
      put(code, code);                // 13
      put(String(Number(code)), code); // 1 (= 01)
      put("jp" + code, code);         // JP-13
      put(p.ja, code);                // 東京都
      put(p.short, code);             // 東京
      put(p.kana, code);              // とうきょう
      put(p.en, code);                // Tokyo
      put(p.en + "prefecture", code); // Tokyo Prefecture
      const suf = SUFFIX[p.ja.slice(-1)];
      if (suf) {
        put(p.kana + suf[0], code);   // とうきょうと
        put(p.en + suf[1], code);     // Tokyo-to
      }
    }
  }
  function resolvePref(raw) {
    if (!resolverIndex) buildResolver();
    const s = normalize(raw);
    return (s && resolverIndex.get(s)) || null;
  }

  // ---- データ読込 -----------------------------------------------------
  async function loadJSON(path, fallback) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (e) {
      console.warn("load failed:", path, e);
      return fallback;
    }
  }

  // ---- 反映待ち投稿（GitHub Pages のデプロイラグ対策） -----------------
  // 投稿/編集/削除の直後は公開サイトへの反映に1〜2分かかる。その間に再読込
  // しても消えないよう、post.js が localStorage("jfm-pending") に控えを残す。
  // 公開版に反映されたのを確認できた控えはここで破棄する。
  const PENDING_KEY = "jfm-pending";
  function mergePending(posts) {
    let pending = [];
    try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); } catch (e) { /* noop */ }
    if (!Array.isArray(pending) || !pending.length) return posts;
    const keep = [];
    const DAY = 24 * 3600 * 1000;
    for (const pd of pending) {
      if (!pd || Date.now() - (pd.savedAt || 0) > DAY) continue; // 期限切れは破棄
      if (pd.type === "del") {
        if (posts.some((p) => p.id === pd.id)) {
          posts = posts.filter((p) => p.id !== pd.id); // まだ残っている→隠す
          keep.push(pd);
        }
        // 公開版からも消えていれば控え不要
      } else if (pd.post) {
        const f = posts.find((p) => p.id === pd.post.id);
        if (f && f.rev && f.rev === pd.post.rev) continue; // 反映済み→控え破棄
        const merged = Object.assign({}, pd.post, { pending: true, imageRemote: pd.imageRemote });
        const i = posts.findIndex((p) => p.id === pd.post.id);
        if (i >= 0) posts[i] = merged; else posts.push(merged);
        keep.push(pd);
      }
    }
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(keep)); } catch (e) { /* noop */ }
    return posts;
  }

  // ---- メイン ---------------------------------------------------------
  async function main() {
    const [prefData, mapData, posts] = await Promise.all([
      loadJSON("data/prefectures.json", { regions: [], prefs: {} }),
      loadJSON("data/japan-map.json", null),
      loadJSON("data/posts.json", []),
    ]);
    state.prefs = prefData.prefs || {};
    state.regions = prefData.regions || [];
    state.map = mapData;
    state.posts = mergePending(Array.isArray(posts) ? posts : []);
    buildResolver();
    buildHaystack();

    buildMap(); // SVG は1回だけ作り、以降は塗りだけ更新
    setupSearch();
    setupRegions();
    setupModal();
    setupTheme();
    renderAll();

    // 投稿モジュール(post.js)向けの公開API
    window.JFM = {
      getPrefs: () => state.prefs,
      resolvePref,
      toast,
      closeModal,
      hasPostId: (id) => state.posts.some((p) => p.id === id),
      addPostLive(post) {
        if (!post) return;
        if (post.id && state.posts.some((p) => p.id === post.id)) return;
        state.posts.push(post);
        renderAll();
      },
      updatePostLive(post) {
        if (!post || !post.id) return;
        const i = state.posts.findIndex((p) => p.id === post.id);
        if (i >= 0) state.posts[i] = post;
        else state.posts.push(post);
        renderAll();
      },
      removePostLive(id) {
        const before = state.posts.length;
        state.posts = state.posts.filter((p) => p.id !== id);
        if (state.posts.length !== before) renderAll();
      },
    };
    document.dispatchEvent(new Event("jfm:ready"));
  }

  function computeByCode() {
    const m = new Map();
    for (const p of state.posts) {
      const code = p.code ? String(p.code) : "";
      if (!state.prefs[code]) continue;
      if (!m.has(code)) m.set(code, []);
      m.get(code).push(p);
    }
    state.byCode = m;
  }

  function prefStatus(code) {
    const list = state.byCode.get(code) || [];
    return { count: list.length, local: list.filter(isLocal).length };
  }

  // データ変更時にまとめて再描画
  function renderAll() {
    computeByCode();
    renderStats();
    renderMap();
    renderRegions();
    renderFeed();
    renderSearchResults();
    renderFooter();
  }

  // ---- 統計 -----------------------------------------------------------
  function renderStats() {
    const nPrefs = state.byCode.size;
    const nLocal = [...state.byCode.values()].filter((list) => list.some(isLocal)).length;
    const pct = Math.round((nPrefs / TOTAL) * 1000) / 10;
    $("#stat-prefs").textContent = nPrefs;
    $("#stat-percent").textContent = pct;
    $("#stat-local").textContent = nLocal;
    $("#stat-dishes").textContent = state.posts.length;
    $("#meter").setAttribute("aria-valuenow", nPrefs);
    requestAnimationFrame(() => {
      $("#progress-bar").style.width = Math.min(100, pct) + "%";
    });
  }

  // ---- 地図 -----------------------------------------------------------
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  function buildMap() {
    const el = $("#map");
    mapRefs.el = el;
    const m = state.map;
    if (!m || !m.prefs) {
      el.innerHTML = '<p class="map-fallback">地図データを読み込めませんでした。</p>';
      return;
    }
    const svg = svgEl("svg", { viewBox: m.viewBox.join(" "), class: "jmap" });
    // 沖縄インセット枠。島が小さくスマホで押しにくいので、枠内のどこでも沖縄県として反応させる
    const { x, y, w, h } = m.inset;
    svg.appendChild(svgEl("rect", { x, y, width: w, height: h, rx: 12, class: "inset-frame", "data-code": m.inset.code }));
    const label = svgEl("text", { x: x + 14, y: y + 14, class: "inset-label", "dominant-baseline": "hanging" });
    label.textContent = nameOf(m.inset.code);
    svg.appendChild(label);
    mapRefs.svg = svg;
    mapRefs.label = label;

    const gPrefs = svgEl("g", { class: "prefs" });
    const gPins = svgEl("g", { class: "pins" });
    for (const code of Object.keys(m.prefs).sort()) {
      const shape = m.prefs[code];
      const path = svgEl("path", { d: shape.d, class: "pref", "data-code": code });
      gPrefs.appendChild(path);
      mapRefs.paths.set(code, path);
      const pin = svgEl("circle", { cx: shape.px, cy: shape.py, r: 10, class: "pin" });
      gPins.appendChild(pin);
      mapRefs.pins.set(code, pin);
    }
    svg.append(gPrefs, gPins);

    const tip = document.createElement("div");
    tip.className = "map-tip";
    tip.hidden = true;
    mapRefs.tip = tip;

    el.innerHTML = "";
    el.append(svg, tip);

    const codeAt = (target) => {
      const hit = target && target.closest ? target.closest("path.pref, .inset-frame") : null;
      return hit ? hit.getAttribute("data-code") : null;
    };
    svg.addEventListener("click", (e) => {
      const code = codeAt(e.target);
      if (code) onPrefPick(code);
    });
    // ツールチップはマウスのみ（タッチはタップ＝開く）
    svg.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const code = codeAt(e.target);
      if (code) showTip(code, e); else hideTip();
    });
    svg.addEventListener("pointerleave", hideTip);

    // 地図の表示幅が変わっても、マーカーと沖縄ラベルは画面上で同じ大きさに保つ
    sizeMarks();
    if (window.ResizeObserver) new ResizeObserver(sizeMarks).observe(svg);
  }

  const PIN_RADIUS_PX = 4.5; // マーカー直径9px + 縁取り2px（小さい県を隠しすぎない）
  const LABEL_SIZE_PX = 12;
  function sizeMarks() {
    const w = mapRefs.svg && mapRefs.svg.getBoundingClientRect().width;
    if (!w) return;
    const unitsPerPx = state.map.viewBox[2] / w;
    for (const pin of mapRefs.pins.values()) pin.setAttribute("r", (PIN_RADIUS_PX * unitsPerPx).toFixed(1));
    mapRefs.label.setAttribute("font-size", (LABEL_SIZE_PX * unitsPerPx).toFixed(1));
  }

  function showTip(code, e) {
    const tip = mapRefs.tip;
    const st = prefStatus(code);
    tip.innerHTML = st.count
      ? `<strong>${esc(nameOf(code))}</strong><br>食べた・${st.count}品${st.local ? `（うち${PIN_DOT}現地 ${st.local}）` : ""}`
      : `<strong>${esc(nameOf(code))}</strong><br><span class="tip-soft">未食</span>`;
    const r = mapRefs.el.getBoundingClientRect();
    tip.style.left = e.clientX - r.left + "px";
    tip.style.top = e.clientY - r.top + "px";
    tip.hidden = false;
  }
  function hideTip() {
    if (mapRefs.tip) mapRefs.tip.hidden = true;
  }

  function renderMap() {
    for (const [code, path] of mapRefs.paths) {
      const st = prefStatus(code);
      path.classList.remove("lv1", "lv2", "lv3", "lv4");
      if (st.count) path.classList.add("lv" + levelFor(st.count));
      mapRefs.pins.get(code).classList.toggle("is-on", st.local > 0);
    }
  }

  // 県を選んだとき: 食べた県はモーダル、未食の県は地図でハイライト
  function onPrefPick(code) {
    if (state.byCode.has(code)) {
      hideTip();
      openModal(code);
    } else {
      highlightPref(code);
      toast(`${nameOf(code)} はまだ食べていません`);
    }
  }

  // 地図上で該当県を一時的にハイライト（点滅）し、地図までスクロール
  function highlightPref(code, scroll) {
    const path = mapRefs.paths.get(code);
    if (!path) return;
    if (scroll) mapRefs.el.scrollIntoView({ behavior: "smooth", block: "center" });
    path.parentNode.appendChild(path); // 縁取りが隣県に隠れないよう最前面へ
    path.classList.remove("is-flash");
    void path.getBoundingClientRect(); // アニメーションを再始動
    path.classList.add("is-flash");
    clearTimeout(path._flashTimer);
    path._flashTimer = setTimeout(() => path.classList.remove("is-flash"), 1800);
  }

  // ---- 地方別の制覇状況 -----------------------------------------------
  function renderRegions() {
    const el = $("#regions");
    el.innerHTML = state.regions
      .map((r) => {
        const codes = regionCodes(r.key);
        const done = codes.filter((c) => state.byCode.has(c)).length;
        const pct = codes.length ? Math.round((done / codes.length) * 100) : 0;
        const complete = codes.length > 0 && done === codes.length;
        // 県ごとに1マス。色は地図と同じ段階、現地で食べた県は中に藍の点
        const cells = codes
          .map((c) => {
            const st = prefStatus(c);
            const cls = (st.count ? " lv" + levelFor(st.count) : "") + (st.local ? " is-local" : "");
            return `<i class="rcell${cls}" title="${esc(state.prefs[c].ja)}${st.count ? `・${st.count}品` : "・未食"}"></i>`;
          })
          .join("");
        return `<button type="button" class="region${complete ? " is-complete" : ""}" data-region="${esc(r.key)}"
            aria-label="${esc(r.name)} ${done} / ${codes.length} 県（${pct}%）">
          <span class="region-name">${esc(r.name)}${complete ? `<span class="region-done">制覇</span>` : ""}</span>
          <span class="region-count"><b>${done}</b><small> / ${codes.length}</small></span>
          <span class="region-cells" aria-hidden="true">${cells}</span>
        </button>`;
      })
      .join("");
  }

  function setupRegions() {
    // 地方を押すと「都道府県をさがす」の該当地方へジャンプ
    $("#regions").addEventListener("click", (e) => {
      const btn = e.target.closest(".region");
      if (!btn) return;
      search.q = "";
      search.filter = "all";
      $("#pref-search").value = "";
      applyChipUI();
      renderSearchResults();
      const group = document.getElementById("sgroup-" + btn.getAttribute("data-region"));
      if (group) group.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ---- フィード -------------------------------------------------------
  function renderFeed() {
    const feed = $("#feed");
    const posts = state.posts;
    if (!posts.length) {
      feed.innerHTML = `<div class="feed-empty"><span class="feed-empty-icon" aria-hidden="true">🍽️</span>
        <p><b>まだ投稿がありません</b><br>食べた料理がここに並びます。</p></div>`;
      return;
    }
    const sorted = [...posts].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    feed.innerHTML = sorted
      .slice(0, 24)
      .map((p) => {
        const name = p.pref || nameOf(p.code);
        const title = p.dish ? esc(p.dish) : esc(name);
        const badges = (isLocal(p) ? " " + LOCAL_BADGE : "") + (p.pending ? " " + PEND_BADGE : "");
        const meta = (p.dish ? `${esc(name)} ・ ${fmtDate(p.date)}` : fmtDate(p.date)) + badges;
        return `
        <article class="card" data-code="${esc(p.code || "")}" tabindex="0">
          ${mediaHTML(p, "card-img")}
          <div class="card-body">
            <div class="card-dish">${title}</div>
            <div class="card-meta">${meta}</div>
            ${p.comment ? `<p class="card-comment">${esc(p.comment)}</p>` : ""}
          </div>
        </article>`;
      })
      .join("");

    feed.querySelectorAll(".card").forEach((el) => {
      const open = () => {
        const code = el.getAttribute("data-code");
        if (code && state.byCode.has(code)) openModal(code);
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
  }

  // ---- 都道府県さがし（検索） ----------------------------------------
  const search = { q: "", filter: "all" };
  const haystack = new Map(); // code -> 検索対象の正規化済み文字列

  function buildHaystack() {
    for (const code of allCodes()) {
      const p = state.prefs[code];
      haystack.set(code, [p.ja, p.kana, p.en].map(normalize));
    }
  }

  function matchesQuery(code, q) {
    if (!q) return true;
    if (/^\d+$/.test(q)) return code === q.padStart(2, "0"); // 都道府県コードは完全一致
    return haystack.get(code).some((h) => h.includes(q));
  }

  function passesFilter(code) {
    const st = prefStatus(code);
    if (search.filter === "eaten") return st.count > 0;
    if (search.filter === "local") return st.local > 0;
    if (search.filter === "todo") return st.count === 0;
    return true;
  }

  function rowHTML(code) {
    const p = state.prefs[code];
    const st = prefStatus(code);
    const eaten = st.count > 0;
    // 未食は控えめに、食べた県だけ地図と同じ色のマスと品数で目立たせる
    return `<button type="button" class="srow${eaten ? " is-eaten" : ""}" data-code="${code}">
      <i class="srow-sw${eaten ? " lv" + levelFor(st.count) : ""}" aria-hidden="true"></i>
      <span class="srow-name">${esc(p.ja)}<span class="srow-sub">${esc(p.kana)}</span></span>
      ${st.local ? `<span class="srow-pin" title="現地で食べた">${PIN_DOT}</span>` : ""}
      <span class="srow-status">${eaten ? `${st.count}品` : "未食"}</span>
    </button>`;
  }

  function renderSearchResults() {
    const resultsEl = $("#search-results");
    const summaryEl = $("#search-summary");
    const q = normalize(search.q);

    let shown = 0;
    const html = state.regions
      .map((r) => {
        const codes = regionCodes(r.key);
        const hits = codes.filter((c) => passesFilter(c) && matchesQuery(c, q));
        if (!hits.length) return "";
        shown += hits.length;
        const done = codes.filter((c) => state.byCode.has(c)).length;
        return `<div class="sgroup" id="sgroup-${esc(r.key)}">
          <h3 class="sgroup-h">${esc(r.name)}<span class="sgroup-count">${done} / ${codes.length}</span></h3>
          <div class="sgrid">${hits.map(rowHTML).join("")}</div>
        </div>`;
      })
      .join("");

    const nEaten = state.byCode.size;
    const nLocal = allCodes().filter((c) => prefStatus(c).local > 0).length;
    summaryEl.textContent = `食べた ${nEaten} 県 ／ 全 ${TOTAL} 都道府県（うち現地で食べた ${nLocal} 県）`;
    resultsEl.innerHTML = shown ? html : `<p class="search-empty">該当する都道府県がありません。</p>`;

    resultsEl.querySelectorAll(".srow").forEach((el) => {
      el.addEventListener("click", () => {
        const code = el.getAttribute("data-code");
        if (state.byCode.has(code)) openModal(code);
        else {
          highlightPref(code, true);
          toast(`${nameOf(code)} はまだ食べていません`);
        }
      });
    });
  }

  function applyChipUI() {
    document.querySelectorAll("#filter-chips .chip").forEach((c) =>
      c.classList.toggle("is-active", c.getAttribute("data-filter") === search.filter)
    );
  }

  function setupSearch() {
    const input = $("#pref-search");
    const params = new URLSearchParams(location.search);
    if (params.get("q")) { search.q = params.get("q"); input.value = search.q; }
    const f = params.get("filter");
    if (f && ["all", "eaten", "local", "todo"].includes(f)) search.filter = f;
    applyChipUI();

    input.addEventListener("input", () => { search.q = input.value; renderSearchResults(); });
    document.querySelectorAll("#filter-chips .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        search.filter = chip.getAttribute("data-filter");
        applyChipUI();
        renderSearchResults();
      });
    });
  }

  // ---- トースト -------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  // ---- モーダル -------------------------------------------------------
  function openModal(code) {
    const list = state.byCode.get(code) || [];
    if (!list.length) return;
    const sorted = [...list].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const nLocal = list.filter(isLocal).length;
    $("#modal-title").innerHTML =
      `${esc(nameOf(code))} <span class="modal-sub">・${list.length}品${nLocal ? `（うち現地 ${nLocal}）` : ""}</span>`;
    const admin = !!(window.JFMPost && window.JFMPost.isAdmin && window.JFMPost.isAdmin());
    $("#modal-body").innerHTML = sorted
      .map(
        (p) => `
      <div class="mpost">
        ${mediaHTML(p, "")}
        ${p.dish ? `<div class="mpost-dish">${esc(p.dish)}</div>` : ""}
        ${p.comment ? `<p class="mpost-comment">${esc(p.comment)}</p>` : ""}
        <div class="mpost-date">${fmtDate(p.date)}${isLocal(p) ? " " + LOCAL_BADGE : ""}${p.pending ? " " + PEND_BADGE : ""}</div>
        ${admin ? `<div class="mpost-actions"><button type="button" class="mpost-btn mpost-edit">編集</button><button type="button" class="mpost-btn mpost-del">削除</button></div>` : ""}
      </div>`
      )
      .join("");
    if (admin) {
      $("#modal-body").querySelectorAll(".mpost").forEach((el, i) => {
        const p = sorted[i];
        const eb = el.querySelector(".mpost-edit");
        const db = el.querySelector(".mpost-del");
        if (eb) eb.addEventListener("click", () => window.JFMPost.editPost(p));
        if (db) db.addEventListener("click", () => window.JFMPost.deletePost(p));
      });
    }
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    $("#modal").hidden = true;
    document.body.style.overflow = "";
  }

  function setupModal() {
    const modal = $("#modal");
    $("#modal-close").addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });
  }

  // ---- フッター / テーマ ---------------------------------------------
  function renderFooter() {
    const latest = state.posts.map((p) => p.date).filter(Boolean).sort().pop();
    $("#footer-updated").textContent = latest ? `最終更新: ${fmtDate(latest)}` : "47都道府県 料理制覇マップ";
  }

  function setupTheme() {
    const KEY = "jfm-theme";
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* noop */ }
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    $("#theme-toggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const isDark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      const next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* noop */ }
    });
  }

  document.addEventListener("DOMContentLoaded", main);
})();
