#!/usr/bin/env bash
set -euo pipefail
reply="$(printf 'GET /readyz HTTP/1.1\r\nHost: qdrant\r\nConnection: close\r\n\r\n' | openssl s_client -connect 127.0.0.1:6333 -servername qdrant -CAfile /run/secrets/qdrant_tls_ca -verify_return_error -quiet 2>/dev/null)"
[[ "$reply" == HTTP/1.1\ 200* ]]
