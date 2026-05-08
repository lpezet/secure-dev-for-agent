FROM mitmproxy/mitmproxy:12.2.2

USER root
RUN pip install --no-cache-dir requests cachetools

CMD ["mitmdump", \
     "--listen-host", "0.0.0.0", \
     "--listen-port", "8080", \
     "-s", "/addons/policy.py", \
     "-s", "/addons/github.py", \
     "-s", "/addons/anthropic.py", \
     "-s", "/addons/cloudflare.py", \
     "--set", "confdir=/home/mitmproxy/.mitmproxy"]
