/* =====================================================================
   Équités préflop Texas Hold'em — la page (navigateur uniquement).
   Le moteur de calcul et le format des fichiers sont dans engine.js,
   les textes dans i18n.js : ces deux fichiers sont chargés avant celui-ci.

   1. Stockage des résultats : fichiers results/*.json (via server.js) + mémoire du navigateur
   2. Calcul parallèle sur tous les cœurs du processeur
   3. Langue et thème
   4. Interface (deux tableaux, tri, filtres, couleurs, menus)
   ===================================================================== */

"use strict";

/* =====================================================================
   1. STOCKAGE DES RÉSULTATS (format : voir engine.js)
   Chaque jeu de résultats a un nom : "<donnes>" pour le premier tableau,
   "<donnes>-top<p>" pour le second.
   - fichiers results/<nom>.json, lus et écrits par server.js
   - mémoire du navigateur (localStorage) : sauvegarde main par main pendant
     un calcul, et seul stockage quand la page est ouverte sans serveur
   ===================================================================== */
const STORAGE_PREFIX = "equites-preflop-v3-";

const setName = (trials, top) => (top ? trials + "-top" + top : String(trials));

function storageRead(name) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + name);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function storageWrite(name, set) {
  try {
    localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(set));
    return true;
  } catch (e) {
    return false;
  }
}
function storageRemove(name) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + name);
  } catch (e) {
    /* rien à faire */
  }
}

/* Le serveur (server.js) répond-il ? Sans lui (index.html ouvert directement),
   la page ne peut ni lire ni écrire les fichiers JSON. */
async function detectServer() {
  if (typeof location === "undefined" || !/^https?:$/.test(location.protocol))
    return false;
  try {
    const r = await fetch("api/ping", { cache: "no-store" });
    return r.ok && (await r.json()).ok === true;
  } catch (e) {
    return false;
  }
}

// Lit results/<nom>.json, ou null s'il n'existe pas encore (top : second tableau)
async function loadResultsFile(trials, top) {
  try {
    const r = await fetch("results/" + setName(trials, top) + ".json", {
      cache: "no-store",
    });
    if (!r.ok) return null;
    const set = await r.json();
    const problem = top ? validateRangeResults(set) : validateResults(set);
    return problem || set.trials !== trials || (top && set.top !== top)
      ? null
      : set;
  } catch (e) {
    return null;
  }
}

// Demande au serveur d'écrire results/<nom>.json. Renvoie null si tout va bien, sinon le message d'erreur.
async function saveResultsFile(set) {
  try {
    const r = await fetch("api/results/" + setName(set.trials, set.top), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(set),
    });
    const answer = await r.json().catch(() => ({}));
    return r.ok ? null : answer.error || "erreur " + r.status;
  } catch (e) {
    return "serveur injoignable";
  }
}

const isComplete = (set, n) =>
  !!set && !!set.hands && Object.keys(set.hands).length === n;

/* =====================================================================
   2. CALCUL PARALLÈLE
   Le moteur est recopié dans des Web Workers (un par cœur).
   Une tâche = une main (voir Engine.simulateJob) ; chaque worker en calcule
   une puis en demande une autre. Sans Workers, repli sur le fil principal.
   ===================================================================== */
function createComputer(onResult, onDone) {
  let workers = [],
    jobs = [],
    queue = [],
    running = 0,
    stopped = false;
  const size = Math.max(
    1,
    Math.min(
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2,
      16,
    ),
  );

  function makeWorkers() {
    const src =
      '"use strict";const E=(' +
      pokerEngine.toString() +
      ")();" +
      "onmessage=function(e){var d=e.data;" +
      "postMessage({id:d.id,result:E.simulateJob(d.job,E.makeRng(E.randomSeed()))});};";
    const url = URL.createObjectURL(
      new Blob([src], { type: "text/javascript" }),
    );
    const list = [];
    for (let i = 0; i < size; i++) list.push(new Worker(url));
    return list;
  }

  let finished = false;
  const finish = () => {
    if (!finished && !stopped) {
      finished = true;
      onDone();
    }
  };

  function feed(worker) {
    if (stopped || !queue.length) {
      if (running === 0) finish();
      return;
    }
    const id = queue.shift();
    running++;
    worker.onmessage = (e) => {
      running--;
      if (stopped) return;
      onResult(jobs[e.data.id], e.data.result);
      feed(worker);
    };
    worker.postMessage({ id, job: jobs[id] });
  }

  /* Repli : fil principal. Premier tableau par lots de 100 000 donnes pour garder
     la page réactive ; second tableau main par main (la page se fige un instant). */
  function runMainThread() {
    const CHUNK = 100000;
    const hands = Engine.buildHands();
    let id = null,
      raw = null,
      rand = Engine.makeRng(Engine.randomSeed());
    function step() {
      if (stopped) return;
      if (id === null) {
        if (!queue.length) return finish();
        id = queue.shift();
        raw = null;
      }
      const job = jobs[id];
      if (job.ranges) {
        onResult(job, Engine.simulateJob(job, rand));
        id = null;
        return setTimeout(step, 0);
      }
      const end = performance.now() + 40;
      while (performance.now() < end && (!raw || raw.trials < job.trials)) {
        const n = Math.min(CHUNK, job.trials - (raw ? raw.trials : 0));
        const part = Engine.simulateHand(hands[job.index], n, rand);
        if (!raw) raw = part;
        else {
          raw.trials += part.trials;
          for (let k = 0; k < raw.equity.length; k++) {
            raw.equity[k] += part.equity[k];
            raw.wins[k] += part.wins[k];
          }
        }
      }
      if (raw.trials >= job.trials) {
        onResult(job, Engine.toPercent(raw));
        id = null;
      }
      setTimeout(step, 0);
    }
    setTimeout(step, 0);
  }

  return {
    threads: size,
    start(list) {
      stopped = false;
      finished = false;
      jobs = list;
      queue = list.map((j, i) => i);
      running = 0;
      try {
        if (!workers.length) workers = makeWorkers();
        workers.forEach((w) => feed(w));
        return "workers";
      } catch (e) {
        workers = [];
        runMainThread();
        return "main";
      }
    },
    stop() {
      stopped = true;
      queue = [];
      workers.forEach((w) => w.terminate());
      workers = [];
    },
  };
}

