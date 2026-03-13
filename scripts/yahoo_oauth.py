"""
yahoo_oauth.py
--------------
Handles Yahoo OAuth2 token refresh and automatically rotates the
YAHOO_REFRESH_TOKEN GitHub Actions secret so the workflow never
needs manual re-authorisation.

Requires env vars:
  YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REFRESH_TOKEN
Optional (for secret rotation):
  GH_PAT           -- GitHub Personal Access Token with repo scope
  GITHUB_REPOSITORY -- set automatically by GitHub Actions (owner/repo)
"""

import base64
import os
import requests
from requests.auth import HTTPBasicAuth


def refresh_access_token():
    """
    Exchange the current refresh token for a new access token.
    Automatically rotates YAHOO_REFRESH_TOKEN in GitHub Secrets if GH_PAT is set.
    Returns the access token string.
    """
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
    resp.raise_for_status()
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

    # Fetch repo public key
    pk_resp = requests.get(
        "https://api.github.com/repos/{}/{}/actions/secrets/public-key".format(owner, repo),
        headers=headers,
        timeout=10,
    )
    pk_resp.raise_for_status()
    pk_data = pk_resp.json()

    # Encrypt with libsodium sealed box
    public_key  = nacl_pub.PublicKey(pk_data["key"].encode("utf-8"), nacl_enc.Base64Encoder())
    sealed_box  = nacl_pub.SealedBox(public_key)
    encrypted   = sealed_box.encrypt(secret_value.encode("utf-8"))
    encoded_val = base64.b64encode(encrypted).decode("utf-8")

    # Upload
    put_resp = requests.put(
        "https://api.github.com/repos/{}/{}/actions/secrets/{}".format(owner, repo, secret_name),
        headers=headers,
        json={"encrypted_value": encoded_val, "key_id": pk_data["key_id"]},
        timeout=10,
    )
    put_resp.raise_for_status()
