"""Fetch mono_laborarory note.com RSS -> articles.json

Runs in GitHub Actions. Writes at most `MAX_ITEMS` articles to articles.json.
Uses only stdlib so no pip install needed.
"""
import json, re, sys, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timezone

RSS_URL = "https://note.com/mono_laborarory/rss"
OUT = "articles.json"
MAX_ITEMS = 6

NS = {
    "media": "http://search.yahoo.com/mrss/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}


def extract_image(item):
    """Try media:thumbnail, then enclosure, then first <img> in content/description."""
    thumb = item.find("media:thumbnail", NS)
    if thumb is not None and thumb.get("url"):
        return thumb.get("url")
    enc = item.find("enclosure")
    if enc is not None and enc.get("url") and "image" in (enc.get("type") or ""):
        return enc.get("url")
    for tag in ("{http://purl.org/rss/1.0/modules/content/}encoded", "description"):
        el = item.find(tag)
        text = (el.text if el is not None else None) or ""
        m = re.search(r'<img[^>]+src="([^"]+)"', text)
        if m:
            return m.group(1)
    return None


def main():
    req = urllib.request.Request(RSS_URL, headers={"User-Agent": "mono-labo-site/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    root = ET.fromstring(data)

    items = []
    for item in root.findall(".//item")[:MAX_ITEMS]:
        title = (item.findtext("title") or "").strip()
        url = (item.findtext("link") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        img = extract_image(item)
        if not title or not url:
            continue
        items.append({"title": title, "url": url, "image": img, "published": pub})

    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": RSS_URL,
        "items": items,
    }
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {len(items)} items to {OUT}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
