/* =====================================================================
   Équités préflop Texas Hold'em — code commun à la page, à server.js et à compute.js.

   1. Moteur de calcul (générateur aléatoire, évaluateur, simulations).
      Il est écrit dans une seule fonction pour pouvoir être copié tel quel
      dans les Web Workers du navigateur et dans compute.js (Node).
   2. Tests de l'évaluateur
   3. Format des fichiers de résultats (results/*.json)

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

  /* --- Simulation contre une range (second tableau) --- */

  // Toutes les combinaisons concrètes d'une main, à plat : [c0, c1, c0, c1, ...] (6, 4 ou 12 combinaisons)
  function handCombos(hand) {
    const out = [];
    for (let s0 = 0; s0 < 4; s0++) {
      for (let s1 = 0; s1 < 4; s1++) {
        if (hand.kind === "p" ? s1 <= s0 : (hand.kind === "s") !== (s0 === s1))
          continue;
        out.push(hand.hi * 4 + s0, hand.lo * 4 + s1);
      }
    }
    return out;
  }

  /* Sous ce taux de donnes compatibles, la situation est jugée presque impossible
     (ex. 9 adversaires tous dans le top 10 % : il n'y a pas assez d'As et de Rois).
     Le taux est mesuré sur les PILOT premiers tirages. */
  const MIN_ACCEPT = 0.01;
  const PILOT = 100000;

  /* Une main contre `opp` adversaires qui ont chacun une combinaison de `range`
     (tableau à plat de handCombos). Chaque adversaire tire une combinaison au hasard ;
     si une carte est déjà prise, toute la donne est rejetée et retirée : on obtient
     exactement la loi « tout le monde dans la range, sans carte en double ».
     Renvoie les totaux bruts, ou impossible: true. */
  function simulateRange(hand, opp, range, trials, rand) {
    const [h0, h1] = holeCards(hand);
    const list = [];
    for (let i = 0; i < range.length; i += 2) {
      const a = range[i],
        b = range[i + 1];
      if (a !== h0 && a !== h1 && b !== h0 && b !== h1) list.push(a, b);
    }
    const m = list.length / 2;
    if (!m) return { trials: 0, equity: 0, wins: 0, impossible: true };
    const combos = Int32Array.from(list);
    const mark = new Float64Array(52); // mark[c] === stamp : carte déjà distribuée dans ce tirage
    let stamp = 0;
    const o0 = new Int32Array(opp),
      o1 = new Int32Array(opp),
      board = new Int32Array(5);
    let done = 0,
      attempts = 0,
      equity = 0,
      wins = 0;

    while (done < trials) {
      if (attempts >= PILOT && done < attempts * MIN_ACCEPT)
        return { trials: done, equity, wins, impossible: true };
      attempts++;
      stamp++;
      mark[h0] = mark[h1] = stamp;
      let ok = true;
      for (let j = 0; j < opp; j++) {
        const x = rand(m) * 2,
          a = combos[x],
          b = combos[x + 1];
        if (mark[a] === stamp || mark[b] === stamp) {
          ok = false;
          break;
        }
        mark[a] = mark[b] = stamp;
        o0[j] = a;
        o1[j] = b;
      }
      if (!ok) continue;
      // Planche : 5 cartes au hasard parmi celles qui restent
      for (let j = 0; j < 5; ) {
        const c = rand(52);
        if (mark[c] === stamp) continue;
        mark[c] = stamp;
        board[j++] = c;
      }
      done++;
      const b0 = board[0],
        b1 = board[1],
        b2 = board[2],
        b3 = board[3],
        b4 = board[4];
      const me = evaluate7(h0, h1, b0, b1, b2, b3, b4);
      let ties = 0,
        lost = false;
      for (let j = 0; j < opp; j++) {
        const v = evaluate7(o0[j], o1[j], b0, b1, b2, b3, b4);
        if (v > me) {
          lost = true;
          break;
        }
        if (v === me) ties++;
      }
      if (!lost) {
        equity += 1 / (ties + 1);
        if (ties === 0) wins++;
      }
    }
    return { trials: done, equity, wins, impossible: false };
  }

  /* Une tâche de calcul de la page : une main (job.index), job.trials donnes,
     contre des adversaires au hasard (premier tableau), ou contre la range de
     chaque colonne si job.ranges est donné (second tableau : 9 tableaux de handCombos).
     Renvoie des % : { eq: [9], win: [9] }, null = case presque impossible. */
  function simulateJob(job, rand) {
    const hand = buildHands()[job.index];
    if (!job.ranges) return toPercent(simulateHand(hand, job.trials, rand));
    const eq = [],
      win = [];
    for (let k = 0; k < MAX_OPP; k++) {
      const r = simulateRange(hand, k + 1, job.ranges[k], job.trials, rand);
      eq.push(r.impossible ? null : (100 * r.equity) / r.trials);
      win.push(r.impossible ? null : (100 * r.wins) / r.trials);
    }
    return { eq, win };
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
    MIN_ACCEPT,
    handCombos,
    simulateRange,
    simulateJob,
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
   3. FORMAT DES FICHIERS DE RÉSULTATS
   Premier tableau, results/<donnes>.json :
     { trials, computedAt, duration, threads, hands: { "AA": {eq:[9], win:[9]}, ... } }
       eq[k]  = équité contre k+1 adversaires, en %
       win[k] = victoire sans partage contre k+1 adversaires, en %
       duration = temps de calcul en secondes, threads = cœurs utilisés (facultatifs)
   Second tableau, results/<donnes>-top<p>.json : même chose contre le top p %,
     plus top, basedOn (date du premier tableau utilisé pour le classement)
     et ranges (les mains de la range, pour chacune des 9 colonnes).
     Une valeur null = situation presque impossible (voir Engine.MIN_ACCEPT).
   ===================================================================== */
const TRIAL_CHOICES = [1000000, 5000000, 10000000, 100000000];
const TOP_CHOICES = [10, 20, 30, 40, 50, 60, 70, 80, 90];

function roundHand(p) {
  const r = (v) => (v === null ? null : Math.round(v * 10000) / 10000);
  return { eq: p.eq.map(r), win: p.win.map(r) };
}

/* Les mains du top p % pour chaque colonne du premier tableau, classées par équité.
   Même définition que la colonne « Top » de la page : rang / 169 ≤ p %.
   Renvoie 9 listes de noms de mains : ranges[k] sert contre k+1 adversaires. */
function topRanges(set, top) {
  const names = Engine.buildHands().map((h) => h.name);
  const size = Math.floor((top / 100) * names.length);
  const ranges = [];
  for (let k = 0; k < Engine.MAX_OPP; k++) {
    ranges.push(
      names
        .slice()
        .sort((a, b) => set.hands[b].eq[k] - set.hands[a].eq[k])
        .slice(0, size),
    );
  }
  return ranges;
}

// Une range (liste de noms de mains) -> toutes ses combinaisons à plat, pour Engine.simulateRange
function rangeCombos(names) {
  const byName = new Map(Engine.buildHands().map((h) => [h.name, h]));
  return [].concat(...names.map((n) => Engine.handCombos(byName.get(n))));
}

// Contenu d'un fichier de résultats : une main par ligne, lisible à l'œil
// (même format pour la page, server.js et compute.js)
function formatResultsFile(set) {
  const names = Engine.buildHands()
    .map((h) => h.name)
    .filter((n) => set.hands[n]);
  const lines = names.map(
    (n) => "    " + JSON.stringify(n) + ": " + JSON.stringify(set.hands[n]),
  );
  let head = '  "trials": ' + set.trials + ",\n";
  if (set.top !== undefined) head += '  "top": ' + set.top + ",\n";
  head += '  "computedAt": ' + JSON.stringify(set.computedAt) + ",\n";
  if (set.duration !== undefined)
    head += '  "duration": ' + set.duration + ",\n";
  if (set.threads !== undefined) head += '  "threads": ' + set.threads + ",\n";
  if (set.basedOn !== undefined)
    head += '  "basedOn": ' + JSON.stringify(set.basedOn) + ",\n";
  if (set.ranges) {
    head +=
      '  "ranges": [\n' +
      set.ranges.map((r) => "    " + JSON.stringify(r)).join(",\n") +
      "\n  ],\n";
  }
  return "{\n" + head + '  "hands": {\n' + lines.join(",\n") + "\n  }\n}\n";
}

/* Vérifie qu'un jeu de résultats est complet et plausible (utilisé aussi par server.js).
   allowNull : le second tableau peut contenir des cases impossibles (null). */
function validateResults(set, allowNull) {
  if (!set || typeof set !== "object") return "contenu vide";
  if (!TRIAL_CHOICES.includes(set.trials)) return "nombre de donnes non prévu";
  if (typeof set.computedAt !== "string" || isNaN(Date.parse(set.computedAt)))
    return "date invalide";
  if (
    set.duration !== undefined &&
    !(Number.isFinite(set.duration) && set.duration >= 0)
  )
    return "durée invalide";
  if (
    set.threads !== undefined &&
    !(Number.isInteger(set.threads) && set.threads >= 1)
  )
    return "nombre de cœurs invalide";
  const names = Engine.buildHands().map((h) => h.name);
  if (!set.hands || Object.keys(set.hands).length !== names.length)
    return "il faut les 169 mains";
  const ok = (v) =>
    (allowNull && v === null) || (typeof v === "number" && v >= 0 && v <= 100);
  for (const n of names) {
    const h = set.hands[n];
    if (!h) return "main manquante : " + n;
    for (const key of ["eq", "win"]) {
      const a = h[key];
      if (!Array.isArray(a) || a.length !== Engine.MAX_OPP || !a.every(ok))
        return "valeurs invalides pour " + n;
    }
  }
  return null;
}

// Fichier du second tableau : même vérification, plus le top et les ranges
function validateRangeResults(set) {
  const problem = validateResults(set, true);
  if (problem) return problem;
  if (!TOP_CHOICES.includes(set.top)) return "top non prévu";
  if (!Array.isArray(set.ranges) || set.ranges.length !== Engine.MAX_OPP)
    return "ranges invalides";
  return null;
}

if (typeof module !== "undefined") {
  module.exports = {
    pokerEngine,
    Engine,
    runTests,
    roundHand,
    topRanges,
    rangeCombos,
    formatResultsFile,
    validateResults,
    validateRangeResults,
    TRIAL_CHOICES,
    TOP_CHOICES,
  };
}
