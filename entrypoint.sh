#!/bin/sh
set -e

# Validate PROXY_URL if set
if [ -n "$PROXY_URL" ]; then
    echo "Checking PROXY_URL: $PROXY_URL"
    # Basic regex check for protocol
    if echo "$PROXY_URL" | grep -qE "^(http|https|socks5|socks5h)://"; then
        echo "PROXY_URL format is valid."
    else
        echo "Error: Invalid PROXY_URL format. Must start with http://, https://, socks5://, or socks5h://"
        exit 1
    fi
fi

# Execute the CMD
exec "$@"