/* =====================================================================
   3. LANGUE ET THÈME (les textes sont dans i18n.js)
   ===================================================================== */
const LANG_KEY = "equites-preflop-lang";
const THEME_KEY = "equites-preflop-theme"; // aussi lu dans index.html, avant l'affichage
const COLORBLIND_KEY = "equites-preflop-colorblind";

// Langue par défaut : choix déjà fait, sinon français si le navigateur est en français, sinon anglais
function detectLanguage() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && I18N[saved]) return saved;
  } catch (e) {
    /* pas de mémoire disponible */
  }
  const first =
    (navigator.languages && navigator.languages[0]) ||
    navigator.language ||
    "en";
  return first.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/* =====================================================================
   4. INTERFACE
   ===================================================================== */

/* Couleurs des cases, par paliers de top.
   Dans chaque colonne, une main prend la couleur du premier palier qui la contient :
   top: 3 = les mains du top 0 à 3 %, puis top: 8 = de 3 à 8 %, etc.
   (top d'une main = son rang dans la colonne / nombre de mains, comme la colonne « Top »).
   Lignes à ajouter, retirer ou modifier librement ; la dernière doit valoir 100.
   normal : couleurs habituelles ; colorblind : mode daltonien (bleu au lieu de vert).
   La couleur du texte, claire ou foncée, est choisie automatiquement. */
const COLOR_TIERS = [
  { top: 3, normal: "#0b6b35", colorblind: "#08306b" },
  { top: 8, normal: "#1a9850", colorblind: "#2166ac" },
  { top: 15, normal: "#66bd63", colorblind: "#4393c3" },
  { top: 25, normal: "#a6d96a", colorblind: "#92c5de" },
  { top: 40, normal: "#d9ef8b", colorblind: "#d1e5f0" },
  { top: 55, normal: "#fee08b", colorblind: "#fddbc7" },
  { top: 70, normal: "#fdae61", colorblind: "#f4a582" },
  { top: 85, normal: "#f46d43", colorblind: "#d6604d" },
  { top: 100, normal: "#d73027", colorblind: "#b2182b" },
];

// En thème sombre, les couleurs sont mélangées au fond pour moins éblouir (0 = pas du tout)
const DARK_DIM = 0.45;

/* Drapeaux dessinés en SVG, tous au même format 3:2 (les emoji drapeaux ne s'affichent pas sous Windows) */
const FLAGS = {
  fr:
    '<svg viewBox="0 0 30 20" width="24" height="16" aria-hidden="true">' +
    '<rect width="10" height="20" fill="#0055a4"/><rect x="10" width="10" height="20" fill="#ffffff"/>' +
    '<rect x="20" width="10" height="20" fill="#ef4135"/></svg>',
  en:
    '<svg viewBox="0 0 30 20" width="24" height="16" aria-hidden="true">' +
    '<rect width="30" height="20" fill="#012169"/>' +
    '<path d="M0,0 L30,20 M30,0 L0,20" stroke="#ffffff" stroke-width="4"/>' +
    '<path d="M0,0 L30,20 M30,0 L0,20" stroke="#c8102e" stroke-width="1.4"/>' +
    '<path d="M15,0 V20 M0,10 H30" stroke="#ffffff" stroke-width="6.6"/>' +
    '<path d="M15,0 V20 M0,10 H30" stroke="#c8102e" stroke-width="4"/></svg>',
};
const LANG_NAMES = { fr: "Français", en: "English" };

