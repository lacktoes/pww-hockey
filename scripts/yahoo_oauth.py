"""
yahoo_oauth.py
--------------
Handles Yahoo OAuth2 token refresh and automatically rotates the
YAHOO_REFRESH_TOKEN GitHub Actions secret so the workflow never
needs manual re-authorisation.

Credentials are read from the environment. To find them, an .env file is
searched for in this order:

  1. $YAHOO_ENV                    -- explicit path to an env file
  2. <repo root>/.env
  3. each parent directory above the repo root (up to 4 levels)

That last one matters if you keep one shared .env alongside several Yahoo
projects rather than a copy inside each repo.

Requires env vars:
  YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REFRESH_TOKEN
Optional (for secret rotation):
  GH_PAT            -- GitHub Personal Access Token with repo scope
  GITHUB_REPOSITORY -- set automatically by GitHub Actions (owner/repo)
"""

import base64
import os
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth

REQUIRED = ("YAHOO_CLIENT_ID", "YAHOO_CLIENT_SECRET", "YAHOO_REFRESH_TOKEN")

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _candidate_env_paths():
    explicit = os.environ.get("YAHOO_ENV")
    if explicit:
        yield Path(explicit)
    yield _REPO_ROOT / ".env"
    parent = _REPO_ROOT
    for _ in range(4):
        parent = parent.parent
        if parent == parent.parent:      # filesystem root
            break
        yield parent / ".env"


def _parse_env_file(path):
    """
    Minimal KEY=VALUE reader, used when python-dotenv is not installed.
    Handles quotes, inline `export`, blank lines and # comments -- which is all
    a credentials file needs. Without this, a missing python-dotenv would mean
    the file is found but silently not loaded.
    """
    out = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, val = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        if key:
            out[key] = val
    return out


def load_env():
    """
    Load the first .env found into os.environ without clobbering values that
    are already set -- CI secrets and shell exports must win over any file.
    Returns the path used, or None.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:
        load_dotenv = None

    for path in _candidate_env_paths():
        try:
            if not path.is_file():
                continue
        except OSError:
            continue

        if load_dotenv is not None:
            load_dotenv(path, override=False)
        else:
            for k, v in _parse_env_file(path).items():
                os.environ.setdefault(k, v)
        return path
    return None


def _require_credentials():
    load_env()
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if not missing:
        return

    searched = "\n".join("    {}".format(p) for p in _candidate_env_paths())
    raise SystemExit(
        "\nMissing Yahoo credential(s): {}\n\n"
        "No .env file containing them was found. Searched:\n{}\n\n"
        "Fix it in whichever way suits:\n"
        "  - create {} containing:\n"
        "        YAHOO_CLIENT_ID=\"...\"\n"
        "        YAHOO_CLIENT_SECRET=\"...\"\n"
        "        YAHOO_REFRESH_TOKEN=\"...\"\n"
        "  - or point at an env file you already have:\n"
        "        set YAHOO_ENV=C:\\path\\to\\your\\.env\n"
        "  - or set the three variables in this shell before running.\n\n"
        "If another Yahoo project on this machine already authenticates, reuse\n"
        "its credentials rather than creating new ones.\n".format(
            ", ".join(missing), searched, _REPO_ROOT / ".env"))


def refresh_access_token():
    """
    Exchange the current refresh token for a new access token.
    Automatically rotates YAHOO_REFRESH_TOKEN in GitHub Secrets if GH_PAT is set.
    Returns the access token string.
    """
    _require_credentials()

    client_id     = os.environ["YAHOO_CLIENT_ID"]
    client_secret = os.environ["YAHOO_CLIENT_SECRET"]
    refresh_token = os.environ["YAHOO_REFRESH_TOKEN"]

    resp = requests.post(
        "https://api.login.yahoo.com/oauth2/get_token",
        auth=HTTPBasicAuth(client_id, client_secret),
        data={
            "refresh_token": refresh_token,
            "grant_type":    "refresh_token",
            "redirect_uri":  "oob",
        },
        timeout=15,
    )

    if not resp.ok:
        # Surface Yahoo's own reason -- the difference between a stale token and
        # revoked API access matters, and the status code alone does not say.
        try:
            body = resp.json()
        except ValueError:
            body = resp.text
        hint = ""
        if resp.status_code in (400, 401):
            hint = ("\n  The refresh token is most likely expired or revoked."
                    "\n  Re-run whichever setup flow issued it, then update .env.")
        elif resp.status_code == 403:
            hint = ("\n  403 usually means the app itself lost access, not the token."
                    "\n  Check the app still exists at developer.yahoo.com/apps/.")
        raise SystemExit("\nYahoo token refresh failed: HTTP {}\n  {}{}\n".format(
            resp.status_code, body, hint))

    tokens = resp.json()
    new_refresh = tokens.get("refresh_token", refresh_token)

    if new_refresh != refresh_token:
        print("  Refresh token rotated -- updating GitHub secret...", end=" ", flush=True)
        _update_github_secret("YAHOO_REFRESH_TOKEN", new_refresh)
        print("done")
        os.environ["YAHOO_REFRESH_TOKEN"] = new_refresh

    return tokens["access_token"]


def _update_github_secret(secret_name, secret_value):
    """
    Encrypt and upload a new value to a GitHub Actions repository secret.
    Requires GH_PAT and GITHUB_REPOSITORY to be set in the environment.
    Silently skips if they are not set (e.g. running locally).
    """
    pat     = os.environ.get("GH_PAT")
    gh_repo = os.environ.get("GITHUB_REPOSITORY")  # "owner/repo"
    if not pat or not gh_repo:
        return

    try:
        from nacl import encoding as nacl_enc
        from nacl import public as nacl_pub
    except ImportError:
        print("(PyNaCl not installed -- skipping secret rotation)")
        return

    owner, repo = gh_repo.split("/", 1)
    headers = {
        "Authorization": "token {}".format(pat),
        "Accept":        "application/vnd.github.v3+json",
    }

    pk_resp = requests.get(
        "https://api.github.com/repos/{}/{}/actions/secrets/public-key".format(owner, repo),
        headers=headers,
        timeout=10,
    )
    pk_resp.raise_for_status()
    pk_data = pk_resp.json()

    public_key  = nacl_pub.PublicKey(pk_data["key"].encode("utf-8"), nacl_enc.Base64Encoder())
    sealed_box  = nacl_pub.SealedBox(public_key)
    encrypted   = sealed_box.encrypt(secret_value.encode("utf-8"))
    encoded_val = base64.b64encode(encrypted).decode("utf-8")

    put_resp = requests.put(
        "https://api.github.com/repos/{}/{}/actions/secrets/{}".format(owner, repo, secret_name),
        headers=headers,
        json={"encrypted_value": encoded_val, "key_id": pk_data["key_id"]},
        timeout=10,
    )
    put_resp.raise_for_status()
