# Équités préflop Hold'em

Tableau des 169 mains de départ du Texas Hold'em, avec leur probabilité de gagner de 2 à 10 joueurs, calculée par simulation Monte Carlo en JavaScript.

## Fichiers

| Fichier          | Rôle                                                          |
| ---------------- | ------------------------------------------------------------- |
| `index.html`     | Structure de la page                                          |
| `style.css`      | Mise en forme (thème clair et sombre)                         |
| `script.js`      | Moteur de calcul, stockage des résultats et interface         |
| `server.js`      | Mini serveur sans dépendance : sert la page et écrit les JSON |
| `compute.js`     | Calcule les fichiers de résultats directement avec Node       |
| `results/*.json` | Résultats à 1, 5 et 10 millions de donnes par main            |

## Utilisation

Avec Node.js 18 ou plus récent :

```
node server.js
```

puis ouvre http://localhost:8080.

La page lit `results/<donnes>.json`. « Recalculer » relance le calcul sur tous les cœurs du processeur. À la fin, le serveur enregistre le résultat dans `results/<donnes>.json` à la place de l'ancien.

Pendant un calcul, chaque main terminée est gardée dans le navigateur : si la page est fermée, « Reprendre » continue là où le calcul s'était arrêté.

Sans serveur (`index.html` ouvert directement), le navigateur n'a pas le droit de lire ni d'écrire les fichiers JSON. La page calcule alors elle-même et garde les résultats dans le navigateur.

La page existe en français et en anglais. Par défaut, elle s'affiche en français si le navigateur est en français, sinon en anglais ; les drapeaux en haut à droite changent la langue, et le choix est mémorisé. Les textes sont dans l'objet `I18N` de `script.js`.

Couleurs : dans chaque colonne, le jaune correspond à la part moyenne (50 % à 2 joueurs, 10 % à 10 joueurs), la pire main est rouge et la meilleure verte. Le « mode daltonien » remplace le vert par du bleu.

## Recalculer sans navigateur

```
node compute.js 1000000 5000000 10000000
```

Même moteur que la page, sur tous les cœurs. Sur 2 cœurs, compte environ 1,5 min pour 1 million, 6 min pour 5 millions et 12 min pour 10 millions.

## Format des fichiers JSON

```
{
  "trials": 1000000,
  "computedAt": "2026-10-28T15:56:40.245Z",
  "hands": {
    "AA": {"eq": [9 valeurs], "win": [9 valeurs]},
    ...
  }
}
```

`eq[0]` est l'équité contre 1 adversaire, `eq[8]` contre 9. `win` ne compte que les pots gagnés sans partage. Les valeurs sont en %.

## Précision

La marge affichée vaut pour **tout le tableau** (169 mains × 9 colonnes) : 4 écarts types, soit `4 × 50 / √donnes` points. Une case prise seule est en général bien plus précise.

| Donnes par main | Marge affichée | Écart max mesuré avec le calcul exact (tête-à-tête) |
| --------------- | -------------- | --------------------------------------------------- |
| 1 000 000       | ±0,2 point     | 0,14 point                                          |
| 5 000 000       | ±0,09 point    | 0,05 point                                          |
| 10 000 000      | ±0,06 point    | 0,04 point                                          |
