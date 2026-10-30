#!/bin/sh
# Copy Philform's service to the server and restart it.
#   deploy/deploy.sh            code only
#   deploy/deploy.sh --setup    also the systemd unit and Caddyfile
# Uses .dev/ssh/config (host "philform"); secrets live in /etc/philform.env on the server.
set -e
cd "$(dirname "$0")/.."
SSH="ssh -F .dev/ssh/config"
rsync -az --delete -e "$SSH" --rsync-path="sudo rsync" \
  --include='backend/' --include='backend/server.mjs' \
  --include='src/' --include='src/background/' --include='src/background/cost.js' \
  --include='src/common/' --include='src/common/wallet.js' \
  --include='src/common/rules-default.js' --include='src/common/rulespack.js' \
  --filter='P site/' --exclude='*' ./ philform:/opt/philform/
# The public pages: the privacy policy and the template that renders it.
# The website, with Phil's drawing and the icons from the extension. The
# Firefox folder is only seeded: tools/publish-firefox.py keeps it up to date.
rsync -az -e "$SSH" --rsync-path="sudo rsync" --exclude=firefox/ deploy/site/ PRIVACY.md src/common/phil.js \
  icons/icon32.png icons/icon128.png philform:/opt/philform/site/
rsync -az -e "$SSH" --rsync-path="sudo rsync" --ignore-existing deploy/site/firefox/ philform:/opt/philform/site/firefox/
if [ "$1" = "--setup" ]; then
  $SSH philform 'sudo install -d -m 750 -o philform -g philform /var/lib/philform'
  rsync -az -e "$SSH" --rsync-path="sudo rsync" deploy/philform.service philform:/etc/systemd/system/philform.service
  rsync -az -e "$SSH" --rsync-path="sudo rsync" deploy/Caddyfile philform:/etc/caddy/Caddyfile
  $SSH philform 'sudo systemctl daemon-reload && sudo systemctl enable philform && sudo systemctl reload caddy'
fi
$SSH philform 'sudo chown -R root:root /opt/philform && sudo systemctl restart philform && sleep 1 && curl -fsS http://127.0.0.1:8787/health && echo'
