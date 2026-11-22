# Security notes

This is a static, client-side app. There is no server, no login, no API and no secrets in the code (checked by searching the source for keys, tokens and passwords). The main risks are cross-site scripting (XSS) through user-entered or imported text, and untrusted data in LocalStorage.

## What was checked and changed

| Area | Finding | Fix |
|---|---|---|
| XSS / unsafe DOM | `escapeHtml` did not escape quotes, and values were placed inside attributes (`title="..."`, `href="..."`, `value="..."`). A `"` in notes, a link or an id could break out of the attribute and add an event handler. Record ids and some class names were inserted unescaped. | `escapeHtml` now escapes `& < > " '`. Ids, status and type from storage are validated (plain id pattern; unknown status/type replaced). User text is otherwise placed with `textContent` or escaped. |
| URL handling | A stored link such as `javascript:...` would have been rendered into `href` in the table. | Only `http:`/`https:` links are rendered, in the table, hero, interview locations and on load. External links use `target="_blank" rel="noopener noreferrer"`. A non-http meeting "location" is shown as plain text. |
| Input validation | Forms already validated; new forms (stage change, checklist, interviews) were added with length limits, real-date checks, no future stage dates, unique checklist names and unique round names. | Validation lives in pure functions that are unit-tested. |
| CSV import/export | Existing protections kept: 1 MB / 2000 row limits, per-row validation, duplicate detection, formula-injection guard on export (cells starting with `= + - @`). | Import now also creates normalised records; invalid statuses and links are rejected per row. |
| LocalStorage | Data was trusted after `JSON.parse`. | Every record is normalised on load. Corrupt JSON is kept in a separate key and the app starts empty. A one-time backup is made before the format upgrade. The notification key is validated. Blocked storage is handled without crashing. |
| Secrets | None found. | - |
| Clickjacking / CSP | No policy. | A `<meta>` Content-Security-Policy is included (see below). |

## Content-Security-Policy included in `index.html`

```
default-src 'none'; script-src 'self' 'sha256-<hash of the small theme script>';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;
img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'
```

- `style-src 'unsafe-inline'` is needed because charts set widths and colours with inline `style` attributes. Scripts are not inline-enabled except for the one hashed theme script. **If you edit that inline script in `index.html`, its hash changes and you must update the CSP hash**, otherwise the browser will block it (the page then falls back to the default dark theme).
- If you stop using Google Fonts, remove the two Google hosts from the policy.

## GitHub Pages: recommended response headers

GitHub Pages does **not** let you set custom HTTP headers, so the `<meta>` CSP above is the main protection available there. A `<meta>` CSP cannot set `frame-ancestors`, and `X-Frame-Options` / HSTS cannot be set from HTML. GitHub Pages already serves HTTPS and HSTS for `github.io` addresses.

If you host somewhere that supports headers (Netlify, Cloudflare Pages, Vercel, nginx), add:

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<hash>'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

(`Strict-Transport-Security` only on HTTPS hosts you control. Notifications still work with this `Permissions-Policy`.) For Netlify or Cloudflare Pages, put these lines in a `_headers` file under `/*`.

## Remaining limitations

- Anyone with access to the browser profile can read LocalStorage. Do not store passwords or sensitive personal data in notes.
- Same-origin scripts (for example a browser extension) can read the data. This app cannot defend against that.
- The CSP is tested only by loading the app in Chrome and checking for console errors; it has not been audited with a CSP scanner.
