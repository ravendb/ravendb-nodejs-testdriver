#!/usr/bin/env bash
#
# Regenerates the self-signed test certificates used by the secured-server example.
#
#   ./generate.sh
#
# Produces, in this directory:
#
#   ca.crt          CA certificate — the client trusts this, so it accepts the server
#   server.pfx      certificate + key, password-less; RavenDB loads this, and the
#                   example's document stores authenticate with the same file
#   server.crt      the same certificate without the key, so the example can read
#                   its thumbprint with node:crypto, which parses PEM but not PKCS#12
#
# One certificate covers both roles, which is what ServerOptions.secured() expects:
# the server presents it, the client authenticates with it, and its thumbprint is
# registered as a well-known admin certificate. It carries both serverAuth and
# clientAuth extended key usages for that reason.
#
# It is issued for localhost / 127.0.0.1 / ::1, which is where the embedded server
# binds in the example. The example reads the thumbprint at runtime, so re-running
# this script needs no code change.
#
# These are throwaway certificates for a local test server. The private keys are
# committed on purpose — nothing is protected by them. Do not reuse them anywhere.
set -euo pipefail

cd "$(dirname "$0")"

# Git Bash / MSYS rewrites arguments that look like absolute POSIX paths, which
# mangles openssl's "/C=IL/O=..." subject strings into Windows paths.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

DAYS=3650
SUBJECT_PREFIX="/C=IL/O=RavenDB Test Driver Examples"

echo "==> CA"
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout ca.key -out ca.crt -days "$DAYS" -sha256 \
    -subj "$SUBJECT_PREFIX/CN=RavenDB Test Driver Example CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"

echo "==> server certificate (localhost)"
openssl req -newkey rsa:2048 -nodes \
    -keyout server.key -out server.csr \
    -subj "$SUBJECT_PREFIX/CN=localhost"

# A real file rather than process substitution: the Windows openssl build cannot
# read the /dev/fd/NN path that <(...) produces under Git Bash.
cat > server.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
EOF

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days "$DAYS" -sha256 -extfile server.ext

# RavenDB wants a single file holding certificate + key.
openssl pkcs12 -export -out server.pfx -inkey server.key -in server.crt \
    -certfile ca.crt -passout pass:

# Intermediate artifacts. server.crt is kept (public certificate, no key) — the
# example reads the thumbprint from it, since node:crypto cannot parse PKCS#12.
rm -f server.csr server.key server.ext ca.key ca.srl

echo
echo "Done. Certificate thumbprint (SHA1):"
openssl x509 -in server.crt -noout -fingerprint -sha1
