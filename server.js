/* Mini serveur du projet, sans aucune dépendance.

   Usage :   node server.js        puis ouvrir http://localhost:8080
   Variables d'environnement :
     PORT=8080                         port d'écoute
     BASE_PATH=/poker                  si la page est servie sous un sous-chemin
                                       (le tunnel Cloudflare transmet le chemin complet)

   - sert la page : index.html, style.css, script.js et results/*.json
   - GET  <BASE_PATH>/api/ping                 indique à la page que le serveur est là
   - POST <BASE_PATH>/api/results/<donnes>     écrit results/<donnes>.json après vérification
*/
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { validateResults, formatResultsFile } = require("./script.js");

const ROOT = __dirname;
const RESULTS = path.join(ROOT, "results");
const PORT = Number(process.env.PORT) || 8080;
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, ""); // sans « / » final
const MAX_BODY = 1024 * 1024; // un jeu de résultats fait ~30 Ko

/* Protection de l'enregistrement, la page étant publique :
   - un nouveau calcul doit rester proche de l'ancien : deux vrais calculs diffèrent
     de moins de 0,2 point ; au-delà de MAX_DRIFT, c'est un envoi trafiqué ;
   - au plus un enregistrement par nombre de donnes toutes les MIN_INTERVAL ms
     (un vrai calcul à 1 million de donnes prend au moins une minute). */
const MAX_DRIFT = 0.5;
const MIN_INTERVAL = 60 * 1000;
const lastSave = {};

// Seuls ces fichiers sont publics (pas server.js, compute.js, Dockerfile…)
const PUBLIC = {
  "/": "index.html",
  "/index.html": "index.html",
  "/style.css": "style.css",
  "/script.js": "script.js",
};
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(
    typeof body === "string" || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body),
  );
}

function serveFile(res, route) {
  let file = PUBLIC[route];
  const m = route.match(/^\/results\/(\d+)\.json$/);
  if (m) file = path.join("results", m[1] + ".json");
  if (!file) return send(res, 404, { error: "introuvable" });
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) return send(res, 404, { error: "introuvable" });
    send(res, 200, data, TYPES[path.extname(file)]);
  });
}

// Plus grand écart entre deux jeux de résultats, en points
function maxDrift(a, b) {
  let max = 0;
  for (const name of Object.keys(a.hands)) {
    for (const key of ["eq", "win"]) {
      a.hands[name][key].forEach((v, i) => {
        max = Math.max(max, Math.abs(v - b.hands[name][key][i]));
      });
    }
  }
  return max;
}

function saveResults(req, res, trials) {
  let body = "",
    tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooBig) return send(res, 413, { error: "contenu trop gros" });
    let set;
    try {
      set = JSON.parse(body);
    } catch (e) {
      return send(res, 400, { error: "JSON illisible" });
    }
    if (set.trials !== trials)
      return send(res, 400, { error: "le nombre de donnes ne correspond pas" });
    const problem = validateResults(set);
    if (problem) return send(res, 400, { error: problem });

    if (lastSave[trials] && Date.now() - lastSave[trials] < MIN_INTERVAL) {
      return send(res, 429, {
        error:
          "un autre calcul vient d'être enregistré, réessaie dans une minute",
      });
    }
    const target = path.join(RESULTS, trials + ".json");
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (e) {
      /* pas encore de fichier */
    }
    if (previous && !validateResults(previous)) {
      const drift = maxDrift(set, previous);
      if (drift > MAX_DRIFT) {
        console.warn(
          new Date().toLocaleString("fr-FR") +
            " · envoi refusé (écart de " +
            drift.toFixed(2) +
            " point)",
        );
        return send(res, 400, {
          error: "résultats trop éloignés du calcul précédent",
        });
      }
    }

    // Écriture dans un fichier temporaire puis renommage : jamais de fichier à moitié écrit
    fs.mkdirSync(RESULTS, { recursive: true });
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, formatResultsFile(set));
    fs.renameSync(tmp, target);
    lastSave[trials] = Date.now();
    console.log(
      new Date().toLocaleString("fr-FR") +
        " · results/" +
        trials +
        ".json enregistré",
    );
    send(res, 200, { ok: true, file: "results/" + trials + ".json" });
  });
}

http
  .createServer((req, res) => {
    let url;
    try {
      url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch (e) {
      return send(res, 400, { error: "adresse invalide" });
    }

    // Sous-chemin : /other-project/poker → /other-project/poker/ (sinon les liens relatifs cassent)
    if (BASE_PATH) {
      if (url === BASE_PATH) {
        res.writeHead(301, { Location: BASE_PATH + "/" });
        return res.end();
      }
      if (!url.startsWith(BASE_PATH + "/"))
        return send(res, 404, { error: "introuvable" });
      url = url.slice(BASE_PATH.length);
    }

    if (url === "/api/ping" && req.method === "GET")
      return send(res, 200, { ok: true });
    const m = url.match(/^\/api\/results\/(\d+)$/);
    if (m && req.method === "POST") return saveResults(req, res, Number(m[1]));
    if (req.method === "GET" || req.method === "HEAD")
      return serveFile(res, url);
    send(res, 405, { error: "méthode non prise en charge" });
  })
  .listen(PORT, () => {
    console.log(
      "Équités préflop : http://localhost:" + PORT + (BASE_PATH || "") + "/",
    );
  });
