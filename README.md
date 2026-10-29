# Équités préflop Hold'em

Tableau des 169 mains de départ du Texas Hold'em, avec leur probabilité de gagner de 2 à 10 joueurs, calculée par simulation Monte Carlo en JavaScript.

Un second tableau donne les mêmes probabilités quand chaque adversaire ne joue que le top 10 %, 20 % … 90 % des mains (classées selon la même colonne du premier tableau).

## Fichiers

| Fichier                            | Rôle                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| `index.html`                       | Structure de la page                                          |
| `style.css`                        | Mise en forme (thème clair et sombre)                         |
| `engine.js`                        | Moteur de calcul, tests, format des fichiers (page et Node)   |
| `i18n.js`                          | Textes de la page en français et en anglais                   |
| `script.js`                        | Stockage, calcul dans le navigateur, interface, couleurs      |
| `server.js`                        | Mini serveur sans dépendance : sert la page et écrit les JSON |
| `Dockerfile`, `docker-compose.yml` | Déploiement à côté du portfolio                               |
| `compute.js`                       | Calcule les fichiers de résultats directement avec Node       |
| `results/<donnes>.json`            | Premier tableau, à 1, 5, 10 (et 100) millions de donnes       |
| `results/<donnes>-top<p>.json`     | Second tableau, contre le top p %                             |

## Utilisation

Avec Node.js 18 ou plus récent :

```
node server.js
```

puis ouvre http://localhost:8080.

La page lit `results/<donnes>.json` et `results/<donnes>-top<p>.json`. Chaque tableau a son bouton « Recalculer », qui relance le calcul sur tous les cœurs du processeur ; un seul calcul tourne à la fois. À la fin, le serveur enregistre le résultat à la place de l'ancien fichier. Pour le second tableau, il vérifie en plus que les ranges correspondent à son propre `results/<donnes>.json`.

Quand un tableau n'est pas encore calculé, un message prend sa place, avec un bouton « Calculer dans ce navigateur » et la commande à lancer sur le serveur à la place. Le second tableau a besoin du premier, au même nombre de donnes.

Par défaut, la page affiche le plus grand nombre de donnes déjà calculé.

« Recalculer » tourne **dans le navigateur du visiteur** (sur son ordinateur, pas sur le serveur), puis envoie le résultat au serveur. Pour calculer sur le serveur, utiliser `compute.js` (plus bas).

Pendant un calcul (dans l'un ou l'autre tableau), chaque main terminée est gardée dans le navigateur : si la page est fermée, « Reprendre » continue là où le calcul s'était arrêté.

Sans serveur (`index.html` ouvert directement), le navigateur n'a pas le droit de lire ni d'écrire les fichiers JSON. La page calcule alors elle-même et garde les résultats dans le navigateur.

La page existe en français et en anglais. Par défaut, elle s'affiche en français si le navigateur est en français, sinon en anglais ; le drapeau en haut à droite ouvre le menu des langues, et le choix est mémorisé. À côté, le soleil ou la lune ouvre le menu du thème (clair ou sombre) ; sans choix, la page suit le thème du système. Les textes sont dans `i18n.js`.

Couleurs : par paliers de top, dans chaque colonne (top 0 à 3 % vert foncé, 3 à 8 % vert, etc.). Les paliers se règlent dans `COLOR_TIERS`, en haut de la partie interface de `script.js`. Le « mode daltonien » remplace le vert par du bleu.

## Recalculer sans navigateur

```
node compute.js 1000000 5000000 10000000
```

Même moteur que la page, sur tous les cœurs. Chaque fichier garde la durée du calcul et le nombre de cœurs utilisés, affichés sous le tableau. Exemple sur un Ryzen 7 5700X (16 fils) : environ 2 min pour le premier tableau à 10 millions, 4 h 30 pour le second.

Second tableau (il faut d'abord `results/<donnes>.json`, qui sert à classer les mains) :

```
node compute.js --top 1000000          # les 9 tops, de 10 % à 90 %
node compute.js --top=10,20 1000000    # seulement certains tops
node compute.js --all 10000000         # premier tableau, puis le second (9 tops)
```

C'est bien plus long que le premier tableau (environ 120 fois) : chaque colonne a sa propre range, donc une donne ne sert plus aux 9 colonnes à la fois, et il faut retirer les donnes où deux joueurs auraient la même carte. Chaque top est écrit dans son fichier dès qu'il est fini.

Une case vaut `null` (« — » sur la page) quand moins d'une donne tirée sur 100 est compatible (`MIN_ACCEPT` dans `engine.js`) : par exemple 7 adversaires ou plus tous dans le top 10 %, il n'y a pas assez de grosses cartes.

Sur le serveur, dans le conteneur (les fichiers vont dans le volume `results`) :

```
docker compose exec -d poker node compute.js --all 10000000
```

## Format des fichiers JSON

```
{
  "trials": 1000000,
  "computedAt": "2026-10-28T15:56:40.245Z",
  "duration": 812,
  "threads": 2,
  "hands": {
    "AA": {"eq": [9 valeurs], "win": [9 valeurs]},
    ...
  }
}
```

Les fichiers du second tableau ont en plus `top`, `basedOn` (date du premier tableau utilisé pour le classement) et `ranges` (les mains de la range de chaque colonne).

`duration` est le temps de calcul en secondes (cumulé sur les reprises pour un calcul fait dans le navigateur), `threads` le nombre de cœurs ; les deux sont facultatifs (les anciens fichiers n'en ont pas, la page n'affiche alors pas de durée).

`eq[0]` est l'équité contre 1 adversaire, `eq[8]` contre 9. `win` ne compte que les pots gagnés sans partage. Les valeurs sont en %.

## Précision

La marge affichée vaut pour **tout le tableau** (169 mains × 9 colonnes) : 4 écarts types, soit `4 × 50 / √donnes` points. Une case prise seule est en général bien plus précise.

| Donnes par main | Marge affichée | Écart max mesuré avec le calcul exact (tête-à-tête) |
| --------------- | -------------- | --------------------------------------------------- |
| 1 000 000       | ±0,2 point     | 0,14 point                                          |
| 5 000 000       | ±0,09 point    | 0,05 point                                          |
| 10 000 000      | ±0,06 point    | 0,04 point                                          |
| 100 000 000     | ±0,02 point    |                                                     |
