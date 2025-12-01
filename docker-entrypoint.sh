#!/bin/bash
set -e

# Configure redsocks transparent proxy if HTTP_PROXY is set
if [ -n "$HTTP_PROXY" ]; then
    # Parse proxy URL (format: http://host:port)
    PROXY_HOST=$(echo "$HTTP_PROXY" | sed -E 's|https?://||' | cut -d: -f1)
    PROXY_PORT=$(echo "$HTTP_PROXY" | sed -E 's|https?://||' | cut -d: -f2)
    
    echo "[Entrypoint] Setting up transparent proxy via redsocks"
    echo "[Entrypoint] Proxy: $PROXY_HOST:$PROXY_PORT"
    
    # Create redsocks config
    cat > /tmp/redsocks.conf << EOF
base {
    log_debug = off;
    log_info = on;
    log = stderr;
    daemon = on;
    redirector = iptables;
}

redsocks {
    local_ip = 127.0.0.1;
    local_port = 12345;
    ip = $PROXY_HOST;
    port = $PROXY_PORT;
    type = http-relay;
}

redsocks {
    local_ip = 127.0.0.1;
    local_port = 12346;
    ip = $PROXY_HOST;
    port = $PROXY_PORT;
    type = http-connect;
}
EOF
    
    # Start redsocks in background
    redsocks -c /tmp/redsocks.conf
    sleep 1
    
    # Setup iptables rules to redirect TCP traffic through redsocks
    # Create new chain for redsocks
    iptables -t nat -N REDSOCKS 2>/dev/null || iptables -t nat -F REDSOCKS
    
    # Exclude local/private networks from proxying
    iptables -t nat -A REDSOCKS -d 0.0.0.0/8 -j RETURN
    iptables -t nat -A REDSOCKS -d 10.0.0.0/8 -j RETURN
    iptables -t nat -A REDSOCKS -d 127.0.0.0/8 -j RETURN
    iptables -t nat -A REDSOCKS -d 169.254.0.0/16 -j RETURN
    iptables -t nat -A REDSOCKS -d 172.16.0.0/12 -j RETURN
    iptables -t nat -A REDSOCKS -d 192.168.0.0/16 -j RETURN
    iptables -t nat -A REDSOCKS -d 224.0.0.0/4 -j RETURN
    iptables -t nat -A REDSOCKS -d 240.0.0.0/4 -j RETURN
    
    # CRITICAL: Exclude the proxy server itself to prevent infinite loop
    iptables -t nat -A REDSOCKS -d $PROXY_HOST -j RETURN
    
    # Redirect HTTP (80) to http-relay and HTTPS (443) to http-connect
    iptables -t nat -A REDSOCKS -p tcp --dport 80 -j REDIRECT --to-ports 12345
    iptables -t nat -A REDSOCKS -p tcp --dport 443 -j REDIRECT --to-ports 12346
    
    # Apply REDSOCKS chain to OUTPUT (for locally generated packets)
    iptables -t nat -A OUTPUT -p tcp -j REDSOCKS
    
    echo "[Entrypoint] Transparent proxy configured successfully (HTTPS only)"
fi

echo "[Entrypoint] Starting: $@"

# Run as worker user
exec gosu worker "$@"
