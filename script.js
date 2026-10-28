/* =====================================================================
   Équités préflop Texas Hold'em — tout est calculé ici, en JavaScript.

   1. Moteur de calcul (générateur aléatoire, évaluateur, simulation).
      Il est écrit dans une seule fonction pour pouvoir être copié tel quel
      dans les Web Workers du navigateur et dans compute.js (Node).
   2. Tests de l'évaluateur
   3. Stockage des résultats : fichiers results/*.json (via server.js) + mémoire du navigateur
   4. Calcul parallèle sur tous les cœurs du processeur
   5. Traductions (français et anglais)
   6. Interface (tableau, tri, filtres, couleurs, langue)

   Codage d'une carte : entier 0..51
     rang    = carte >> 2   (0 = 2, 1 = 3, ..., 8 = T, 9 = J, 10 = Q, 11 = K, 12 = A)
     couleur = carte & 3    (0 = ♠, 1 = ♥, 2 = ♦, 3 = ♣)
   ===================================================================== */

"use strict";

/* =====================================================================
   1. MOTEUR
   ===================================================================== */
function pokerEngine() {
  const RANKS = "23456789TJQKA";
  const SUITS = "shdc";
  const MAX_OPP = 9;
  const CAT_NAMES = [
    "Carte haute",
    "Paire",
    "Double paire",
    "Brelan",
    "Quinte",
    "Couleur",
    "Full",
    "Carré",
    "Quinte flush",
  ];

  /* --- Générateur aléatoire : xoshiro128** ---
     Période de 2^128 : on peut tirer des milliards de cartes sans jamais
     retomber sur la même séquence. */
  function makeRng(seed) {
    let s = seed >>> 0;
    const splitmix = () => {
      // sert seulement à initialiser l'état
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    let a = splitmix(),
      b = splitmix(),
      c = splitmix(),
      d = splitmix();
    const rotl = (x, k) => (x << k) | (x >>> (32 - k));
    return function randInt(n) {
      // entier uniforme dans [0, n)
      const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
      const t = b << 9;
      c ^= a;
      d ^= b;
      b ^= c;
      a ^= d;
      c ^= t;
      d = rotl(d, 11);
      return Math.floor((r / 4294967296) * n);
    };
  }

  // Graine imprévisible : chaque calcul utilise un tirage différent
  function randomSeed() {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      return crypto.getRandomValues(new Uint32Array(1))[0];
    }
    return Math.floor(Math.random() * 4294967296);
  }

  /* --- Évaluateur 7 cartes ---
     Renvoie un entier : plus il est grand, meilleure est la main.
     catégorie * 2^20 + départage (rangs codés sur 4 bits chacun)
       8 quinte flush, 7 carré, 6 full, 5 couleur, 4 quinte,
       3 brelan, 2 double paire, 1 paire, 0 carte haute */
  function popcount(m) {
    let n = 0;
    while (m) {
      m &= m - 1;
      n++;
    }
    return n;
  }
  function highBit(m) {
    return 31 - Math.clz32(m);
  }

  // Carte haute d'une quinte dans un masque de 13 rangs, ou -1. Gère la roue A-2-3-4-5.
  function straightTop(mask) {
    const x = (mask << 1) | ((mask >> 12) & 1); // bit 0 = As joué en carte basse
    const y = x & (x >> 1) & (x >> 2) & (x >> 3) & (x >> 4);
    return y ? highBit(y) + 3 : -1;
  }

  // Les n meilleurs rangs d'un masque, concaténés sur 4 bits chacun
  function topRanks(mask, n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const b = highBit(mask);
      v = (v << 4) | b;
      mask &= ~(1 << b);
    }
    return v;
  }

  const suitMask = new Int32Array(4);
  const rankCount = new Int32Array(13);
  const seven = new Int32Array(7);

  function evaluate7(c0, c1, c2, c3, c4, c5, c6) {
    suitMask[0] = suitMask[1] = suitMask[2] = suitMask[3] = 0;
    rankCount.fill(0);
    seven[0] = c0;
    seven[1] = c1;
    seven[2] = c2;
    seven[3] = c3;
    seven[4] = c4;
    seven[5] = c5;
    seven[6] = c6;
    for (let i = 0; i < 7; i++) {
      const r = seven[i] >> 2;
      suitMask[seven[i] & 3] |= 1 << r;
      rankCount[r]++;
    }
    // Couleur / quinte flush
    for (let s = 0; s < 4; s++) {
      if (popcount(suitMask[s]) >= 5) {
        const t = straightTop(suitMask[s]);
        if (t >= 0) return (8 << 20) | t;
        return (5 << 20) | topRanks(suitMask[s], 5);
      }
    }
    const all = suitMask[0] | suitMask[1] | suitMask[2] | suitMask[3];
    let quad = -1,
      trip1 = -1,
      trip2 = -1,
      pair1 = -1,
      pair2 = -1;
    for (let r = 12; r >= 0; r--) {
      const n = rankCount[r];
      if (n === 4) quad = r;
      else if (n === 3) {
        if (trip1 < 0) trip1 = r;
        else if (trip2 < 0) trip2 = r;
      } else if (n === 2) {
        if (pair1 < 0) pair1 = r;
        else if (pair2 < 0) pair2 = r;
      }
    }
    if (quad >= 0)
      return (7 << 20) | (quad << 4) | topRanks(all & ~(1 << quad), 1);
    if (trip1 >= 0 && (trip2 >= 0 || pair1 >= 0)) {
      return (6 << 20) | (trip1 << 4) | Math.max(trip2, pair1);
    }
    const st = straightTop(all);
    if (st >= 0) return (4 << 20) | st;
    if (trip1 >= 0)
      return (3 << 20) | (trip1 << 8) | topRanks(all & ~(1 << trip1), 2);
    if (pair2 >= 0) {
      return (
        (2 << 20) |
        (pair1 << 8) |
        (pair2 << 4) |
        topRanks(all & ~(1 << pair1) & ~(1 << pair2), 1)
      );
    }
    if (pair1 >= 0)
      return (1 << 20) | (pair1 << 12) | topRanks(all & ~(1 << pair1), 3);
    return topRanks(all, 5);
  }

  // "As Kd 7h ..." -> valeur de la main
  function evalString(str) {
    const c = str
      .trim()
      .split(/\s+/)
      .map((s) => RANKS.indexOf(s[0]) * 4 + SUITS.indexOf(s[1]));
    return evaluate7(c[0], c[1], c[2], c[3], c[4], c[5], c[6]);
  }

  /* --- Les 169 mains, dans l'ordre de la grille classique : AA, AKs, AKo, ... --- */
  function buildHands() {
    const hands = [];
    for (let a = 12; a >= 0; a--) {
      for (let b = a; b >= 0; b--) {
        if (a === b)
          hands.push({
            name: RANKS[a] + RANKS[b],
            hi: a,
            lo: b,
            kind: "p",
            combos: 6,
          });
        else {
          hands.push({
            name: RANKS[a] + RANKS[b] + "s",
            hi: a,
            lo: b,
            kind: "s",
            combos: 4,
          });
          hands.push({
            name: RANKS[a] + RANKS[b] + "o",
            hi: a,
            lo: b,
            kind: "o",
            combos: 12,
          });
        }
      }
    }
    return hands;
  }

  // Deux cartes concrètes représentant la main (les couleurs exactes ne changent rien)
  function holeCards(hand) {
    return [hand.hi * 4, hand.lo * 4 + (hand.kind === "s" ? 0 : 1)];
  }

  /* --- Simulation d'une main contre 1 à 9 adversaires au hasard ---
     À chaque donne on distribue 9 adversaires ; la colonne « k adversaires »
     utilise les k premiers. Chaque colonne reste une estimation sans biais.
     Équité : pot gagné = 1, pot partagé entre n joueurs = 1/n.
     Renvoie les totaux bruts (pas des %) pour pouvoir additionner des lots. */
  function simulateHand(hand, trials, rand) {
    const [h0, h1] = holeCards(hand);
    const deck = new Int32Array(50);
    let n = 0;
    for (let c = 0; c < 52; c++) if (c !== h0 && c !== h1) deck[n++] = c;

    const equity = new Float64Array(MAX_OPP);
    const wins = new Float64Array(MAX_OPP);
    const need = 5 + 2 * MAX_OPP;

    for (let t = 0; t < trials; t++) {
      // Mélange de Fisher-Yates partiel : seules les `need` premières cartes servent
      for (let i = 0; i < need; i++) {
        const j = i + rand(50 - i);
        const tmp = deck[i];
        deck[i] = deck[j];
        deck[j] = tmp;
      }
      const b0 = deck[0],
        b1 = deck[1],
        b2 = deck[2],
        b3 = deck[3],
        b4 = deck[4];
      const me = evaluate7(h0, h1, b0, b1, b2, b3, b4);
      let ties = 0;
      for (let k = 0; k < MAX_OPP; k++) {
        const o = 5 + 2 * k;
        const v = evaluate7(deck[o], deck[o + 1], b0, b1, b2, b3, b4);
        if (v > me) break; // perdu ici et à toutes les tables plus grandes
        if (v === me) ties++;
        equity[k] += 1 / (ties + 1);
        if (ties === 0) wins[k] += 1;
      }
    }
    return { trials, equity: Array.from(equity), wins: Array.from(wins) };
  }

  // Totaux bruts -> pourcentages
  function toPercent(raw) {
    return {
      eq: raw.equity.map((v) => (100 * v) / raw.trials),
      win: raw.wins.map((v) => (100 * v) / raw.trials),
    };
  }

  return {
    RANKS,
    MAX_OPP,
    CAT_NAMES,
    makeRng,
    randomSeed,
    evaluate7,
    evalString,
    buildHands,
    holeCards,
    simulateHand,
    toPercent,
  };
}

