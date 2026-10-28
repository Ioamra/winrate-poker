/* Génère les fichiers results/<donnes>.json avec exactement le même moteur que la page.

   Usage :   node compute.js 1000000 5000000 10000000
   Utilise tous les cœurs du processeur (worker_threads).
   Les fichiers produits sont chargés par la page au démarrage :
   aucun visiteur n'a alors besoin de recalculer. */
"use strict";
const { Worker, isMainThread, parentPort } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Engine, roundHand, formatResultsFile } = require("./script.js");

if (!isMainThread) {
  // Fil de calcul : reçoit une main, renvoie ses pourcentages
  parentPort.on("message", ({ index, trials }) => {
    const hand = Engine.buildHands()[index];
    const raw = Engine.simulateHand(
      hand,
      trials,
      Engine.makeRng(Engine.randomSeed()),
    );
    parentPort.postMessage({ index, result: Engine.toPercent(raw) });
  });
} else {
  main();
}

async function main() {
  const counts = process.argv
    .slice(2)
    .map(Number)
    .filter((n) => n > 0);
  if (!counts.length) {
    console.log("Usage : node compute.js 1000000 5000000 10000000");
    process.exit(1);
  }
  const threads = os.cpus().length;
  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  for (const trials of counts) await computeSet(trials, threads, outDir);
}

function computeSet(trials, threads, outDir) {
  const hands = Engine.buildHands();
  const queue = hands.map((h, i) => i);
  const set = { trials, computedAt: null, hands: {} };
  const t0 = Date.now();
  let done = 0;
  console.log(
    `${trials.toLocaleString("fr-FR")} donnes par main, ${threads} cœurs…`,
  );

  return new Promise((resolve) => {
    let alive = threads;
    for (let w = 0; w < threads; w++) {
      const worker = new Worker(__filename);
      const next = () => {
        if (!queue.length) {
          worker.terminate();
          if (--alive === 0) finish();
          return;
        }
        worker.postMessage({ index: queue.shift(), trials });
      };
      worker.on("message", ({ index, result }) => {
        set.hands[hands[index].name] = roundHand(result);
        done++;
        const s = (Date.now() - t0) / 1000;
        process.stdout.write(
          `\r  ${done}/${hands.length} mains · ${s.toFixed(0)} s   `,
        );
        next();
      });
      next();
    }
    function finish() {
      // Ordre de la grille classique dans le fichier
      const ordered = {};
      for (const h of hands) ordered[h.name] = set.hands[h.name];
      set.hands = ordered;
      set.computedAt = new Date().toISOString();
      const file = path.join(outDir, `${trials}.json`);
      fs.writeFileSync(file, formatResultsFile(set));
      console.log(
        `\n  écrit : ${file} (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
      );
      resolve();
    }
  });
}
