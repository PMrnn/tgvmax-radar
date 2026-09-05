# TGVmax Radar

Petite app 100% côté navigateur (un seul fichier `index.html`, pas de backend) qui
interroge en direct l'API ouverte SNCF « Disponibilité MAX JEUNE / MAX SENIOR »
(`tgvmax` sur `ressources.data.sncf.com`) pour repérer les trains avec places
TGVmax libres.

## Fonctionnalités

1. **Trajets libres depuis une gare** : ville/gare de départ + date → tous les
   trains TGVmax libres au départ, triés par heure.
2. **Trajet A → B (jusqu'à 3 trains)** : ville de départ + ville d'arrivée + date
   → tous les itinéraires *entièrement* en places TGVmax libres, en direct,
   avec 1 ou avec 2 correspondances (3 trains max). Les correspondances tiennent
   compte d'un temps mini différent selon qu'on change de train à quai (même
   gare) ou qu'on doit traverser une ville à plusieurs gares (Paris).

Pour Paris, toutes les gares intra-muros (Nord, Est, Austerlitz, Montparnasse,
Lyon, Bercy — regroupées par la SNCF sous « PARIS (intramuros) ») **et** les
gares proches (Aéroport CDG 2 TGV, Marne-la-Vallée Chessy, Massy Palaiseau,
Massy TGV) sont automatiquement incluses dès que vous tapez « Paris ».

## Lancer l'app

```bash
./run.sh
```

(ou `./run.sh 9000` pour un autre port). Le script démarre un petit serveur
local et ouvre `http://localhost:8934` dans votre navigateur.

Vous pouvez aussi double-cliquer sur `index.html`, mais certains navigateurs
bloquent les requêtes réseau depuis un fichier local (`file://`) — le script
`run.sh` évite ce problème.

## Limites connues

- Le jeu de données SNCF ne couvre qu'une **fenêtre glissante de 30 jours** et
  n'est mis à jour qu'**environ une fois par jour** (~14h) — ce n'est donc pas
  du temps réel à la minute près.
- Il liste uniquement les trajets **MAX JEUNE / MAX SENIOR** (TGV INOUI,
  INTERCITÉS, OUIGO Train Classique) avec réservation obligatoire — pas les
  TER, ni les abonnements Liberté/Forfait.
- La recherche de correspondances se limite à la **même journée** (pas de
  correspondance après minuit) et à un **maximum de 2 correspondances**.
- La recherche de gare est une simple correspondance texte (ex. « Quimper »
  peut aussi remonter « Quimperlé ») — vérifiez la gare exacte affichée dans
  les résultats.
- Ceci n'est pas une app officielle SNCF : vérifiez toujours la disponibilité
  réelle avant de réserver.