const Engine = pokerEngine();

/* =====================================================================
   2. TESTS DE L'ÉVALUATEUR
   [description, main A, main B, attendu : 1 = A gagne, 0 = égalité, -1 = B gagne]
   ===================================================================== */
const TESTS = [
  [
    "Quinte flush royale bat carré",
    "As Ks Qs Js Ts 2d 3c",
    "9h 9d 9c 9s Kd 2h 3d",
    1,
  ],
  ["Carré bat full", "9h 9d 9c 9s Kd 2h 3d", "Kh Kd Kc 2s 2d 4h 5c", 1],
  ["Full bat couleur", "Kh Kd Kc 2s 2d 4h 5c", "Ah 9h 6h 4h 2h Kd 3c", 1],
  ["Couleur bat quinte", "Ah 9h 6h 4h 2h Kd 3c", "9c Td Jh Qs Kd 2h 3c", 1],
  ["Quinte bat brelan", "9c Td Jh Qs Kd 2h 3c", "7h 7d 7c As Kd 2h 4c", 1],
  [
    "Brelan bat double paire",
    "7h 7d 7c As Kd 2h 4c",
    "Ah Ad Kc Ks Qd 2h 4c",
    1,
  ],
  ["Double paire bat paire", "Ah Ad Kc Ks Qd 2h 4c", "Ah Ad Qc Js 9d 2h 4c", 1],
  ["Paire bat carte haute", "2h 2d 5c 7s 9d Jh Kc", "Ah Kd Qc Js 9d 2h 4c", 1],
  [
    "Roue A-2-3-4-5 reconnue comme quinte",
    "Ah 2d 3c 4s 5d 9h Kc",
    "Ah Ad Ac Ks Qd 2h 4c",
    1,
  ],
  [
    "Quinte au 6 bat la roue",
    "2h 3d 4c 5s 6d Kh Kc",
    "Ah 2d 3c 4s 5d Qh Kc",
    1,
  ],
  [
    "Pas de quinte K-A-2-3-4",
    "Kh Ad 2c 3s 4d 9h 8c",
    "Ah Ad 7c 6s 9d 2h 4c",
    -1,
  ],
  [
    "Kicker : AK bat AQ sur paire d'As",
    "Ah Kd Ac 7s 5d 3h 2c",
    "As Qd Ac 7s 5d 3h 2c",
    1,
  ],
  [
    "La planche joue : égalité",
    "2h 3d As Ks Qs Js Ts",
    "4h 5d As Ks Qs Js Ts",
    0,
  ],
  [
    "Full : le meilleur brelan compte",
    "Kh Kd Kc 5s 5d 5h 2c",
    "Qh Qd Qc 5s 5d 5h 2c",
    1,
  ],
  [
    "Deux brelans font un full",
    "Kh Kd Kc 5s 5d 5h 2c",
    "Ah Kd Qc Js Td 2h 2c",
    1,
  ],
  [
    "Trois paires : on garde les deux meilleures",
    "Ah Ad Kc Ks 2d 2h 9c",
    "Ah Ad Kc Ks 3d 3h 8c",
    1,
  ],
  [
    "Couleur : départage à la 5e carte",
    "Ah Kh 9h 6h 3h 2d 2c",
    "Ah Kh 9h 6h 2h 3d 3c",
    1,
  ],
];

