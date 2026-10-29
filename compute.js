/* Génère les fichiers de résultats avec exactement le même moteur que la page.

   Usage :
     node compute.js 1000000 5000000 10000000
         premier tableau : results/<donnes>.json
     node compute.js --top 10000000
         second tableau, pour les 9 tops (10 % à 90 %) : results/<donnes>-top<p>.json
         Il faut déjà results/<donnes>.json : il sert à classer les mains.
     node compute.js --top=10,20 10000000
         second tableau, seulement pour les tops donnés
     node compute.js --all 10000000
         les deux : premier tableau, puis le second pour les 9 tops
         (--all --top=10,20 : seulement ces tops pour le second)

   Utilise tous les cœurs du processeur (worker_threads).
   Les fichiers produits sont chargés par la page au démarrage :
   aucun visiteur n'a alors besoin de recalculer. */
"use strict";
const { Worker, isMainThread, parentPort } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  Engine,
  roundHand,
  topRanges,
  rangeCombos,
  formatResultsFile,
  validateResults,
  TOP_CHOICES,
} = require("./engine.js");

if (!isMainThread) {
  // Fil de calcul : reçoit une main (et pour le second tableau une colonne et une range),
  // renvoie ses pourcentages
  parentPort.on("message", ({ index, trials, opp, range }) => {
    const hand = Engine.buildHands()[index];
    const rand = Engine.makeRng(Engine.randomSeed());
    if (!range) {
      const raw = Engine.simulateHand(hand, trials, rand);
      return parentPort.postMessage({ index, result: Engine.toPercent(raw) });
    }
    const raw = Engine.simulateRange(hand, opp, range, trials, rand);
    parentPort.postMessage({
      index,
      opp,
      eq: raw.impossible ? null : (100 * raw.equity) / raw.trials,
      win: raw.impossible ? null : (100 * raw.wins) / raw.trials,
    });
  });
} else {
  main();
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const topArg = args.find((a) => a === "--top" || a.startsWith("--top="));
  const counts = args.map(Number).filter((n) => n > 0);
  if (!counts.length) {
    console.log("Usage : node compute.js 1000000 5000000 10000000");
    console.log("        node compute.js --top 10000000");
    console.log("        node compute.js --top=10,20 10000000");
    console.log("        node compute.js --all 10000000");
    process.exit(1);
  }
  // Arguments vérifiés avant tout calcul (sinon un calcul de plusieurs heures partirait pour rien)
  const tops =
    topArg && topArg.includes("=")
      ? topArg.split("=")[1].split(",").map(Number)
      : TOP_CHOICES;
  if (tops.some((p) => !TOP_CHOICES.includes(p))) {
    console.log("Tops possibles : " + TOP_CHOICES.join(", "));
    process.exit(1);
  }
  const threads = os.cpus().length;
  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });

  for (const trials of counts) {
    // Premier tableau (seul, ou avant le second avec --all)
    if (all || !topArg) await computeSet(trials, threads, outDir);
    if (!all && !topArg) continue;

    const file = path.join(outDir, `${trials}.json`);
    let base = null;
    try {
      base = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      /* absent */
    }
    if (!base || validateResults(base)) {
      console.log(
        `Il faut d'abord ${file} : node compute.js ${trials} (il sert à classer les mains)`,
      );
      process.exit(1);
    }
    for (const top of tops)
      await computeRangeSet(trials, top, base, threads, outDir);
  }
}

/* Distribue des tâches aux fils de calcul, une à la fois par fil.
   onResult(message) est appelé à chaque tâche terminée. */
function runJobs(jobs, threads, onResult) {
  const queue = jobs.slice();
  return new Promise((resolve) => {
    let alive = Math.min(threads, queue.length);
    if (!alive) return resolve();
    for (let w = 0; w < Math.min(threads, jobs.length); w++) {
      const worker = new Worker(__filename);
      const next = () => {
        if (!queue.length) {
          worker.terminate();
          if (--alive === 0) resolve();
          return;
        }
        worker.postMessage(queue.shift());
      };
      worker.on("message", (msg) => {
        onResult(msg);
        next();
      });
      next();
    }
  });
}

function progress(done, total, t0) {
  const s = (Date.now() - t0) / 1000;
  const left = done ? ((total - done) * s) / done : 0;
  process.stdout.write(
    `\r  ${done}/${total} · ${s.toFixed(0)} s · encore ~${(left / 60).toFixed(0)} min   `,
  );
}

// Écrit le fichier avec la durée du calcul et le nombre de cœurs utilisés
function writeSet(set, file, t0, threads) {
  set.duration = Math.round((Date.now() - t0) / 1000);
  set.threads = threads;
  fs.writeFileSync(file, formatResultsFile(set));
  console.log(`\n  écrit : ${file} (${durationText(set.duration)})`);
}

function durationText(s) {
  if (s < 90) return s + " s";
  if (s < 5400) return Math.round(s / 60) + " min";
  return Math.floor(s / 3600) + " h " + Math.round((s % 3600) / 60) + " min";
}

// Premier tableau : une tâche par main, contre 1 à 9 adversaires au hasard
async function computeSet(trials, threads, outDir) {
  const hands = Engine.buildHands();
  const set = { trials, computedAt: null, hands: {} };
  const t0 = Date.now();
  let done = 0;
  console.log(
    `${trials.toLocaleString("fr-FR")} donnes par main, ${threads} cœurs…`,
  );
  await runJobs(
    hands.map((h, index) => ({ index, trials })),
    threads,
    ({ index, result }) => {
      set.hands[hands[index].name] = roundHand(result);
      progress(++done, hands.length, t0);
    },
  );
  // Ordre de la grille classique dans le fichier
  const ordered = {};
  for (const h of hands) ordered[h.name] = set.hands[h.name];
  set.hands = ordered;
  set.computedAt = new Date().toISOString();
  writeSet(set, path.join(outDir, `${trials}.json`), t0, threads);
}

/* Second tableau : une tâche par main et par colonne (169 × 9),
   la colonne « k adversaires » utilise la range classée sur cette même colonne. */
async function computeRangeSet(trials, top, base, threads, outDir) {
  const hands = Engine.buildHands();
  const ranges = topRanges(base, top);
  const combos = ranges.map(rangeCombos);
  const out = {};
  for (const h of hands)
    out[h.name] = {
      eq: new Array(Engine.MAX_OPP).fill(null),
      win: new Array(Engine.MAX_OPP).fill(null),
    };

  // Les colonnes à beaucoup d'adversaires sont les plus longues : en premier
  const jobs = [];
  for (let opp = Engine.MAX_OPP; opp >= 1; opp--)
    hands.forEach((h, index) =>
      jobs.push({ index, trials, opp, range: combos[opp - 1] }),
    );

  const t0 = Date.now();
  let done = 0;
  console.log(
    `Top ${top} % (${ranges[0].length} mains), ${trials.toLocaleString("fr-FR")} donnes par case, ${threads} cœurs…`,
  );
  await runJobs(jobs, threads, ({ index, opp, eq, win }) => {
    out[hands[index].name].eq[opp - 1] = eq;
    out[hands[index].name].win[opp - 1] = win;
    progress(++done, jobs.length, t0);
  });
  const set = {
    trials,
    top,
    computedAt: new Date().toISOString(),
    basedOn: base.computedAt,
    ranges,
    hands: {},
  };
  for (const h of hands) set.hands[h.name] = roundHand(out[h.name]);
  writeSet(set, path.join(outDir, `${trials}-top${top}.json`), t0, threads);
}
