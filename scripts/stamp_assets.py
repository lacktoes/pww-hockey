"""
stamp_assets.py - give the page's CSS and JS links a content version (?v=<hash>).

    python scripts/stamp_assets.py        # run after changing docs/*.js or docs/*.css

GitHub Pages lets browsers keep each file for 10 minutes, and phones often keep them
longer. Without a version, a phone could load a new index.html with an old style.css or
app.js and show half-styled, dead controls. With one, a new page always asks for exactly
the files it was built with. The hash comes from each file's contents, so it only changes
when the file does.
"""
import hashlib
import pathlib
import re
import sys

DOCS = pathlib.Path(__file__).resolve().parent.parent / "docs"
INDEX = DOCS / "index.html"


def version(path):
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]


def main():
    html = INDEX.read_text(encoding="utf-8")

    def stamp(m):
        attr, name = m.group(1), m.group(2)
        f = DOCS / name
        if not f.exists():
            return m.group(0)
        return '{}="{}?v={}"'.format(attr, name, version(f))

    new = re.sub(r'(src|href)="([\w.-]+\.(?:js|css))(?:\?v=[\w]*)?"', stamp, html)
    if new != html:
        INDEX.write_text(new, encoding="utf-8")
        print("stamped:", ", ".join(re.findall(r'"([\w.-]+\.(?:js|css)\?v=\w+)"', new)))
    else:
        print("already current")
    return 0


if __name__ == "__main__":
    sys.exit(main())