function runTests() {
  return TESTS.map(([name, a, b, expected]) => {
    const va = Engine.evalString(a),
      vb = Engine.evalString(b);
    const got = va > vb ? 1 : va < vb ? -1 : 0;
    return {
      name,
      a,
      b,
      ok: got === expected,
      catA: Engine.CAT_NAMES[va >> 20],
      catB: Engine.CAT_NAMES[vb >> 20],
    };
  });
}

/* =====================================================================
   3. STOCKAGE DES RÉSULTATS
   Un jeu de résultats : { trials, computedAt, hands: { "AA": {eq:[9], win:[9]}, ... } }
     eq[k]  = équité contre k+1 adversaires, en %
     win[k] = victoire sans partage contre k+1 adversaires, en %
   - fichiers results/<donnes>.json, lus et écrits par server.js
   - mémoire du navigateur (localStorage) : sauvegarde main par main pendant
     un calcul, et seul stockage quand la page est ouverte sans serveur
   ===================================================================== */
const STORAGE_PREFIX = "equites-preflop-v3-";
const TRIAL_CHOICES = [1000000, 5000000, 10000000];

function roundHand(p) {
  const r = (v) => Math.round(v * 10000) / 10000;
  return { eq: p.eq.map(r), win: p.win.map(r) };
}

// Contenu d'un fichier results/<donnes>.json : une main par ligne, lisible à l'œil
// (même format pour la page, server.js et compute.js)
function formatResultsFile(set) {
  const names = Engine.buildHands()
    .map((h) => h.name)
    .filter((n) => set.hands[n]);
  const lines = names.map(
    (n) => "    " + JSON.stringify(n) + ": " + JSON.stringify(set.hands[n]),
  );
  return (
    "{\n" +
    '  "trials": ' +
    set.trials +
    ",\n" +
    '  "computedAt": ' +
    JSON.stringify(set.computedAt) +
    ",\n" +
    '  "hands": {\n' +
    lines.join(",\n") +
    "\n  }\n}\n"
  );
}

