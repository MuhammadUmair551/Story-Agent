"# code_base_squid" 
"# nutshyll" 

## Security exceptions

`GHSA-vfj7-8cjw-p6xm` (braces) is temporarily allowlisted in `security-exceptions.json`. npm currently publishes only 3.0.3 despite the advisory declaring 3.0.4 as the first patched version. It is a dev-only transitive dependency through shadcn/fast-glob/micromatch. Remove the exception as soon as an upstream patched release is available.

## Story Agent authentication

Signup uses name, email and password; sign in immediately afterward. Email is an unverified
login identifier. No email provider, sending domain or custom domain is required. Forgotten
password recovery is unavailable; use a password manager. Account settings offer password
change requiring the current password, which revokes every session.

Render needs MongoDB, the existing provider/runtime settings, an exact `WEB_ORIGIN` allowlist
and `AUTH_PUBLIC_ORIGIN` (an allowed HTTPS origin). Vercel keeps
`NEXT_PUBLIC_API_BASE_URL` pointing to the Render API. The free Vercel hostname is sufficient.
No mail-related secrets are required. See [authentication security and rollout](.project/story-agent/11-authentication.md)
for required indexes, safe legacy-data handling and production smoke tests, and the
[usage guide](.project/story-agent/05-usage-guide.md) for local setup.
