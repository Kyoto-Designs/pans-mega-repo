# Pan’s Mega Repo

A minimal, independent source for **AltStore Classic**.

## Source URL

After enabling GitHub Pages, add this URL to AltStore Classic:

`https://kyoto-designs.github.io/pans-mega-repo/apps.json`

## Files

- `apps.json` — AltStore Classic source catalog.
- `assets/icon.png` — source icon.

## Publish with GitHub Pages

1. Create a **public** GitHub repository named `pans-mega-repo` under `Kyoto-Designs`.
2. Upload the contents of this folder to the repository root (make sure `apps.json` is at the root).
3. Open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select branch **main** and folder **/(root)**, then save.
6. Wait for GitHub Pages to finish deploying.
7. Open the Source URL above in Safari. It should display the JSON document.
8. In AltStore Classic, add the source using that URL.

## Adding apps

Each app entry must use the AltStore Classic schema. Use accurate app metadata and a direct HTTPS URL to an IPA that you are authorized to distribute. The `bundleIdentifier`, version, build number, and file size must match the actual IPA.

Do not add an app until its IPA and metadata have been checked.