// Vérifie qu'un jeu de résultats est complet et plausible (utilisé aussi par server.js)
function validateResults(set) {
  if (!set || typeof set !== "object") return "contenu vide";
  if (!TRIAL_CHOICES.includes(set.trials)) return "nombre de donnes non prévu";
  if (typeof set.computedAt !== "string" || isNaN(Date.parse(set.computedAt)))
    return "date invalide";
  const names = Engine.buildHands().map((h) => h.name);
  if (!set.hands || Object.keys(set.hands).length !== names.length)
    return "il faut les 169 mains";
  for (const n of names) {
    const h = set.hands[n];
    if (!h) return "main manquante : " + n;
    for (const key of ["eq", "win"]) {
      const a = h[key];
      if (
        !Array.isArray(a) ||
        a.length !== Engine.MAX_OPP ||
        !a.every((v) => typeof v === "number" && v >= 0 && v <= 100)
      )
        return "valeurs invalides pour " + n;
    }
  }
  return null;
}

function storageRead(trials) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + trials);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function storageWrite(trials, set) {
  try {
    localStorage.setItem(STORAGE_PREFIX + trials, JSON.stringify(set));
    return true;
  } catch (e) {
    return false;
  }
}
function storageRemove(trials) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + trials);
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

// Lit results/<donnes>.json, ou null s'il n'existe pas encore
async function loadResultsFile(trials) {
  try {
    const r = await fetch("results/" + trials + ".json", { cache: "no-store" });
    if (!r.ok) return null;
    const set = await r.json();
    return validateResults(set) ? null : set;
  } catch (e) {
    return null;
  }
}

