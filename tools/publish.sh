#!/usr/bin/env bash
# Republie l'app sur GitHub Pages : bash tools/publish.sh "message"
#   branche main -> V1 : https://supernovabejaia.github.io/green-quest-360/
#   branche v2   -> V2 : https://supernovabejaia.github.io/green-quest-360-v2/
# Pense à changer VERSION dans app/sw.js avant, sinon les téléphones gardent l'ancienne version.
set -euo pipefail
cd "$(dirname "$0")/.."
branch="$(git branch --show-current)"
case "$branch" in
  main) remote=origin; url="https://supernovabejaia.github.io/green-quest-360/" ;;
  v2)   remote=v2;     url="https://supernovabejaia.github.io/green-quest-360-v2/" ;;
  *) echo "Branche $branch : rien à publier (main ou v2 seulement)"; exit 1 ;;
esac
git add -A
git commit -m "${1:-Mise a jour}" || true
if [ "$branch" = main ]; then
  git push origin main
else
  git push v2 v2:main
fi
git push "$remote" "$(git subtree split --prefix app "$branch")":gh-pages --force
echo "Publié : $url (1 à 2 minutes)"
