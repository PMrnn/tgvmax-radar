# TGVmax Radar

App installable (PWA) qui interroge en direct l'API ouverte SNCF « Disponibilité
MAX JEUNE / MAX SENIOR » (`tgvmax` sur `ressources.data.sncf.com`) pour repérer
les trains avec places TGVmax libres — en ligne sur
**https://pmrnn.github.io/tgvmax-radar/**.

Le cœur de l'app (`index.html`, `sw.js`) est 100% côté navigateur, sans backend.
Un petit backend séparé (dossier `worker/`) existe uniquement pour les
**alertes push** (voir plus bas).

## Fonctionnalités

1. **Trajets libres depuis une gare** : ville/gare de départ + date → tous les
   trains TGVmax libres au départ, triés par heure. Filtrable par fenêtres
   horaires de départ/arrivée (voir ci-dessous).
2. **Trajet A → B (jusqu'à 3 trains)** : ville de départ + ville d'arrivée +
   **plage de dates** aller → tous les itinéraires *entièrement* en places
   TGVmax libres, en direct, avec 1 ou 2 correspondances (3 trains max). Les
   correspondances tiennent compte d'un temps mini différent selon qu'on
   change de train à quai (même gare) ou qu'on traverse une ville à plusieurs
   gares (Paris).
   - **Retour optionnel** : activez « Ajouter un retour » avec sa propre plage
     de dates — seuls les allers ayant *au moins un retour compatible* sont
     affichés, avec les retours possibles imbriqués sous chaque aller.
3. **Fenêtres horaires (« ou »)** dans les deux onglets : ajoutez plusieurs
   fenêtres de départ/arrivée acceptées (ex. « avant 9h » OU « après 18h » pour
   éviter les horaires de bureau) — vide = toute heure, plusieurs fenêtres = OU.
4. **🔔 Alertes** : sauvegardez n'importe quelle recherche (des deux onglets)
   comme alerte. Elle est revérifiée automatiquement (~toutes les heures) même
   application fermée, et vous recevez une vraie notification dès qu'un
   nouveau trajet correspond — voir « Comment marchent les alertes » plus bas.

Pour Paris, toutes les gares intra-muros (Nord, Est, Austerlitz, Montparnasse,
Lyon, Bercy — regroupées par la SNCF sous « PARIS (intramuros) ») **et** les
gares proches (Aéroport CDG 2 TGV, Marne-la-Vallée Chessy, Massy Palaiseau,
Massy TGV) sont automatiquement incluses dès que vous tapez « Paris ».

## Installer sur le téléphone

Ouvrez **https://pmrnn.github.io/tgvmax-radar/** dans Chrome (Android) et
utilisez « Installer l'application » / « Ajouter à l'écran d'accueil ». L'app
s'ouvre alors en plein écran avec sa propre icône, comme une vraie app.

## Comment marchent les alertes

```
Vous créez une alerte  →  stockée dans un Cloudflare Worker (worker/)
                           (vos critères + votre abonnement push navigateur)
                                        │
                    GitHub Actions (cron, ~toutes les heures)
                                        │
              worker/scripts/check-watches.mjs relance la même recherche
              contre l'API SNCF en direct, compare aux résultats déjà notifiés
                                        │
                    nouveau trajet trouvé → vraie notification Web Push
                    (via `web-push`, même app/téléphone fermé)
```

- **Coût : 0€.** Cloudflare Workers/KV et GitHub Actions (repo public) sont
  utilisés très en dessous de leurs paliers gratuits, et aucun moyen de
  paiement n'est rattaché au compte Cloudflare utilisé — au pire, un excès de
  quota fait échouer des requêtes, il ne facture jamais rien.
- **Vos données** : chaque alerte contient vos critères de recherche + un
  abonnement push (fourni par votre navigateur, pas de compte/mot de passe).
  Stockées dans Cloudflare KV, supprimables à tout moment depuis l'onglet
  « Mes alertes » (bouton Supprimer).
- Le check tourne côté serveur, donc les alertes fonctionnent même si le
  téléphone est éteint/l'app fermée — seule la réception de la notification
  nécessite que le téléphone soit allumé et connecté.
- Un trajet n'est notifié qu'**une fois** (état `notifiedKeys` par alerte) —
  pas de spam à chaque vérification horaire pour le même résultat.

### Composants (pour changer/redéployer)

- `worker/src/index.js` : Worker Cloudflare — API `POST/GET/DELETE /watches`
  (utilisée par l'app) + `/admin/watches` (utilisée par le job GitHub Actions,
  protégée par le header `X-Admin-Secret`). Redéployer : `cd worker && npx wrangler deploy`
  (avec `CLOUDFLARE_API_TOKEN` en variable d'env).
- `worker/scripts/check-watches.mjs` : le script Node exécuté par
  `.github/workflows/check-watches.yml`. Réutilise volontairement la même
  logique de recherche que `index.html` (à garder synchronisées si l'une
  évolue).
- Secrets GitHub Actions (`gh secret set`, repo `PMrnn/tgvmax-radar`) :
  `TGVMAX_WORKER_URL`, `TGVMAX_ADMIN_SECRET`, `TGVMAX_VAPID_PUBLIC_KEY`,
  `TGVMAX_VAPID_PRIVATE_KEY`. La clé VAPID publique est aussi codée en dur
  dans `index.html` (`VAPID_PUBLIC_KEY`) — ne pas la régénérer sans mettre à
  jour les deux (ça invaliderait tous les abonnements existants).

## Lancer l'app en local

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
- Les alertes revérifient environ toutes les heures — comme la donnée SNCF ne
  change elle-même qu'environ 1x/jour, la plupart des vérifications ne trouvent
  rien de neuf ; c'est normal, ça sert surtout à capter les ouvertures/annulations
  qui bougent en cours de journée sur le quota TGVmax partagé.
- Recevoir une notification nécessite d'avoir installé l'app et autorisé les
  notifications au moins une fois ; si vous désinstallez l'app ou videz les
  données du site, l'alerte reste en base jusqu'à ce que l'envoi échoue (auto-nettoyée).