// Demande au serveur d'écrire results/<donnes>.json. Renvoie null si tout va bien, sinon le message d'erreur.
async function saveResultsFile(set) {
  try {
    const r = await fetch("api/results/" + set.trials, {
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
   4. CALCUL PARALLÈLE
   Le moteur est recopié dans des Web Workers (un par cœur).
   Chaque worker calcule une main entière puis en demande une autre.
   Sans Workers, repli sur le fil principal par petits lots.
   ===================================================================== */
function createComputer(onResult, onDone) {
  let workers = [],
    queue = [],
    running = 0,
    stopped = false;
  const hands = Engine.buildHands();
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
      "var raw=E.simulateHand(d.hand,d.trials,E.makeRng(E.randomSeed()));" +
      "postMessage({index:d.index,result:E.toPercent(raw)});};";
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

  function feed(worker, trials) {
    if (stopped || !queue.length) {
      if (running === 0) finish();
      return;
    }
    const index = queue.shift();
    running++;
    worker.onmessage = (e) => {
      running--;
      if (stopped) return;
      onResult(e.data.index, e.data.result);
      feed(worker, trials);
    };
    const h = hands[index];
    worker.postMessage({
      index,
      trials,
      hand: { hi: h.hi, lo: h.lo, kind: h.kind },
    });
  }

  // Repli : fil principal, lots de 100 000 donnes pour garder la page réactive
  function runMainThread(trials) {
    const CHUNK = 100000;
    let index = null,
      raw = null,
      rand = Engine.makeRng(Engine.randomSeed());
    function step() {
      if (stopped) return;
      if (index === null) {
        if (!queue.length) return finish();
        index = queue.shift();
        raw = null;
      }
      const end = performance.now() + 40;
      while (performance.now() < end && (!raw || raw.trials < trials)) {
        const n = Math.min(CHUNK, trials - (raw ? raw.trials : 0));
        const part = Engine.simulateHand(hands[index], n, rand);
        if (!raw) raw = part;
        else {
          raw.trials += part.trials;
          for (let k = 0; k < raw.equity.length; k++) {
            raw.equity[k] += part.equity[k];
            raw.wins[k] += part.wins[k];
          }
        }
      }
      if (raw.trials >= trials) {
        onResult(index, Engine.toPercent(raw));
        index = null;
      }
      setTimeout(step, 0);
    }
    setTimeout(step, 0);
  }

  return {
    threads: size,
    start(indices, trials) {
      stopped = false;
      finished = false;
      queue = indices.slice();
      running = 0;
      try {
        if (!workers.length) workers = makeWorkers();
        workers.forEach((w) => feed(w, trials));
        return "workers";
      } catch (e) {
        workers = [];
        runMainThread(trials);
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
   5. TRADUCTIONS
   Chaque texte a une clé. Dans le HTML :
     data-i18n="clé"          remplace le texte de l'élément
     data-i18n-html="clé"     remplace son contenu (texte avec <b>…</b>)
     data-i18n-placeholder / data-i18n-aria-label   remplacent ces attributs
   {nom} dans un texte est remplacé par la valeur donnée à t().
   ===================================================================== */
const I18N = {
  fr: {
    locale: "fr-FR",
    title: "Équités préflop Hold'em",
    h1: "Équités préflop, 169 mains",
    lede: "Probabilité de gagner le pot si tout le monde va à l'abattage, contre des mains <b>tirées au hasard</b>, par simulation Monte Carlo. Les égalités comptent comme une part du pot.",
    langLabel: "Langue",
    trialsLabel: "Donnes par main",
    trialsOption: "{n} (±{m} pt)",
    run: "Recalculer",
    stop: "Arrêter",
    resume: "Reprendre ({done} / {n})",
    typeLabel: "Type",
    all: "Toutes",
    pairs: "Paires",
    suited: "Assorties",
    offsuit: "Non assorties",
    measureLabel: "Mesure",
    equity: "Équité",
    wins: "Victoire seule",
    searchLabel: "Chercher",
    searchPlaceholder: "ex. AK, 77, T9s",
    legendLow: "sous la moyenne",
    legendHigh: "au-dessus",
    colorblind: "Mode daltonien",
    count: "{n} main",
    countPlural: "{n} mains",
    thHand: "Main",
    thRank: "Rang",
    thRankSub: "sur 169 mains",
    thTop: "Top",
    thTopSub: "des 169 mains",
    thAtPlayers: "à {p} joueurs",
    thPlayers: "{p} joueurs",
    thOpp: "{k} adv.",
    thAvg: "moy. {v} %",
    percent: "{v} %",
    empty: "Aucune main ne correspond. Essaie « AK », « 77 » ou « T9s ».",
    loading: "Chargement…",
    computing:
      "Calcul en cours sur {t} : {d} / {n} mains{eta}. Les mains déjà calculées sont gardées si tu fermes la page.",
    cores: "{n} cœur",
    coresPlural: "{n} cœurs",
    eta: " · encore environ {x}",
    minutes: "{n} min",
    seconds: "{n} s",
    shown:
      "Résultats à {trials} donnes par main, calculés le {date}{src}. Écart maximal attendu sur tout le tableau : ±{m} point.",
    srcFile: ", lus dans results/{trials}.json",
    srcLocal: ", gardés dans ce navigateur",
    dateAt: "{d} à {h}",
    none: "Aucun résultat pour {trials} donnes.",
    interrupted: " Un recalcul a été interrompu à {d} / {n} mains.",
    noServer:
      " Page ouverte sans server.js : les recalculs restent dans ce navigateur.",
    saveFail: " Le serveur n'a pas pu écrire le fichier ({e}).",
    privateFail:
      " Attention : le navigateur refuse de garder ces résultats (navigation privée ?).",
  },
  en: {
    locale: "en-GB",
    title: "Hold'em Preflop Equities",
    h1: "Preflop equities, 169 hands",
    lede: "Chance of winning the pot when everyone goes to showdown against <b>random hands</b>, by Monte Carlo simulation. Split pots count as a share of the pot.",
    langLabel: "Language",
    trialsLabel: "Deals per hand",
    trialsOption: "{n} (±{m} pt)",
    run: "Recalculate",
    stop: "Stop",
    resume: "Resume ({done} / {n})",
    typeLabel: "Type",
    all: "All",
    pairs: "Pairs",
    suited: "Suited",
    offsuit: "Offsuit",
    measureLabel: "Measure",
    equity: "Equity",
    wins: "Outright wins",
    searchLabel: "Search",
    searchPlaceholder: "e.g. AK, 77, T9s",
    legendLow: "below average",
    legendHigh: "above",
    colorblind: "Colour-blind mode",
    count: "{n} hand",
    countPlural: "{n} hands",
    thHand: "Hand",
    thRank: "Rank",
    thRankSub: "out of 169 hands",
    thTop: "Top",
    thTopSub: "of 169 hands",
    thAtPlayers: "{p} players",
    thPlayers: "{p} players",
    thOpp: "{k} opp.",
    thAvg: "avg {v}%",
    percent: "{v}%",
    empty: "No hand matches. Try “AK”, “77” or “T9s”.",
    loading: "Loading…",
    computing:
      "Computing on {t}: {d} / {n} hands{eta}. Finished hands are kept if you close the page.",
    cores: "{n} core",
    coresPlural: "{n} cores",
    eta: " · about {x} left",
    minutes: "{n} min",
    seconds: "{n} s",
    shown:
      "Results with {trials} deals per hand, computed on {date}{src}. Expected maximum error across the whole table: ±{m} points.",
    srcFile: ", read from results/{trials}.json",
    srcLocal: ", stored in this browser",
    dateAt: "{d} at {h}",
    none: "No results for {trials} deals.",
    interrupted: " A recalculation was interrupted at {d} / {n} hands.",
    noServer:
      " Page opened without server.js: recalculations stay in this browser.",
    saveFail: " The server could not write the file ({e}).",
    privateFail:
      " Warning: the browser won't keep these results (private browsing?).",
  },
};

const LANG_KEY = "equites-preflop-lang";
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
   6. INTERFACE
   ===================================================================== */

/* Couleurs des cases : 7 teintes de la pire main (rouge) à la meilleure.
   Le jaune pâle du milieu correspond exactement à la part moyenne. */
const PALETTES = {
  normal: [
    "#d73027",
    "#fc8d59",
    "#fee08b",
    "#ffffbf",
    "#d9ef8b",
    "#91cf60",
    "#1a9850",
  ],
  colorblind: [
    "#d73027",
    "#fc8d59",
    "#fee090",
    "#ffffbf",
    "#e0f3f8",
    "#91bfdb",
    "#4575b4",
  ],
};

/* Forme de l'échelle de couleurs : 1 = linéaire (beaucoup de jaune),
   0,5 = racine carrée (réglage actuel), plus petit = encore moins de jaune. */
const COLOR_CURVE = 0.5;

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

  let trials = TRIAL_CHOICES[0];
  let shown = null; // jeu complet affiché (fichier ou navigateur)
  let shownFrom = ""; // "file" | "local"
  let serverMode = false; // true si server.js répond : les résultats s'écrivent dans results/*.json
  let saveNote = ""; // clé et valeur du dernier problème d'enregistrement
  let fresh = null; // recalcul en cours ou interrompu (dans le navigateur)
  let computing = false,
    computer = null,
    runStart = 0,
    runDoneAtStart = 0;
  let filter = "all",
    measure = "eq",
    sortCol = 1,
    sortDir = -1,
    query = "";
  let rankCol = 1; // colonne de joueurs qui sert au rang et au top
  let loaded = false;

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
    buildHead();
    render();
    updateStatus();
  }

  /* --- Couleurs --- */
  const isDark = () => {
    const forced = document.documentElement.getAttribute("data-theme");
    if (forced) return forced === "dark";
    return !!(
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  };
  // Teinte à une position p entre 0 (pire) et 1 (meilleure), adoucie en thème sombre
  function paletteColor(p) {
    const stops = PALETTES[colorblind ? "colorblind" : "normal"].map(hexToRgb);
    const x = Math.min(Math.max(p, 0), 1) * (stops.length - 1);
    const i = Math.min(Math.floor(x), stops.length - 2);
    let c = mix(stops[i], stops[i + 1], x - i);
    if (isDark()) c = mix(c, hexToRgb("#171d1a"), 0.45);
    return c;
  }
  function cellStyle(v, k, stats) {
    // Jaune = part moyenne ; chaque côté s'étire jusqu'à la pire / meilleure main de la colonne.
    // L'écart passe par COLOR_CURVE (racine carrée) : les mains proches de la moyenne
    // s'écartent vite du jaune, ce qui donne plus de vert et de rouge dans le tableau.
    const fair = 100 / (k + 1),
      s = stats[k];
    let p = 0.5;
    if (v >= fair && s.max > fair)
      p = 0.5 + 0.5 * Math.pow((v - fair) / (s.max - fair), COLOR_CURVE);
    else if (v < fair && s.min < fair)
      p = 0.5 - 0.5 * Math.pow((fair - v) / (fair - s.min), COLOR_CURVE);
    const bg = paletteColor(p);
    // const ink = luminance(bg) > 0.22 ? "#151a17" : "#f4f7f5";
    const ink = "#f4f7f5";
    return "background-color:" + rgbToCss(bg) + ";color:" + ink;
  }
  function updateLegend() {
    const stops = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1].map((p) =>
      rgbToCss(paletteColor(p)),
    );
    $("ramp").style.background =
      "linear-gradient(90deg," + stops.join(",") + ")";
    $("colorblind").setAttribute("aria-pressed", String(colorblind));
  }

  /* --- En-tête du tableau --- */
  function buildHead() {
    let head =
      '<th class="left sticky" scope="col"><button type="button" data-c="0"><span class="n">' +
      t("thHand") +
      '</span><span class="sub">&nbsp;</span><span class="fair">&nbsp;</span></button></th>' +
      '<th scope="col" class="rankhead"><div class="th-static"><span class="n">' +
      t("thRank") +
      '</span><span class="sub" id="rank-sub"></span><span class="fair">' +
      t("thRankSub") +
      "</span></div></th>" +
      '<th scope="col" class="rankhead last"><div class="th-static"><span class="n">' +
      t("thTop") +
      '</span><span class="sub" id="top-sub"></span><span class="fair">' +
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
        t("thAvg", { v: fmt(100 / (k + 1), 1) }) +
        "</span></button></th>";
    }
    $("hrow").innerHTML = head;
    document.querySelectorAll("#hrow button").forEach((b) =>
      b.addEventListener("click", () => {
        const c = +b.dataset.c;
        if (c === sortCol) sortDir *= -1;
        else {
          sortCol = c;
          sortDir = c === 0 ? 1 : -1;
        }
        if (c !== 0) rankCol = c; // le rang suit le dernier nombre de joueurs choisi
        render();
      }),
    );
  }

  /* --- Données affichées : le recalcul en cours prime, sinon le jeu complet --- */
  function cell(i) {
    const name = hands[i].name;
    if (computing || (fresh && !shown)) {
      if (fresh && fresh.hands[name])
        return { data: fresh.hands[name], old: false };
      if (shown && shown.hands[name])
        return { data: shown.hands[name], old: true };
      return null;
    }
    return shown && shown.hands[name]
      ? { data: shown.hands[name], old: false }
      : null;
  }
  const value = (i, k) => {
    const c = cell(i);
    return c ? (measure === "eq" ? c.data.eq : c.data.win)[k - 1] : null;
  };

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

  function render() {
    if (!$("rank-sub")) return;
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
    if (sortCol !== 0) {
      idx.sort((x, y) => {
        const vx = value(x, sortCol),
          vy = value(y, sortCol);
        if (vx === null && vy === null) return x - y;
        if (vx === null) return 1;
        if (vy === null) return -1;
        return sortDir * (vx - vy);
      });
    } else if (sortDir < 0) idx.reverse();

    // Pire et meilleure valeur de chaque colonne, sur les 169 mains, pour étirer les couleurs
    const stats = {};
    for (let k = 1; k <= MAX_OPP; k++) {
      let min = Infinity,
        max = -Infinity;
      for (let i = 0; i < N; i++) {
        const v = value(i, k);
        if (v !== null) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      stats[k] = { min, max };
    }

    // Rang et top sur les 169 mains (pas seulement celles filtrées), pour la colonne choisie.
    // Top % = rang / 169 : AA, 1er, est dans le top 0,6 % ; une main 17e est dans le top 10 %.
    const ranked = hands
      .map((h, i) => i)
      .filter((i) => value(i, rankCol) !== null)
      .sort((x, y) => value(y, rankCol) - value(x, rankCol));
    const rankOf = new Map();
    ranked.forEach((i, r) => rankOf.set(i, r + 1));
    $("rank-sub").textContent = t("thAtPlayers", { p: rankCol + 1 });
    $("top-sub").textContent = t("thAtPlayers", { p: rankCol + 1 });

    const d = decimals();
    let html = "";
    for (const i of idx) {
      const c = cell(i);
      const old = c && c.old;
      const rk = rankOf.get(i);
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
            N +
            '</span></td><td class="rank last">' +
            t("percent", { v: fmt((rk / N) * 100, 1) }) +
            "</td>"
          : '<td class="rank pending">…</td><td class="rank last pending">…</td>');
      for (let k = 1; k <= MAX_OPP; k++) {
        const v = value(i, k);
        if (v === null) {
          html += '<td class="c pending">…</td>';
          continue;
        }
        html +=
          '<td class="c' +
          (k === sortCol ? " sel" : "") +
          '"' +
          (old ? "" : ' style="' + cellStyle(v, k, stats) + '"') +
          ">" +
          fmt(v, d) +
          "</td>";
      }
      html += "</tr>";
    }
    $("tb").innerHTML =
      html ||
      '<tr><td class="left empty" colspan="12">' + t("empty") + "</td></tr>";
    $("count").textContent = plural("count", idx.length);
    document.querySelectorAll("#hrow button").forEach((b) => {
      const th = b.parentElement;
      if (+b.dataset.c === sortCol)
        th.setAttribute("aria-sort", sortDir < 0 ? "descending" : "ascending");
      else th.removeAttribute("aria-sort");
    });
    updateLegend();
  }

  /* --- Bandeau d'état et boutons --- */
  function updateStatus() {
    const doneFresh = fresh ? Object.keys(fresh.hands).length : 0;
    $("progress").style.width = (computing ? (doneFresh / N) * 100 : 0) + "%";
    $("progress-track").hidden = !computing;

    let text;
    if (!loaded) {
      text = t("loading");
    } else if (computing) {
      const elapsed = (performance.now() - runStart) / 1000;
      const doneThisRun = doneFresh - runDoneAtStart;
      let eta = "";
      if (doneThisRun > 0) {
        const left = ((N - doneFresh) * elapsed) / doneThisRun;
        eta = t("eta", {
          x:
            left >= 90
              ? t("minutes", { n: Math.round(left / 60) })
              : t("seconds", { n: Math.ceil(left) }),
        });
      }
      text = t("computing", {
        t: plural("cores", computer.threads),
        d: doneFresh,
        n: N,
        eta,
      });
    } else if (shown) {
      text = t("shown", {
        trials: int(trials),
        date: dateText(shown.computedAt),
        src: shownFrom === "file" ? t("srcFile", { trials }) : t("srcLocal"),
        m: marginText(trials),
      });
      if (saveNote) text += t(saveNote.key, { e: saveNote.e || "" });
    } else {
      text = t("none", { trials: int(trials) });
    }
    if (loaded && !computing && fresh && !isComplete(fresh, N))
      text += t("interrupted", { d: doneFresh, n: N });
    if (loaded && !serverMode && !computing) text += t("noServer");
    $("status").textContent = text;

    $("run").textContent = computing ? t("stop") : t("run");
    $("run").classList.toggle("stop", computing);
    $("resume").hidden = computing || !fresh || isComplete(fresh, N);
    $("resume").textContent = t("resume", { done: doneFresh, n: N });
    $("trials").disabled = computing;
  }

  /* --- Choix du jeu de résultats à afficher --- */
  async function loadSet() {
    if (computing) stop();
    const myTrials = trials;
    shown = null;
    fresh = null;
    saveNote = "";
    loaded = false;
    updateStatus();
    const local = storageRead(trials);
    const file = await loadResultsFile(trials);
    if (myTrials !== trials) return; // l'utilisateur a changé d'avis entre-temps

    // Le plus récent des jeux complets est affiché
    const candidates = [];
    if (isComplete(file, N)) candidates.push({ set: file, from: "file" });
    if (isComplete(local, N)) candidates.push({ set: local, from: "local" });
    candidates.sort((a, b) =>
      String(b.set.computedAt).localeCompare(String(a.set.computedAt)),
    );
    if (candidates.length) {
      shown = candidates[0].set;
      shownFrom = candidates[0].from;
    }

    if (local && !isComplete(local, N)) fresh = local; // recalcul interrompu
    loaded = true;
    render();
    updateStatus();

    if (!shown) start(!!fresh); // rien de disponible : on calcule
  }

  /* --- Calcul --- */
  function start(resume) {
    if (!resume || !fresh) {
      fresh = { trials, computedAt: null, hands: {} };
      storageWrite(trials, fresh);
    }
    const job = fresh,
      jobTrials = trials; // ce calcul précis, même si l'affichage change
    const todo = hands
      .map((h, i) => i)
      .filter((i) => !job.hands[hands[i].name]);
    computing = true;
    saveNote = "";
    runStart = performance.now();
    runDoneAtStart = Object.keys(job.hands).length;
    let lastRender = 0;
    if (computer) computer.stop();
    computer = createComputer(
      (index, result) => {
        job.hands[hands[index].name] = roundHand(result);
        storageWrite(jobTrials, job); // sauvegarde main par main
        if (fresh !== job) return;
        if (performance.now() - lastRender > 500) {
          render();
          lastRender = performance.now();
        }
        updateStatus();
      },
      async () => {
        job.computedAt = new Date().toISOString();
        const savedLocal = storageWrite(jobTrials, job);
        let from = "local",
          note = "";
        if (serverMode) {
          const error = await saveResultsFile(job);
          if (!error) {
            from = "file";
            storageRemove(jobTrials); // le fichier JSON fait foi, plus besoin de la copie
          } else {
            note = { key: "saveFail", e: error };
          }
        } else if (!savedLocal) {
          note = { key: "privateFail" };
        }
        if (fresh !== job) return;
        computing = false;
        shown = job;
        shownFrom = from;
        fresh = null;
        saveNote = note;
        render();
        updateStatus();
      },
    );
    computer.start(todo, trials);
    render();
    updateStatus();
  }

  function stop() {
    if (computer) computer.stop();
    computing = false;
    render();
    updateStatus();
  }

  /* --- Contrôles --- */
  $("run").addEventListener("click", () => (computing ? stop() : start(false)));
  $("resume").addEventListener("click", () => start(true));
  $("trials").addEventListener("change", () => {
    trials = +$("trials").value;
    loadSet();
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

  /* --- Menu des langues : un drapeau, qui ouvre la liste au clic --- */
  const langMenu = $("lang-menu"),
    langBtn = $("lang-btn");
  const openLangMenu = (open) => {
    langMenu.hidden = !open;
    langBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      const current = langMenu.querySelector('[data-lang="' + lang + '"]');
      if (current) current.focus();
    }
  };
  document.querySelectorAll("[data-lang]").forEach((b) => {
    b.querySelector(".flag-icon").innerHTML = FLAGS[b.dataset.lang];
    b.addEventListener("click", () => {
      lang = b.dataset.lang;
      try {
        localStorage.setItem(LANG_KEY, lang);
      } catch (e) {
        /* rien */
      }
      openLangMenu(false);
      langBtn.focus();
      applyLanguage();
    });
  });
  langBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openLangMenu(langMenu.hidden);
  });
  document.addEventListener("click", (e) => {
    if (!langMenu.hidden && !langMenu.contains(e.target)) openLangMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (langMenu.hidden) return;
    if (e.key === "Escape") {
      openLangMenu(false);
      langBtn.focus();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...langMenu.querySelectorAll("[data-lang]")];
      const i = items.indexOf(document.activeElement);
      items[
        (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
      ].focus();
      e.preventDefault();
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
  detectServer().then((ok) => {
    serverMode = ok;
    loadSet();
  });
}

/* --- Démarrage : page web ou module Node (server.js, compute.js) --- */
if (typeof document !== "undefined") {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", initPage);
  else initPage();
}
if (typeof module !== "undefined") {
  module.exports = {
    pokerEngine,
    Engine,
    runTests,
    roundHand,
    formatResultsFile,
    validateResults,
    TRIAL_CHOICES,
    I18N,
  };
}
