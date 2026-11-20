# GitNow actions

GitHub Actions that build a repository and deploy it to **all-inkl** webspace on every push, like IONOS Deploy Now does for IONOS.

- **Plain JavaScript on Node 24.** No npm packages and no build step.
- **Uploads over FTPS** (FTP with TLS) with `lftp`, so it works on every all-inkl plan, including those without SSH.
- **Only changed files** are uploaded on each deploy.
- **Commands like `php artisan migrate`** run through a one-time PHP script, because FTP can't run commands.

| Action | What it does |
|---|---|
| `resolve` | Reads `.deploy-now/<project>/config.yaml` and decides what this branch deploys to: production, a preview site, or nothing. |
| `deploy` | Uploads the built site to all-inkl, renders templates such as `.env`, and runs the commands from `config.yaml`. |

`templates/` holds the workflow files and `config.yaml` presets that go into a customer's repository. `examples/static-site/` is a complete example repository.

## How a deploy works

```
push ─▶ gitnow-orchestration.yaml
         ├─ resolve   which environment? (production / preview / none)
         ├─ build     gitnow-build.yaml: your build steps → site packed as an artifact
         └─ deploy    gitnow-deploy.yaml → the deploy action:
              1. read <base-path>/.gitnow/<environment>.json from the server (the last deploy's file list)
              2. render .deploy-now/<project>/*.template into the site (e.g. .env)
              3. hash every file; compare with the last deploy
              4. run "pre-deployment-remote-commands" through the hook
              5. upload new and changed files, remove files that are gone
              6. save the new file list
              7. run "post-deployment-remote-commands" through the hook
```

The GitHub environment of the deploy job (`production`, `preview-<branch>`) shows the deploy status and the site address on commits and pull requests.

## Set up a repository

The GitNow web app will do this for customers. Until then, do it by hand:

