#!/bin/bash
# One-time bootstrap for the nginx + Let's Encrypt setup in docker-compose.yml.
#
# nginx/conf.d/ashwin.opsmonsters.com.conf references a real cert
# (/etc/letsencrypt/live/...) before one exists, and certbot needs nginx
# already answering on :80 to complete the http-01 challenge. This breaks
# the chicken-and-egg: it stands up a throwaway self-signed cert so nginx
# can start, requests the real cert through that running nginx, then
# reloads nginx onto it. Re-running it later is harmless (it skips
# requesting a cert that's already there and not close to expiring) — but
# renewal is otherwise handled automatically by the `certbot` service's
# own loop, this script is only for the very first run.
#
# Prereqs: ashwin.opsmonsters.com's DNS A/AAAA record in Cloudflare already
# points at this server's IP and is set to DNS-only (grey cloud) — Let's
# Encrypt's http-01 challenge and this domain's TLS termination both happen
# on this box directly, not through Cloudflare's proxy.
#
# Usage: ./scripts/init-letsencrypt.sh [email-for-letsencrypt-notices]
set -eu

domain="ashwin.opsmonsters.com"
email="${1:-}"
rsa_key_size=4096
data_path="./certbot"
compose="docker compose"

# The one argument this script takes is a notification email, not the
# domain (that's hardcoded above — this always issues for
# ashwin.opsmonsters.com). Catch the easy mix-up early instead of quietly
# handing certbot a bogus --email value.
case "$email" in
  '' | *@*) ;;
  *)
    echo "error: '$email' doesn't look like an email address." >&2
    echo "Usage: $0 [email-for-letsencrypt-notices]" >&2
    exit 1
    ;;
esac

if [ -d "$data_path/conf/live/$domain" ]; then
  echo "Existing certificate data found for $domain — skipping issuance."
  echo "Delete $data_path/conf/live/$domain first if you need to start over."
  exit 0
fi

echo "### Installing recommended TLS parameters ..."
mkdir -p "$data_path/conf"
# Bundled in the repo (nginx/tls/) rather than fetched from GitHub at deploy
# time — that used to curl these from certbot's repo, which 404s the moment
# that repo's default branch/path changes upstream. See git history.
cp "$(dirname "$0")/../nginx/tls/options-ssl-nginx.conf" "$data_path/conf/options-ssl-nginx.conf"
if [ ! -f "$data_path/conf/ssl-dhparams.pem" ]; then
  echo "### Generating a 2048-bit DH param file (one-time, takes a few seconds-minutes) ..."
  openssl dhparam -out "$data_path/conf/ssl-dhparams.pem" 2048
fi

echo "### Creating a dummy certificate for $domain so nginx can start ..."
path="/etc/letsencrypt/live/$domain"
mkdir -p "$data_path/conf/live/$domain"
$compose run --rm --entrypoint "\
  openssl req -x509 -nodes -newkey rsa:$rsa_key_size -days 1 \
    -keyout '$path/privkey.pem' \
    -out '$path/fullchain.pem' \
    -subj '/CN=localhost'" certbot

echo "### Starting nginx ..."
$compose up -d nginx

echo "### Deleting dummy certificate for $domain ..."
$compose run --rm --entrypoint "\
  rm -rf /etc/letsencrypt/live/$domain && \
  rm -rf /etc/letsencrypt/archive/$domain && \
  rm -rf /etc/letsencrypt/renewal/$domain.conf" certbot

echo "### Requesting the real Let's Encrypt certificate for $domain ..."
email_arg="--register-unsafely-without-email"
if [ -n "$email" ]; then
  email_arg="--email $email"
fi
$compose run --rm --entrypoint "\
  certbot certonly --webroot -w /var/www/certbot \
    $email_arg \
    -d $domain \
    --rsa-key-size $rsa_key_size \
    --agree-tos \
    --non-interactive" certbot

echo "### Reloading nginx onto the real certificate ..."
$compose exec nginx nginx -s reload

echo "Done. https://$domain should now be serving a trusted certificate."