/* Soleil et lune du menu de thème, dessinés en SVG comme les drapeaux */
const THEME_ICONS = {
  light:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<circle cx="12" cy="12" r="4.2" fill="currentColor"/>' +
    '<path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
  dark:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z" fill="currentColor"/></svg>',
};

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToCss = (c) => "rgb(" + c.map((v) => Math.round(v)).join(" ") + ")";
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// Luminance relative (WCAG), pour choisir un texte clair ou foncé lisible sur la case
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* Écart maximal attendu sur tout le tableau (169 mains × 9 colonnes).
   Pour une case seule, l'écart type vaut au plus 50 / √donnes points.
   Sur 1 521 cases, on prend 4 écarts types : la probabilité qu'une case au moins
   dépasse cette marge est d'environ 10 %. */
const tableMargin = (trials) => (4 * 50) / Math.sqrt(trials);

function initPage() {
  const $ = (id) => document.getElementById(id);
  const hands = Engine.buildHands();
  const N = hands.length;
  const MAX_OPP = Engine.MAX_OPP;

  let lang = detectLanguage();
  let colorblind = false;
  try {
    colorblind = localStorage.getItem(COLORBLIND_KEY) === "1";
  } catch (e) {
    /* rien */
  }

  let trials = TRIAL_CHOICES[TRIAL_CHOICES.length - 1]; // au démarrage : le plus grand jeu disponible
  let top = TOP_CHOICES[0]; // second tableau : adversaires dans le top <top> %
  let serverMode = false; // true si server.js répond : les résultats s'écrivent dans results/*.json
  let computer = null; // un seul calcul à la fois, tous cœurs utilisés
  let filter = "all",
    measure = "eq",
    query = "";

  /* --- Textes --- */
  const t = (key, vars) => {
    let s = I18N[lang][key];
    if (s === undefined) s = I18N.fr[key] || key;
    if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  };
  const plural = (key, n, vars) =>
    t(n > 1 ? key + "Plural" : key, Object.assign({ n }, vars));
  const fmt = (v, d) =>
    new Intl.NumberFormat(t("locale"), {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(v);
  const int = (v) => new Intl.NumberFormat(t("locale")).format(v);
  const decimals = () => (trials >= 5000000 ? 2 : 1);
  const marginText = (n) =>
    fmt(tableMargin(n), tableMargin(n) >= 0.095 ? 1 : 2);
  const dateText = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return t("dateAt", {
      d: d.toLocaleDateString(t("locale")),
      h: d.toLocaleTimeString(t("locale"), {
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  };
  const durationText = (s) =>
    s < 90
      ? t("seconds", { n: Math.max(1, Math.round(s)) })
      : s < 5400
        ? t("minutes", { n: Math.round(s / 60) })
        : t("hours", {
            h: Math.floor(s / 3600),
            m: Math.round((s % 3600) / 60),
          });
  // « en 27 min sur 16 cœurs », si le fichier contient la durée (anciens fichiers : rien)
  const tookText = (set) =>
    typeof set.duration === "number"
      ? t("took", {
          x: durationText(set.duration),
          t: plural("cores", set.threads || 1),
        })
      : "";
  const escapeAttr =(s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  /* --- Les deux calculs ---
     Chacun a son jeu affiché (shown, fichier ou navigateur) et son recalcul
     en cours ou interrompu (fresh, gardé main par main dans le navigateur).
     Le second tableau a besoin du premier : il en tire le classement des mains. */
  const newCalc = (o) =>
    Object.assign(
      {
        shown: null,
        shownFrom: "", // "file" | "local"
        fresh: null,
        computing: false,
        loaded: false,
        saveNote: "", // clé et valeur du dernier problème d'enregistrement
        runStart: 0,
        durationBefore: 0, // durée des parties déjà faites d'un calcul repris
        runDoneAtStart: 0,
      },
      o,
    );
  const calcs = [
    newCalc({
      ui: {
        run: "run",
        resume: "resume",
        progress: "progress",
        track: "progress-track",
        status: "status",
      },
      top: () => null,
      newSet: () => ({ trials, computedAt: null, hands: {} }),
      jobs: (set, indices) =>
        indices.map((index) => ({ index, trials: set.trials })),
      canStart: () => true,
      serverCommand: () => "node compute.js " + trials,
    }),
    newCalc({
      ui: {
        run: "run2",
        resume: "resume2",
        progress: "progress2",
        track: "progress-track2",
        status: "range-status",
      },
      top: () => top,
      newSet: () => {
        const base = calcs[0].shown;
        if (!base) return null;
        return {
          trials,
          top,
          computedAt: null,
          basedOn: base.computedAt,
          ranges: topRanges(base, top),
          hands: {},
        };
      },
      jobs: (set, indices) => {
        const ranges = set.ranges.map(rangeCombos);
        return indices.map((index) => ({ index, trials: set.trials, ranges }));
      },
      canStart: () => !!calcs[0].shown,
      serverCommand: () => "node compute.js --top=" + top + " " + trials,
    }),
  ];
  const nameOf = (c) => setName(trials, c.top());
  const busy = () => calcs.some((c) => c.computing);

  // Données d'une main : le recalcul en cours prime, sinon le jeu complet
  function cell(c, i) {
    const name = hands[i].name;
    if (c.computing || (c.fresh && !c.shown)) {
      if (c.fresh && c.fresh.hands[name])
        return { data: c.fresh.hands[name], old: false };
      if (c.shown && c.shown.hands[name])
        return { data: c.shown.hands[name], old: true };
      return null;
    }
    return c.shown && c.shown.hands[name]
      ? { data: c.shown.hands[name], old: false }
      : null;
  }
  // null : main pas encore calculée, ou case presque impossible (second tableau)
  const valueOf = (c, i, k) => {
    const x = cell(c, i);
    return x ? (measure === "eq" ? x.data.eq : x.data.win)[k - 1] : null;
  };
  const rangesOf = (c) => {
    const set = c.computing || (c.fresh && !c.shown) ? c.fresh : c.shown;
    return set && set.ranges;
  };

  /* Les deux tableaux partagent filtres, recherche et mesure ;
     chacun garde son tri et la colonne qui sert au rang et au top. */
  const tables = [
    {
      calc: calcs[0],
      head: $("hrow"),
      body: $("tb"),
      sortCol: 1,
      sortDir: -1,
      rankCol: 1, // colonne de joueurs qui sert au rang et au top
      fair: (k) => t("thAvg", { v: fmt(100 / (k + 1), 1) }),
      headTitle: () => "",
    },
    {
      calc: calcs[1],
      head: $("hrow2"),
      body: $("tb2"),
      sortCol: 1,
      sortDir: -1,
      rankCol: 1,
      fair: () => "&nbsp;",
      headTitle: (k) => {
        const r = rangesOf(calcs[1]);
        return r ? t("rangeHead", { p: k + 1, list: r[k - 1].join(" ") }) : "";
      },
    },
  ];

  /* --- Message à la place d'un tableau pas encore calculé --- */
  function placeholderHTML(c) {
    if (!c.loaded) return t("loading");
    if (c.shown || c.fresh || c.computing) return null;
    if (!c.canStart()) return t("needMain", { trials: int(trials) });
    const cmd = c.serverCommand();
    return (
      '<div class="todo"><p class="todo-title">' +
      (c.top()
        ? t("notComputedRange", { trials: int(trials), p: top })
        : t("notComputed", { trials: int(trials) })) +
      '</p><p><button type="button" class="primary" data-start="' +
      calcs.indexOf(c) +
      '"' +
      (busy() ? " disabled" : "") +
      ">" +
      t("computeHere") +
      '</button> <span class="todo-note">' +
      t("computeHereNote") +
      "</span></p><p>" +
      t("serverCmd") +
      " <code>" +
      cmd +
      "</code><br>" +
      t("dockerCmd") +
      " <code>docker compose exec poker " +
      cmd +
      "</code></p></div>"
    );
  }

  function applyLanguage() {
    document.documentElement.lang = lang;
    document.title = t("title");
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
    });
    $("lang-flag").innerHTML = FLAGS[lang];
    $("lang-btn").setAttribute(
      "aria-label",
      t("langLabel") + " : " + LANG_NAMES[lang],
    );
    $("lang-btn").title = LANG_NAMES[lang];
    document
      .querySelectorAll("[data-lang]")
      .forEach((b) =>
        b.setAttribute("aria-checked", String(b.dataset.lang === lang)),
      );
    $("trials").innerHTML = TRIAL_CHOICES.map(
      (n) =>
        '<option value="' +
        n +
        '"' +
        (n === trials ? " selected" : "") +
        ">" +
        t("trialsOption", { n: int(n), m: marginText(n) }) +
        "</option>",
    ).join("");
    $("top").innerHTML = TOP_CHOICES.map(
      (p) =>
        '<option value="' +
        p +
        '"' +
        (p === top ? " selected" : "") +
        ">" +
        t("topOption", { p }) +
        "</option>",
    ).join("");
    tables.forEach(buildHead);
    render();
    updateStatus();
  }

  /* --- Thème --- */
  const isDark = () => {
    const forced = document.documentElement.getAttribute("data-theme");
    if (forced) return forced === "dark";
    return !!(
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  };
  // Le bouton montre le thème affiché (choisi, sinon celui du système)
  function updateThemeButton() {
    const current = isDark() ? "dark" : "light";
    $("theme-icon").innerHTML = THEME_ICONS[current];
    $("theme-btn").setAttribute(
      "aria-label",
      t("themeLabel") + " : " + t(current),
    );
    $("theme-btn").title = t(current);
    document
      .querySelectorAll("[data-theme-choice]")
      .forEach((b) =>
        b.setAttribute(
          "aria-checked",
          String(b.dataset.themeChoice === current),
        ),
      );
  }

  /* --- Couleurs --- */
  // Style CSS de chaque palier (fond + texte lisible), selon le mode daltonien et le thème
  function tierStyles() {
    const surface = hexToRgb("#171d1a");
    return COLOR_TIERS.map((tier) => {
      let bg = hexToRgb(colorblind ? tier.colorblind : tier.normal);
      if (isDark()) bg = mix(bg, surface, DARK_DIM);
      const ink = luminance(bg) > 0.22 ? "#151a17" : "#f4f7f5";
      return "background-color:" + rgbToCss(bg) + ";color:" + ink;
    });
  }
  // Indice du palier d'une main dont le top vaut pct (en %)
  const tierOf = (pct) => {
    const i = COLOR_TIERS.findIndex((tier) => pct <= tier.top + 1e-9);
    return i < 0 ? COLOR_TIERS.length - 1 : i;
  };
  function updateLegend(styles) {
    $("tiers").innerHTML = COLOR_TIERS.map(
      (tier, i) =>
        '<span class="tier" style="' +
        styles[i] +
        '">' +
        t("legendTier", { v: tier.top }) +
        "</span>",
    ).join("");
    $("colorblind").setAttribute("aria-pressed", String(colorblind));
  }

  /* --- En-tête d'un tableau --- */
  function buildHead(tb) {
    let head =
      '<th class="left sticky" scope="col"><button type="button" data-c="0"><span class="n">' +
      t("thHand") +
      '</span><span class="sub">&nbsp;</span><span class="fair">&nbsp;</span></button></th>' +
      '<th scope="col" class="rankhead"><div class="th-static"><span class="n">' +
      t("thRank") +
      '</span><span class="sub rank-sub"></span><span class="fair">' +
      t("thRankSub") +
      "</span></div></th>" +
      '<th scope="col" class="rankhead last"><div class="th-static"><span class="n">' +
      t("thTop") +
      '</span><span class="sub rank-sub"></span><span class="fair">' +
      t("thTopSub") +
      "</span></div></th>";
    for (let k = 1; k <= MAX_OPP; k++) {
      head +=
        '<th scope="col"><button type="button" data-c="' +
        k +
        '"><span class="n">' +
        t("thPlayers", { p: k + 1 }) +
        "</span>" +
        '<span class="sub">' +
        t("thOpp", { k }) +
        "</span>" +
        '<span class="fair">' +
        tb.fair(k) +
        "</span></button></th>";
    }
    tb.head.innerHTML = head;
    tb.head.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        const c = +b.dataset.c;
        if (c === tb.sortCol) tb.sortDir *= -1;
        else {
          tb.sortCol = c;
          tb.sortDir = c === 0 ? 1 : -1;
        }
        if (c !== 0) tb.rankCol = c; // le rang suit le dernier nombre de joueurs choisi
        render();
      }),
    );
  }

  const cardHTML = (r, suit) => {
    const red = suit === "♥" || suit === "♦";
    return (
      '<span class="card' +
      (red ? " r" : "") +
      '">' +
      (r === "T" ? "10" : r) +
      "<span>" +
      suit +
      "</span></span>"
    );
  };
  const handHTML = (h) =>
    '<span class="hand">' +
    cardHTML(Engine.RANKS[h.hi], "♠") +
    cardHTML(Engine.RANKS[h.lo], h.kind === "s" ? "♠" : "♥") +
    '</span><span class="kind">' +
    h.name +
    "</span>";

  /* --- Un tableau : en-tête (tri, rang, ranges) et lignes des mains idx (filtrées) --- */
  function renderTable(tb, idx, styles) {
    const c = tb.calc;
    tb.head.querySelectorAll("button[data-c]").forEach((b) => {
      const col = +b.dataset.c,
        th = b.parentElement;
      if (col === tb.sortCol)
        th.setAttribute(
          "aria-sort",
          tb.sortDir < 0 ? "descending" : "ascending",
        );
      else th.removeAttribute("aria-sort");
      if (col > 0) th.title = tb.headTitle(col);
    });
    tb.head
      .querySelectorAll(".rank-sub")
      .forEach(
        (el) => (el.textContent = t("thAtPlayers", { p: tb.rankCol + 1 })),
      );

    const message = placeholderHTML(c);
    if (message) {
      tb.body.innerHTML =
        '<tr><td class="left empty" colspan="12">' + message + "</td></tr>";
      return;
    }

    /* Classement de chaque colonne sur les 169 mains (pas seulement celles filtrées) :
       il donne le rang, le top et la couleur. Top % = rang / nombre de mains classées :
       AA, 1er, est dans le top 0,6 % ; une main 17e est dans le top 10 %. */
    const value = (i, k) => valueOf(c, i, k);
    const rankOf = [],
      counted = [];
    for (let k = 1; k <= MAX_OPP; k++) {
      const ranked = hands
        .map((h, i) => i)
        .filter((i) => value(i, k) !== null)
        .sort((x, y) => value(y, k) - value(x, k));
      rankOf[k] = new Map();
      ranked.forEach((i, r) => rankOf[k].set(i, r + 1));
      counted[k] = ranked.length;
    }

    const rows = idx.slice();
    if (tb.sortCol !== 0) {
      rows.sort((x, y) => {
        const vx = value(x, tb.sortCol),
          vy = value(y, tb.sortCol);
        if (vx === null && vy === null) return x - y;
        if (vx === null) return 1;
        if (vy === null) return -1;
        return tb.sortDir * (vx - vy);
      });
    } else if (tb.sortDir < 0) rows.reverse();

    const d = decimals();
    const impossible =
      '<td class="c na" title="' + escapeAttr(t("impossible")) + '">—</td>';
    let html = "";
    for (const i of rows) {
      const x = cell(c, i);
      const old = !!(x && x.old);
      const rk = rankOf[tb.rankCol].get(i),
        of = counted[tb.rankCol];
      html +=
        "<tr" +
        (old ? ' class="old"' : "") +
        '><td class="left sticky">' +
        handHTML(hands[i]) +
        "</td>" +
        (rk
          ? '<td class="rank">' +
            rk +
            '<span class="of"> / ' +
            of +
            '</span></td><td class="rank last">' +
            t("percent", { v: fmt((rk / of) * 100, 1) }) +
            "</td>"
          : '<td class="rank pending">…</td><td class="rank last pending">…</td>');
      for (let k = 1; k <= MAX_OPP; k++) {
        const v = value(i, k);
        if (v === null) {
          html += x ? impossible : '<td class="c pending">…</td>';
          continue;
        }
        const tier = tierOf((rankOf[k].get(i) / counted[k]) * 100);
        html +=
          '<td class="c' +
          (k === tb.sortCol ? " sel" : "") +
          '"' +
          (old ? "" : ' style="' + styles[tier] + '"') +
          ">" +
          fmt(v, d) +
          "</td>";
      }
      html += "</tr>";
    }
    tb.body.innerHTML =
      html ||
      '<tr><td class="left empty" colspan="12">' + t("empty") + "</td></tr>";
  }

  function render() {
    if (!tables[0].head.firstChild) return;
    const q = query.trim().toUpperCase().replace("10", "T");
    const idx = hands
      .map((h, i) => i)
      .filter((i) => {
        const h = hands[i],
          name = h.name.toUpperCase();
        if (filter !== "all" && h.kind !== filter) return false;
        if (!q) return true;
        return (
          name.startsWith(q) ||
          (q.length >= 2 && name.startsWith(q[1] + q[0] + q.slice(2)))
        );
      });
    const styles = tierStyles();
    tables.forEach((tb) => renderTable(tb, idx, styles));
    $("count").textContent = plural("count", idx.length);
    updateLegend(styles);
    updateThemeButton();
  }

  /* --- Bandeaux d'état et boutons --- */
  function statusText(c) {
    const doneFresh = c.fresh ? Object.keys(c.fresh.hands).length : 0;
    let text = "";
    if (!c.loaded) {
      text = t("loading");
    } else if (c.computing) {
      const elapsed = (performance.now() - c.runStart) / 1000;
      const doneThisRun = doneFresh - c.runDoneAtStart;
      let eta = "";
      if (doneThisRun > 0) {
        const left = ((N - doneFresh) * elapsed) / doneThisRun;
        eta = t("eta", { x: durationText(left) });
      }
      text = t("computing", {
        t: plural("cores", computer.threads),
        d: doneFresh,
        n: N,
        // Temps écoulé depuis le début du calcul, reprises comprises
        elapsed: t("elapsed", { x: durationText(c.durationBefore + elapsed) }),
        eta,
      });
    } else if (c.shown) {
      const src = c.shownFrom === "file" ? "" : t("srcLocal");
      text = c.top()
        ? t("rangeShown", {
            trials: int(trials),
            p: top,
            h: c.shown.ranges[0].length,
            date: dateText(c.shown.computedAt),
            time: tookText(c.shown),
            src,
          })
        : t("shown", {
            trials: int(trials),
            date: dateText(c.shown.computedAt),
            time: tookText(c.shown),
            src,
            m: marginText(trials),
          });
      if (c.saveNote) text += t(c.saveNote.key, { e: c.saveNote.e || "" });
    }
    if (c.loaded && !c.computing && c.fresh && !isComplete(c.fresh, N))
      text += t("interrupted", { d: doneFresh, n: N });
    if (c === calcs[0] && c.loaded && !serverMode && !c.computing)
      text += t("noServer");
    return text.trim();
  }

  function updateStatus() {
    for (const c of calcs) {
      const ui = c.ui;
      const doneFresh = c.fresh ? Object.keys(c.fresh.hands).length : 0;
      $(ui.progress).style.width =
        (c.computing ? (doneFresh / N) * 100 : 0) + "%";
      $(ui.track).hidden = !c.computing;
      $(ui.status).textContent = statusText(c);

      const run = $(ui.run);
      run.textContent = c.computing ? t("stop") : t("run");
      run.classList.toggle("stop", c.computing);
      run.disabled = !c.computing && (busy() || !c.loaded || !c.canStart());
      // « Recalculer » seulement s'il y a déjà des résultats ; sinon le bouton
      // « Calculer » du message, à la place du tableau, s'en charge
      run.hidden = !c.computing && !c.shown;
      $(ui.resume).hidden = c.computing || !c.fresh || isComplete(c.fresh, N);
      $(ui.resume).disabled = busy();
      $(ui.resume).textContent = t("resume", { done: doneFresh, n: N });
    }
    $("trials").disabled = busy();
    $("top").disabled = calcs[1].computing;
  }

  const refresh = () => {
    render();
    updateStatus();
  };

  /* --- Choix du jeu de résultats à afficher --- */

  // Par défaut : le plus grand nombre de donnes déjà calculé (fichier ou navigateur)
  async function pickDefaultTrials() {
    for (const n of TRIAL_CHOICES.slice().reverse()) {
      if (isComplete(storageRead(setName(n)), N) || (await loadResultsFile(n)))
        return n;
    }
    return TRIAL_CHOICES[0];
  }

  async function loadCalc(c) {
    if (c.computing) stopCalc(c);
    const name = nameOf(c);
    c.shown = null;
    c.fresh = null;
    c.saveNote = "";
    c.loaded = false;
    refresh();
    const local = storageRead(name);
    const file = await loadResultsFile(trials, c.top());
    if (name !== nameOf(c)) return; // l'utilisateur a changé d'avis entre-temps

    // Le plus récent des jeux complets est affiché
    const candidates = [];
    if (isComplete(file, N)) candidates.push({ set: file, from: "file" });
    if (isComplete(local, N)) candidates.push({ set: local, from: "local" });
    candidates.sort((a, b) =>
      String(b.set.computedAt).localeCompare(String(a.set.computedAt)),
    );
    if (candidates.length) {
      c.shown = candidates[0].set;
      c.shownFrom = candidates[0].from;
    }
    if (local && !isComplete(local, N)) c.fresh = local; // recalcul interrompu
    c.loaded = true;
    refresh();
  }

  /* --- Calcul (dans ce navigateur) --- */
  function startCalc(c, resume) {
    if (busy() || !c.loaded) return;
    if (!resume || !c.fresh) {
      const set = c.newSet();
      if (!set) return;
      c.fresh = set;
      storageWrite(nameOf(c), set);
    }
    const job = c.fresh,
      jobName = nameOf(c); // ce calcul précis, même si l'affichage change
    const todo = hands
      .map((h, i) => i)
      .filter((i) => !job.hands[hands[i].name]);
    c.computing = true;
    c.saveNote = "";
    c.runStart = performance.now();
    c.runDoneAtStart = Object.keys(job.hands).length;
    let lastRender = 0;
    // Durée cumulée sur toutes les reprises du calcul
    const durationBefore = job.duration || 0,
      runStart = c.runStart;
    c.durationBefore = durationBefore;
    if (computer) computer.stop();
    computer = createComputer(
      (task, result) => {
        job.hands[hands[task.index].name] = roundHand(result);
        job.duration = Math.round(
          durationBefore + (performance.now() - runStart) / 1000,
        );
        job.threads = computer.threads;
        storageWrite(jobName, job); // sauvegarde main par main
        if (c.fresh !== job) return;
        if (performance.now() - lastRender > 500) {
          render();
          lastRender = performance.now();
        }
        updateStatus();
      },
      async () => {
        job.computedAt = new Date().toISOString();
        const savedLocal = storageWrite(jobName, job);
        let from = "local",
          note = "";
        if (serverMode) {
          const error = await saveResultsFile(job);
          if (!error) {
            from = "file";
            storageRemove(jobName); // le fichier JSON fait foi, plus besoin de la copie
          } else {
            note = { key: "saveFail", e: error };
          }
        } else if (!savedLocal) {
          note = { key: "privateFail" };
        }
        if (c.fresh !== job) return;
        c.computing = false;
        c.shown = job;
        c.shownFrom = from;
        c.fresh = null;
        c.saveNote = note;
        refresh();
      },
    );
    computer.start(c.jobs(job, todo));
    refresh();
  }

  function stopCalc(c) {
    if (computer) computer.stop();
    c.computing = false;
    refresh();
  }

  /* --- Contrôles --- */
  calcs.forEach((c) => {
    $(c.ui.run).addEventListener("click", () =>
      c.computing ? stopCalc(c) : startCalc(c, false),
    );
    $(c.ui.resume).addEventListener("click", () => startCalc(c, true));
  });
  // Le temps écoulé avance chaque seconde, même si aucune main ne se termine
  setInterval(() => {
    if (busy()) updateStatus();
  }, 1000);
  // Bouton « Calculer » du message affiché à la place d'un tableau vide
  tables.forEach((tb) =>
    tb.body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-start]");
      if (b) startCalc(calcs[+b.dataset.start], false);
    }),
  );
  $("trials").addEventListener("change", async () => {
    trials = +$("trials").value;
    await loadCalc(calcs[0]); // le second tableau a besoin du premier
    loadCalc(calcs[1]);
  });
  $("top").addEventListener("change", () => {
    top = +$("top").value;
    loadCalc(calcs[1]);
  });

  document.querySelectorAll("[data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f;
      document
        .querySelectorAll("[data-f]")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      render();
    }),
  );
  document.querySelectorAll("[data-m]").forEach((b) =>
    b.addEventListener("click", () => {
      measure = b.dataset.m;
      document
        .querySelectorAll("[data-m]")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      render();
    }),
  );
  $("q").addEventListener("input", (e) => {
    query = e.target.value;
    render();
  });

  /* --- Menus de la langue et du thème : une icône, qui ouvre la liste au clic --- */
  const menus = [];
  function setupMenu(btn, menu, onPick) {
    const m = { btn, menu };
    m.open = (open) => {
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) {
        menus.filter((o) => o !== m).forEach((o) => o.open(false));
        const current = menu.querySelector('[aria-checked="true"]');
        if (current) current.focus();
      }
    };
    menu.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        onPick(b);
        m.open(false);
        btn.focus();
      }),
    );
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      m.open(menu.hidden);
    });
    menus.push(m);
  }
  document.addEventListener("click", (e) => {
    for (const m of menus)
      if (!m.menu.hidden && !m.menu.contains(e.target)) m.open(false);
  });
  document.addEventListener("keydown", (e) => {
    const m = menus.find((o) => !o.menu.hidden);
    if (!m) return;
    if (e.key === "Escape") {
      m.open(false);
      m.btn.focus();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...m.menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      items[
        (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
      ].focus();
      e.preventDefault();
    }
  });

  document.querySelectorAll("[data-lang]").forEach((b) => {
    b.querySelector(".flag-icon").innerHTML = FLAGS[b.dataset.lang];
  });
  setupMenu($("lang-btn"), $("lang-menu"), (b) => {
    lang = b.dataset.lang;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch (e) {
      /* rien */
    }
    applyLanguage();
  });

  document.querySelectorAll("[data-theme-choice]").forEach((b) => {
    b.querySelector(".theme-icon").innerHTML =
      THEME_ICONS[b.dataset.themeChoice];
  });
  // Le changement d'attribut data-theme redessine la page (MutationObserver plus bas)
  setupMenu($("theme-btn"), $("theme-menu"), (b) => {
    const choice = b.dataset.themeChoice;
    document.documentElement.setAttribute("data-theme", choice);
    try {
      localStorage.setItem(THEME_KEY, choice);
    } catch (e) {
      /* rien */
    }
  });

  $("colorblind").addEventListener("click", () => {
    colorblind = !colorblind;
    try {
      localStorage.setItem(COLORBLIND_KEY, colorblind ? "1" : "0");
    } catch (e) {
      /* rien */
    }
    render();
  });

  // Les couleurs des cases changent avec le thème clair ou sombre
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", render);
  }
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(render).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }

  /* --- Vérification de l'évaluateur au démarrage (résultat dans la console) --- */
  const tests = runTests();
  const failed = tests.filter((x) => !x.ok);
  if (failed.length)
    console.error(
      "Évaluateur : " + failed.length + " test(s) en échec",
      failed,
    );
  else
    console.info(
      "Évaluateur : " + tests.length + " / " + tests.length + " tests réussis",
    );

  applyLanguage();
  detectServer().then(async (ok) => {
    serverMode = ok;
    trials = await pickDefaultTrials();
    $("trials").value = String(trials);
    // Le premier tableau d'abord : le second en a besoin pour son bouton « Calculer »
    await loadCalc(calcs[0]);
    loadCalc(calcs[1]);
  });
}

/* --- Démarrage --- */
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", initPage);
else initPage();
