#!/usr/bin/env bash
# Configure, une seule fois, la clé secrète du robot « version propre » :
#   1. génère une clé aléatoire (elle n'est affichée nulle part) ;
#   2. la donne au script Google V2 (qui refusera toute autre clé ensuite) ;
#   3. l'enregistre dans les secrets GitHub du dépôt V2, avec l'adresse du script.
# Utilisation : bash tools/setup-bot-key.sh
set -euo pipefail
REPO="SupernovaBejaia/green-quest-360-v2"
URL="https://script.google.com/macros/s/AKfycbxa-vXdnbuJg112McNNYq05Fl3bNiGvT15Hidmf6zFi257Bg0SrnbbJhdEXGzL88A302g/exec"

KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"

echo "1/3 Envoi de la clé au script Google…"
RES="$(curl -sL -H 'Content-Type: text/plain' --data "{\"action\":\"bot_init\",\"botKey\":\"$KEY\"}" "$URL")"
echo "    $RES"
case "$RES" in *'"ok":true'*) ;; *) echo "Échec : la clé n'a pas été acceptée (déjà configurée ?)."; exit 1 ;; esac

echo "2/3 Vérification…"
curl -sL -H 'Content-Type: text/plain' --data "{\"action\":\"bot_pending\",\"key\":\"$KEY\"}" "$URL"; echo

echo "3/3 Enregistrement dans les secrets GitHub…"
printf '%s' "$KEY" | gh secret set GQ_BOT_KEY -R "$REPO"
printf '%s' "$URL" | gh secret set GQ_BOT_URL -R "$REPO"
gh secret list -R "$REPO"
echo "Terminé. Le robot peut maintenant déposer les versions propres dans le Drive."
