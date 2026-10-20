# Receipts Only

Store: `index.html` (GitHub Pages). Videos: `maker.html`. Autopilot: `.github/workflows/autopilot.yml` + `automation/run.mjs`.

## Settings you can change (`config.json`)
- `INVITE_CODE`: your Oopbuy code. Every link is switched to it.
- `STORE_URL`: this site's address, shown on the last screen of each video and in the description.
- `POST_TIMES`: Pacific times to post. Remove `"21:00"` to drop the 9 PM post.
- `ITEMS_PER_VIDEO`, `VOICE`, `HASHTAGS`, `PRIVACY` (`public`, `unlisted` or `private`).

## Secrets (Settings > Secrets and variables > Actions)
`YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`

## Run it by hand
Actions > Autopilot > Run workflow. `test` makes a video without posting (download it under Artifacts). `post` posts one now.

`data/state.json` remembers which finds were used and which time slots were posted. Don't edit it while a run is going.