1. **In KAS (all-inkl):**
   - **Create an extra FTP user** under *FTP → FTP-Benutzer* and limit it to a folder for this project, for example `/my-site/`.
   - **Point the domain** at the production folder: `/my-site/production/`. For Laravel, use `/my-site/production/public/`.
   - **Turn on SSL** (Let's Encrypt) for the domain.
2. **Copy the files** from `examples/static-site/`, or from `templates/`, into the repository:
   - `.github/workflows/gitnow-orchestration.yaml`
   - `.github/workflows/gitnow-deploy.yaml`
   - `.github/workflows/gitnow-build.yaml`: copy `gitnow-build.static.yaml` or `gitnow-build.laravel.yaml` under this name.
   - `.deploy-now/my-site/config.yaml`, plus any `*.template` files.
3. **Edit the copies:**
   - The workflow files use `AmmarInkl/gitnow-actions/…@v1`. Change it only if you run your own copy of this repository.
   - If you rename `my-site`, change it in the workflows and in the folder name under `.deploy-now/`.
   - In `config.yaml`, set the domain, `base-path` and `web-root`.
4. **In the repository's settings on GitHub** (*Secrets and variables → Actions*):
   - Variable `GITNOW_FTP_HOST`, e.g. `w0123456.kasserver.com`
   - Secret `GITNOW_FTP_USER`: the FTP user from step 1
   - Secret `GITNOW_FTP_PASSWORD`
   - Any secrets your templates use, e.g. `APP_KEY`, `DB_PASSWORD`
5. **Push to `main`.**

**About `base-path`:** it is the project folder *as the FTP login sees it*.
- An FTP user limited to `/my-site/` sees that folder as `/`, so use `base-path: /`.
- The main FTP account sees the whole webspace, so use `base-path: /my-site`.

## config.yaml

```yaml
version: 1.0

deploy:                       # same as IONOS Deploy Now
  bootstrap:                  # first deploy
    excludes: []
    pre-deployment-remote-commands: []
    post-deployment-remote-commands: []
  recurring:                  # every deploy after that
    excludes: [tests]
    pre-deployment-remote-commands: [php artisan down]
    post-deployment-remote-commands: [php artisan migrate --force, php artisan up]
  # force: bootstrap          # optional: always use one of the two blocks

gitnow:
  publish-dir: ./             # what the build produces (dist, out, ./)
  transport: ftps             # ssh comes later
  base-path: /                # project folder as the FTP login sees it
  web-root: public            # folder the domain points at, inside each deploy ("" = the deploy itself)
  php-version: "8.3"          # optional
  php-cli: ""                 # optional: full path of PHP's command-line program, if the hook can't find it
  environments:
    production:
      branch: main
      domain: www.example.com # or url: https://www.example.com
      path: production        # folder under base-path (default)
    previews:                 # one site per branch
      enabled: false
      domain: preview.example.com   # → https://<branch>.preview.example.com (create the subdomain in KAS)
      path: previews          # → <base-path>/previews/<branch>
      exclude-branches: [dependabot/**]
```

A project that comes from IONOS Deploy Now keeps its `deploy:` part and only adds `gitnow:`. `runtime.cron-jobs` is accepted but not supported yet: all-inkl cron jobs can only call web addresses, and GitNow will set them up through the all-inkl API in a later version.

## Templates

Every `*.template` file in `.deploy-now/<project>/` is written into the site on each deploy, without the `.template` suffix and in the same subfolder. For example, `.env.template` becomes `.env`.

**Syntax** (the same as IONOS Deploy Now):
- `$NAME` and `${NAME}` insert a value.
- `${NAME.urlEncoded()}` inserts it URL-encoded.

**Where values come from:**
- GitHub variables and secrets of the repository and its environment. `GITHUB_TOKEN` is never used.
- GitNow's own values: `GITNOW_APP_URL`, `GITNOW_ENVIRONMENT`, `GITNOW_BRANCH` and `GITNOW_COMMIT`. `IONOS_APP_URL` also works.

Names without a value stay as they are, and the deploy log warns about them.

## What gets uploaded and removed

- **The file list:** the server keeps the last deploy's file list with a SHA-256 hash of each file, in `<base-path>/.gitnow/<environment>.json`, outside the site. Only new and changed files are uploaded. A file is removed only if GitNow uploaded it before and it isn't in the new build. Files your app creates on the server (uploads, logs, cache) are never touched.
- **`excludes`** are never uploaded and never removed. `.git`, `.github` and `.deploy-now` are always excluded. Excludes work like rsync patterns:
  - `node_modules`: that name anywhere.
  - `/storage`: only at the top of the deploy.
  - `storage/logs`: that path from the top.
  - `*.log` and `**` wildcards.
- **The first deploy (bootstrap)** uploads everything and removes nothing. Old files already in the folder stay.
- **Editing files on the server by hand** isn't tracked, since the file list doesn't know about it. Set `deploy.force: bootstrap` once to upload everything again.

## Commands without SSH

FTP can't run commands. When a deploy has commands, GitNow:

1. Writes a one-time PHP script (`php/hook.php`) that has the commands built in, and uploads it into the web root under a random name.
2. Calls it over HTTPS with a secret token. Only a hash of the token is stored in the file.
3. The script deletes itself, runs the commands in the deploy folder one by one, and streams their output into the GitHub log.
4. The deploy fails at the first command that fails.

Details:
- A request can't add or change commands.
- The script refuses to run after 15 minutes.
- Commands that start with `php` use PHP's command-line program for the domain's PHP version. If it can't be found, set `php-cli`.
- The domain must already point at the deploy folder, plus `web-root`, because the script is reached through the site's address.

**Needs:** the server's PHP must allow `proc_open`. Very long commands may hit a web server timeout; the script prints "still running..." every 25 seconds so the connection stays open.

## Publish this repository

This repository lives at [github.com/AmmarInkl/gitnow-actions](https://github.com/AmmarInkl/gitnow-actions). Customers' workflows use its actions as `AmmarInkl/gitnow-actions/resolve@v1` and `…/deploy@v1`, which only works because the repository is **public**.

After a fix, move the `v1` tag so every customer gets it:

```powershell
git tag -f v1
git push -f origin v1
```

## Tests

```powershell
node --test test/
```

No packages to install. The tests use a local folder in place of the FTP server and a fake for GitHub. The hook test also runs the generated PHP script with your local `php`, if there is one.

## Not checked on a real all-inkl account yet

- FTPS login with an extra FTP user (`f0…`), the certificate check, and how many parallel uploads all-inkl allows (4 are used).
- Whether all-inkl's PHP allows `proc_open`, where its PHP command-line program is, and how long a web request may run.
- That `lftp` and `yq` behave on `ubuntu-latest` exactly as expected. The deploy has not run on GitHub yet.
