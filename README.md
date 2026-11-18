# Green Quest 360 (Supernova)

Web app installable (Android + iPhone) pour prendre des **photos 360 hors ligne** pendant Green Quest, puis les **envoyer dans Google Drive**. Un écran de conseils guide chaque participant pour réussir sa photo sphère.

- **Prise de vue guidée** : points cibles à viser, déclenchement automatique quand le téléphone est immobile.
- **Assemblage 360 sur le téléphone**, sans Internet. L'alignement se fait sur le contenu des images,
  ce qui corrige le gyroscope ; l'exposition est égalisée ; la photo fait 4096×2048.
- **Métadonnées** : photo reconnue comme 360 (XMP GPano) avec la position GPS (EXIF).
- **File d'envoi** vers Drive via Google Apps Script : reprise automatique et aucun doublon.
  Un Google Sheet est rempli pour la carte.
- **Interface** en français et en arabe.
- **Atelier HD** (`hd.html`) : refait une version 8192 px sur ordinateur à partir des photos sources.

**App en ligne** : <https://supernovabejaia.github.io/green-quest-360/>.
**V2 de test** : <https://supernovabejaia.github.io/green-quest-360-v2/> — contrôle qualité, dossiers par participant, version propre automatique. Voir [docs/V2.md](docs/V2.md) (branche `v2`).
**Atelier HD** : <https://supernovabejaia.github.io/green-quest-360/hd.html>.
**Photos reçues** : dossier Drive « Green Quest Cartographie ».
**Republier après une modification** : `bash tools/publish.sh "message"`. Change d'abord `VERSION` dans `app/sw.js`.

| Dossier | Contenu |
|---|---|
| `app/` | l'application à héberger (fichiers statiques, HTTPS) |
| `apps-script/Code.gs` | le script Google qui reçoit les photos |
| `docs/INSTALLATION.md` | mise en place (organisateur) |
| `docs/GUIDE-PARTICIPANTS.md` | guide FR / AR à partager |
| `tools/serve.mjs` | serveur de test local (`node tools/serve.mjs`) |

**Tests en local** : `node tools/serve.mjs`, puis
- <http://localhost:5360/?sim> : simulation sur PC, on fait tourner la vue à la souris ;
- <http://localhost:5360/test/stitch-test.html> : test de précision de l'assemblage.
