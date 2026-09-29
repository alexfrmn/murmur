# Visitor counters for murmurconnect.com

The footer of the site shows visitors for today, the last 7 days, the last 30 days,
all time, and the number of people on the site right now. The numbers come from a
small service on the site's own server, so the page loads no third-party script and
sets no cookie.

- `stats.py` — Python 3 standard library only: `POST /api/hit` records a visit,
  `GET /api/stats` returns the counters. A visit is reduced to
  `sha256(day salt + IP + User-Agent)` with a random salt per day, so a visitor is
  counted once per day and cannot be followed across days. Requests whose
  User-Agent looks like a crawler are ignored.
- `murmurconnect-stats.service` — systemd unit; the database lives in
  `/var/lib/murmurconnect-stats/stats.db` (`StateDirectory`).
- `nginx-api.conf` — the `location /api/` block for the site's nginx server, which
  passes the visitor's address from Cloudflare's `CF-Connecting-IP` header.

Install on the web server:

```sh
install -D -m 0755 stats.py /opt/murmurconnect-stats/stats.py
install -m 0644 murmurconnect-stats.service /etc/systemd/system/
install -m 0644 nginx-api.conf /etc/nginx/snippets/murmurconnect-api.conf
# add `include snippets/murmurconnect-api.conf;` to the HTTPS server block, then
nginx -t && systemctl reload nginx
systemctl enable --now murmurconnect-stats
curl -s https://murmurconnect.com/api/stats
```

The counters start on the day the service is installed; the `since` field says when.
