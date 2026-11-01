# Séances : chrono et compteur de pompes

Web app à installer sur l'écran d'accueil de l'iPhone. Elle s'ouvre en plein écran comme une app, fonctionne hors ligne, et toutes les données restent sur le téléphone. Pas besoin de Mac ni de compte Apple Developer.

## Fonctionnalités

- **Chrono** : effort, repos et nombre de répétitions réglables avec les boutons − / + (appui long pour aller vite), plus des préréglages (Tabata 20/10, 30/15…).
- **Exercices** : ta liste d'exercices, chacun avec son propre chrono. ▶ lance l'exercice, toucher la carte permet de le modifier ou de le supprimer.
- **Pompes** : séries × sous-séries, temps par sous-série, récup entre sous-séries, repos après chaque série. Après chaque effort, l'app te demande combien de pompes tu as faites (la valeur précédente est proposée par défaut). Le total du jour est suivi avec un objectif quotidien.
- **Stats** : graphiques sur 7 jours, 30 jours ou 12 semaines, total du jour, de la semaine (avec l'évolution par rapport à la semaine précédente), du mois et depuis le début, record sur une journée, meilleure série, moyennes, cadence (pompes par minute d'effort), jours consécutifs, historique des séances chrono.
- Pendant une séance : bips 3-2-1, annonces vocales (« Repos », « Série 2 »…), écran maintenu allumé, pause en touchant le cercle, bouton +10 s et bouton pour passer à la phase suivante.
- **Réglages** (roue dentée) : sons, voix, durée de préparation, objectif quotidien, export et import d'une sauvegarde.

## Installer sur l'iPhone

L'app doit être servie en **HTTPS** pour fonctionner hors ligne et garder l'écran allumé. Le plus simple est GitHub Pages, qui est gratuit et permanent :

1. Crée un compte sur github.com, puis un nouveau dépôt **public** (par exemple `seances`).
2. Sur la page du dépôt : *Add file → Upload files*, puis dépose `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.webmanifest` et le dossier `icons`. Valide avec *Commit changes*.
3. *Settings → Pages* : Source = *Deploy from a branch*, Branch = `main` / `(root)`, puis *Save*.
4. Au bout d'une minute environ, l'app est en ligne sur `https://<ton-pseudo>.github.io/seances/`.
5. Sur l'iPhone, ouvre cette adresse dans **Safari**, puis touche **Partager → Sur l'écran d'accueil**.

Lance toujours l'app depuis son icône : c'est là que tes données sont stockées.

### Test rapide sans hébergement (même Wi-Fi)

Sur le PC, dans ce dossier :

```bash
python -m http.server 8080 --bind 0.0.0.0
```

Sur l'iPhone, ouvre ensuite `http://<IP-du-PC>:8080` dans Safari (par exemple `http://192.168.178.36:8080`). Windows peut demander d'autoriser Python dans le pare-feu. En HTTP simple, l'écran ne reste pas allumé et l'app ne marche pas hors ligne, donc ce mode sert seulement à essayer.

## Bon à savoir

- **Son en mode silencieux** : sur iOS 17 et plus, les bips passent même quand le bouton silencieux est activé. Sur les versions plus anciennes, désactive le mode silencieux.
- **Écran verrouillé** : iOS met les web apps en pause quand l'écran est verrouillé. L'app garde l'écran allumé pendant une séance. Si tu changes d'app, le chrono rattrape le temps écoulé à ton retour, mais tu n'entends pas les bips entre-temps.
- **Sauvegarde** : *Réglages → Exporter* crée un fichier JSON (que tu peux par exemple enregistrer dans Fichiers ou iCloud). *Importer* le restaure.
- **Mise à jour de l'app** : après avoir modifié les fichiers, change `VERSION` dans `sw.js` (`seances-v2`…). L'iPhone prend la nouvelle version au deuxième lancement.
